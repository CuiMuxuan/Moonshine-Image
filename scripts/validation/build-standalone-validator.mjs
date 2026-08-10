#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { path7za } from "7zip-bin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CHANNELS = new Set(["test", "beta", "stable"]);

function normalizeVersion(value) {
  const version = String(value ?? "").trim().replace(/^v/i, "");
  if (!VERSION_PATTERN.test(version)) throw new Error(`Invalid app version: ${version}`);
  return version;
}

function normalizeChannel(value) {
  const channel = String(value ?? "test").trim().toLowerCase();
  if (!CHANNELS.has(channel)) throw new Error(`Unsupported channel: ${channel}`);
  return channel;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const separator = token.indexOf("=");
    const name = separator >= 0 ? token.slice(2, separator) : token.slice(2);
    const inline = separator >= 0 ? token.slice(separator + 1) : undefined;
    if (!name || Object.hasOwn(values, name)) throw new Error(`Invalid or repeated option: ${token}`);
    if (inline !== undefined) {
      values[name] = inline;
      continue;
    }
    if (["no-archive", "help"].includes(name)) {
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

function requiredPath(value, label) {
  const resolved = path.resolve(String(value ?? "").trim());
  if (!value || !fs.existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  return resolved;
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function copyFile(source, destination) {
  ensureDirectory(path.dirname(destination));
  fs.copyFileSync(source, destination);
}

function copyDirectory(source, destination) {
  ensureDirectory(destination);
  fs.cpSync(source, destination, { recursive: true, force: true });
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function listFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function writeText(filePath, value) {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${value.replace(/\r?\n/g, "\r\n")}\r\n`, "utf8");
}

function createManifest(packageRoot, { version, channel, publicKeyPath, nodePath }) {
  const files = listFiles(packageRoot).map((absolute) => ({
    path: path.relative(packageRoot, absolute).replace(/\\/g, "/"),
    bytes: fs.statSync(absolute).size,
    sha256: sha256(absolute),
  }));
  const publicKeyFingerprint = crypto
    .createHash("sha256")
    .update(crypto.createPublicKey(fs.readFileSync(publicKeyPath)).export({ type: "spki", format: "der" }))
    .digest("hex");
  return {
    schemaVersion: 1,
    product: "Moonshine-Image",
    appVersion: version,
    channel,
    createdAt: new Date().toISOString(),
    nodeVersion: process.version,
    bundledNodeBytes: fs.statSync(nodePath).size,
    publicKeyFingerprint,
    files,
  };
}

function archiveDirectory({ archivePath, outputRoot, packageName }) {
  const result = spawnSync(path7za, ["a", "-tzip", "-mx=9", archivePath, packageName], {
    cwd: outputRoot,
    stdio: "ignore",
    shell: false,
  });
  if (result.error) throw new Error(`7-Zip failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`7-Zip archive creation failed with exit code ${result.status}`);
  const verify = spawnSync(path7za, ["t", archivePath], { stdio: "ignore", shell: false });
  if (verify.error) throw new Error(`7-Zip verification failed to start: ${verify.error.message}`);
  if (verify.status !== 0) throw new Error(`7-Zip archive verification failed with exit code ${verify.status}`);
}

const COPY_MAP = Object.freeze([
  ["scripts/validation/standalone/Run-Moonshine-Image-Test-Validator.cmd", "Run-Moonshine-Image-Test-Validator.cmd"],
  ["scripts/validation/standalone/Run-Moonshine-Image-Test-Validator.ps1", "Run-Moonshine-Image-Test-Validator.ps1"],
  ["scripts/validation/standalone/README.txt", "README.txt"],
  ["scripts/validation/run-release-validation.mjs", "scripts/validation/run-release-validation.mjs"],
  ["scripts/validation/release-validation-lib.mjs", "scripts/validation/release-validation-lib.mjs"],
  ["scripts/validation/standalone/app-release-cli-shim.mjs", "scripts/release/app-release-lib.mjs"],
  ["scripts/build-offline-bundle-win.mjs", "scripts/build-offline-bundle-win.mjs"],
  ["scripts/release/manifest-signing.mjs", "scripts/release/manifest-signing.mjs"],
  ["src-electron/runtime/manifest-verifier.js", "src-electron/runtime/manifest-verifier.js"],
  ["src-electron/runtime/environment-spec.js", "src-electron/runtime/environment-spec.js"],
]);

export function buildStandaloneValidator({
  version = "1.3.0",
  channel = "test",
  source = "https://download.moonshine.email",
  publicKeyFile,
  nodeExe = process.execPath,
  outputDir = path.join(repoRoot, "dist", "validation"),
  archive = true,
  packageName,
} = {}) {
  const normalizedVersion = normalizeVersion(version);
  const normalizedChannel = normalizeChannel(channel);
  const normalizedSource = String(source ?? "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(normalizedSource)) throw new Error("source must be an HTTPS URL");
  const publicKeyPath = requiredPath(publicKeyFile, "publicKeyFile");
  const nodePath = requiredPath(nodeExe, "nodeExe");
  const outputRoot = path.resolve(outputDir);
  const name = packageName || `Moonshine-Image-v${normalizedVersion}-win-x64-${normalizedChannel}-validator`;
  const packageRoot = path.join(outputRoot, name);
  const archivePath = path.join(outputRoot, `${name}.zip`);
  ensureDirectory(outputRoot);
  fs.rmSync(packageRoot, { recursive: true, force: true });
  if (archive) fs.rmSync(archivePath, { force: true });
  ensureDirectory(packageRoot);

  for (const [sourceRelative, targetRelative] of COPY_MAP) {
    copyFile(path.join(repoRoot, sourceRelative), path.join(packageRoot, targetRelative));
  }
  copyFile(nodePath, path.join(packageRoot, "node.exe"));
  copyFile(publicKeyPath, path.join(packageRoot, "release-public-key.pem"));
  copyDirectory(path.join(repoRoot, "node_modules", "yaml"), path.join(packageRoot, "node_modules", "yaml"));
  copyDirectory(path.join(repoRoot, "node_modules", "7zip-bin"), path.join(packageRoot, "node_modules", "7zip-bin"));

  writeText(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "moonshine-image-standalone-validator",
    version: normalizedVersion,
    private: true,
    type: "module",
  }, null, 2));
  writeText(path.join(packageRoot, "validator-config.json"), JSON.stringify({
    schemaVersion: 1,
    product: "Moonshine-Image",
    source: normalizedSource,
    channel: normalizedChannel,
    appVersion: normalizedVersion,
  }, null, 2));
  writeText(path.join(packageRoot, "THIRD-PARTY-NOTICES.txt"), [
    "Moonshine-Image standalone validation package",
    "",
    `Bundled Node.js runtime: ${process.version}. Node.js is distributed under the MIT license; see https://github.com/nodejs/node/blob/main/LICENSE for the license text.`,
    "The Node.js runtime is included only to avoid requiring a separate installation.",
    "",
    "yaml package: MIT license. See node_modules/yaml/LICENSE.",
    "7zip-bin package and 7za.exe: LGPL-2.1-or-later / 7-Zip license terms. See node_modules/7zip-bin/LICENSE.txt and node_modules/7zip-bin/README.md.",
    "",
    "This package contains no R2 credentials, private key, user images, or model files.",
  ].join("\n"));

  const manifestPath = path.join(packageRoot, "validator-manifest.json");
  const manifest = createManifest(packageRoot, {
    version: normalizedVersion,
    channel: normalizedChannel,
    publicKeyPath: path.join(packageRoot, "release-public-key.pem"),
    nodePath: path.join(packageRoot, "node.exe"),
  });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  if (archive) archiveDirectory({ archivePath, outputRoot, packageName: name });
  const result = {
    packageRoot,
    archivePath: archive ? archivePath : null,
    archiveBytes: archive ? fs.statSync(archivePath).size : null,
    archiveSha256: archive ? sha256(archivePath) : null,
    manifestPath,
    manifest,
  };
  fs.writeFileSync(path.join(outputRoot, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function printUsage() {
  process.stdout.write(`Usage: node scripts/validation/build-standalone-validator.mjs [options]\n\nOptions:\n  --version <version>          expected app version (default: 1.3.0)\n  --channel <test|beta|stable> validation channel (default: test)\n  --source <https-url>         public feed base URL\n  --public-key-file <path>     Ed25519 public key PEM (required)\n  --node-exe <path>            Node executable to bundle (default: current Node)\n  --output-dir <path>          output directory (default: dist/validation)\n  --no-archive                 keep the unpacked folder only\n  --help                       show this help\n`);
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printUsage();
      process.exit(0);
    }
    const result = buildStandaloneValidator({
      version: args.version,
      channel: args.channel,
      source: args.source,
      publicKeyFile: args["public-key-file"],
      nodeExe: args["node-exe"],
      outputDir: args["output-dir"],
      archive: !args["no-archive"],
    });
    process.stdout.write(`${JSON.stringify({
      packageRoot: result.packageRoot,
      archivePath: result.archivePath,
      archiveBytes: result.archiveBytes,
      archiveSha256: result.archiveSha256,
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
