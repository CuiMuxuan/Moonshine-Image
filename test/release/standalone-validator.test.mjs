import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildStandaloneValidator } from "../../scripts/validation/build-standalone-validator.mjs";

test("standalone validator builder creates a self-contained validation folder", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-validator-test-"));
  try {
    const keyPair = crypto.generateKeyPairSync("ed25519");
    const publicKeyPath = path.join(temporaryRoot, "public.pem");
    const nodePath = path.join(temporaryRoot, "fake-node.exe");
    fs.writeFileSync(publicKeyPath, keyPair.publicKey.export({ type: "spki", format: "pem" }));
    fs.writeFileSync(nodePath, "test-node");

    const result = buildStandaloneValidator({
      version: "1.3.0",
      channel: "test",
      source: "https://download.moonshine.email",
      publicKeyFile: publicKeyPath,
      nodeExe: nodePath,
      outputDir: temporaryRoot,
      archive: false,
      packageName: "validator-fixture",
    });

    assert.equal(result.archivePath, null);
    assert.equal(fs.existsSync(path.join(result.packageRoot, "Run-Moonshine-Image-Test-Validator.cmd")), true);
    assert.equal(fs.existsSync(path.join(result.packageRoot, "Run-Moonshine-Image-Test-Validator.ps1")), true);
    assert.equal(fs.existsSync(path.join(result.packageRoot, "node.exe")), true);
    assert.equal(fs.existsSync(path.join(result.packageRoot, "node_modules", "yaml")), true);
    assert.equal(fs.existsSync(path.join(result.packageRoot, "node_modules", "7zip-bin", "win", "x64", "7za.exe")), true);

    const config = JSON.parse(fs.readFileSync(path.join(result.packageRoot, "validator-config.json"), "utf8"));
    assert.deepEqual(config, {
      schemaVersion: 1,
      product: "Moonshine-Image",
      source: "https://download.moonshine.email",
      channel: "test",
      appVersion: "1.3.0",
    });
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.appVersion, "1.3.0");
    assert.equal(manifest.channel, "test");
    assert.ok(manifest.files.some((file) => file.path === "node.exe"));
    assert.equal(manifest.files.some((file) => file.path.includes("private-key")), false);
    assert.equal(fs.readFileSync(path.join(result.packageRoot, "scripts", "release", "app-release-lib.mjs"), "utf8").includes("@aws-sdk"), false);
    const wrapper = fs.readFileSync(path.join(result.packageRoot, "Run-Moonshine-Image-Test-Validator.ps1"), "utf8");
    assert.match(wrapper, /Get-StartupLogTail/);
    assert.match(wrapper, /Validation report contains failed checks/);
    assert.match(wrapper, /ConvertFrom-Json\)\.ok/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
