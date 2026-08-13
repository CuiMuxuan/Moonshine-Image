import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  auditPackagedRuntimeDirectory,
  auditPackagedRuntimeZip,
} from "./audit-release-runtime.mjs";
import { buildOfflineBundle } from "./build-offline-bundle-win.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
);
const version = packageJson.version;
const releaseRoot = path.join(repoRoot, "dist", "releases", `v${version}`);
const packagedCandidates = [
  path.join(repoRoot, "dist", "electron", "Packaged", "Moonshine-Image-win32-x64"),
  path.join(repoRoot, "dist", "electron", "packaged", "Moonshine-Image-win32-x64"),
];
const defaultCu126TorchWheelPath =
  "C:\\code\\torch\\torch-2.11.0+cu126-cp312-cp312-win_amd64.whl";
const DEFAULT_RUNTIME_FLAVORS = ["cpu", "cu130"];
// Historical regression marker: const runtimeFlavors = ["cpu", "cu130"];
const DEFAULT_MODEL_BUNDLES = ["bundled-models"];

function parseMatrixList(value, fallback, label) {
  const raw = String(value ?? "").trim();
  if (!raw) return [...fallback];
  const values = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!values.length || values.some((item) => /[^a-z0-9-]/.test(item))) {
    throw new Error(`${label} must be a comma-separated list of safe identifiers`);
  }
  return [...new Set(values)];
}

// The public offline matrix is intentionally two complete packages. Developers
// may opt into additional local combinations through explicit environment vars.
const runtimeFlavors = parseMatrixList(
  process.env.MOONSHINE_MATRIX_RUNTIME_FLAVORS,
  DEFAULT_RUNTIME_FLAVORS,
  "MOONSHINE_MATRIX_RUNTIME_FLAVORS",
);
const modelBundles = parseMatrixList(
  process.env.MOONSHINE_MATRIX_MODEL_BUNDLES,
  DEFAULT_MODEL_BUNDLES,
  "MOONSHINE_MATRIX_MODEL_BUNDLES",
);
const electronBuildRetryCount = Math.max(
  1,
  Number.parseInt(process.env.MOONSHINE_ELECTRON_BUILD_RETRIES || "3", 10) || 3
);
const electronBuildRetryDelayMs = Math.max(
  0,
  Number.parseInt(process.env.MOONSHINE_ELECTRON_BUILD_RETRY_DELAY_MS || "15000", 10) || 15000
);
const skipExistingArtifacts = ["1", "true", "yes"].includes(
  String(process.env.MOONSHINE_PACKAGE_SKIP_EXISTING || "").trim().toLowerCase()
);
const useLegacyRuntimeMatrix = ["1", "true", "yes"].includes(
  String(process.env.MOONSHINE_PACKAGE_LEGACY_RUNTIME || "").trim().toLowerCase()
);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

function resolveNpmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ]
    .map((candidate) => String(candidate || "").trim())
    .filter(Boolean);

  const npmCliPath = candidates.find(
    (candidate) => candidate.endsWith(".js") && fs.existsSync(candidate)
  );
  if (!npmCliPath) {
    throw new Error(
      `Unable to resolve npm CLI path. Checked: ${candidates.join(", ") || "(none)"}`
    );
  }
  return npmCliPath;
}

function runCommand(command, args, options = {}) {
  const displayCommand = options.displayCommand || formatCommand(command, args);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ...(options.env || {}) },
  });

  if (result.error) {
    throw new Error(
      `${displayCommand} failed to start: ${result.error.message}`
    );
  }

  if (result.status !== 0) {
    const exitDetail =
      result.status == null
        ? `signal ${result.signal || "unknown"}`
        : `exit code ${result.status}`;
    throw new Error(`${displayCommand} failed with ${exitDetail}`);
  }
}

function runNpm(args, options = {}) {
  runCommand(process.execPath, [resolveNpmCliPath(), ...args], {
    ...options,
    displayCommand: `npm ${args.join(" ")}`,
  });
}

function sleep(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runElectronBuildWithRetry(env) {
  let lastError = null;

  for (let attempt = 1; attempt <= electronBuildRetryCount; attempt += 1) {
    try {
      if (attempt > 1) {
        console.log(
          `Retrying Electron build (${attempt}/${electronBuildRetryCount})...`
        );
      }
      runNpm(["run", "build", "--", "-m", "electron"], { env });
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= electronBuildRetryCount) {
        break;
      }
      console.warn(
        `Electron build attempt ${attempt}/${electronBuildRetryCount} failed: ${error.message}`
      );
      console.warn(`Waiting ${Math.round(electronBuildRetryDelayMs / 1000)}s before retry...`);
      sleep(electronBuildRetryDelayMs);
    }
  }

  throw lastError;
}

function resolvePackagedDir() {
  const packagedDir = packagedCandidates.find((candidate) => fs.existsSync(candidate));
  if (!packagedDir) {
    throw new Error(
      `Unable to find packaged Electron output. Checked: ${packagedCandidates.join(", ")}`
    );
  }
  return packagedDir;
}

function findNsisInstaller() {
  const candidates = [
    process.env.MOONSHINE_NSIS_INSTALLER,
    path.join(repoRoot, "dist", "electron", "Packaged", `Moonshine-Image-Setup-${version}.exe`),
    path.join(repoRoot, "dist", "electron", "packaged", `Moonshine-Image-Setup-${version}.exe`),
  ]
    .map((candidate) => String(candidate || "").trim())
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate));
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function resolveNsisInstaller() {
  const installer = findNsisInstaller();
  if (!installer) {
    throw new Error(`Unable to locate the app-only NSIS installer. Set MOONSHINE_NSIS_INSTALLER or build it first.`);
  }
  return installer;
}

function resolveOfflineSource(runtimeFlavor, type) {
  const flavorKey = runtimeFlavor.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const specific = process.env[`MOONSHINE_OFFLINE_${type.toUpperCase()}_ROOT_${flavorKey}`];
  const generic = process.env[`MOONSHINE_OFFLINE_${type.toUpperCase()}_ROOT`];
  const candidates = [
    specific,
    generic,
    type === "runtime"
      ? path.join(repoRoot, "dist", "components", "prepared", `v${version}`, `runtime-${runtimeFlavor}`, "win-x64")
      : path.join(repoRoot, "models"),
  ]
    .map((candidate) => String(candidate || "").trim())
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate));
  const selected = candidates.find((candidate) => fs.existsSync(candidate));
  if (!selected) throw new Error(`Unable to locate offline ${type} payload for ${runtimeFlavor}. Checked: ${candidates.join(", ")}`);
  return selected;
}

async function buildOfflineOne(runtimeFlavor, modelBundle) {
  const installerPath = resolveNsisInstaller();
  const result = await buildOfflineBundle({
    version,
    variant: runtimeFlavor,
    installerPath,
    runtimeRoot: resolveOfflineSource(runtimeFlavor, "runtime"),
    modelsRoot: modelBundle === "bundled-models" ? resolveOfflineSource(runtimeFlavor, "models") : undefined,
    outputDir: releaseRoot,
    privateKeyFile: process.env.MOONSHINE_MANIFEST_PRIVATE_KEY_FILE,
    privateKeyPem: process.env.MOONSHINE_MANIFEST_PRIVATE_KEY_PEM,
    allowUnsigned: ["1", "true", "yes"].includes(String(process.env.MOONSHINE_OFFLINE_ALLOW_UNSIGNED || "").trim().toLowerCase()),
  });
  return {
    artifactName: path.basename(result.archivePath),
    zipPath: result.archivePath,
    runtimeFlavor,
    modelBundle,
    packageKind: "full-offline",
    sha256: result.archive?.sha256 || "",
    audit: { offlineBundle: result },
  };
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function compressPackagedApp(packagedDir, zipPath) {
  fs.rmSync(zipPath, { force: true });
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$source = ${JSON.stringify(packagedDir)}`,
    `$destination = ${JSON.stringify(zipPath)}`,
    "Compress-Archive -LiteralPath $source -DestinationPath $destination -Force",
  ].join("; ");

  runCommand("powershell.exe", ["-NoProfile", "-Command", command]);
}

function createMatrixEnv(runtimeFlavor, modelBundle) {
  const env = {
    MOONSHINE_RUNTIME_FLAVOR: runtimeFlavor,
    MOONSHINE_MODEL_BUNDLE: modelBundle,
    MOONSHINE_RUNTIME_ENV_NAME:
      runtimeFlavor === "cu130"
        ? process.env.MOONSHINE_CU130_RUNTIME_ENV_NAME || "moonshine-runtime-312"
        : `moonshine-runtime-312-${runtimeFlavor}`,
  };

  if (runtimeFlavor === "cu126") {
    env.MOONSHINE_TORCH_WHEEL =
      process.env.MOONSHINE_TORCH_WHEEL || defaultCu126TorchWheelPath;
  }

  return env;
}

async function buildOne(runtimeFlavor, modelBundle) {
  const bundleLabel = modelBundle === "bundled-models" ? "full" : modelBundle;
  const artifactName = `Moonshine-Image-v${version}-win-x64-${runtimeFlavor}-${bundleLabel}.zip`;
  const zipPath = path.join(releaseRoot, artifactName);
  const env = createMatrixEnv(runtimeFlavor, modelBundle);

  if (skipExistingArtifacts && fs.existsSync(zipPath)) {
    console.log(`\n=== Skipping existing ${artifactName} ===`);
    const archiveAudit = auditPackagedRuntimeZip({
      zipPath,
      runtimeFlavor,
      modelBundle,
      runFunctionalSmoke: true,
    });
    return {
      artifactName,
      zipPath,
      runtimeFlavor,
      modelBundle,
      packageKind: bundleLabel === "full" ? "full-offline" : "developer-matrix",
      sha256: await sha256File(zipPath),
      audit: {
        directory: { status: "not-run", reason: "Existing ZIP was audited without an unpackaged build directory." },
        archive: archiveAudit,
      },
    };
  }

  if (runtimeFlavor === "cu126" && !fs.existsSync(env.MOONSHINE_TORCH_WHEEL)) {
    throw new Error(
      `Missing CUDA 12.6 torch wheel: ${env.MOONSHINE_TORCH_WHEEL}. Set MOONSHINE_TORCH_WHEEL before running the release matrix.`
    );
  }

  console.log(`\n=== Building ${artifactName} ===`);
  runElectronBuildWithRetry(env);
  const packagedDir = resolvePackagedDir();
  const directoryAudit = auditPackagedRuntimeDirectory({
    appDir: packagedDir,
    runtimeFlavor,
    modelBundle,
    runFunctionalSmoke: false,
  });
  compressPackagedApp(packagedDir, zipPath);
  const archiveAudit = auditPackagedRuntimeZip({
    zipPath,
    runtimeFlavor,
    modelBundle,
    runFunctionalSmoke: true,
  });

  return {
    artifactName,
    zipPath,
    runtimeFlavor,
    modelBundle,
    packageKind: bundleLabel === "full" ? "full-offline" : "developer-matrix",
    sha256: await sha256File(zipPath),
    audit: {
      directory: directoryAudit,
      archive: archiveAudit,
    },
  };
}

function writeSha256Sums(artifacts) {
  const lines = artifacts.map((artifact) => `${artifact.sha256}  ${artifact.artifactName}`);
  fs.writeFileSync(path.join(releaseRoot, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
}

function writeReleaseMatrixManifest(artifacts) {
  // Historical regression marker: verification: artifact.audit
  const manifest = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    version,
    runtimeFlavors,
    modelBundles,
    packageKinds:
      modelBundles.length === 1 && modelBundles[0] === "bundled-models"
        ? ["full-offline"]
        : ["developer-matrix"],
    pythonTarget: "3.12",
    samRuntimePolicy: {
      sam1: "SAM1 code is bundled in the backend for every package; model weights remain external.",
      sam2: "SAM2/SAM2.1 code is bundled in the backend for every package; model weights remain external.",
      cpu: "SAM3/SAM3.1 is CUDA-only and deliberately not bundled in CPU packages.",
      cu126:
        "SAM3/SAM3.1 runtime code and required Python dependencies are bundled as a non-editable wheel installation with a Windows compatibility fallback when Triton is unavailable.",
      cu130:
        "SAM3/SAM3.1 runtime code and required Python dependencies are bundled as a non-editable wheel installation with a Windows compatibility fallback when Triton is unavailable.",
      modelWeights: "No SAM model weights are bundled by this runtime policy. Models are supplied through model management or manual installation.",
    },
    artifacts: artifacts.map((artifact) => {
      const verifiedSam3 = artifact.audit?.archive?.manifest?.samRuntime?.sam3 || null;
      return {
        artifactName: artifact.artifactName,
        runtimeFlavor: artifact.runtimeFlavor,
        modelBundle: artifact.modelBundle,
        packageKind: artifact.packageKind,
        sha256: artifact.sha256,
        samRuntime: {
          sam1: { code: "bundled-backend-plugin", modelWeightsBundled: false },
          sam2: { code: "bundled-backend-plugin", modelWeightsBundled: false },
          sam3:
            artifact.runtimeFlavor === "cpu"
              ? { availability: "cuda-only-unavailable", runtimeBundled: false, modelWeightsBundled: false }
              : {
                  availability: "bundled-cuda-runtime",
                  runtimeBundled: true,
                  modelWeightsBundled: false,
                  acceleration: verifiedSam3?.acceleration || null,
                  compatibilitySmoke: verifiedSam3?.compatibilitySmoke || null,
                },
        },
        verification: artifact.audit,
      };
    }),
  };
  fs.writeFileSync(
    path.join(releaseRoot, "release-matrix.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
}

async function main() {
  ensureDir(releaseRoot);

  const artifacts = [];
  if (!useLegacyRuntimeMatrix) {
    if (!findNsisInstaller()) {
      runNpm(["run", "build:electron:installer"], {
        env: { MOONSHINE_RUNTIME_FLAVOR: "cpu", MOONSHINE_MODEL_BUNDLE: "external-models" },
      });
    }
    for (const runtimeFlavor of runtimeFlavors) {
      for (const modelBundle of modelBundles) {
        artifacts.push(await buildOfflineOne(runtimeFlavor, modelBundle));
      }
    }
  } else {
    for (const runtimeFlavor of runtimeFlavors) {
      for (const modelBundle of modelBundles) {
        artifacts.push(await buildOne(runtimeFlavor, modelBundle));
      }
    }
  }

  writeSha256Sums(artifacts);
  writeReleaseMatrixManifest(artifacts);
  console.log(`\nPrepared ${artifacts.length} release artifacts in ${releaseRoot}`);
}

await main();
