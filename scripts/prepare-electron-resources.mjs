import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  INTEGRITY_MANIFEST_FILE,
  INTEGRITY_RESOURCE_DIR,
  INTEGRITY_SIGNATURE_FILE,
  PACKAGED_FFMPEG_RESOURCE_DIR,
  PACKAGED_FFMPEG_TARGET_DIR,
  PACKAGED_MODELS_RESOURCE_DIR,
  PACKAGED_RUNTIME_METADATA_FILE,
  PACKAGED_RUNTIME_RESOURCE_DIR,
  PACKAGED_RUNTIME_TARGET_DIR,
} from "../src-electron/integrity/public-key.js";
import { prepareBackendResources } from "./prepare-backend-resources.mjs";
import { buildPackagedWindowsRuntime } from "./build-runtime-win.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const sourceModelsRoot = path.join(repoRoot, "models");
const buildResourcesRoot = path.join(repoRoot, "build-resources");
const packagedModelsRoot = path.join(buildResourcesRoot, PACKAGED_MODELS_RESOURCE_DIR);
const modelBundle = normalizeModelBundle(process.env.MOONSHINE_MODEL_BUNDLE);
const packagedFfmpegRoot = path.join(
  buildResourcesRoot,
  PACKAGED_FFMPEG_RESOURCE_DIR,
  PACKAGED_FFMPEG_TARGET_DIR
);
const integrityRoot = path.join(buildResourcesRoot, INTEGRITY_RESOURCE_DIR);
const defaultPrivateKeyPath = path.join(
  repoRoot,
  "build-keys",
  "integrity-private.pem"
);

const excludedDirNames = new Set(["__pycache__"]);
const excludedFileNames = new Set([".DS_Store"]);
const protectedResourceDirs = [
  {
    rootDir: path.join(buildResourcesRoot, "backend"),
    resourcePrefix: "backend",
  },
  {
    rootDir: packagedModelsRoot,
    resourcePrefix: PACKAGED_MODELS_RESOURCE_DIR,
  },
  {
    rootDir: path.join(buildResourcesRoot, PACKAGED_FFMPEG_RESOURCE_DIR),
    resourcePrefix: PACKAGED_FFMPEG_RESOURCE_DIR,
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
const bundledModelFileNames = new Set(["big-lama.pt", "slbr.pth.tar"]);

function normalizeModelBundle(value) {
  const normalized = String(value || "bundled-models").trim().toLowerCase();
  const aliases = {
    external: "external-models",
    "external-models": "external-models",
    bundled: "bundled-models",
    "bundled-models": "bundled-models",
  };
  const result = aliases[normalized];
  if (!result) {
    throw new Error(
      `Unsupported MOONSHINE_MODEL_BUNDLE: ${value}. Expected external-models or bundled-models.`
    );
  }
  return result;
}

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

function listFiles(rootDir, ignoredDirNames = excludedDirNames) {
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
        if (ignoredDirNames.has(entry.name)) {
          continue;
        }
        queue.push(fullPath);
        continue;
      }
      if (excludedFileNames.has(entry.name) || entry.name.endsWith(".pyc") || entry.name.endsWith(".pyo")) {
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
  if (modelBundle === "external-models") {
    return;
  }

  if (!fs.existsSync(sourceModelsRoot)) {
    throw new Error(`Models source directory does not exist: ${sourceModelsRoot}`);
  }

  for (const absolutePath of listFiles(sourceModelsRoot)) {
    const relativePath = path.relative(sourceModelsRoot, absolutePath);
    if (!bundledModelFileNames.has(relativePath.replace(/\\/g, "/"))) {
      continue;
    }
    const destinationPath = path.join(packagedModelsRoot, relativePath);
    ensureDir(path.dirname(destinationPath));
    fs.copyFileSync(absolutePath, destinationPath);
  }
}

function resolveFfmpegSourceRoot() {
  const candidateRoots = [
    process.env.MOONSHINE_FFMPEG_ROOT,
    "C:\\code\\ffmpeg",
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const candidateRoot of candidateRoots) {
    if (
      fs.existsSync(path.join(candidateRoot, "ffmpeg.exe")) &&
      fs.existsSync(path.join(candidateRoot, "ffprobe.exe"))
    ) {
      return path.dirname(candidateRoot);
    }

    const binRoot = path.join(candidateRoot, "bin");
    if (
      fs.existsSync(path.join(binRoot, "ffmpeg.exe")) &&
      fs.existsSync(path.join(binRoot, "ffprobe.exe"))
    ) {
      return candidateRoot;
    }
  }

  throw new Error(
    "Missing FFmpeg runtime. Set MOONSHINE_FFMPEG_ROOT or place FFmpeg at C:\\code\\ffmpeg."
  );
}

function copyOptionalFile(sourcePath, destinationPath) {
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    return false;
  }

  ensureDir(path.dirname(destinationPath));
  fs.copyFileSync(sourcePath, destinationPath);
  return true;
}

function copyPackagedFfmpegRuntime() {
  const sourceRoot = resolveFfmpegSourceRoot();
  const sourceBinRoot = path.join(sourceRoot, "bin");
  resetDir(packagedFfmpegRoot);

  const copiedRequired = [
    copyOptionalFile(
      path.join(sourceBinRoot, "ffmpeg.exe"),
      path.join(packagedFfmpegRoot, "ffmpeg.exe")
    ),
    copyOptionalFile(
      path.join(sourceBinRoot, "ffprobe.exe"),
      path.join(packagedFfmpegRoot, "ffprobe.exe")
    ),
  ];

  if (copiedRequired.some((copied) => !copied)) {
    throw new Error(`FFmpeg runtime is incomplete: ${sourceBinRoot}`);
  }

  for (const absolutePath of listFiles(sourceBinRoot)) {
    const lowerName = path.basename(absolutePath).toLowerCase();
    if (!lowerName.endsWith(".dll")) {
      continue;
    }

    copyOptionalFile(absolutePath, path.join(packagedFfmpegRoot, path.basename(absolutePath)));
  }

  [
    "LICENSE",
    "LICENSE.txt",
    "COPYING.GPLv3",
    "COPYING.LGPLv3",
    "README.txt",
  ].forEach((fileName) => {
    copyOptionalFile(path.join(sourceRoot, fileName), path.join(packagedFfmpegRoot, fileName));
  });
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
  prepareBackendResources();
  buildPackagedWindowsRuntime({ allowFallback: true });
  copyPackagedModels();
  copyPackagedFfmpegRuntime();
  resetDir(integrityRoot);

  const manifest = {
    schemaVersion: 1,
    appVersion: process.env.npm_package_version || "0.0.1",
    runtimeFlavor: process.env.MOONSHINE_RUNTIME_FLAVOR || "cu130",
    modelBundle,
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
