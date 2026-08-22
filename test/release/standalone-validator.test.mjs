import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildStandaloneValidator } from "../../scripts/validation/build-standalone-validator.mjs";
import { EMBEDDED_RELEASE_PUBLIC_KEY_PEM } from "../../src-electron/runtime/release-public-key.generated.js";
import {
  defaultUserDataRoot,
  resolveValidationEdition,
  run,
} from "../../scripts/validation/run-release-validation.mjs";

function guardValidatorEntrySideEffects(t) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-validator-entry-"));
  const sentinelPath = path.join(temporaryRoot, "sentinel.txt");
  fs.writeFileSync(sentinelPath, "unchanged");

  const originalFetch = globalThis.fetch;
  const originalCwd = process.cwd;
  const originalAppData = process.env.APPDATA;
  const originalStdoutWrite = process.stdout.write;
  let fetchCalls = 0;
  let stdout = "";
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("validator entry must not fetch before argument validation");
  };
  process.cwd = () => temporaryRoot;
  process.env.APPDATA = temporaryRoot;
  process.stdout.write = (chunk) => {
    stdout += String(chunk);
    return true;
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
    process.cwd = originalCwd;
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    process.stdout.write = originalStdoutWrite;
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  return {
    assertNoSideEffects() {
      assert.equal(fetchCalls, 0);
      assert.deepEqual(fs.readdirSync(temporaryRoot).sort(), ["sentinel.txt"]);
      assert.equal(fs.readFileSync(sentinelPath, "utf8"), "unchanged");
    },
    stdout: () => stdout,
  };
}

test("standalone validator help returns zero without network or filesystem changes", { concurrency: false }, async (t) => {
  const guard = guardValidatorEntrySideEffects(t);

  assert.equal(await run(["--help"]), 0);
  assert.match(guard.stdout(), /^Usage: node scripts\/validation\/run-release-validation\.mjs/m);
  guard.assertNoSideEffects();
});

test("standalone validator rejects a missing source before network or filesystem changes", { concurrency: false }, async (t) => {
  const guard = guardValidatorEntrySideEffects(t);

  await assert.rejects(run([]), /--source is required/);
  assert.equal(guard.stdout(), "");
  guard.assertNoSideEffects();
});

test("standalone validator builder creates a self-contained validation folder", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-validator-test-"));
  try {
    const keyPair = crypto.generateKeyPairSync("ed25519");
    const publicKeyPath = path.join(temporaryRoot, "public.pem");
    const nodePath = path.join(temporaryRoot, "fake-node.exe");
    fs.writeFileSync(publicKeyPath, keyPair.publicKey.export({ type: "spki", format: "pem" }));
    fs.writeFileSync(nodePath, "test-node");

    const result = buildStandaloneValidator({
      version: "1.3.3-test.1",
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
    assert.equal(fs.existsSync(path.join(result.packageRoot, "scripts", "validation", "support-diagnostics-lib.mjs")), true);
    assert.equal(fs.existsSync(path.join(result.packageRoot, "src", "shared", "appConfigSchema.js")), true);
    assert.equal(fs.existsSync(path.join(result.packageRoot, "src", "utils", "shortcutConfig.js")), true);
    assert.equal(fs.existsSync(path.join(result.packageRoot, "requirements", "requirements-cpu.lock.txt")), true);
    assert.equal(fs.existsSync(path.join(result.packageRoot, "requirements", "requirements-cu130.lock.txt")), true);
    assert.equal(fs.existsSync(path.join(result.packageRoot, "node_modules", "yaml")), true);
    assert.equal(fs.existsSync(path.join(result.packageRoot, "node_modules", "7zip-bin", "win", "x64", "7za.exe")), true);

    const config = JSON.parse(fs.readFileSync(path.join(result.packageRoot, "validator-config.json"), "utf8"));
    assert.deepEqual(config, {
      schemaVersion: 1,
      product: "Moonshine-Image-Test",
      edition: "test",
      appId: "com.moonshine.image.test",
      source: "https://download.moonshine.email",
      channel: "test",
      appVersion: "1.3.3-test.1",
    });
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.appVersion, "1.3.3-test.1");
    assert.equal(manifest.channel, "test");
    assert.ok(manifest.files.some((file) => file.path === "node.exe"));
    assert.equal(manifest.files.some((file) => file.path.includes("private-key")), false);
    assert.equal(fs.readFileSync(path.join(result.packageRoot, "scripts", "release", "app-release-lib.mjs"), "utf8").includes("@aws-sdk"), false);
    const wrapper = fs.readFileSync(path.join(result.packageRoot, "Run-Moonshine-Image-Test-Validator.ps1"), "utf8");
    assert.match(wrapper, /Get-StartupLogTail/);
    assert.match(wrapper, /function Get-ValidatorIdentity/);
    assert.match(wrapper, /Find-MoonshineInstall -ProductName \$identity\.productName -ExecutableName \$identity\.executableName/);
    assert.match(wrapper, /-DefaultUserDataName \$identity\.userDataName/);
    assert.doesNotMatch(wrapper, /Join-Path \$env:APPDATA "Moonshine-Image"/);
    assert.match(wrapper, /Validation report contains failed checks/);
    assert.match(wrapper, /ConvertFrom-Json\)\.ok/);
    assert.match(wrapper, /--user-data/);
    assert.match(wrapper, /--requirements-root/);
    assert.match(wrapper, /-not \$FullDownload/);
    assert.match(wrapper, /& \$nodePath @validatorArgs 2>&1 \| ForEach-Object/);
    assert.doesNotMatch(wrapper, /\$nodeOutput = @\(& \$nodePath/);
    const validator = fs.readFileSync(path.join(result.packageRoot, "scripts", "validation", "run-release-validation.mjs"), "utf8");
    assert.match(validator, /\[验证\]\[阶段/);
    assert.match(validator, /startHeartbeat/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("standalone validation defaults stay isolated by app edition", () => {
  const appData = "C:\\Users\\validator\\AppData\\Roaming";
  assert.equal(
    defaultUserDataRoot({ appData, appVersion: "1.3.3-test.2", channel: "test" }),
    path.join(appData, "Moonshine-Image-Test"),
  );
  assert.equal(
    defaultUserDataRoot({ appData, appVersion: "1.3.3", channel: "stable" }),
    path.join(appData, "Moonshine-Image"),
  );
  assert.equal(resolveValidationEdition({ channel: "test" }).productName, "Moonshine-Image-Test");
  assert.equal(resolveValidationEdition({ appVersion: "1.3.3-test.2" }).channel, "test");
  assert.throws(
    () => defaultUserDataRoot({ appData, appVersion: "1.3.3-test.2", channel: "stable" }),
    /locked to the test channel/,
  );
});

test("standalone validator defaults to the current package version", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-validator-version-"));
  try {
    const nodePath = path.join(temporaryRoot, "fake-node.exe");
    fs.writeFileSync(nodePath, "test-node");
    const result = buildStandaloneValidator({
      channel: "test",
      nodeExe: nodePath,
      outputDir: temporaryRoot,
      archive: false,
      packageName: "validator-version-fixture",
    });
    const validatorPackage = JSON.parse(fs.readFileSync(path.join(result.packageRoot, "package.json"), "utf8"));
    const applicationPackage = JSON.parse(fs.readFileSync("package.json", "utf8"));
    assert.equal(validatorPackage.version, applicationPackage.version);
    assert.equal(result.manifest.appVersion, applicationPackage.version);
    assert.equal(
      fs.readFileSync(path.join(result.packageRoot, "release-public-key.pem"), "utf8").replace(/\r\n/g, "\n").trim(),
      EMBEDDED_RELEASE_PUBLIC_KEY_PEM.replace(/\r\n/g, "\n").trim(),
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
