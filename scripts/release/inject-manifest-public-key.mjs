#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { createPublicKey } from "node:crypto";

import { MANIFEST_KEY_ID } from "../../src-electron/runtime/manifest-verifier.js";

const defaultOutput = path.resolve(
  "src-electron/runtime/release-public-key.generated.js",
);

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

function readPem(args) {
  if (args["public-key-file"]) return fs.readFile(args["public-key-file"], "utf8");
  const pem = String(process.env.MOONSHINE_MANIFEST_PUBLIC_KEY_PEM || "").trim();
  if (!pem) throw new Error("MOONSHINE_MANIFEST_PUBLIC_KEY_PEM or --public-key-file is required");
  return pem;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pem = String(await readPem(args)).trim();
  let key;
  try {
    key = createPublicKey(pem);
  } catch (error) {
    throw new Error(`Invalid manifest public key: ${error.message}`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Manifest public key must be Ed25519");
  }
  const output = path.resolve(args.output || defaultOutput);
  const source = [
    "// Generated during a release build. Do not add private key material here.",
    `export const EMBEDDED_RELEASE_PUBLIC_KEY_PEM = ${JSON.stringify(pem)};`,
    `export const EMBEDDED_RELEASE_KEY_ID = ${JSON.stringify(MANIFEST_KEY_ID)};`,
    "",
  ].join("\n");
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  await fs.writeFile(temporary, source, { encoding: "utf8", mode: 0o644 });
  await fs.rename(temporary, output);
  process.stdout.write(JSON.stringify({ output, keyId: MANIFEST_KEY_ID, algorithm: "Ed25519" }) + "\n");
}

main().catch((error) => {
  process.stderr.write(`Manifest public-key injection failed: ${error.message}\n`);
  process.exitCode = 1;
});
