import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { canonicalizeJson } from "../../src-electron/runtime/manifest-verifier.js";
import { AppManifestGuard } from "../../src-electron/updater/app-manifest-guard.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

function makeManifest() {
  const payload = {
    schemaVersion: 1,
    edition: "official",
    productName: "Moonshine-Image",
    appId: "com.moonshine.image",
    channel: "stable",
    sequence: 7,
    appVersion: "1.3.1",
    platform: "win32",
    arch: "x64",
    publishedAt: "2026-08-07T00:00:00.000Z",
    expiresAt: "2026-09-07T00:00:00.000Z",
    app: {
      latestYmlPath: "app/win-x64/stable/latest.yml",
      latestYmlSha256: "a".repeat(64),
      installerSha256: "b".repeat(64),
      installerSha512: Buffer.alloc(64, 5).toString("base64"),
    },
  };
  return {
    payload,
    signature: {
      algorithm: "Ed25519",
      keyId: "moonshine-app-manifest-v1",
      value: sign(null, canonicalizeJson(payload), privateKey).toString("base64"),
    },
  };
}

test("AppManifestGuard verifies the signed app manifest and validates electron-updater metadata", async () => {
  const manifest = makeManifest();
  let requests = 0;
  const guard = new AppManifestGuard({
    sources: [{ id: "primary", baseUrl: "https://download.example" }],
    publicKeys: { "moonshine-app-manifest-v1": publicKey },
    fetchImpl: async () => {
      requests += 1;
      return new Response(JSON.stringify(manifest), { status: 200 });
    },
    now: () => Date.parse("2026-08-08T00:00:00.000Z"),
  });
  const preflight = await guard.preflight();
  assert.equal(preflight.verified, true);
  assert.equal(requests, 1);
  assert.equal(guard.validateUpdateInfo({
    version: "1.3.1",
    files: [{ url: "Moonshine-Image-Setup-1.3.1.exe", sha512: manifest.payload.app.installerSha512 }],
  }).valid, true);
  assert.throws(
    () => guard.validateUpdateInfo({ version: "1.3.2", files: [] }),
    (error) => error.code === "APP_MANIFEST_VERSION_MISMATCH"
  );
});

test("AppManifestGuard is inert when no release public key is configured", async () => {
  const guard = new AppManifestGuard({ sources: [{ id: "primary", baseUrl: "https://download.example" }] });
  const result = await guard.preflight();
  assert.deepEqual(result, { enabled: false, verified: false, manifest: null });
  assert.equal(guard.validateUpdateInfo({ version: "9.9.9" }).valid, true);
});

test("AppManifestGuard rejects signed app identity mismatches", async () => {
  const manifest = makeManifest();
  manifest.payload.appId = "com.moonshine.image.test";
  manifest.signature.value = sign(null, canonicalizeJson(manifest.payload), privateKey).toString("base64");
  const guard = new AppManifestGuard({
    sources: [{ id: "primary", baseUrl: "https://download.example" }],
    publicKeys: { "moonshine-app-manifest-v1": publicKey },
    fetchImpl: async () => new Response(JSON.stringify(manifest), { status: 200 }),
    now: () => Date.parse("2026-08-08T00:00:00.000Z"),
  });
  await assert.rejects(
    guard.preflight(),
    (error) => error.code === "APP_MANIFEST_EDITION_MISMATCH",
  );
});
