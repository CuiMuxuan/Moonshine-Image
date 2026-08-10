#!/usr/bin/env node

import { createPublicKey } from "node:crypto";

import { MANIFEST_KEY_ID } from "../../src-electron/runtime/manifest-verifier.js";

async function main() {
  const pem = String(process.env.MOONSHINE_MANIFEST_PUBLIC_KEY_PEM || "").trim();
  const keyId = String(process.env.MOONSHINE_MANIFEST_KEY_ID || MANIFEST_KEY_ID).trim();
  if (!pem) throw new Error("MOONSHINE_MANIFEST_PUBLIC_KEY_PEM is required for a production release");
  if (keyId !== MANIFEST_KEY_ID) throw new Error(`MOONSHINE_MANIFEST_KEY_ID must be ${MANIFEST_KEY_ID}`);
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Manifest public key must be Ed25519");
  process.stdout.write(JSON.stringify({ ok: true, keyId, algorithm: "Ed25519" }) + "\n");
}

main().catch((error) => {
  process.stderr.write(`Manifest release-key assertion failed: ${error.message}\n`);
  process.exitCode = 1;
});
