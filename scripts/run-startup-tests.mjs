import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const testDirectory = path.join(repoRoot, "test", "electron");
const startupTests = readdirSync(testDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.test\.(?:js|mjs)$/u.test(entry.name))
  .map((entry) => path.join(testDirectory, entry.name))
  .sort();

if (startupTests.length === 0) {
  throw new Error(`No startup tests found in ${testDirectory}`);
}

const result = spawnSync(process.execPath, ["--test", ...startupTests], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
