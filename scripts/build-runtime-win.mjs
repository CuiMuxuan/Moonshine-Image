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
const requirementsPath = path.join(repoRoot, "IOPaint", "requirements.txt");
const smokeImagePath = path.join(repoRoot, "IOPaint", "iopaint", "tests", "image.png");
const smokeMaskPath = path.join(repoRoot, "IOPaint", "iopaint", "tests", "mask.png");
const sourceModelPath = path.join(repoRoot, "models", PACKAGED_DEFAULT_MODEL_FILE);
const runtimeEnvName =
  process.env.MOONSHINE_RUNTIME_ENV_NAME || "moonshine-runtime-311";
const targetPythonVersion = "3.11.5";

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

function installRuntimeDependencies() {
  runCommand("conda", ["run", "-n", runtimeEnvName, "python", "-m", "pip", "install", "-r", requirementsPath]);
}

function runRuntimeSmokeTest() {
  fs.rmSync(smokeOutputDir, { recursive: true, force: true });
  ensureDir(smokeOutputDir);

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
      path.join(repoRoot, "IOPaint", "main.py"),
      "run",
      "--model=lama",
      "--device=cpu",
      `--image=${smokeImagePath}`,
      `--mask=${smokeMaskPath}`,
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
