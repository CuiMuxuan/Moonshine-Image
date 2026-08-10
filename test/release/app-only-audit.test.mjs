import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stringify as stringifyYaml } from "yaml";

import { auditAppOnlyPackage } from "../../scripts/release/app-only-audit-lib.mjs";

function digest(buffer, algorithm, encoding) {
  return crypto.createHash(algorithm).update(buffer).digest(encoding);
}

function createFixture(t) {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-app-audit-test-"));
  t.after(() => fs.rmSync(artifactDir, { recursive: true, force: true }));
  const resourcesRoot = path.join(artifactDir, "win-unpacked", "resources");
  const backendFile = path.join(resourcesRoot, "backend", "server", "main.py");
  const ffmpegFile = path.join(resourcesRoot, "ffmpeg", "win-x64", "ffmpeg.exe");
  const ffprobeFile = path.join(resourcesRoot, "ffmpeg", "win-x64", "ffprobe.exe");
  const integrityRoot = path.join(resourcesRoot, "integrity");
  fs.mkdirSync(path.dirname(backendFile), { recursive: true });
  fs.mkdirSync(path.dirname(ffmpegFile), { recursive: true });
  fs.mkdirSync(integrityRoot, { recursive: true });
  const backendBytes = Buffer.from("print('moonshine')\n");
  const ffmpegBytes = Buffer.from("fake ffmpeg\n");
  const ffprobeBytes = Buffer.from("fake ffprobe\n");
  fs.writeFileSync(backendFile, backendBytes);
  fs.writeFileSync(ffmpegFile, ffmpegBytes);
  fs.writeFileSync(ffprobeFile, ffprobeBytes);

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const manifest = {
    schemaVersion: 1,
    appVersion: "1.3.0",
    hashAlgorithm: "sha256",
    resourceMode: "app-only",
    entries: [
      {
        path: "backend/server/main.py",
        size: backendBytes.length,
        sha256: digest(backendBytes, "sha256", "hex"),
      },
      {
        path: "ffmpeg/win-x64/ffmpeg.exe",
        size: ffmpegBytes.length,
        sha256: digest(ffmpegBytes, "sha256", "hex"),
      },
      {
        path: "ffmpeg/win-x64/ffprobe.exe",
        size: ffprobeBytes.length,
        sha256: digest(ffprobeBytes, "sha256", "hex"),
      },
    ],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(integrityRoot, "manifest.json"), manifestBytes);
  fs.writeFileSync(
    path.join(integrityRoot, "manifest.sig"),
    `${crypto.sign(null, manifestBytes, privateKey).toString("base64")}\n`,
  );

  const installerName = "Moonshine-Image-Setup-1.3.0.exe";
  const installerBytes = Buffer.from("fake installer bytes");
  fs.writeFileSync(path.join(artifactDir, installerName), installerBytes);
  fs.writeFileSync(path.join(artifactDir, `${installerName}.blockmap`), "blockmap");
  fs.writeFileSync(path.join(artifactDir, "latest.yml"), stringifyYaml({
    version: "1.3.0",
    files: [{
      url: installerName,
      sha512: digest(installerBytes, "sha512", "base64"),
      size: installerBytes.length,
    }],
    path: installerName,
    sha512: digest(installerBytes, "sha512", "base64"),
  }));

  return {
    artifactDir,
    resourcesRoot,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

test("app-only audit verifies integrity and updater metadata", (t) => {
  const fixture = createFixture(t);
  const result = auditAppOnlyPackage({
    artifactDir: fixture.artifactDir,
    expectedVersion: "1.3.0",
    integrityPublicKeyPem: fixture.publicKeyPem,
  });
  assert.equal(result.integrity.resourceMode, "app-only");
  assert.equal(result.integrity.entryCount, 3);
  assert.deepEqual(result.integrity.prefixes.sort(), ["backend", "ffmpeg"]);
  assert.equal(result.updateMetadata.installerBytes, 20);
});

test("app-only audit rejects forbidden bundled resources", (t) => {
  const fixture = createFixture(t);
  fs.mkdirSync(path.join(fixture.resourcesRoot, "runtime"), { recursive: true });
  assert.throws(
    () => auditAppOnlyPackage({
      artifactDir: fixture.artifactDir,
      expectedVersion: "1.3.0",
      integrityPublicKeyPem: fixture.publicKeyPem,
    }),
    /forbidden resource directory: runtime/,
  );
});

test("app-only audit rejects unprotected backend files and stale updater hashes", (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(path.join(fixture.resourcesRoot, "backend", "unprotected.py"), "pass\n");
  assert.throws(
    () => auditAppOnlyPackage({
      artifactDir: fixture.artifactDir,
      expectedVersion: "1.3.0",
      integrityPublicKeyPem: fixture.publicKeyPem,
    }),
    /Unprotected backend resources/,
  );

  fs.rmSync(path.join(fixture.resourcesRoot, "backend", "unprotected.py"));
  fs.appendFileSync(path.join(fixture.artifactDir, "Moonshine-Image-Setup-1.3.0.exe"), "tampered");
  assert.throws(
    () => auditAppOnlyPackage({
      artifactDir: fixture.artifactDir,
      expectedVersion: "1.3.0",
      integrityPublicKeyPem: fixture.publicKeyPem,
    }),
    /installer size does not match/,
  );
});
