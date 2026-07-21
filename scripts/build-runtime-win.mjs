import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  PACKAGED_DEFAULT_MODEL_FILE,
  PACKAGED_RUNTIME_ENV_DIR,
  PACKAGED_RUNTIME_METADATA_FILE,
  PACKAGED_RUNTIME_RESOURCE_DIR,
  PACKAGED_RUNTIME_TARGET_DIR,
} from "../src-electron/integrity/public-key.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const buildResourcesRoot = path.join(repoRoot, "build-resources");
const runtimeRoot = path.join(
  buildResourcesRoot,
  PACKAGED_RUNTIME_RESOURCE_DIR,
  PACKAGED_RUNTIME_TARGET_DIR
);
const runtimeEnvPath = path.join(runtimeRoot, PACKAGED_RUNTIME_ENV_DIR);
const runtimeManifestPath = path.join(runtimeRoot, PACKAGED_RUNTIME_METADATA_FILE);
const legacyRuntimeArchivePath = path.join(runtimeRoot, "env.zip");
const smokeOutputDir = path.join(buildResourcesRoot, ".tmp", "runtime-smoke-output");
const smokeInputDir = path.join(buildResourcesRoot, ".tmp", "runtime-smoke-input");
const smokeMaskDir = path.join(buildResourcesRoot, ".tmp", "runtime-smoke-mask");
const runtimeTmpDir = path.join(buildResourcesRoot, ".tmp", "runtime");
const runtimePythonScriptDir = path.join(runtimeTmpDir, "python-scripts");
const missingRequirementsPath = path.join(runtimeTmpDir, "missing-requirements.txt");
const pinnedRuntimePackagesPath = path.join(runtimeTmpDir, "pinned-runtime-packages.txt");
const runtimeRequirementsPath = path.join(runtimeTmpDir, "runtime-requirements-no-torch.txt");
const sam3RuntimeRequirementsPath = path.join(runtimeTmpDir, "sam3-runtime-requirements.txt");
const sam3WheelDir = path.join(runtimeTmpDir, "sam3-wheel");
const requirementsPath = path.join(repoRoot, "server", "requirements.txt");
const smokeImagePath = path.join(smokeInputDir, "image.png");
const smokeMaskPath = path.join(smokeMaskDir, "image.png");
const sam3CompatibilitySmokeScriptPath = path.join(__dirname, "verify_sam3_compatibility.py");
const sourceModelPath = path.join(repoRoot, "models", PACKAGED_DEFAULT_MODEL_FILE);
const configuredSam3SourceDir = String(process.env.MOONSHINE_SAM3_SOURCE_DIR || "").trim();
const defaultSam3SourceDir = path.join(repoRoot, "third_party", "sam3");
const sam3SourceDir = path.resolve(configuredSam3SourceDir || defaultSam3SourceDir);
const hasExplicitRuntimeFlavor = Boolean(process.env.MOONSHINE_RUNTIME_FLAVOR);
const runtimeFlavor = normalizeRuntimeFlavor(process.env.MOONSHINE_RUNTIME_FLAVOR);
const modelBundle = normalizeModelBundle(process.env.MOONSHINE_MODEL_BUNDLE);
const runtimeEnvName =
  process.env.MOONSHINE_RUNTIME_ENV_NAME ||
  (hasExplicitRuntimeFlavor ? `moonshine-runtime-312-${runtimeFlavor}` : "moonshine-runtime-312");
const targetPythonVersion = "3.12.11";
const torchVersion = "2.11.0";
const torchvisionVersion = "0.26.0";
const defaultCu126TorchWheelPath =
  "C:\\code\\torch\\torch-2.11.0+cu126-cp312-cp312-win_amd64.whl";
const condaPackPythonWarnings = [
  process.env.PYTHONWARNINGS,
  "ignore:pkg_resources is deprecated as an API:UserWarning",
]
  .filter(Boolean)
  .join(",");
const torchFlavorConfig = {
  cpu: {
    indexUrl: "https://download.pytorch.org/whl/cpu",
    expectedCuda: null,
    installSource: "pytorch-cpu-index",
  },
  cu126: {
    indexUrl: "https://download.pytorch.org/whl/cu126",
    expectedCuda: "12.6",
    installSource: "local-torch-wheel-cu126",
  },
  cu130: {
    indexUrl: "https://download.pytorch.org/whl/cu130",
    expectedCuda: "13.0",
    installSource: "pytorch-cu130-index-or-existing-env",
  },
};
const obsoleteRuntimePackages = [
  "gradio",
  "gradio-client",
  "diffusers",
  "accelerate",
  "controlnet-aux",
];
const sam3RuntimeRequiredModules = [
  "sam3",
  "iopath",
  "hydra",
  "omegaconf",
  "einops",
  "ftfy",
  "pycocotools",
  "psutil",
  "sam3._moonshine_compat",
];
const sam3RuntimeOptionalModules = [
  "triton",
];
const sam3SupportRequirements = [
  "timm>=1.0.17",
  "tqdm",
  "ftfy==6.1.1",
  "regex",
  "iopath>=0.1.10",
  "typing_extensions",
  "huggingface_hub",
  "hydra-core",
  "omegaconf",
  "einops",
  "pycocotools",
  "psutil",
  "scipy>=1.11,<2",
  "scikit-image",
];
// Triton is an optional accelerator. The vendored SAM3 compatibility layer keeps Windows releases functional without it.

function normalizeRuntimeFlavor(value) {
  const normalized = String(value || "cu130").trim().toLowerCase();
  if (["cpu", "cu126", "cu130"].includes(normalized)) {
    return normalized;
  }
  throw new Error(
    `Unsupported MOONSHINE_RUNTIME_FLAVOR: ${value}. Expected cpu, cu126 or cu130.`
  );
}

function normalizeModelBundle(value) {
  const normalized = String(value || "bundled-models").trim().toLowerCase();
  if (["bundled-models", "external-models"].includes(normalized)) {
    return normalized;
  }
  throw new Error(
    `Unsupported MOONSHINE_MODEL_BUNDLE: ${value}. Expected bundled-models or external-models.`
  );
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ...(options.env || {}) },
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`
    );
  }
}

function runCommandCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    encoding: "utf8",
    env: { ...process.env, ...(options.env || {}) },
    ...options,
  });

  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${
        result.status ?? "unknown"
      }${stderr ? `: ${stderr}` : ""}`
    );
  }

  return String(result.stdout || "").trim();
}

function getRuntimeEnvPrefix() {
  const envListJson = runCommandCapture("conda", ["env", "list", "--json"]);
  const envList = JSON.parse(envListJson || "{}");
  const envs = Array.isArray(envList.envs) ? envList.envs : [];
  const matchedEnv = envs.find((envPath) =>
    path.normalize(String(envPath || "")).endsWith(path.normalize(runtimeEnvName))
  );
  if (!matchedEnv) {
    throw new Error(`Unable to resolve conda environment prefix: ${runtimeEnvName}`);
  }
  return matchedEnv;
}

function copyRuntimeEnvDirectory(sourceEnvPath, destinationEnvPath) {
  fs.rmSync(destinationEnvPath, { recursive: true, force: true });
  fs.cpSync(sourceEnvPath, destinationEnvPath, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (sourcePath) => {
      const name = path.basename(sourcePath);
      return (
        name !== "__pycache__" &&
        !name.endsWith(".pyc") &&
        !name.endsWith(".pyo")
      );
    },
  });
}

function writeRuntimePythonScript(scriptName, script) {
  ensureDir(runtimePythonScriptDir);
  const scriptPath = path.join(runtimePythonScriptDir, scriptName);
  fs.writeFileSync(scriptPath, `${String(script).trim()}\n`, "utf8");
  return scriptPath;
}

function runRuntimePythonScript(scriptName, script, args = [], options = {}) {
  const scriptPath = writeRuntimePythonScript(scriptName, script);
  runCommand(
    "conda",
    ["run", "-n", runtimeEnvName, "python", scriptPath, ...args],
    options
  );
}

function runRuntimePythonScriptCapture(scriptName, script, args = [], options = {}) {
  const scriptPath = writeRuntimePythonScript(scriptName, script);
  return runCommandCapture(
    "conda",
    ["run", "-n", runtimeEnvName, "python", scriptPath, ...args],
    options
  );
}

function getPackagedRuntimePythonPath() {
  return path.join(runtimeEnvPath, process.platform === "win32" ? "python.exe" : "bin/python");
}

function runPackagedRuntimePythonScriptCapture(scriptName, script, args = [], options = {}) {
  const scriptPath = writeRuntimePythonScript(scriptName, script);
  return runCommandCapture(getPackagedRuntimePythonPath(), [scriptPath, ...args], options);
}

function ensureSourceModelExists() {
  if (!fs.existsSync(sourceModelPath)) {
    throw new Error(
      `Missing bundled model file: ${sourceModelPath}. Put ${PACKAGED_DEFAULT_MODEL_FILE} in the repo-level models directory first.`
    );
  }
}

function ensureRuntimeEnv() {
  const envListJson = runCommandCapture("conda", ["env", "list", "--json"]);
  const parsed = JSON.parse(envListJson);
  const envs = Array.isArray(parsed?.envs) ? parsed.envs : [];
  const hasRuntimeEnv = envs.some((envPath) => {
    const normalized = String(envPath || "").replace(/\\/g, "/");
    return normalized.endsWith(`/${runtimeEnvName}`);
  });

  if (!hasRuntimeEnv) {
    runCommand("conda", ["create", "-n", runtimeEnvName, `python=${targetPythonVersion}`, "-y"]);
    return;
  }

  const pythonVersion = runCommandCapture("conda", [
    "run",
    "-n",
    runtimeEnvName,
    "python",
    "--version",
  ]);
  if (!pythonVersion.includes(targetPythonVersion)) {
    runCommand("conda", ["env", "remove", "-n", runtimeEnvName, "-y"]);
    runCommand("conda", ["create", "-n", runtimeEnvName, `python=${targetPythonVersion}`, "-y"]);
  }
}

function getInstalledPackageNames(packageNames) {
  const script = String.raw`
import importlib.metadata as metadata
import json
import sys

try:
    from packaging.utils import canonicalize_name
except Exception:
    def canonicalize_name(name):
        return name.lower().replace("_", "-")

installed = set()
for dist in metadata.distributions():
    name = dist.metadata.get("Name")
    if name:
        installed.add(canonicalize_name(name))

result = []
for raw_name in sys.argv[1:]:
    if canonicalize_name(raw_name) in installed:
        result.append(raw_name)

print(json.dumps(result))
`;

  const output = runRuntimePythonScriptCapture(
    "installed-package-names.py",
    script,
    packageNames
  );

  try {
    return JSON.parse(output);
  } catch {
    return [];
  }
}

function removeObsoleteRuntimePackages() {
  const installedObsoletePackages = getInstalledPackageNames(obsoleteRuntimePackages);
  if (installedObsoletePackages.length === 0) {
    return;
  }

  runCommand("conda", [
    "run",
    "-n",
    runtimeEnvName,
    "python",
    "-m",
    "pip",
    "uninstall",
    "-y",
    ...installedObsoletePackages,
  ]);
}

function bundlesSam3Runtime() {
  return runtimeFlavor === "cu126" || runtimeFlavor === "cu130";
}

function ensureSam3Source() {
  if (!bundlesSam3Runtime()) {
    return null;
  }

  const pyprojectPath = path.join(sam3SourceDir, "pyproject.toml");
  if (!fs.existsSync(pyprojectPath)) {
    throw new Error(
      `CUDA runtime builds require a controlled SAM3 source tree. Set MOONSHINE_SAM3_SOURCE_DIR to a directory containing pyproject.toml. Checked: ${pyprojectPath}`
    );
  }

  const pyproject = fs.readFileSync(pyprojectPath, "utf8");
  if (!/^\s*name\s*=\s*["']sam3["']\s*$/m.test(pyproject)) {
    throw new Error(`SAM3 source metadata is invalid: ${pyprojectPath} does not declare project name sam3.`);
  }

  return { sourceDir: sam3SourceDir, pyprojectPath };
}

function clearSam3RuntimeInstallation() {
  runCommand("conda", [
    "run",
    "-n",
    runtimeEnvName,
    "python",
    "-m",
    "pip",
    "uninstall",
    "-y",
    "sam3",
  ]);

  const script = String.raw`
import shutil
import site
import sysconfig
from pathlib import Path

roots = set()
for value in site.getsitepackages():
    if value:
        roots.add(Path(value).resolve())
for key in ("purelib", "platlib"):
    value = sysconfig.get_paths().get(key)
    if value:
        roots.add(Path(value).resolve())

for root in roots:
    if not root.is_dir():
        continue
    for pattern in ("sam3", "sam3-*.dist-info", "sam3*.egg-info", "__editable__.sam3*", "sam3.egg-link"):
        for candidate in root.glob(pattern):
            if candidate.is_dir():
                shutil.rmtree(candidate, ignore_errors=True)
            else:
                candidate.unlink(missing_ok=True)
`;
  runRuntimePythonScript("clear-sam3-runtime.py", script);
}

function buildSam3Wheel(sam3Source) {
  fs.rmSync(sam3WheelDir, { recursive: true, force: true });
  ensureDir(sam3WheelDir);
  runCommand("conda", [
    "run",
    "-n",
    runtimeEnvName,
    "python",
    "-m",
    "pip",
    "wheel",
    "--no-deps",
    "--no-build-isolation",
    "--wheel-dir",
    sam3WheelDir,
    sam3Source.sourceDir,
  ]);

  const wheels = fs
    .readdirSync(sam3WheelDir)
    .filter((fileName) => /^sam3-.+\.whl$/i.test(fileName))
    .map((fileName) => path.join(sam3WheelDir, fileName));
  if (wheels.length !== 1) {
    throw new Error(`Expected exactly one SAM3 wheel in ${sam3WheelDir}, found: ${wheels.join(", ") || "none"}`);
  }
  return wheels[0];
}

function installSam3SupportDependencies() {
  ensureDir(runtimeTmpDir);
  fs.writeFileSync(sam3RuntimeRequirementsPath, `${sam3SupportRequirements.join("\n")}\n`);

  const pinnedPackages = getInstalledPackageConstraints(["torch", "torchvision", "numpy"]);
  const installArgs = [
    "run",
    "-n",
    runtimeEnvName,
    "python",
    "-m",
    "pip",
    "install",
    "--upgrade-strategy",
    "only-if-needed",
    "-r",
    sam3RuntimeRequirementsPath,
  ];
  if (pinnedPackages.length > 0) {
    fs.writeFileSync(pinnedRuntimePackagesPath, `${pinnedPackages.join("\n")}\n`);
    installArgs.push("-c", pinnedRuntimePackagesPath);
  }
  runCommand("conda", installArgs);
}

function verifySam3Runtime({ phase, usePackagedPython = false }) {
  const expectedState = bundlesSam3Runtime() ? "present" : "absent";
  const script = String.raw`
import importlib
import importlib.metadata as metadata
import importlib.util
import json
import site
import sys
import sysconfig
from pathlib import Path

source_dir = Path(sys.argv[1]).resolve()
expected_state = sys.argv[2]
required_modules = ${JSON.stringify(sam3RuntimeRequiredModules)}
optional_modules = ${JSON.stringify(sam3RuntimeOptionalModules)}

def normalize(value):
    return str(Path(value).resolve()).replace("\\", "/").casefold()

site_roots = set()
for value in site.getsitepackages():
    if value:
        site_roots.add(Path(value).resolve())
for key in ("purelib", "platlib"):
    value = sysconfig.get_paths().get(key)
    if value:
        site_roots.add(Path(value).resolve())

def relative_to_site(path_value):
    resolved = Path(path_value).resolve()
    for root in site_roots:
        try:
            return str(resolved.relative_to(root)).replace("\\", "/")
        except ValueError:
            continue
    return None

source_normalized = normalize(source_dir)
editable_artifacts = []
source_path_leak = any(
    normalize(entry) == source_normalized
    or normalize(entry).startswith(source_normalized + "/")
    for entry in sys.path
    if entry
)
for root in site_roots:
    if not root.is_dir():
        continue
    editable_artifacts.extend(item.name for item in root.glob("__editable__.sam3*"))
    editable_artifacts.extend(item.name for item in root.glob("sam3.egg-link"))
    for pth in root.glob("*.pth"):
        content = pth.read_text(encoding="utf-8", errors="ignore").replace("\\", "/").casefold()
        if source_normalized in content:
            source_path_leak = True
            editable_artifacts.append(pth.name)

result = {
    "phase": ${JSON.stringify("runtime")},
    "expectedState": expected_state,
    "requiredModules": {},
    "optionalModules": {},
    "editableArtifacts": sorted(set(editable_artifacts)),
    "sourcePathLeak": source_path_leak,
    "valid": False,
}

if expected_state == "absent":
    sam3_spec = importlib.util.find_spec("sam3")
    try:
        metadata.version("sam3")
        sam3_distribution_present = True
    except metadata.PackageNotFoundError:
        sam3_distribution_present = False
    result.update({
        "sam3Importable": sam3_spec is not None,
        "sam3DistributionPresent": sam3_distribution_present,
    })
    result["valid"] = (
        not sam3_spec
        and not sam3_distribution_present
        and not result["editableArtifacts"]
        and not result["sourcePathLeak"]
    )
else:
    try:
        sam3 = importlib.import_module("sam3")
        sam3_file = Path(sam3.__file__).resolve()
        sam3_normalized = normalize(sam3_file)
        if sam3_normalized == source_normalized or sam3_normalized.startswith(source_normalized + "/"):
            source_path_leak = True
        result["sourcePathLeak"] = source_path_leak
        missing = []
        for module_name in required_modules:
            try:
                importlib.import_module(module_name)
                result["requiredModules"][module_name] = True
            except Exception:
                result["requiredModules"][module_name] = False
                missing.append(module_name)
        for module_name in optional_modules:
            try:
                importlib.import_module(module_name)
                result["optionalModules"][module_name] = True
            except Exception:
                result["optionalModules"][module_name] = False
        compatibility = importlib.import_module("sam3._moonshine_compat")
        acceleration = compatibility.runtime_capabilities()
        result["acceleration"] = acceleration
        compatibility_ready = acceleration.get("triton", {}).get("backend") in {
            "triton",
            "compatibility-fallback",
        }
        sam3_location = relative_to_site(sam3_file)
        numpy_version = metadata.version("numpy")
        numpy_major = int(numpy_version.split(".", 1)[0])
        result.update({
            "sam3Version": metadata.version("sam3"),
            "sam3Location": sam3_location,
            "missingModules": missing,
            "numpyVersion": numpy_version,
            "numpyRuntimeCompatible": numpy_major >= 1,
            "compatibilityReady": compatibility_ready,
        })
        result["valid"] = bool(
            sam3_location
            and not missing
            and not result["editableArtifacts"]
            and not result["sourcePathLeak"]
            and result["numpyRuntimeCompatible"]
            and result["compatibilityReady"]
        )
    except Exception as error:
        result["error"] = str(error)

print(json.dumps(result, ensure_ascii=False, sort_keys=True))
`;
  const scriptName = `verify-sam3-runtime-${phase}.py`;
  const output = usePackagedPython
    ? runPackagedRuntimePythonScriptCapture(scriptName, script, [sam3SourceDir, expectedState])
    : runRuntimePythonScriptCapture(scriptName, script, [sam3SourceDir, expectedState]);
  let verification;
  try {
    verification = JSON.parse(output);
  } catch (error) {
    throw new Error(`SAM3 ${phase} verification did not return JSON: ${output}`);
  }
  verification.phase = phase;
  if (!verification.valid) {
    throw new Error(`SAM3 ${phase} verification failed: ${JSON.stringify(verification)}`);
  }
  return verification;
}

function runSam3CompatibilitySmoke({ phase, usePackagedPython = false }) {
  if (!bundlesSam3Runtime()) {
    return { status: "not-required", reason: "SAM3 is CUDA-only in CPU releases." };
  }

  const environment = {
    MOONSHINE_SAM3_DISABLE_TRITON: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONSAFEPATH: "1",
  };
  const output = usePackagedPython
    ? runCommandCapture(
        getPackagedRuntimePythonPath(),
        [sam3CompatibilitySmokeScriptPath, "--expect-backend", "compatibility-fallback"],
        { env: environment }
      )
    : runCommandCapture(
        "conda",
        [
          "run",
          "-n",
          runtimeEnvName,
          "python",
          sam3CompatibilitySmokeScriptPath,
          "--expect-backend",
          "compatibility-fallback",
        ],
        { env: environment }
      );
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error(`SAM3 ${phase} compatibility smoke did not return JSON: ${output}`);
  }
  if (result.status !== "pass") {
    throw new Error(`SAM3 ${phase} compatibility smoke failed: ${JSON.stringify(result)}`);
  }
  return result;
}

function installSam3Runtime(sam3Source) {
  clearSam3RuntimeInstallation();
  if (!bundlesSam3Runtime()) {
    return {
      bundled: false,
      availability: "cuda-only-unavailable",
      prePackVerification: verifySam3Runtime({ phase: "pre-pack" }),
    };
  }

  const wheelPath = buildSam3Wheel(sam3Source);
  // Install support packages before SAM3 metadata enters the resolver; keep NumPy/Torch pinned.
  installSam3SupportDependencies();
  runCommand("conda", [
    "run",
    "-n",
    runtimeEnvName,
    "python",
    "-m",
    "pip",
    "install",
    "--no-deps",
    "--force-reinstall",
    wheelPath,
  ]);
  const prePackVerification = verifySam3Runtime({ phase: "pre-pack" });
  const prePackCompatibilitySmoke = runSam3CompatibilitySmoke({ phase: "pre-pack" });
  return {
    bundled: true,
    availability: "bundled-cuda-runtime",
    wheelFileName: path.basename(wheelPath),
    wheelSha256: sha256File(wheelPath),
    packageVersion: prePackVerification.sam3Version || "",
    installMode: "wheel-non-editable-no-deps",
    numpyPolicy: "preserve-runtime-numpy-2.x-and-verify-imports",
    prePackVerification,
    prePackCompatibilitySmoke,
  };
}

function getMissingRequirements(requirementsFilePath = requirementsPath) {
  const script = String.raw`
import importlib.metadata as metadata
import re
import sys

try:
    from packaging.requirements import Requirement
    from packaging.utils import canonicalize_name
except Exception:
    Requirement = None

    def canonicalize_name(name):
        return name.lower().replace("_", "-")

installed = {}
for dist in metadata.distributions():
    name = dist.metadata.get("Name")
    if name:
        installed[canonicalize_name(name)] = dist.version

missing = []
with open(sys.argv[1], "r", encoding="utf-8") as req_file:
    for raw_line in req_file:
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("-"):
            missing.append(stripped)
            continue

        requirement_text = stripped.split("#", 1)[0].strip()
        if not requirement_text:
            continue

        if Requirement is not None:
            try:
                req = Requirement(requirement_text)
                if req.marker is not None and not req.marker.evaluate():
                    continue
                installed_version = installed.get(canonicalize_name(req.name))
                if installed_version and (
                    not req.specifier
                    or req.specifier.contains(installed_version, prereleases=True)
                ):
                    continue
                missing.append(stripped)
                continue
            except Exception:
                pass

        package_name = re.split(r"[<>=!~;\[]", requirement_text, maxsplit=1)[0].strip()
        if package_name and canonicalize_name(package_name) in installed:
            continue
        missing.append(stripped)

print("\n".join(missing))
`;

  const output = runRuntimePythonScriptCapture("missing-requirements.py", script, [
    requirementsFilePath,
  ]);

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getInstalledPackageConstraints(packageNames) {
  const script = String.raw`
import importlib.metadata as metadata
import json
import sys

try:
    from packaging.utils import canonicalize_name
except Exception:
    def canonicalize_name(name):
        return name.lower().replace("_", "-")

installed = {}
for dist in metadata.distributions():
    name = dist.metadata.get("Name")
    if name:
        installed[canonicalize_name(name)] = dist.version

result = []
for raw_name in sys.argv[1:]:
    name = canonicalize_name(raw_name)
    version = installed.get(name)
    if version:
        result.append(f"{raw_name}=={version}")

print(json.dumps(result))
`;

  const output = runRuntimePythonScriptCapture(
    "installed-package-constraints.py",
    script,
    packageNames
  );

  try {
    return JSON.parse(output);
  } catch {
    return [];
  }
}

function writeRuntimeRequirementsWithoutTorch() {
  ensureDir(runtimeTmpDir);
  const filteredLines = fs
    .readFileSync(requirementsPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => {
      const stripped = line.trim();
      if (!stripped || stripped.startsWith("#")) {
        return true;
      }
      const packageName = stripped
        .split("#", 1)[0]
        .trim()
        .split(/[<>=!~;\[]/, 1)[0]
        .trim()
        .toLowerCase()
        .replace(/_/g, "-");
      return packageName !== "torch" && packageName !== "torchvision";
    });

  fs.writeFileSync(runtimeRequirementsPath, `${filteredLines.join("\n").trim()}\n`);
  return runtimeRequirementsPath;
}

function getRuntimeTorchInfo() {
  const script = String.raw`
import json
from importlib import metadata

result = {
    "torchVersion": "",
    "torchCudaVersion": None,
    "torchCudaAvailable": False,
    "torchvisionVersion": "",
}

try:
    import torch
    result["torchVersion"] = getattr(torch, "__version__", "")
    result["torchCudaVersion"] = getattr(torch.version, "cuda", None)
    result["torchCudaAvailable"] = bool(torch.cuda.is_available())
except Exception as error:
    result["torchError"] = str(error)

try:
    result["torchvisionVersion"] = metadata.version("torchvision")
except Exception as error:
    result["torchvisionMetadataError"] = str(error)

print(json.dumps(result, ensure_ascii=False))
`;

  const output = runRuntimePythonScriptCapture("torch-runtime-info.py", script);
  try {
    return JSON.parse(output);
  } catch {
    return {};
  }
}

function isTorchRuntimeSatisfied(info) {
  if (!info?.torchVersion || !info?.torchvisionVersion) {
    return false;
  }

  const expectedCuda = torchFlavorConfig[runtimeFlavor].expectedCuda;
  if (runtimeFlavor === "cpu") {
    return !info.torchCudaVersion;
  }

  return (
    info.torchCudaVersion === expectedCuda ||
    String(info.torchVersion).includes(`+${runtimeFlavor}`) ||
    String(info.torchvisionVersion).includes(`+${runtimeFlavor}`)
  );
}

function installTorchRuntime() {
  const initialInfo = getRuntimeTorchInfo();
  if (isTorchRuntimeSatisfied(initialInfo)) {
    return {
      ...initialInfo,
      torchInstallSource: "existing-env",
    };
  }

  const config = torchFlavorConfig[runtimeFlavor];
  const pipBaseArgs = ["run", "-n", runtimeEnvName, "python", "-m", "pip", "install"];

  if (runtimeFlavor === "cu126") {
    const torchWheelPath =
      process.env.MOONSHINE_TORCH_WHEEL || defaultCu126TorchWheelPath;
    if (!fs.existsSync(torchWheelPath)) {
      throw new Error(
        `Missing CUDA 12.6 torch wheel: ${torchWheelPath}. Set MOONSHINE_TORCH_WHEEL to a local torch ${torchVersion}+cu126 wheel.`
      );
    }
    runCommand("conda", [...pipBaseArgs, torchWheelPath]);
    runCommand("conda", [
      ...pipBaseArgs,
      `torchvision==${torchvisionVersion}`,
      "--index-url",
      config.indexUrl,
      "--no-deps",
      "--force-reinstall",
    ]);
  } else {
    runCommand("conda", [
      ...pipBaseArgs,
      `torch==${torchVersion}`,
      `torchvision==${torchvisionVersion}`,
      "--index-url",
      config.indexUrl,
      "--force-reinstall",
    ]);
  }

  const nextInfo = getRuntimeTorchInfo();
  if (!isTorchRuntimeSatisfied(nextInfo)) {
    throw new Error(
      `Installed PyTorch runtime does not match ${runtimeFlavor}: ${JSON.stringify(nextInfo)}`
    );
  }

  return {
    ...nextInfo,
    torchInstallSource:
      runtimeFlavor === "cu126" && process.env.MOONSHINE_TORCH_WHEEL
        ? process.env.MOONSHINE_TORCH_WHEEL
        : config.installSource,
  };
}

function installRuntimeDependencies() {
  const torchInfo = installTorchRuntime();
  const runtimeRequirements = writeRuntimeRequirementsWithoutTorch();

  const missingRequirements = getMissingRequirements(runtimeRequirements);
  if (missingRequirements.length === 0) {
    console.log("Runtime dependencies are already satisfied.");
    return torchInfo;
  }

  ensureDir(runtimeTmpDir);
  fs.writeFileSync(missingRequirementsPath, `${missingRequirements.join("\n")}\n`);

  const pinnedRuntimePackages = getInstalledPackageConstraints(["torch", "torchvision"]);
  const installArgs = [
    "run",
    "-n",
    runtimeEnvName,
    "python",
    "-m",
    "pip",
    "install",
    "--upgrade-strategy",
    "only-if-needed",
    "-r",
    missingRequirementsPath,
  ];

  if (pinnedRuntimePackages.length > 0) {
    fs.writeFileSync(
      pinnedRuntimePackagesPath,
      `${pinnedRuntimePackages.join("\n")}\n`
    );
    installArgs.push("-c", pinnedRuntimePackagesPath);
  }

  runCommand("conda", installArgs);
  return {
    ...getRuntimeTorchInfo(),
    torchInstallSource: torchInfo.torchInstallSource,
  };
}

function createSmokeFixtures() {
  fs.rmSync(smokeInputDir, { recursive: true, force: true });
  fs.rmSync(smokeMaskDir, { recursive: true, force: true });
  ensureDir(smokeInputDir);
  ensureDir(smokeMaskDir);

  const script = String.raw`
from pathlib import Path
import sys

from PIL import Image, ImageDraw

image_path = Path(sys.argv[1])
mask_path = Path(sys.argv[2])
image = Image.new("RGB", (64, 64), (236, 240, 244))
draw = ImageDraw.Draw(image)
draw.rectangle((20, 20, 44, 44), fill=(52, 101, 164))
mask = Image.new("L", (64, 64), 0)
mask_draw = ImageDraw.Draw(mask)
mask_draw.rectangle((20, 20, 44, 44), fill=255)
image.save(image_path)
mask.save(mask_path)
`;

  runRuntimePythonScript("create-smoke-fixtures.py", script, [
    smokeImagePath,
    smokeMaskPath,
  ]);
}

function runRuntimeSmokeTest() {
  fs.rmSync(smokeOutputDir, { recursive: true, force: true });
  ensureDir(smokeOutputDir);
  createSmokeFixtures();

  const smokeEnv = {
    LAMA_MODEL_URL: sourceModelPath,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    PYTHONIOENCODING: "utf-8",
  };

  runCommand(
    "conda",
    [
      "run",
      "-n",
      runtimeEnvName,
      "python",
      path.join(repoRoot, "server", "main.py"),
      "run",
      "--model=lama",
      "--device=cpu",
      `--image=${smokeInputDir}`,
      `--mask=${smokeMaskDir}`,
      `--output=${smokeOutputDir}`,
      `--model-dir=${path.join(repoRoot, "models")}`,
    ],
    {
      env: smokeEnv,
    }
  );
}

function materializeRuntimeDirectory() {
  ensureDir(runtimeRoot);
  fs.rmSync(runtimeEnvPath, { recursive: true, force: true });
  fs.rmSync(legacyRuntimeArchivePath, { force: true });
  runCommand("conda", [
    "pack",
    "-n",
    runtimeEnvName,
    "--format",
    "no-archive",
    "--ignore-missing-files",
    "--output",
    runtimeEnvPath,
    "--force",
  ], {
    env: {
      PYTHONWARNINGS: condaPackPythonWarnings,
    },
  });

  const expectedPythonPath = getPackagedRuntimePythonPath();
  if (!fs.existsSync(expectedPythonPath)) {
    const sourceEnvPath = getRuntimeEnvPrefix();
    console.warn(
      `conda-pack output is missing ${path.basename(expectedPythonPath)}; copying environment from ${sourceEnvPath}`
    );
    copyRuntimeEnvDirectory(sourceEnvPath, runtimeEnvPath);
  }
}

function writeRuntimeManifest(torchInfo = {}, sam3Runtime = {}) {
  const pythonExecutable =
    process.platform === "win32" ? `${PACKAGED_RUNTIME_ENV_DIR}/python.exe` : `${PACKAGED_RUNTIME_ENV_DIR}/bin/python`;
  const condaUnpackExecutable =
    process.platform === "win32"
      ? `${PACKAGED_RUNTIME_ENV_DIR}/Scripts/conda-unpack.exe`
      : `${PACKAGED_RUNTIME_ENV_DIR}/bin/conda-unpack`;
  const manifest = {
    schemaVersion: 4,
    envName: runtimeEnvName,
    runtimeFlavor,
    modelBundle,
    pythonVersion: targetPythonVersion,
    layout: "directory",
    envDir: PACKAGED_RUNTIME_ENV_DIR,
    pythonExecutable,
    condaUnpackExecutable,
    builtAt: new Date().toISOString(),
    pythonSha256: sha256File(path.join(runtimeRoot, pythonExecutable)),
    torchVersion: torchInfo.torchVersion || "",
    torchCudaVersion: torchInfo.torchCudaVersion || null,
    torchCudaAvailable: Boolean(torchInfo.torchCudaAvailable),
    torchvisionVersion: torchInfo.torchvisionVersion || "",
    torchInstallSource: torchInfo.torchInstallSource || "",
    samRuntime: {
      sam1: {
        code: "bundled-backend-plugin",
        modelWeightsBundled: false,
      },
      sam2: {
        code: "bundled-backend-plugin",
        modelWeightsBundled: false,
      },
      sam3: {
        bundled: Boolean(sam3Runtime.bundled),
        availability: sam3Runtime.availability || "unknown",
        packageVersion: sam3Runtime.packageVersion || "",
        wheelFileName: sam3Runtime.wheelFileName || "",
        wheelSha256: sam3Runtime.wheelSha256 || "",
        installMode: sam3Runtime.installMode || "",
        numpyPolicy: sam3Runtime.numpyPolicy || "",
        requiredModules: sam3Runtime.bundled ? sam3RuntimeRequiredModules : [],
        optionalModules: sam3Runtime.bundled ? sam3RuntimeOptionalModules : [],
        acceleration:
          sam3Runtime.postPackVerification?.acceleration ||
          sam3Runtime.prePackVerification?.acceleration ||
          null,
        compatibilitySmoke: {
          prePack: sam3Runtime.prePackCompatibilitySmoke || null,
          postPack: sam3Runtime.postPackCompatibilitySmoke || null,
        },
        importVerification: {
          prePack: sam3Runtime.prePackVerification || null,
          postPack: sam3Runtime.postPackVerification || null,
        },
        modelWeightsBundled: false,
      },
    },
    modelFile: PACKAGED_DEFAULT_MODEL_FILE,
    smokeTest: {
      image: path.relative(repoRoot, smokeImagePath).replace(/\\/g, "/"),
      mask: path.relative(repoRoot, smokeMaskPath).replace(/\\/g, "/"),
      outputDir: path.relative(repoRoot, smokeOutputDir).replace(/\\/g, "/"),
    },
  };

  fs.writeFileSync(runtimeManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function hasReusableRuntimeArtifact() {
  if (
    !fs.existsSync(runtimeEnvPath) ||
    !fs.existsSync(path.join(runtimeEnvPath, process.platform === "win32" ? "python.exe" : "bin/python")) ||
    !fs.existsSync(runtimeManifestPath)
  ) {
    return false;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(runtimeManifestPath, "utf8"));
    if (manifest.schemaVersion < 4 || (manifest.runtimeFlavor && manifest.runtimeFlavor !== runtimeFlavor)) {
      return false;
    }
    const sam3Runtime = manifest.samRuntime?.sam3;
    if (bundlesSam3Runtime()) {
      return Boolean(
        sam3Runtime?.bundled &&
          sam3Runtime?.importVerification?.postPack?.valid &&
          ["triton", "compatibility-fallback"].includes(
            sam3Runtime?.acceleration?.triton?.backend
          ) &&
          sam3Runtime?.compatibilitySmoke?.postPack?.status === "pass" &&
          !sam3Runtime.importVerification.postPack.sourcePathLeak &&
          (!sam3Runtime.importVerification.postPack.editableArtifacts ||
            sam3Runtime.importVerification.postPack.editableArtifacts.length === 0)
      );
    }
    return Boolean(sam3Runtime && !sam3Runtime.bundled && sam3Runtime.availability === "cuda-only-unavailable");
  } catch {
    return false;
  }
}

export function buildPackagedWindowsRuntime(options = {}) {
  const { allowFallback = true } = options;
  // Do not hide a missing or invalid controlled SAM3 source behind an old CUDA artifact.
  const sam3Source = ensureSam3Source();

  try {
    ensureSourceModelExists();
    ensureRuntimeEnv();
    removeObsoleteRuntimePackages();
    const torchInfo = installRuntimeDependencies();
    const sam3Runtime = installSam3Runtime(sam3Source);
    runRuntimeSmokeTest();
    materializeRuntimeDirectory();
    sam3Runtime.postPackVerification = verifySam3Runtime({
      phase: "post-pack",
      usePackagedPython: true,
    });
    sam3Runtime.postPackCompatibilitySmoke = runSam3CompatibilitySmoke({
      phase: "post-pack",
      usePackagedPython: true,
    });
    const manifest = writeRuntimeManifest(torchInfo, sam3Runtime);

    return {
      success: true,
      runtimeEnvPath,
      runtimeManifestPath,
      reusedExistingArtifact: false,
      manifest,
    };
  } catch (error) {
    if (allowFallback && hasReusableRuntimeArtifact()) {
      console.warn(
        `Runtime build failed, reusing the previous packaged runtime artifact: ${error.message}`
      );
      return {
        success: true,
        runtimeEnvPath,
        runtimeManifestPath,
        reusedExistingArtifact: true,
        warning: error.message,
      };
    }

    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const result = buildPackagedWindowsRuntime();
  console.log(
    `Prepared packaged runtime at ${result.runtimeEnvPath}${
      result.reusedExistingArtifact ? " (reused existing artifact)" : ""
    }`
  );
}
