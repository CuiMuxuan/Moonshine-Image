#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { buildComponentBundles } from "./component-bundle-lib.mjs";

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const separator = token.indexOf("=");
    if (separator > 2) {
      values[token.slice(2, separator)] = token.slice(separator + 1);
      continue;
    }
    const name = token.slice(2);
    if (name === "overwrite") {
      values[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    values[name] = value;
    index += 1;
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  for (const name of ["version", "output-dir", "runtime-cpu-root", "runtime-cu130-root", "ffmpeg-root"]) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }
  if (args.version !== packageJson.version) {
    throw new Error(`--version ${args.version} does not match package.json ${packageJson.version}`);
  }
  const result = await buildComponentBundles({
    version: args.version,
    outputDir: args["output-dir"],
    runtimeCpuRoot: args["runtime-cpu-root"],
    runtimeCu130Root: args["runtime-cu130-root"],
    ffmpegRoot: args["ffmpeg-root"],
    sevenZipPath: args["7zip-path"],
    overwrite: Boolean(args.overwrite),
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    packageVersion: packageJson.version,
    outputDir: result.outputDir,
    descriptorPath: result.descriptorPath,
    reportPath: result.reportPath,
    components: result.report.components.map(({ id, version, file, sha256 }) => ({ id, version, file, sha256 })),
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`Component bundle build failed: ${error.message}\n`);
  process.exitCode = 1;
});
