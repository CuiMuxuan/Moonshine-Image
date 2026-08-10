import fs from "node:fs/promises";
import path from "node:path";
import { createPrivateKey, sign } from "node:crypto";

import {
  canonicalizeJson,
  MANIFEST_KEY_ID,
  parseManifest,
} from "../../src-electron/runtime/manifest-verifier.js";

export function signManifestPayload(payload, { privateKey, keyId = MANIFEST_KEY_ID } = {}) {
  if (!privateKey) throw new Error("A manifest private key is required");
  const normalizedPayload = parseManifest(payload);
  if (!normalizedPayload || typeof normalizedPayload !== "object" || Array.isArray(normalizedPayload)) {
    throw new Error("Manifest payload must be an object");
  }
  const key = privateKey.type === "private" || privateKey.asymmetricKeyType
    ? privateKey
    : createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Manifest signing key must be Ed25519");
  }
  const normalizedKeyId = String(keyId ?? "").trim();
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(normalizedKeyId)) {
    throw new Error("Manifest keyId is invalid");
  }
  const value = sign(null, canonicalizeJson(normalizedPayload), key).toString("base64");
  return {
    payload: normalizedPayload,
    signature: {
      algorithm: "Ed25519",
      keyId: normalizedKeyId,
      value,
    },
  };
}

export async function signManifestFile({ payloadPath, outputPath, privateKeyPem, privateKeyPath, keyId }) {
  if (!payloadPath || !outputPath) throw new Error("payloadPath and outputPath are required");
  let pem = privateKeyPem;
  if (!pem && privateKeyPath) pem = await fs.readFile(privateKeyPath, "utf8");
  if (!pem) throw new Error("A manifest private key must be supplied by secret or file");
  const payload = JSON.parse(await fs.readFile(payloadPath, "utf8"));
  const manifest = signManifestPayload(payload, { privateKey: pem, keyId });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { outputPath, keyId: manifest.signature.keyId, sequence: manifest.payload.sequence };
}
