#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const configuredPython = String(process.env.MOONSHINE_TEST_PYTHON || "").trim();
const candidates = [
  configuredPython,
  path.join(repoRoot, "build-resources", "runtime", "win-x64", "env", "python.exe"),
  path.join(repoRoot, "build-resources", "runtime", "win-x64", "env", "bin", "python"),
  process.platform === "win32" ? "python.exe" : "python3",
].filter(Boolean);

function commandAvailable(command) {
  if (path.isAbsolute(command) && !fs.existsSync(command)) return false;
  const result = spawnSync(command, ["--version"], {
    cwd: repoRoot,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  });
  return result.status === 0;
}

const python = candidates.find(commandAvailable);
if (!python) {
  process.stderr.write("No usable Python runtime was found for model manifest tests.\n");
  process.exit(1);
}

const result = spawnSync(
  python,
  ["-m", "unittest", "discover", "-s", "server/tests", "-p", "test_model_manifest_registry.py", "-v"],
  {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);

