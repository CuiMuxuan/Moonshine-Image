#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { MANIFEST_KEY_ID } from "../../src-electron/runtime/manifest-verifier.js";

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

async function writeExclusive(filePath, content, mode) {
  const handle = await fs.open(filePath, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(filePath, mode);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["output-dir"]) {
    throw new Error("--output-dir is required; choose a private directory outside the repository");
  }

  const outputDir = path.resolve(args["output-dir"]);
  const privateKeyPath = path.join(outputDir, "release-manifest-private.pem");
  const publicKeyPath = path.join(outputDir, "release-manifest-public.pem");
  const metadataPath = path.join(outputDir, "release-manifest-key.json");
  const targetPaths = [privateKeyPath, publicKeyPath, metadataPath];

  await fs.mkdir(outputDir, { recursive: true });
  for (const targetPath of targetPaths) {
    try {
      await fs.access(targetPath);
      throw new Error(`Refusing to overwrite existing release key material: ${targetPath}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const fingerprintSha256 = crypto.createHash("sha256").update(publicKeyDer).digest("hex");
  const metadata = {
    schemaVersion: 1,
    keyId: MANIFEST_KEY_ID,
    algorithm: "Ed25519",
    fingerprintSha256,
    generatedAt: new Date().toISOString(),
    privateKeyFile: path.basename(privateKeyPath),
    publicKeyFile: path.basename(publicKeyPath),
  };

  const createdPaths = [];
  try {
    await writeExclusive(privateKeyPath, privateKeyPem, 0o600);
    createdPaths.push(privateKeyPath);
    await writeExclusive(publicKeyPath, publicKeyPem, 0o644);
    createdPaths.push(publicKeyPath);
    await writeExclusive(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 0o644);
    createdPaths.push(metadataPath);
  } catch (error) {
    await Promise.all(createdPaths.map((filePath) => fs.rm(filePath, { force: true })));
    throw error;
  }

  process.stdout.write(`${JSON.stringify({
    outputDir,
    publicKeyPath,
    privateKeyPath,
    metadataPath,
    keyId: MANIFEST_KEY_ID,
    algorithm: "Ed25519",
    fingerprintSha256,
    privateKeyPrinted: false,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`Release manifest key generation failed: ${error.message}\n`);
  process.exitCode = 1;
});
