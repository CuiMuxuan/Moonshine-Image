import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundledPython = path.join(
  root,
  "build-resources",
  "runtime",
  "win-x64",
  "env",
  "python.exe"
);
const candidates = [
  process.env.MOONSHINE_PYTHON,
  existsSync(bundledPython) ? bundledPython : "",
  process.platform === "win32" ? "python" : "python3",
].filter(Boolean);

let lastError = null;
for (const command of candidates) {
  const result = spawnSync(command, ["scripts/verify_slbr_local_processing.py"], {
    cwd: root,
    stdio: "inherit",
  });
  if (!result.error) {
    process.exit(result.status ?? 1);
  }
  lastError = result.error;
}

throw lastError || new Error("No usable Python runtime was found for SLBR local tests.");
