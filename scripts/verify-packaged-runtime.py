"""Validate a packaged Moonshine runtime without using host Python state."""

from __future__ import annotations

import argparse
import importlib
import importlib.metadata as metadata
import importlib.util
import json
import site
import sys
import sysconfig
from pathlib import Path


SAM3_REQUIRED_MODULES = (
    "sam3",
    "iopath",
    "hydra",
    "omegaconf",
    "einops",
    "ftfy",
    "pycocotools",
    "psutil",
    "triton",
)


def normalize_path(value: str | Path) -> str:
    return str(Path(value).resolve()).replace("\\", "/").casefold()


def site_package_roots() -> tuple[Path, ...]:
    roots: set[Path] = set()
    for value in site.getsitepackages():
        if value:
            roots.add(Path(value).resolve())
    for key in ("purelib", "platlib"):
        value = sysconfig.get_paths().get(key)
        if value:
            roots.add(Path(value).resolve())
    return tuple(sorted(roots))


def relative_to_any(path_value: Path, roots: tuple[Path, ...], runtime_root: Path) -> str | None:
    resolved = path_value.resolve()
    for root in roots:
        try:
            resolved.relative_to(root)
        except ValueError:
            continue
        return str(resolved.relative_to(runtime_root)).replace("\\", "/")
    return None


def discover_editable_artifacts(roots: tuple[Path, ...], source_dir: Path) -> tuple[list[str], bool]:
    artifacts: set[str] = set()
    source_normalized = normalize_path(source_dir)
    source_path_leak = any(
        normalize_path(entry) == source_normalized
        or normalize_path(entry).startswith(f"{source_normalized}/")
        for entry in sys.path
        if entry
    )
    for root in roots:
        if not root.is_dir():
            continue
        artifacts.update(item.name for item in root.glob("__editable__.sam3*"))
        artifacts.update(item.name for item in root.glob("sam3.egg-link"))
        for pth_file in root.glob("*.pth"):
            content = pth_file.read_text(encoding="utf-8", errors="ignore")
            if source_normalized in content.replace("\\", "/").casefold():
                source_path_leak = True
                artifacts.add(pth_file.name)
    return sorted(artifacts), source_path_leak


def import_backend(backend_root: Path) -> dict:
    if not backend_root.is_dir():
        raise RuntimeError(f"Packaged backend directory is missing: {backend_root}")
    sys.path.insert(0, str(backend_root))
    importlib.import_module("moonshine_server.api")
    importlib.import_module("moonshine_server.plugins.segment_anything")
    importlib.import_module("moonshine_server.plugins.segment_anything2.build_sam")
    return {"api": True, "sam1": True, "sam2": True}


def verify_cuda_runtime(roots: tuple[Path, ...], runtime_root: Path, source_dir: Path) -> dict:
    editable_artifacts, source_path_leak = discover_editable_artifacts(roots, source_dir)
    result: dict = {
        "expected": "bundled-cuda-runtime",
        "editableArtifacts": editable_artifacts,
        "sourcePathLeak": source_path_leak,
        "requiredModules": {},
    }
    errors: list[str] = []
    try:
        sam3 = importlib.import_module("sam3")
        sam3_file = Path(sam3.__file__).resolve()
        sam3_normalized = normalize_path(sam3_file)
        if sam3_normalized == normalize_path(source_dir) or sam3_normalized.startswith(
            f"{normalize_path(source_dir)}/"
        ):
            source_path_leak = True
        result["sourcePathLeak"] = source_path_leak
        sam3_location = relative_to_any(sam3_file, roots, runtime_root)
        if not sam3_location:
            errors.append("sam3.__file__ is outside packaged runtime site-packages")
        result["sam3Location"] = sam3_location
        result["sam3Version"] = metadata.version("sam3")
    except Exception as error:
        errors.append(f"cannot import sam3 from packaged runtime: {error}")

    for module_name in SAM3_REQUIRED_MODULES:
        try:
            importlib.import_module(module_name)
            result["requiredModules"][module_name] = True
        except Exception:
            result["requiredModules"][module_name] = False
            errors.append(f"required SAM3 module is unavailable: {module_name}")

    try:
        numpy_version = metadata.version("numpy")
        result["numpyVersion"] = numpy_version
        result["numpyRuntimeCompatible"] = int(numpy_version.split(".", 1)[0]) >= 1
        if not result["numpyRuntimeCompatible"]:
            errors.append(f"runtime numpy is incompatible: {numpy_version}")
    except Exception as error:
        errors.append(f"cannot inspect runtime numpy: {error}")

    if editable_artifacts:
        errors.append("editable SAM3 metadata is present in packaged site-packages")
    if source_path_leak:
        errors.append("packaged runtime resolves SAM3 through the build source path")
    result["errors"] = errors
    result["valid"] = not errors
    return result


def verify_cpu_runtime(roots: tuple[Path, ...], source_dir: Path) -> dict:
    editable_artifacts, source_path_leak = discover_editable_artifacts(roots, source_dir)
    errors: list[str] = []
    sam3_spec = importlib.util.find_spec("sam3")
    try:
        metadata.version("sam3")
        sam3_distribution_present = True
    except metadata.PackageNotFoundError:
        sam3_distribution_present = False
    if sam3_spec is not None:
        errors.append("CPU package unexpectedly imports sam3")
    if sam3_distribution_present:
        errors.append("CPU package unexpectedly contains a sam3 distribution")
    if editable_artifacts:
        errors.append("CPU package contains editable SAM3 metadata")
    if source_path_leak:
        errors.append("CPU package exposes the SAM3 build source path")
    return {
        "expected": "cuda-only-unavailable",
        "sam3Importable": sam3_spec is not None,
        "sam3DistributionPresent": sam3_distribution_present,
        "editableArtifacts": editable_artifacts,
        "sourcePathLeak": source_path_leak,
        "errors": errors,
        "valid": not errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit a packaged Moonshine Python runtime.")
    parser.add_argument("--runtime-flavor", required=True, choices=("cpu", "cu126", "cu130"))
    parser.add_argument("--runtime-root", required=True)
    parser.add_argument("--backend-root", required=True)
    parser.add_argument("--sam3-source-dir", required=True)
    args = parser.parse_args()

    runtime_root = Path(args.runtime_root).resolve()
    backend_root = Path(args.backend_root).resolve()
    source_dir = Path(args.sam3_source_dir).resolve()
    result: dict = {"runtimeFlavor": args.runtime_flavor, "status": "fail"}
    try:
        result["backendImports"] = import_backend(backend_root)
        roots = site_package_roots()
        if args.runtime_flavor == "cpu":
            result["sam3"] = verify_cpu_runtime(roots, source_dir)
        else:
            result["sam3"] = verify_cuda_runtime(roots, runtime_root, source_dir)
        result["status"] = "pass" if result["sam3"]["valid"] else "fail"
    except Exception as error:
        result["error"] = str(error)

    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
