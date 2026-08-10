#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { auditAppOnlyPackage } from "./app-only-audit-lib.mjs";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    result[name] = value;
    index += 1;
  }
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  const result = auditAppOnlyPackage({
    artifactDir: args["artifact-dir"] || "dist/electron/Packaged",
    expectedVersion: args.version || packageJson.version,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`App-only package audit failed: ${error.message}\n`);
  process.exitCode = 1;
}
