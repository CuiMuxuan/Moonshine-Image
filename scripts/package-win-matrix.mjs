import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  "C:\\Users\\cjh02\\Downloads\\torch-2.11.0+cu126-cp311-cp311-win_amd64.whl";
const runtimeFlavors = ["cpu", "cu126", "cu130"];
const modelBundles = ["external-models", "bundled-models"];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ...(options.env || {}) },
  });

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`
    );
  }
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

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
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
        ? process.env.MOONSHINE_CU130_RUNTIME_ENV_NAME || "moonshine-runtime-311"
        : `moonshine-runtime-311-${runtimeFlavor}`,
  };

  if (runtimeFlavor === "cu126") {
    env.MOONSHINE_TORCH_WHEEL =
      process.env.MOONSHINE_TORCH_WHEEL || defaultCu126TorchWheelPath;
  }

  return env;
}

function buildOne(runtimeFlavor, modelBundle) {
  const artifactName = `Moonshine-Image-v${version}-win-x64-${runtimeFlavor}-${modelBundle}.zip`;
  const zipPath = path.join(releaseRoot, artifactName);
  const env = createMatrixEnv(runtimeFlavor, modelBundle);

  if (runtimeFlavor === "cu126" && !fs.existsSync(env.MOONSHINE_TORCH_WHEEL)) {
    throw new Error(
      `Missing CUDA 12.6 torch wheel: ${env.MOONSHINE_TORCH_WHEEL}. Set MOONSHINE_TORCH_WHEEL before running the release matrix.`
    );
  }

  console.log(`\n=== Building ${artifactName} ===`);
  runCommand("npm", ["run", "build", "--", "-m", "electron"], { env });
  compressPackagedApp(resolvePackagedDir(), zipPath);

  return {
    artifactName,
    zipPath,
    sha256: sha256File(zipPath),
  };
}

function writeSha256Sums(artifacts) {
  const lines = artifacts.map((artifact) => `${artifact.sha256}  ${artifact.artifactName}`);
  fs.writeFileSync(path.join(releaseRoot, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
}

ensureDir(releaseRoot);

const artifacts = [];
for (const runtimeFlavor of runtimeFlavors) {
  for (const modelBundle of modelBundles) {
    artifacts.push(buildOne(runtimeFlavor, modelBundle));
  }
}

writeSha256Sums(artifacts);
console.log(`\nPrepared ${artifacts.length} release artifacts in ${releaseRoot}`);
