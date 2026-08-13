import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { signAppManifestFile } from "../../scripts/release/app-manifest-lib.mjs";
import { verifySignedManifest } from "../../src-electron/runtime/manifest-verifier.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

test("app manifest signer binds latest.yml, installer and blockmap hashes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-app-manifest-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installerName = "Moonshine-Image-Test-Setup-1.3.3-test.1.exe";
  const installer = Buffer.from("installer-for-manifest");
  await fs.writeFile(path.join(root, installerName), installer);
  await fs.writeFile(path.join(root, `${installerName}.blockmap`), "blockmap");
  await fs.writeFile(
    path.join(root, "latest.yml"),
    [
      "version: 1.3.3-test.1",
      "path: Moonshine-Image-Test-Setup-1.3.3-test.1.exe",
      "files:",
      "  - url: Moonshine-Image-Test-Setup-1.3.3-test.1.exe",
      `    size: ${installer.length}`,
      "",
    ].join("\n"),
  );
  const output = path.join(root, "manifests", "test", "latest.json");
  const result = await signAppManifestFile({
    artifactDir: root,
    appVersion: "1.3.3-test.1",
    channel: "test",
    sequence: 4,
    outputPath: output,
    privateKey,
  });
  const written = JSON.parse(await fs.readFile(output, "utf8"));
  const verified = verifySignedManifest(written, {
    publicKeys: { "moonshine-app-manifest-v1": publicKey },
    expectedChannel: "test",
    expectedAppVersion: "1.3.3-test.1",
    now: Date.now(),
  });
  assert.equal(verified.sequence, 4);
  assert.equal(result.payload.edition, "test");
  assert.equal(result.payload.productName, "Moonshine-Image-Test");
  assert.equal(result.payload.app.latestYmlPath, "app/win-x64/test/latest.yml");
  assert.equal(result.payload.app.installerPath, `app/win-x64/test/${installerName}`);
  assert.equal(result.payload.app.installerSha256.length, 64);
  assert.equal(result.payload.app.blockmapSha256.length, 64);
});

test("app manifest signer rejects a missing key", async () => {
  await assert.rejects(
    () => signAppManifestFile({ outputPath: "ignored.json", artifactDir: ".", sequence: 1 }),
    /private key is required/,
  );
});
