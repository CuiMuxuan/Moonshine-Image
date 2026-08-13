import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { path7za } from "7zip-bin";

import {
  buildOfflineBundle,
  createPayloadManifest,
  inspectOfflineBundle,
  normalizeVariant,
} from "../../scripts/build-offline-bundle-win.mjs";
import { BUNDLED_FFMPEG_SPEC_HASH } from "../../src-electron/runtime/environment-spec.js";

function writeFile(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-offline-bundle-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installer = path.join(root, "Moonshine-Image-Setup-1.3.0.exe");
  const runtime = path.join(root, "runtime");
  const ffmpeg = path.join(root, "ffmpeg");
  const models = path.join(root, "models");
  const outputDir = path.join(root, "out");
  fs.writeFileSync(installer, "installer-bytes");
  writeFile(runtime, "env/python.exe", "python");
  writeFile(runtime, "runtime-manifest.json", JSON.stringify({ runtimeFlavor: "cpu" }));
  writeFile(ffmpeg, "ffmpeg.exe", "ffmpeg");
  writeFile(ffmpeg, "ffprobe.exe", "ffprobe");
  writeFile(models, "big-lama.pt", "model");
  writeFile(models, "slbr.pth.tar", "slbr");
  writeFile(models, "mat/Places_512_FullData_G.pth", "mat");
  writeFile(models, "sam/sam_vit_b_01ec64.pth", "sam1-default");
  writeFile(models, "sam2/sam2.1_hiera_large.pt", "sam2-default");
  writeFile(models, "sam/sam_vit_h.pth", "optional-sam1");
  writeFile(models, "sam3/sam3.pt", "must-not-ship");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    root,
    installer,
    runtime,
    ffmpeg,
    models,
    outputDir,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

test("offline bundle manifest hashes all payload files and keeps variant explicit", async (t) => {
  const fixture = createFixture(t);
  const payloadRoot = path.join(fixture.outputDir, "payload");
  fs.mkdirSync(payloadRoot, { recursive: true });
  writeFile(payloadRoot, "runtime/python.exe", "python");
  writeFile(payloadRoot, "ffmpeg/ffmpeg.exe", "ffmpeg");
  const manifest = await createPayloadManifest({
    payloadRoot,
    version: "1.3.0",
    variant: "cpu",
    publishedAt: "2026-08-08T00:00:00.000Z",
  });
  assert.equal(manifest.kind, "moonshine-offline-payload");
  assert.equal(manifest.variant, "cpu");
  assert.deepEqual(manifest.files.map((entry) => entry.path), ["ffmpeg/ffmpeg.exe", "runtime/python.exe"]);
  assert.equal(normalizeVariant("CU130"), "cu130");
});

test("offline bundle creates a verifiable outer ZIP with NSIS sibling and signed payload manifest", async (t) => {
  const fixture = createFixture(t);
  const result = await buildOfflineBundle({
    version: "1.3.0",
    variant: "cpu",
    installerPath: fixture.installer,
    runtimeRoot: fixture.runtime,
    modelsRoot: fixture.models,
    outputDir: fixture.outputDir,
    privateKeyPem: fixture.privateKeyPem,
  });
  assert.equal(result.packageKind, "full-offline");
  assert.equal(result.payload.signed, true);
  assert.ok(fs.statSync(result.archivePath).size > 0);
  const listing = spawnSync(path7za, ["l", result.archivePath], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /Moonshine-Image-Setup-1\.3\.0\.exe/);
  assert.match(listing.stdout, /offline-payload[\\/]payload-manifest\.json/);
  assert.match(listing.stdout, /offline-payload[\\/]runtime[\\/]env[\\/]python\.exe/);
  const manifest = JSON.parse(
    spawnSync(path7za, ["x", "-so", result.archivePath, "*/offline-payload/payload-manifest.json"], { encoding: "utf8" }).stdout,
  );
  assert.equal(manifest.appVersion, "1.3.0");
  assert.equal(manifest.variant, "cpu");
  assert.equal(manifest.payload, undefined);
  assert.equal(manifest.ffmpegHash, BUNDLED_FFMPEG_SPEC_HASH);
  assert.equal(manifest.files.some((entry) => entry.path.startsWith("ffmpeg/")), false);
  assert.deepEqual(
    manifest.files.filter((entry) => entry.path.startsWith("models/")).map((entry) => entry.path),
    [
      "models/big-lama.pt",
      "models/mat/Places_512_FullData_G.pth",
      "models/sam/sam_vit_b_01ec64.pth",
      "models/sam2/sam2.1_hiera_large.pt",
      "models/slbr.pth.tar",
    ],
  );
  assert.equal(manifest.files.some((entry) => entry.path.startsWith("models/sam3/")), false);
  assert.equal(
    (await inspectOfflineBundle({
      zipPath: result.archivePath,
      expectedVersion: "1.3.0",
      expectedVariant: "cpu",
      publicKeyPem: fixture.publicKeyPem,
    })).status,
    "pass",
  );
});

test("offline bundle refuses unsigned production assembly unless explicitly allowed", async (t) => {
  const fixture = createFixture(t);
  await assert.rejects(
    buildOfflineBundle({
      version: "1.3.0",
      variant: "cu130",
      installerPath: fixture.installer,
      runtimeRoot: fixture.runtime,
      outputDir: fixture.outputDir,
    }),
    /requires .*private[- ]key/i,
  );
  const result = await buildOfflineBundle({
    version: "1.3.0",
    variant: "cu130",
    installerPath: fixture.installer,
    runtimeRoot: fixture.runtime,
    outputDir: fixture.outputDir,
    allowUnsigned: true,
    dryRun: true,
  });
  assert.equal(result.payload.signed, false);
});

test("offline bundle filters legacy payload FFmpeg because the installer already contains it", async (t) => {
  const fixture = createFixture(t);
  const payloadRoot = path.join(fixture.root, "legacy-payload");
  writeFile(payloadRoot, "runtime/env/python.exe", "python");
  writeFile(payloadRoot, "ffmpeg/ffmpeg.exe", "legacy duplicate");
  const result = await buildOfflineBundle({
    version: "1.3.0",
    variant: "cpu",
    installerPath: fixture.installer,
    payloadRoot,
    outputDir: fixture.outputDir,
    privateKeyPem: fixture.privateKeyPem,
  });
  const listing = spawnSync(path7za, ["l", result.archivePath], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.doesNotMatch(listing.stdout, /offline-payload[\\/]ffmpeg[\\/]/i);
  assert.match(listing.stdout, /offline-payload[\\/]runtime[\\/]env[\\/]python\.exe/i);
});
