import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { signManifestFile, signManifestPayload } from "../../scripts/release/manifest-signing.mjs";
import { verifySignedManifest } from "../../src-electron/runtime/manifest-verifier.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const execFileAsync = promisify(execFile);

function payload() {
  return {
    schemaVersion: 1,
    channel: "beta",
    sequence: 11,
    appVersion: "1.3.0",
    platform: "win32",
    arch: "x64",
    publishedAt: "2026-08-07T00:00:00.000Z",
    expiresAt: "2026-09-07T00:00:00.000Z",
    components: [{
      id: "ffmpeg",
      kind: "ffmpeg",
      version: "7.0.0",
      artifactPath: "components/ffmpeg.zip",
      size: 1,
      sha256: "a".repeat(64),
    }],
  };
}

test("release signer creates a manifest accepted by the client verifier", () => {
  const manifest = signManifestPayload(payload(), { privateKey, keyId: "moonshine-app-manifest-v1" });
  const verified = verifySignedManifest(manifest, {
    publicKeys: { "moonshine-app-manifest-v1": publicKey },
    expectedChannel: "beta",
    now: Date.parse("2026-08-08T00:00:00.000Z"),
    clockSkewMs: 0,
  });
  assert.equal(verified.sequence, 11);
  assert.equal(verified.signature.algorithm, "Ed25519");
});

test("file signer writes only the signed manifest to the requested output", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-manifest-sign-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const payloadPath = path.join(directory, "payload.json");
  const outputPath = path.join(directory, "nested", "signed.json");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  await fs.writeFile(payloadPath, JSON.stringify(payload()));
  const result = await signManifestFile({ payloadPath, outputPath, privateKeyPem });
  assert.equal(result.keyId, "moonshine-app-manifest-v1");
  const written = JSON.parse(await fs.readFile(outputPath, "utf8"));
  assert.equal(written.payload.sequence, 11);
  assert.ok(written.signature.value);
});

test("release public-key injection validates Ed25519 and never writes a private key", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-public-key-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, "release-public-key.generated.js");
  const pem = publicKey.export({ type: "spki", format: "pem" });
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/release/inject-manifest-public-key.mjs", "--output", outputPath],
    {
      cwd: path.resolve("."),
      env: { ...process.env, MOONSHINE_MANIFEST_PUBLIC_KEY_PEM: pem },
    },
  );
  assert.match(stdout, /moonshine-app-manifest-v1/);
  const generated = await fs.readFile(outputPath, "utf8");
  assert.match(generated, /EMBEDDED_RELEASE_PUBLIC_KEY_PEM/);
  assert.doesNotMatch(generated, /BEGIN PRIVATE KEY/);
});
