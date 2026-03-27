import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  INTEGRITY_MANIFEST_FILE,
  INTEGRITY_RESOURCE_DIR,
  INTEGRITY_SIGNATURE_FILE,
  PACKAGED_MODELS_RESOURCE_DIR,
  PACKAGED_RUNTIME_METADATA_FILE,
  PACKAGED_RUNTIME_RESOURCE_DIR,
  PACKAGED_RUNTIME_TARGET_DIR,
} from "../src-electron/integrity/public-key.js";
import { buildPackagedWindowsRuntime } from "./build-runtime-win.mjs";
import { materializePackagedBackend } from "./materialize-iopaint-backend.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const sourceModelsRoot = path.join(repoRoot, "models");
const buildResourcesRoot = path.join(repoRoot, "build-resources");
const packagedModelsRoot = path.join(buildResourcesRoot, PACKAGED_MODELS_RESOURCE_DIR);
const integrityRoot = path.join(buildResourcesRoot, INTEGRITY_RESOURCE_DIR);
const defaultPrivateKeyPath = path.join(
  repoRoot,
  "build-keys",
  "integrity-private.pem"
);

const excludedDirNames = new Set(["__pycache__"]);
const protectedResourceDirs = [
  {
    rootDir: path.join(buildResourcesRoot, "backend"),
    resourcePrefix: "backend",
  },
  {
    rootDir: packagedModelsRoot,
    resourcePrefix: PACKAGED_MODELS_RESOURCE_DIR,
  },
];
const protectedResourceFiles = [
  {
    absolutePath: path.join(
      buildResourcesRoot,
      PACKAGED_RUNTIME_RESOURCE_DIR,
      PACKAGED_RUNTIME_TARGET_DIR,
      PACKAGED_RUNTIME_METADATA_FILE
    ),
    manifestPath: [
      PACKAGED_RUNTIME_RESOURCE_DIR,
      PACKAGED_RUNTIME_TARGET_DIR,
      PACKAGED_RUNTIME_METADATA_FILE,
    ].join("/"),
  },
];

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
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentPath = queue.pop();
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (excludedDirNames.has(entry.name)) {
          continue;
        }
        queue.push(fullPath);
        continue;
      }
      files.push(fullPath);
    }
  }

  return files.sort();
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function copyPackagedModels() {
  resetDir(packagedModelsRoot);
  if (!fs.existsSync(sourceModelsRoot)) {
    throw new Error(`Models source directory does not exist: ${sourceModelsRoot}`);
  }

  for (const absolutePath of listFiles(sourceModelsRoot)) {
    const relativePath = path.relative(sourceModelsRoot, absolutePath);
    const destinationPath = path.join(packagedModelsRoot, relativePath);
    ensureDir(path.dirname(destinationPath));
    fs.copyFileSync(absolutePath, destinationPath);
  }
}

function createManifestEntries() {
  const entries = [];

  for (const resourceDir of protectedResourceDirs) {
    for (const absolutePath of listFiles(resourceDir.rootDir)) {
      const relativePath = path.relative(resourceDir.rootDir, absolutePath);
      const manifestPath = toPosixPath(path.join(resourceDir.resourcePrefix, relativePath));
      const stats = fs.statSync(absolutePath);

      entries.push({
        path: manifestPath,
        size: stats.size,
        sha256: sha256File(absolutePath),
      });
    }
  }

  for (const protectedFile of protectedResourceFiles) {
    if (!fs.existsSync(protectedFile.absolutePath)) {
      throw new Error(`Protected resource file does not exist: ${protectedFile.absolutePath}`);
    }

    const stats = fs.statSync(protectedFile.absolutePath);
    entries.push({
      path: protectedFile.manifestPath,
      size: stats.size,
      sha256: sha256File(protectedFile.absolutePath),
    });
  }

  return entries.sort((a, b) => a.path.localeCompare(b.path));
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
  materializePackagedBackend();
  buildPackagedWindowsRuntime({ allowFallback: true });
  copyPackagedModels();
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
