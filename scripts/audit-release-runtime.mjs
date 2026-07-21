import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  PACKAGED_BACKEND_PROJECT_DIR,
  PACKAGED_BACKEND_RESOURCE_DIR,
  PACKAGED_RUNTIME_ENV_DIR,
  PACKAGED_RUNTIME_METADATA_FILE,
  PACKAGED_RUNTIME_RESOURCE_DIR,
  PACKAGED_RUNTIME_TARGET_DIR,
} from "../src-electron/integrity/public-key.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const runtimeAuditScriptPath = path.join(__dirname, "verify-packaged-runtime.py");
const sam3ImageSmokeScriptPath = path.join(__dirname, "verify_sam3_image_smoke.py");
const sam3VideoSmokeScriptPath = path.join(__dirname, "verify_sam3_video_smoke.py");
const sam3CompatibilitySmokeScriptPath = path.join(__dirname, "verify_sam3_compatibility.py");
const defaultSam3SourceDir = path.join(repoRoot, "third_party", "sam3");

function fail(message) {
  throw new Error(message);
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    shell: false,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...(options.env || {}) },
  });
  if (result.error) {
    fail(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    const stdout = String(result.stdout || "").trim();
    fail(
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}${
        stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ""
      }`
    );
  }
  return String(result.stdout || "").trim();
}

function parseJsonOutput(output, label) {
  const trimmed = String(output || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const trailingJsonOffset = trimmed.lastIndexOf("\n{");
    if (trailingJsonOffset >= 0) {
      try {
        return JSON.parse(trimmed.slice(trailingJsonOffset + 1));
      } catch {
        // Fall through to the bounded diagnostic below.
      }
    }
    fail(`${label} did not return JSON: ${trimmed.slice(-2000)}`);
  }
}

function hasRuntimeManifest(appRoot) {
  return fs.existsSync(
    path.join(
      appRoot,
      "resources",
      PACKAGED_RUNTIME_RESOURCE_DIR,
      PACKAGED_RUNTIME_TARGET_DIR,
      PACKAGED_RUNTIME_METADATA_FILE
    )
  );
}

function resolveAppRoot(candidateRoot) {
  if (hasRuntimeManifest(candidateRoot)) {
    return candidateRoot;
  }
  if (!fs.existsSync(candidateRoot)) {
    fail(`Packaged application root does not exist: ${candidateRoot}`);
  }
  for (const entry of fs.readdirSync(candidateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const child = path.join(candidateRoot, entry.name);
    if (hasRuntimeManifest(child)) {
      return child;
    }
  }
  fail(`Unable to locate a packaged application runtime under ${candidateRoot}`);
}

function resolvePackagedPaths(appRoot) {
  const runtimeRoot = path.join(
    appRoot,
    "resources",
    PACKAGED_RUNTIME_RESOURCE_DIR,
    PACKAGED_RUNTIME_TARGET_DIR
  );
  const envRoot = path.join(runtimeRoot, PACKAGED_RUNTIME_ENV_DIR);
  const pythonExecutable = path.join(envRoot, process.platform === "win32" ? "python.exe" : "bin/python");
  const backendRoot = path.join(
    appRoot,
    "resources",
    PACKAGED_BACKEND_RESOURCE_DIR,
    PACKAGED_BACKEND_PROJECT_DIR
  );
  const manifestPath = path.join(runtimeRoot, PACKAGED_RUNTIME_METADATA_FILE);
  if (!fs.existsSync(pythonExecutable)) {
    fail(`Packaged runtime Python is missing: ${pythonExecutable}`);
  }
  if (!fs.existsSync(backendRoot)) {
    fail(`Packaged backend is missing: ${backendRoot}`);
  }
  return { runtimeRoot, pythonExecutable, backendRoot, manifestPath };
}

function validateRuntimeManifest(manifestPath, runtimeFlavor, modelBundle) {
  if (!fs.existsSync(manifestPath)) {
    fail(`Packaged runtime manifest is missing: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion < 4) {
    fail(`Runtime manifest schema is too old for self-contained SAM validation: ${manifest.schemaVersion}`);
  }
  if (manifest.runtimeFlavor !== runtimeFlavor || manifest.modelBundle !== modelBundle) {
    fail(
      `Runtime manifest mismatch: expected ${runtimeFlavor}/${modelBundle}, received ${manifest.runtimeFlavor}/${manifest.modelBundle}`
    );
  }
  const sam3 = manifest.samRuntime?.sam3;
  if (!sam3) {
    fail("Runtime manifest is missing SAM3 runtime metadata.");
  }
  if (runtimeFlavor === "cpu") {
    if (sam3.bundled || sam3.availability !== "cuda-only-unavailable") {
      fail("CPU runtime manifest must declare SAM3 as CUDA-only and not bundled.");
    }
  } else if (
    !sam3.bundled ||
    sam3.installMode !== "wheel-non-editable-no-deps" ||
    !sam3.wheelSha256 ||
    !sam3.importVerification?.postPack?.valid ||
    !["triton", "compatibility-fallback"].includes(sam3.acceleration?.triton?.backend) ||
    sam3.compatibilitySmoke?.prePack?.status !== "pass" ||
    sam3.compatibilitySmoke?.postPack?.status !== "pass"
  ) {
    fail("CUDA runtime manifest does not prove a self-contained SAM3 wheel and compatibility fallback.");
  }
  return {
    schemaVersion: manifest.schemaVersion,
    runtimeFlavor: manifest.runtimeFlavor,
    modelBundle: manifest.modelBundle,
    samRuntime: manifest.samRuntime,
  };
}

function releaseEnvironment({ backendRoot, runtimeFlavor, modelBundle }) {
  return {
    MOONSHINE_RUNTIME_FLAVOR: runtimeFlavor,
    MOONSHINE_MODEL_BUNDLE: modelBundle,
    MOONSHINE_PACKAGED_RUNTIME: "1",
    PYTHONPATH: backendRoot,
    PYTHONNOUSERSITE: "1",
    PYTHONSAFEPATH: "1",
  };
}

function resolveSam3SourceDir() {
  return path.resolve(
    String(process.env.MOONSHINE_SAM3_SOURCE_DIR || defaultSam3SourceDir).trim()
  );
}

function runImportAudit({ paths, runtimeFlavor, modelBundle }) {
  const output = runCapture(
    paths.pythonExecutable,
    [
      runtimeAuditScriptPath,
      "--runtime-flavor",
      runtimeFlavor,
      "--runtime-root",
      paths.runtimeRoot,
      "--backend-root",
      paths.backendRoot,
      "--sam3-source-dir",
      resolveSam3SourceDir(),
    ],
    { env: releaseEnvironment({ backendRoot: paths.backendRoot, runtimeFlavor, modelBundle }) }
  );
  const result = parseJsonOutput(output, "Packaged runtime import audit");
  if (result.status !== "pass") {
    fail(`Packaged runtime import audit failed: ${output}`);
  }
  return result;
}

function runCudaFunctionalSmoke({ paths, runtimeFlavor, modelBundle, modelsDir }) {
  if (runtimeFlavor === "cpu") {
    return { status: "not-required", reason: "SAM3 is CUDA-only in CPU releases." };
  }
  const resolvedModelsDir = path.resolve(
    modelsDir || process.env.MOONSHINE_AUDIT_MODELS_DIR || path.join(repoRoot, "models")
  );
  const expectedWeights = [
    path.join(resolvedModelsDir, "sam3", "sam3.pt"),
    path.join(resolvedModelsDir, "sam3", "sam3.1_multiplex.pt"),
  ];
  const missingWeights = expectedWeights.filter((weightPath) => !fs.existsSync(weightPath));
  if (missingWeights.length > 0) {
    fail(
      `CUDA runtime functional audit requires external SAM3 smoke weights. Missing: ${missingWeights.join(", ")}`
    );
  }

  const env = {
    ...releaseEnvironment({ backendRoot: paths.backendRoot, runtimeFlavor, modelBundle }),
    // Functional image and video smoke must exercise the Windows-safe path even on builders with Triton.
    MOONSHINE_SAM3_DISABLE_TRITON: "1",
  };
  const image = parseJsonOutput(
    runCapture(
      paths.pythonExecutable,
      [sam3ImageSmokeScriptPath, "--model-dir", resolvedModelsDir, "--device", "cuda"],
      { env }
    ),
    "SAM3 image smoke"
  );
  const video = parseJsonOutput(
    runCapture(
      paths.pythonExecutable,
      [
        sam3VideoSmokeScriptPath,
        "--model-dir",
        resolvedModelsDir,
        "--device",
        "cuda",
        "--model-id",
        "sam3_1_multiplex",
      ],
      { env }
    ),
    "SAM3 video smoke"
  );
  if (image.status !== "pass" || video.status !== "pass") {
    fail(`SAM3 functional audit failed: ${JSON.stringify({ image, video })}`);
  }
  return { status: "passed", backend: "compatibility-fallback", image, video };
}

function runSam3CompatibilitySmoke({ paths, runtimeFlavor, modelBundle }) {
  if (runtimeFlavor === "cpu") {
    return { status: "not-required", reason: "SAM3 is CUDA-only in CPU releases." };
  }
  const output = runCapture(
    paths.pythonExecutable,
    [sam3CompatibilitySmokeScriptPath, "--expect-backend", "compatibility-fallback"],
    {
      env: {
        ...releaseEnvironment({ backendRoot: paths.backendRoot, runtimeFlavor, modelBundle }),
        MOONSHINE_SAM3_DISABLE_TRITON: "1",
      },
    }
  );
  const result = parseJsonOutput(output, "SAM3 compatibility smoke");
  if (result.status !== "pass") {
    fail(`SAM3 compatibility smoke failed: ${JSON.stringify(result)}`);
  }
  return result;
}

function auditResolvedPackage({ appRoot, runtimeFlavor, modelBundle, scope, runFunctionalSmoke, modelsDir }) {
  const paths = resolvePackagedPaths(appRoot);
  const manifest = validateRuntimeManifest(paths.manifestPath, runtimeFlavor, modelBundle);
  const importAudit = runImportAudit({ paths, runtimeFlavor, modelBundle });
  const compatibilitySmoke = runSam3CompatibilitySmoke({ paths, runtimeFlavor, modelBundle });
  const functionalSmoke = runFunctionalSmoke
    ? runCudaFunctionalSmoke({ paths, runtimeFlavor, modelBundle, modelsDir })
    : { status: "not-run" };
  return {
    status: "passed",
    scope,
    runtimeFlavor,
    modelBundle,
    auditedAt: new Date().toISOString(),
    manifest,
    importAudit,
    compatibilitySmoke,
    functionalSmoke,
  };
}

export function auditPackagedRuntimeDirectory({
  appDir,
  runtimeFlavor,
  modelBundle,
  modelsDir,
  runFunctionalSmoke = false,
}) {
  return auditResolvedPackage({
    appRoot: resolveAppRoot(appDir),
    runtimeFlavor,
    modelBundle,
    scope: "directory",
    modelsDir,
    runFunctionalSmoke,
  });
}

function extractZip(zipPath, destinationDir) {
  if (fs.existsSync(destinationDir)) {
    fail(`Archive extraction destination must not exist: ${destinationDir}`);
  }
  const command = [
    '$ErrorActionPreference = "Stop"',
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$zip = ${JSON.stringify(zipPath)}`,
    `$destination = ${JSON.stringify(destinationDir)}`,
    "[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $destination)",
  ].join("; ");
  runCapture("powershell.exe", ["-NoProfile", "-Command", command]);
}

function createArchiveAuditTempDirectory() {
  const configuredTempDir = String(process.env.MOONSHINE_RUNTIME_AUDIT_TEMP_DIR || "").trim();
  const defaultTempDirs =
    process.platform === "win32"
      ? [path.parse(os.tmpdir()).root, path.dirname(repoRoot)]
      : [os.tmpdir()];
  const candidates = [
    ...new Set([configuredTempDir, ...defaultTempDirs].filter(Boolean).map((candidate) => path.resolve(candidate))),
  ];
  let lastError;

  for (const candidate of candidates) {
    try {
      return fs.mkdtempSync(path.join(candidate, "mra-"));
    } catch (error) {
      lastError = error;
    }
  }

  fail(
    `Unable to create a short release audit temporary directory: ${String(
      lastError?.message || lastError || "unknown error"
    )}. Set MOONSHINE_RUNTIME_AUDIT_TEMP_DIR to a short writable directory.`
  );
}

function relocateExtractedRuntime(appRoot) {
  const { runtimeRoot } = resolvePackagedPaths(appRoot);
  const condaUnpackExecutable = path.join(
    runtimeRoot,
    PACKAGED_RUNTIME_ENV_DIR,
    process.platform === "win32" ? "Scripts/conda-unpack.exe" : "bin/conda-unpack"
  );
  if (!fs.existsSync(condaUnpackExecutable)) {
    fail(`Extracted runtime is missing conda-unpack: ${condaUnpackExecutable}`);
  }
  runCapture(condaUnpackExecutable, []);
}

export function auditPackagedRuntimeZip({
  zipPath,
  runtimeFlavor,
  modelBundle,
  modelsDir,
  runFunctionalSmoke = true,
}) {
  if (!fs.existsSync(zipPath)) {
    fail(`Release ZIP does not exist: ${zipPath}`);
  }
  const extractionParent = createArchiveAuditTempDirectory();
  const extractionRoot = path.join(extractionParent, "x");
  try {
    extractZip(zipPath, extractionRoot);
    const appRoot = resolveAppRoot(extractionRoot);
    relocateExtractedRuntime(appRoot);
    return auditResolvedPackage({
      appRoot,
      runtimeFlavor,
      modelBundle,
      scope: "zip-clean-temp",
      modelsDir,
      runFunctionalSmoke,
    });
  } finally {
    fs.rmSync(extractionParent, { recursive: true, force: true });
  }
}
