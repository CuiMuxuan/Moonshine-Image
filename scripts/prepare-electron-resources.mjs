import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { buildSync } = require(require.resolve("esbuild", { paths: [path.resolve("node_modules/@quasar/app-vite")] }));

import {
  INTEGRITY_MANIFEST_FILE,
  INTEGRITY_RESOURCE_DIR,
  INTEGRITY_SIGNATURE_FILE,
  PACKAGED_FFMPEG_RESOURCE_DIR,
  PACKAGED_FFMPEG_TARGET_DIR,
  PACKAGED_MODELS_RESOURCE_DIR,
  PACKAGED_SAM3_RESOURCE_DIR,
  PACKAGED_RUNTIME_METADATA_FILE,
  PACKAGED_RUNTIME_RESOURCE_DIR,
  PACKAGED_RUNTIME_TARGET_DIR,
} from "../src-electron/integrity/public-key.js";
import { prepareBackendResources } from "./prepare-backend-resources.mjs";
import { buildPackagedWindowsRuntime } from "./build-runtime-win.mjs";
import { buildMcpNativeBroker } from "./build-mcp-native-broker.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const sourceModelsRoot = path.join(repoRoot, "models");
const buildResourcesRoot = path.join(repoRoot, "build-resources");
const packagedModelsRoot = path.join(buildResourcesRoot, PACKAGED_MODELS_RESOURCE_DIR);
const packagedSam3Root = path.join(buildResourcesRoot, PACKAGED_SAM3_RESOURCE_DIR);
const sam3WheelStagingRoot = path.join(buildResourcesRoot, ".tmp", "runtime", "sam3-wheel");
const sam3SourceRoot = path.join(repoRoot, "third_party", "sam3");
const modelBundle = normalizeModelBundle(process.env.MOONSHINE_MODEL_BUNDLE);
const runtimeFlavor = String(process.env.MOONSHINE_RUNTIME_FLAVOR || "cu130").trim().toLowerCase();
const packagedFfmpegRoot = path.join(
  buildResourcesRoot,
  PACKAGED_FFMPEG_RESOURCE_DIR,
  PACKAGED_FFMPEG_TARGET_DIR
);
const integrityRoot = path.join(buildResourcesRoot, INTEGRITY_RESOURCE_DIR);
const mcpAdapterRoot = path.join(buildResourcesRoot, "mcp");
const mcpAdapterEntry = path.join(repoRoot, "src-electron", "mcp-stdio-server.mjs");
const mcpExternalProxyEntry = path.join(repoRoot, "src-electron", "mcp-external-proxy.mjs");
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
    rootDir: mcpAdapterRoot,
    resourcePrefix: "mcp",
  },
  {
    rootDir: packagedModelsRoot,
    resourcePrefix: PACKAGED_MODELS_RESOURCE_DIR,
  },
  {
    rootDir: path.join(buildResourcesRoot, PACKAGED_FFMPEG_RESOURCE_DIR),
    resourcePrefix: PACKAGED_FFMPEG_RESOURCE_DIR,
  },
  {
    rootDir: packagedSam3Root,
    resourcePrefix: PACKAGED_SAM3_RESOURCE_DIR,
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
    path.join(buildResourcesRoot, PACKAGED_FFMPEG_RESOURCE_DIR),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const candidateRoot of candidateRoots) {
    if (
      fs.existsSync(path.join(candidateRoot, "ffmpeg.exe")) &&
      fs.existsSync(path.join(candidateRoot, "ffprobe.exe"))
    ) {
      return candidateRoot;
    }

    for (const binRoot of [
      path.join(candidateRoot, "bin"),
      path.join(candidateRoot, PACKAGED_FFMPEG_TARGET_DIR),
    ]) {
      if (
        fs.existsSync(path.join(binRoot, "ffmpeg.exe")) &&
        fs.existsSync(path.join(binRoot, "ffprobe.exe"))
      ) {
        return candidateRoot;
      }
    }
  }

  throw new Error(
    "Missing FFmpeg runtime. Set MOONSHINE_FFMPEG_ROOT or provide build-resources/ffmpeg."
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
  const sourceBinRoot = [
    path.join(sourceRoot, "bin"),
    path.join(sourceRoot, PACKAGED_FFMPEG_TARGET_DIR),
    sourceRoot,
  ].find(
    (candidate) =>
      fs.existsSync(path.join(candidate, "ffmpeg.exe")) &&
      fs.existsSync(path.join(candidate, "ffprobe.exe")),
  );
  if (!sourceBinRoot) {
    throw new Error(`FFmpeg runtime is incomplete: ${sourceRoot}`);
  }
  // A previous preparation may already have materialized the destination. Do
  // not reset it and then try to copy files from the directory just removed.
  if (path.resolve(sourceBinRoot) === path.resolve(packagedFfmpegRoot)) {
    return;
  }
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
    copyOptionalFile(path.join(path.dirname(sourceBinRoot), fileName), path.join(packagedFfmpegRoot, fileName));
    copyOptionalFile(path.join(sourceRoot, fileName), path.join(packagedFfmpegRoot, fileName));
  });
}

function isCudaRuntimeFlavor() {
  return runtimeFlavor === "cu126" || runtimeFlavor === "cu130";
}

function findSam3Wheel(directoryPath) {
  if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
    return null;
  }
  const wheels = fs.readdirSync(directoryPath)
    .filter((fileName) => /^sam3-.+\.whl$/iu.test(fileName))
    .map((fileName) => path.join(directoryPath, fileName));
  if (wheels.length > 1) {
    throw new Error(`Expected exactly one SAM3 wheel in ${directoryPath}, found: ${wheels.join(", ")}`);
  }
  return wheels[0] || null;
}

function resolveSam3WheelSource() {
  const configured = String(process.env.MOONSHINE_SAM3_WHEEL || "").trim();
  if (configured) {
    const configuredPath = path.resolve(configured);
    if (fs.existsSync(configuredPath) && fs.statSync(configuredPath).isFile()) {
      if (!/^sam3-.+\.whl$/iu.test(path.basename(configuredPath))) {
        throw new Error(`MOONSHINE_SAM3_WHEEL must name a sam3-*.whl file: ${configuredPath}`);
      }
      return configuredPath;
    }
    const configuredWheel = findSam3Wheel(configuredPath);
    if (configuredWheel) return configuredWheel;
    throw new Error(`Configured SAM3 wheel does not exist: ${configuredPath}`);
  }

  return findSam3Wheel(sam3WheelStagingRoot) || findSam3Wheel(packagedSam3Root);
}

function buildSam3Wheel() {
  ensureDir(sam3WheelStagingRoot);
  const python = String(
    process.env.MOONSHINE_SAM3_BUILD_PYTHON || process.env.PYTHON || "python",
  ).trim();
  if (!python) throw new Error("A Python executable is required to build the SAM3 wheel.");
  if (!fs.existsSync(path.join(sam3SourceRoot, "pyproject.toml"))) {
    throw new Error(`SAM3 source tree is missing pyproject.toml: ${sam3SourceRoot}`);
  }

  resetDir(sam3WheelStagingRoot);
  const result = spawnSync(
    python,
    [
      "-m",
      "pip",
      "wheel",
      "--no-deps",
      "--no-build-isolation",
      "--wheel-dir",
      sam3WheelStagingRoot,
      sam3SourceRoot,
    ],
    { cwd: repoRoot, env: process.env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`SAM3 wheel build failed with exit code ${result.status}.`);
  }
  return findSam3Wheel(sam3WheelStagingRoot);
}

function preparePackagedSam3Wheel() {
  if (!isCudaRuntimeFlavor()) {
    resetDir(packagedSam3Root);
    return null;
  }

  // Resolve the source before resetting the destination: an explicitly
  // supplied wheel may already live under build-resources/sam3.
  const sourceWheel = resolveSam3WheelSource() || buildSam3Wheel();
  if (!sourceWheel || !fs.existsSync(sourceWheel)) {
    throw new Error(
      `CUDA resource preparation requires a SAM3 wheel. Set MOONSHINE_SAM3_WHEEL or build ${sam3SourceRoot}.`,
    );
  }

  const fileName = path.basename(sourceWheel);
  const sourceRelative = path.relative(path.resolve(packagedSam3Root), path.resolve(sourceWheel));
  const sourceIsDestination = sourceRelative === ""
    || (!sourceRelative.startsWith(`..${path.sep}`) && sourceRelative !== ".." && !path.isAbsolute(sourceRelative));
  const sourceBytes = sourceIsDestination
    ? fs.readFileSync(sourceWheel)
    : null;
  resetDir(packagedSam3Root);
  const destinationWheel = path.join(packagedSam3Root, fileName);
  if (sourceBytes) fs.writeFileSync(destinationWheel, sourceBytes);
  else fs.copyFileSync(sourceWheel, destinationWheel);
  const manifest = {
    schemaVersion: 1,
    package: "sam3",
    fileName,
    sha256: sha256File(destinationWheel),
    installMode: "wheel-non-editable-no-deps",
  };
  fs.writeFileSync(
    path.join(packagedSam3Root, "wheel-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

function createManifestEntries({ includeBundledComponents = true, includeFfmpeg = true, includeSam3 = isCudaRuntimeFlavor() } = {}) {
  const entries = [];
  const resourceDirs = protectedResourceDirs.filter(({ resourcePrefix }) =>
    resourcePrefix === "backend"
      || (includeFfmpeg && resourcePrefix === PACKAGED_FFMPEG_RESOURCE_DIR)
      || (includeBundledComponents && resourcePrefix === PACKAGED_MODELS_RESOURCE_DIR)
      || (includeSam3 && resourcePrefix === PACKAGED_SAM3_RESOURCE_DIR),
  );
  const resourceFiles = includeBundledComponents ? protectedResourceFiles : [];

  for (const resourceDir of resourceDirs) {
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

  for (const protectedFile of resourceFiles) {
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

function prepareMcpAdapterResource() {
  resetDir(mcpAdapterRoot);
  for (const [entryPoint, outputName] of [
    [mcpAdapterEntry, "mcp-stdio-server.mjs"],
    [mcpExternalProxyEntry, "moonshine-mcp-proxy.mjs"],
  ]) {
    buildSync({
      entryPoints: [entryPoint],
      outfile: path.join(mcpAdapterRoot, outputName),
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      legalComments: "none",
      sourcemap: false,
    });
  }
  buildMcpNativeBroker();
}

export function prepareElectronResources({ includeBundledComponents = false, includeFfmpeg = true } = {}) {
  prepareBackendResources();
  prepareMcpAdapterResource();
  const sam3 = preparePackagedSam3Wheel();
  if (includeFfmpeg) {
    copyPackagedFfmpegRuntime();
  }
  if (includeBundledComponents) {
    buildPackagedWindowsRuntime({ allowFallback: true });
    copyPackagedModels();
  }
  resetDir(integrityRoot);

  const manifest = {
    schemaVersion: 1,
    appVersion: process.env.npm_package_version || "0.0.1",
    runtimeFlavor: process.env.MOONSHINE_RUNTIME_FLAVOR || "cu130",
    modelBundle: includeBundledComponents ? modelBundle : "external-models",
    resourceMode: includeBundledComponents ? "bundled" : "app-only",
    generatedAt: new Date().toISOString(),
    hashAlgorithm: "sha256",
    sam3,
    entries: createManifestEntries({ includeBundledComponents, includeFfmpeg, includeSam3: Boolean(sam3) }),
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
  const includeBundledComponents = ["1", "true", "yes"].includes(
    String(process.env.MOONSHINE_PACKAGE_LEGACY_RUNTIME || "")
      .trim()
      .toLowerCase()
  );
  const manifest = prepareElectronResources({ includeBundledComponents });
  console.log(
    `Prepared ${manifest.entries.length} protected runtime files in ${buildResourcesRoot}`
  );
}
