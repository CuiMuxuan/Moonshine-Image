#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { path7za } from "7zip-bin";

import { signManifestPayload } from "./release/manifest-signing.mjs";
import { canonicalizeJson } from "../src-electron/runtime/manifest-verifier.js";
import {
  BUNDLED_FFMPEG_SPEC_HASH,
  buildEnvironmentSpec,
} from "../src-electron/runtime/environment-spec.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VARIANTS = new Set(["cpu", "cu130"]);
const EXCLUDED_DIRS = new Set([".git", "__pycache__", ".pytest_cache", "node_modules"]);
const EXCLUDED_FILES = new Set([".DS_Store"]);

// Keep complete ZIPs useful for offline first-run without copying every
// optional checkpoint present in a developer model directory. SAM3 remains
// app-managed and is intentionally excluded from offline release payloads.
export const DEFAULT_OFFLINE_MODEL_PATHS = Object.freeze([
  "big-lama.pt",
  "slbr.pth.tar",
  "mat/Places_512_FullData_G.pth",
  "sam/sam_vit_b_01ec64.pth",
  "sam2/sam2.1_hiera_large.pt",
  "ocr/PP-OCRv6_det_small.onnx",
  "ocr/PP-OCRv6_rec_small.onnx",
  "ocr/ch_ppocr_mobile_v2.0_cls_mobile.onnx",
  "ocr/manifest.json",
]);

function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function normalizeVersion(value) {
  const normalized = requiredText(value, "version").replace(/^v/i, "");
  if (!VERSION_PATTERN.test(normalized)) throw new Error(`Invalid version: ${normalized}`);
  return normalized;
}

function normalizeVariant(value) {
  const normalized = requiredText(value, "variant").toLowerCase();
  if (!VARIANTS.has(normalized)) throw new Error(`Unsupported offline bundle variant: ${normalized}`);
  return normalized;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const separator = token.indexOf("=");
    const name = separator >= 0 ? token.slice(2, separator) : token.slice(2);
    const inlineValue = separator >= 0 ? token.slice(separator + 1) : undefined;
    if (!name) throw new Error("Option name is empty");
    if (Object.hasOwn(values, name)) throw new Error(`Option repeated: ${name}`);
    if (inlineValue !== undefined) {
      values[name] = inlineValue;
      continue;
    }
    if (name === "allow-unsigned" || name === "allow-missing-models" || name === "dry-run" || name === "keep-staging" || name === "help") {
      values[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    values[name] = value;
    index += 1;
  }
  return values;
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, "/");
}

function assertSafeRelativePath(relativePath, label = "path") {
  const normalized = toPosixPath(relativePath);
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a safe relative path: ${relativePath}`);
  }
  return normalized;
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function listFiles(rootDir) {
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root)) throw new Error(`Payload source directory does not exist: ${root}`);
  const files = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Payload source must not contain symlinks: ${absolute}`);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) queue.push(absolute);
        continue;
      }
      if (entry.isFile() && !EXCLUDED_FILES.has(entry.name)) files.push(absolute);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function hashFileStreaming(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  let size = 0;
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({ size, sha256: hash.digest("hex") }));
  });
}

function copyDirectoryContents(sourceRoot, destinationRoot) {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  const files = listFiles(source);
  if (files.length === 0) throw new Error(`Payload source directory is empty: ${source}`);
  for (const filePath of files) {
    const relativePath = assertSafeRelativePath(path.relative(source, filePath), "payload file");
    const destinationPath = path.join(destination, ...relativePath.split("/"));
    ensureDirectory(path.dirname(destinationPath));
    fs.copyFileSync(filePath, destinationPath);
  }
  return files.length;
}

function copySelectedModelFiles(sourceRoot, destinationRoot, relativePaths = DEFAULT_OFFLINE_MODEL_PATHS) {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  if (!fs.existsSync(source)) throw new Error(`Model source directory does not exist: ${source}`);
  const selected = [];
  const missing = [];
  for (const relative of relativePaths) {
    const safeRelative = assertSafeRelativePath(relative, "offline model path");
    const sourcePath = path.resolve(source, ...safeRelative.split("/"));
    const relativeSource = path.relative(source, sourcePath);
    if (relativeSource === ".." || relativeSource.startsWith(`..${path.sep}`) || path.isAbsolute(relativeSource)) {
      throw new Error(`Offline model path escapes source root: ${relative}`);
    }
    if (!fs.existsSync(sourcePath)) {
      missing.push(safeRelative);
      continue;
    }
    const stat = fs.lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Offline model path must be a regular file: ${relative}`);
    }
    const destinationPath = path.join(destination, ...safeRelative.split("/"));
    ensureDirectory(path.dirname(destinationPath));
    fs.copyFileSync(sourcePath, destinationPath);
    selected.push(safeRelative);
  }
  return { requested: [...relativePaths], included: selected, missing };
}

function collectPayloadFiles(payloadRoot) {
  const files = [];
  for (const filePath of listFiles(payloadRoot)) {
    const relativePath = assertSafeRelativePath(path.relative(payloadRoot, filePath), "payload file");
    files.push({ absolutePath: filePath, relativePath });
  }
  return files;
}

async function createPayloadManifest({
  payloadRoot,
  version,
  variant,
  publishedAt = new Date().toISOString(),
  environmentSpec,
}) {
  const entries = [];
  for (const { absolutePath, relativePath } of collectPayloadFiles(payloadRoot)) {
    if (relativePath === "payload-manifest.json") continue;
    const digest = await hashFileStreaming(absolutePath);
    entries.push({ path: relativePath, size: digest.size, sha256: digest.sha256 });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: 1,
    kind: "moonshine-offline-payload",
    appVersion: version,
    platform: "win32",
    arch: "x64",
    variant,
    generatedAt: publishedAt,
    hashAlgorithm: "sha256",
    files: entries,
    totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
    ...(environmentSpec
      ? {
        pythonVersion: environmentSpec.pythonVersion,
        requirementsLockHash: environmentSpec.requirementsLockHash,
        ffmpegHash: environmentSpec.ffmpegHash,
        environmentSpec,
        specHash: environmentSpec.specHash,
      }
      : {}),
  };
}

async function resolveOfflineEnvironmentSpec({ version, variant, runtimeRoot }) {
  if (!runtimeRoot) return null;
  const requirementsPath = path.join(repoRoot, "server", `requirements-${variant}.lock.txt`);
  if (!fs.existsSync(requirementsPath)) return null;
  let runtimeManifest = {};
  const runtimeManifestPath = path.join(runtimeRoot, "runtime-manifest.json");
  if (fs.existsSync(runtimeManifestPath)) {
    try {
      runtimeManifest = JSON.parse(fs.readFileSync(runtimeManifestPath, "utf8"));
    } catch {
      runtimeManifest = {};
    }
  }
  const requirementsDigest = await hashFileStreaming(requirementsPath);
  return buildEnvironmentSpec({
    appVersion: version,
    pythonVersion: runtimeManifest.pythonVersion || "3.12.10",
    accelerator: variant,
    requirementsLockHash: requirementsDigest.sha256,
    ffmpegHash: BUNDLED_FFMPEG_SPEC_HASH,
  });
}

function signPayloadManifest(payload, { privateKeyPem, keyId = "moonshine-app-manifest-v1" } = {}) {
  if (!privateKeyPem) return { payload, signature: null };
  return signManifestPayload(payload, { privateKey: privateKeyPem, keyId });
}

// The runtime bootstrap reads the payload metadata from the manifest root. Keep
// the signature alongside that metadata while signing only the canonical
// payload, so the signature does not become self-referential.
function serializePayloadManifest(signed) {
  if (!signed || typeof signed !== "object") throw new Error("Signed payload manifest must be an object");
  const payload = signed.payload && typeof signed.payload === "object" ? signed.payload : signed;
  return {
    ...payload,
    signature: signed.signature ?? null,
  };
}

function resolvePrivateKey({ privateKeyFile, allowUnsigned }) {
  const keyPath = String(privateKeyFile || process.env.MOONSHINE_MANIFEST_PRIVATE_KEY_FILE || "").trim();
  const keyPem = process.env.MOONSHINE_MANIFEST_PRIVATE_KEY_PEM ||
    (keyPath ? fs.readFileSync(path.resolve(keyPath), "utf8") : "");
  if (!keyPem && !allowUnsigned) {
    throw new Error("Offline bundle payload manifest requires MOONSHINE_MANIFEST_PRIVATE_KEY_PEM or --private-key-file (use --allow-unsigned only for local diagnostics)");
  }
  return keyPem;
}

function resolveSevenZip(customPath) {
  const candidates = [customPath, process.env.MOONSHINE_7ZA, path7za]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));
  const selected = candidates.find((candidate) => fs.existsSync(candidate));
  if (!selected) throw new Error(`7-Zip executable not found. Checked: ${candidates.join(", ")}`);
  return selected;
}

function runSevenZip(archivePath, sourceRoot, sevenZipPath) {
  const result = spawnSync(sevenZipPath, ["a", "-tzip", "-mx=5", archivePath, path.basename(sourceRoot)], {
    cwd: path.dirname(sourceRoot),
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw new Error(`7-Zip failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`7-Zip archive creation failed with exit code ${result.status}`);
  const verification = spawnSync(sevenZipPath, ["t", archivePath], { stdio: "inherit", shell: false });
  if (verification.error) throw new Error(`7-Zip verification failed to start: ${verification.error.message}`);
  if (verification.status !== 0) throw new Error(`7-Zip archive verification failed with exit code ${verification.status}`);
}

export async function inspectOfflineBundle({
  zipPath,
  expectedVersion,
  expectedVariant,
  publicKeyPem,
  sevenZipPath,
} = {}) {
  const archive = path.resolve(requiredText(zipPath, "zipPath"));
  if (!fs.existsSync(archive)) throw new Error(`Offline bundle does not exist: ${archive}`);
  const extractionParent = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-offline-verify-"));
  try {
    const output = spawnSync(resolveSevenZip(sevenZipPath), ["x", "-y", archive, `-o${extractionParent}`], {
      stdio: "ignore",
      shell: false,
    });
    if (output.error) throw new Error(`7-Zip extraction failed to start: ${output.error.message}`);
    if (output.status !== 0) throw new Error(`7-Zip extraction failed with exit code ${output.status}`);
    const packageDirs = fs.readdirSync(extractionParent, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const packageRoot = packageDirs.length === 1 ? path.join(extractionParent, packageDirs[0].name) : extractionParent;
    const manifestPath = path.join(packageRoot, "offline-payload", "payload-manifest.json");
    if (!fs.existsSync(manifestPath)) throw new Error("Offline bundle is missing offline-payload/payload-manifest.json");
    const signed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const payload = signed?.payload?.kind === "moonshine-offline-payload"
      ? signed.payload
      : (() => {
        const rootPayload = { ...(signed || {}) };
        delete rootPayload.signature;
        return rootPayload;
      })();
    if (!payload || payload.kind !== "moonshine-offline-payload") throw new Error("Offline payload manifest kind is invalid");
    if (expectedVersion && payload.appVersion !== normalizeVersion(expectedVersion)) throw new Error("Offline payload version mismatch");
    if (expectedVariant && payload.variant !== normalizeVariant(expectedVariant)) throw new Error("Offline payload variant mismatch");
    if (publicKeyPem && !signed.signature?.value) {
      throw new Error("Offline payload manifest is unsigned");
    }
    if (publicKeyPem && signed.signature?.value) {
      const valid = crypto.verify(
        null,
        canonicalizeJson(payload),
        publicKeyPem,
        Buffer.from(signed.signature.value, "base64"),
      );
      if (!valid) throw new Error("Offline payload manifest signature verification failed");
    }
    const verifiedFiles = [];
    for (const entry of payload.files || []) {
      const relativePath = assertSafeRelativePath(entry.path, "payload manifest path");
      const target = path.resolve(packageRoot, "offline-payload", ...relativePath.split("/"));
      const payloadRoot = path.resolve(packageRoot, "offline-payload");
      const relativeTarget = path.relative(payloadRoot, target);
      if (relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) throw new Error(`Payload manifest path escapes payload root: ${entry.path}`);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`Offline payload file is missing: ${entry.path}`);
      const digest = await hashFileStreaming(target);
      if (digest.size !== entry.size || digest.sha256 !== String(entry.sha256).toLowerCase()) throw new Error(`Offline payload hash mismatch: ${entry.path}`);
      verifiedFiles.push(entry.path);
    }
    return {
      status: "pass",
      variant: payload.variant,
      version: payload.appVersion,
      files: verifiedFiles.length,
      totalBytes: payload.totalBytes,
      signed: Boolean(signed.signature?.value),
    };
  } finally {
    fs.rmSync(extractionParent, { recursive: true, force: true });
  }
}

export async function buildOfflineBundle({
  version = packageJson.version,
  variant,
  installerPath,
  payloadRoot,
  runtimeRoot,
  modelsRoot,
  outputDir = path.join(repoRoot, "dist", "releases", `v${version}`),
  privateKeyPem,
  privateKeyFile,
  keyId,
  sevenZipPath,
  allowUnsigned = false,
  allowMissingModels = false,
  dryRun = false,
  keepStaging = false,
} = {}) {
  const normalizedVersion = normalizeVersion(version);
  const normalizedVariant = normalizeVariant(variant);
  const installer = path.resolve(requiredText(installerPath, "installerPath"));
  if (!fs.existsSync(installer) || !fs.statSync(installer).isFile()) throw new Error(`Installer does not exist: ${installer}`);

  const destination = path.resolve(outputDir);
  ensureDirectory(destination);
  const packageName = `Moonshine-Image-v${normalizedVersion}-win-x64-${normalizedVariant}-offline`;
  const archivePath = path.join(destination, `${packageName}.zip`);
  const stagingParent = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-offline-"));
  const stagingRoot = path.join(stagingParent, packageName);
  const offlinePayloadRoot = path.join(stagingRoot, "offline-payload");
  ensureDirectory(offlinePayloadRoot);

  try {
    let modelSelection = null;
    fs.copyFileSync(installer, path.join(stagingRoot, path.basename(installer)));
    const sourcePayloadRoot = payloadRoot ? path.resolve(payloadRoot) : null;
    const resolvedRuntimeRoot = runtimeRoot
      ? path.resolve(runtimeRoot)
      : sourcePayloadRoot
        ? path.join(sourcePayloadRoot, "runtime")
        : null;
    if (!resolvedRuntimeRoot) throw new Error("runtimeRoot or payloadRoot is required");
    copyDirectoryContents(resolvedRuntimeRoot, path.join(offlinePayloadRoot, "runtime"));

    const payloadModelsRoot = sourcePayloadRoot ? path.join(sourcePayloadRoot, "models") : null;
    const resolvedModelsRoot = modelsRoot
      ? path.resolve(modelsRoot)
      : payloadModelsRoot && fs.existsSync(payloadModelsRoot)
        ? payloadModelsRoot
        : null;
    if (resolvedModelsRoot) {
      modelSelection = copySelectedModelFiles(resolvedModelsRoot, path.join(offlinePayloadRoot, "models"));
      if (!allowMissingModels && modelSelection.missing.length > 0) {
        throw new Error(`Offline model source is missing required default weights: ${modelSelection.missing.join(", ")}`);
      }
    }

    const environmentSpec = await resolveOfflineEnvironmentSpec({
      version: normalizedVersion,
      variant: normalizedVariant,
      runtimeRoot: resolvedRuntimeRoot,
    });
    const payload = await createPayloadManifest({
      payloadRoot: offlinePayloadRoot,
      version: normalizedVersion,
      variant: normalizedVariant,
      environmentSpec,
    });
    if (!payload.files.some(({ path: relative }) => relative.startsWith("runtime/"))) {
      throw new Error("Offline payload must contain runtime/ files");
    }
    const keyPem = privateKeyPem || resolvePrivateKey({ privateKeyFile, allowUnsigned });
    const signed = signPayloadManifest(payload, { privateKeyPem: keyPem, keyId });
    const manifestPath = path.join(offlinePayloadRoot, "payload-manifest.json");
    const manifestDocument = serializePayloadManifest(signed);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifestDocument, null, 2)}\n`);
    const manifestDigest = await hashFileStreaming(manifestPath);

    const report = {
      schemaVersion: 1,
      version: normalizedVersion,
      variant: normalizedVariant,
      packageKind: "full-offline",
      archivePath,
      installer: {
        name: path.basename(installer),
        size: fs.statSync(installer).size,
        sha256: (await hashFileStreaming(installer)).sha256,
      },
      payload: {
        root: "offline-payload",
        files: payload.files.length,
        totalBytes: payload.totalBytes,
        manifestSha256: manifestDigest.sha256,
        signed: Boolean(manifestDocument.signature?.value),
      },
      models: modelSelection,
      sources: {
        runtime: resolvedRuntimeRoot,
        ffmpeg: "bundled-in-installer",
        models: resolvedModelsRoot,
      },
    };
    const reportPath = path.join(destination, `${packageName}.json`);
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    if (!dryRun) {
      // 7-Zip updates an existing archive in place. Remove a same-named
      // previous candidate so excluded model files can never survive a rebuild.
      fs.rmSync(archivePath, { force: true });
      runSevenZip(archivePath, stagingRoot, resolveSevenZip(sevenZipPath));
      report.archive = {
        size: fs.statSync(archivePath).size,
        sha256: (await hashFileStreaming(archivePath)).sha256,
      };
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    return { ...report, reportPath, stagingRoot: keepStaging ? stagingRoot : undefined };
  } finally {
    if (!keepStaging) fs.rmSync(stagingParent, { recursive: true, force: true });
  }
}

function usage() {
  return `Usage: node scripts/build-offline-bundle-win.mjs --variant <cpu|cu130> --installer <path> [options]\n\nOptions:\n  --version <version>            App version (default: package.json)\n  --payload-root <path>          Existing offline-payload directory\n  --runtime-root <path>          Prepared runtime directory\n  --models-root <path>           Model directory (optional)\n  --allow-missing-models         Diagnostic mode only; permit an incomplete default model set\n  --output-dir <path>             Output directory\n  --private-key-file <path>       Ed25519 key for payload-manifest.json\n  --allow-unsigned                Local diagnostic mode only\n  --dry-run                       Assemble and report without creating ZIP\n  --keep-staging                  Keep temporary assembly directory\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(usage());
    } else {
      const result = await buildOfflineBundle({
        version: args.version,
        variant: args.variant,
        installerPath: args.installer,
        payloadRoot: args["payload-root"],
        runtimeRoot: args["runtime-root"],
        modelsRoot: args["models-root"],
        outputDir: args["output-dir"],
        privateKeyFile: args["private-key-file"],
        keyId: args["key-id"],
        allowUnsigned: Boolean(args["allow-unsigned"]),
        allowMissingModels: Boolean(args["allow-missing-models"]),
        dryRun: Boolean(args["dry-run"]),
        keepStaging: Boolean(args["keep-staging"]),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch (error) {
    process.stderr.write(`Offline bundle build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

export { createPayloadManifest, normalizeVariant, normalizeVersion, parseArgs, serializePayloadManifest };
