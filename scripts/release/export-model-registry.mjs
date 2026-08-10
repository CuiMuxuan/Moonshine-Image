#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { parseCliArgs, safeCliError } from "./app-release-lib.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const usage = `Usage: node scripts/release/export-model-registry.mjs --output <path> [--python <path>]\n`;

function commandAvailable(command) {
  if (path.isAbsolute(command) && !fs.existsSync(command)) return false;
  return spawnSync(command, ["--version"], {
    cwd: repoRoot,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
  }).status === 0;
}

function resolvePython(explicit) {
  const candidates = [
    explicit,
    process.env.MOONSHINE_RELEASE_PYTHON,
    path.join(repoRoot, "build-resources", "runtime", "win-x64", "env", "python.exe"),
    path.join(repoRoot, "build-resources", "runtime", "win-x64", "env", "bin", "python"),
    process.platform === "win32" ? "python.exe" : "python3",
  ].map((value) => String(value || "").trim()).filter(Boolean);
  const selected = candidates.find(commandAvailable);
  if (!selected) throw new Error("No usable Python runtime was found for model registry export");
  return selected;
}

function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    boolean: ["help"],
    values: ["output", "python"],
  });
  if (args.help) {
    process.stdout.write(usage);
    return;
  }
  if (!args.output) throw new Error("--output is required");
  const result = spawnSync(
    resolvePython(args.python),
    [path.join(repoRoot, "scripts", "release", "export-model-registry.py"), "--output", path.resolve(args.output)],
    {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || "Model registry export failed").trim());
  }
  process.stdout.write(String(result.stdout || ""));
}

try {
  main();
} catch (error) {
  process.stderr.write(`Model registry export failed: ${safeCliError(error)}\n`);
  process.exitCode = 1;
}

