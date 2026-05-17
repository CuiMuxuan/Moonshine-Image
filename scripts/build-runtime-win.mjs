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
const requirementsPath = path.join(repoRoot, "server", "requirements.txt");
const smokeImagePath = path.join(smokeInputDir, "image.png");
const smokeMaskPath = path.join(smokeMaskDir, "image.png");
const sourceModelPath = path.join(repoRoot, "models", PACKAGED_DEFAULT_MODEL_FILE);
const runtimeEnvName =
  process.env.MOONSHINE_RUNTIME_ENV_NAME || "moonshine-runtime-311";
const targetPythonVersion = "3.11.5";
const obsoleteRuntimePackages = [
  "gradio",
  "gradio-client",
  "diffusers",
  "accelerate",
  "controlnet-aux",
];

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

function getMissingRequirements() {
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
    requirementsPath,
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

function installRuntimeDependencies() {
  const torchWheelPath = process.env.MOONSHINE_TORCH_WHEEL;
  if (torchWheelPath && fs.existsSync(torchWheelPath)) {
    runCommand("conda", [
      "run",
      "-n",
      runtimeEnvName,
      "python",
      "-m",
      "pip",
      "install",
      torchWheelPath,
    ]);
  }

  const missingRequirements = getMissingRequirements();
  if (missingRequirements.length === 0) {
    console.log("Runtime dependencies are already satisfied.");
    return;
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
  ]);

  const expectedPythonPath = path.join(
    runtimeEnvPath,
    process.platform === "win32" ? "python.exe" : "bin/python"
  );
  if (!fs.existsSync(expectedPythonPath)) {
    const sourceEnvPath = getRuntimeEnvPrefix();
    console.warn(
      `conda-pack output is missing ${path.basename(expectedPythonPath)}; copying environment from ${sourceEnvPath}`
    );
    copyRuntimeEnvDirectory(sourceEnvPath, runtimeEnvPath);
  }
}

function writeRuntimeManifest() {
  const pythonExecutable =
    process.platform === "win32" ? `${PACKAGED_RUNTIME_ENV_DIR}/python.exe` : `${PACKAGED_RUNTIME_ENV_DIR}/bin/python`;
  const condaUnpackExecutable =
    process.platform === "win32"
      ? `${PACKAGED_RUNTIME_ENV_DIR}/Scripts/conda-unpack.exe`
      : `${PACKAGED_RUNTIME_ENV_DIR}/bin/conda-unpack`;
  const manifest = {
    schemaVersion: 2,
    envName: runtimeEnvName,
    pythonVersion: targetPythonVersion,
    layout: "directory",
    envDir: PACKAGED_RUNTIME_ENV_DIR,
    pythonExecutable,
    condaUnpackExecutable,
    builtAt: new Date().toISOString(),
    pythonSha256: sha256File(path.join(runtimeRoot, pythonExecutable)),
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
  return (
    fs.existsSync(runtimeEnvPath) &&
    fs.existsSync(path.join(runtimeEnvPath, process.platform === "win32" ? "python.exe" : "bin/python")) &&
    fs.existsSync(runtimeManifestPath)
  );
}

export function buildPackagedWindowsRuntime(options = {}) {
  const { allowFallback = true } = options;

  try {
    ensureSourceModelExists();
    ensureRuntimeEnv();
    removeObsoleteRuntimePackages();
    installRuntimeDependencies();
    runRuntimeSmokeTest();
    materializeRuntimeDirectory();
    const manifest = writeRuntimeManifest();

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
