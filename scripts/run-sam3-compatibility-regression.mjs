import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(repoRoot, "third_party", "sam3");
const smokeScriptPath = path.join(__dirname, "verify_sam3_compatibility.py");
const runtimeFlavor = String(process.env.MOONSHINE_RUNTIME_FLAVOR || "cu130").trim().toLowerCase();
const runtimeEnvName =
  process.env.MOONSHINE_RUNTIME_ENV_NAME ||
  (runtimeFlavor === "cu130"
    ? process.env.MOONSHINE_CU130_RUNTIME_ENV_NAME || "moonshine-runtime-312"
    : `moonshine-runtime-312-${runtimeFlavor}`);

if (!["cu126", "cu130"].includes(runtimeFlavor)) {
  throw new Error("SAM3 compatibility regression requires MOONSHINE_RUNTIME_FLAVOR=cu126 or cu130.");
}
if (!fs.existsSync(path.join(sourceDir, "pyproject.toml"))) {
  throw new Error(`Vendored SAM3 source is missing: ${sourceDir}`);
}

const pythonPath = [sourceDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
const result = spawnSync(
  "conda",
  [
    "run",
    "-n",
    runtimeEnvName,
    "python",
    smokeScriptPath,
    "--expect-backend",
    "compatibility-fallback",
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      MOONSHINE_SAM3_DISABLE_TRITON: "1",
      PYTHONNOUSERSITE: "1",
      PYTHONPATH: pythonPath,
    },
  }
);

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  throw new Error(`SAM3 compatibility regression failed with exit code ${result.status ?? "unknown"}.`);
}
