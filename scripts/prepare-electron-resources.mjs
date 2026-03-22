import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  INTEGRITY_MANIFEST_FILE,
  INTEGRITY_RESOURCE_DIR,
  INTEGRITY_SIGNATURE_FILE,
  PACKAGED_BACKEND_PROJECT_DIR,
  PACKAGED_BACKEND_RESOURCE_DIR,
} from "../src-electron/integrity/public-key.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const sourceBackendRoot = path.join(repoRoot, "IOPaint");
const buildResourcesRoot = path.join(repoRoot, "build-resources");
const packagedBackendRoot = path.join(
  buildResourcesRoot,
  PACKAGED_BACKEND_RESOURCE_DIR,
  PACKAGED_BACKEND_PROJECT_DIR
);
const integrityRoot = path.join(buildResourcesRoot, INTEGRITY_RESOURCE_DIR);
const defaultPrivateKeyPath = path.join(
  repoRoot,
  "build-keys",
  "integrity-private.pem"
);
const excludedDirNames = new Set([".venv", "__pycache__", "tests"]);
const excludedFileNames = new Set(["requirements-dev.txt", "setup.py", ".gitignore"]);
const allowedRootFiles = new Set(["main.py", "requirements.txt"]);
const allowedRuntimeExtensions = new Set([".py", ".txt", ".yaml"]);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resetDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

function toPosixPath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function listFiles(rootDir) {
  const files = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentPath = queue.pop();
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      files.push(fullPath);
    }
  }

  return files.sort();
}

function shouldCopyBackendFile(relativePath) {
  const normalizedPath = toPosixPath(relativePath);
  const segments = normalizedPath.split("/");
  const fileName = segments.at(-1);

  if (segments.some((segment) => excludedDirNames.has(segment))) {
    return false;
  }

  if (excludedFileNames.has(fileName)) {
    return false;
  }

  if (segments.length === 1) {
    return allowedRootFiles.has(fileName);
  }

  if (segments[0] !== "iopaint") {
    return false;
  }

  return allowedRuntimeExtensions.has(path.extname(fileName).toLowerCase());
}

function copyPackagedBackend() {
  if (!fs.existsSync(sourceBackendRoot)) {
    throw new Error(`Backend source directory does not exist: ${sourceBackendRoot}`);
  }

  resetDir(packagedBackendRoot);

  for (const absolutePath of listFiles(sourceBackendRoot)) {
    const relativePath = path.relative(sourceBackendRoot, absolutePath);
    if (!shouldCopyBackendFile(relativePath)) {
      continue;
    }

    const destinationPath = path.join(packagedBackendRoot, relativePath);
    ensureDir(path.dirname(destinationPath));
    fs.copyFileSync(absolutePath, destinationPath);
  }
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function createManifestEntries() {
  return listFiles(packagedBackendRoot).map((absolutePath) => {
    const relativePath = path.relative(packagedBackendRoot, absolutePath);
    const manifestPath = toPosixPath(
      path.join(
        PACKAGED_BACKEND_RESOURCE_DIR,
        PACKAGED_BACKEND_PROJECT_DIR,
        relativePath
      )
    );
    const stats = fs.statSync(absolutePath);

    return {
      path: manifestPath,
      size: stats.size,
      sha256: sha256File(absolutePath),
    };
  });
}

function readPrivateKey() {
  const privateKeyPath =
    process.env.MOONSHINE_INTEGRITY_PRIVATE_KEY || defaultPrivateKeyPath;

  if (!fs.existsSync(privateKeyPath)) {
    throw new Error(
      `Missing integrity private key: ${privateKeyPath}. Run "node scripts/generate-integrity-keypair.mjs" first or set MOONSHINE_INTEGRITY_PRIVATE_KEY.`
    );
  }

  return fs.readFileSync(privateKeyPath, "utf8");
}

export function prepareElectronResources() {
  copyPackagedBackend();
  resetDir(integrityRoot);

  const manifest = {
    schemaVersion: 1,
    appVersion: process.env.npm_package_version || "0.0.1",
    generatedAt: new Date().toISOString(),
    hashAlgorithm: "sha256",
    entries: createManifestEntries(),
  };
  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const signature = crypto
    .sign(null, manifestBuffer, readPrivateKey())
    .toString("base64");

  ensureDir(integrityRoot);
  fs.writeFileSync(path.join(integrityRoot, INTEGRITY_MANIFEST_FILE), manifestBuffer);
  fs.writeFileSync(path.join(integrityRoot, INTEGRITY_SIGNATURE_FILE), `${signature}\n`);

  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const manifest = prepareElectronResources();
  console.log(
    `Prepared ${manifest.entries.length} protected runtime files in ${buildResourcesRoot}`
  );
}
