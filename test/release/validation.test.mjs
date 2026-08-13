import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalizeJson,
  MANIFEST_KEY_ID,
} from "../../src-electron/runtime/manifest-verifier.js";
import {
  checkRemoteObject,
  createValidationReport,
  evaluateSourceAvailability,
  inspectLocalInstall,
  inspectManagedEnvironment,
  objectUrl,
  recordCheck,
  resolveReleaseArtifactPath,
  sanitizeText,
  verifyManifestDocument,
} from "../../scripts/validation/release-validation-lib.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

function signedRuntimeManifest() {
  const now = Date.now();
  const payload = {
    schemaVersion: 1,
    channel: "stable",
    sequence: 2,
    appVersion: "1.3.0",
    platform: "win32",
    arch: "x64",
    publishedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(),
    components: [{
      id: "ffmpeg",
      kind: "ffmpeg",
      version: "7.0.0",
      artifactPath: "components/win-x64/releases/7.0.0/ffmpeg.zip",
      size: 5,
      sha256: "a".repeat(64),
      entrypoint: "ffmpeg.exe",
    }],
  };
  return {
    payload,
    signature: {
      algorithm: "Ed25519",
      keyId: MANIFEST_KEY_ID,
      value: sign(null, canonicalizeJson(payload), privateKey).toString("base64"),
    },
  };
}

function fakeFetch(objects) {
  return async (input, init = {}) => {
    const url = new URL(input);
    const object = objects.get(url.pathname.slice(1));
    if (!object) return new Response("missing", { status: 404 });
    const body = Buffer.from(object.body);
    if (init.method === "HEAD") {
      return new Response(null, { status: 200, headers: { "content-length": String(body.length) } });
    }
    const range = init.headers?.Range || init.headers?.range;
    if (range) {
      const [, startText, endText] = /bytes=(\d+)-(\d+)/.exec(range);
      const start = Number(startText);
      const end = Number(endText);
      return new Response(body.subarray(start, end + 1), {
        status: 206,
        headers: {
          "content-range": `bytes ${start}-${end}/${body.length}`,
          "content-length": String(end - start + 1),
        },
      });
    }
    return new Response(body, { status: 200, headers: { "content-length": String(body.length) } });
  };
}

test("validator checks signed manifests and full archive hash", async () => {
  const manifest = signedRuntimeManifest();
  const manifestBody = Buffer.from(JSON.stringify(manifest));
  const artifactBody = Buffer.from("12345");
  const objects = new Map([
    ["components/win-x64/stable/manifest.json", { body: manifestBody }],
    ["components/win-x64/releases/7.0.0/ffmpeg.zip", { body: artifactBody }],
  ]);
  const fetchImpl = fakeFetch(objects);
  const verified = await verifyManifestDocument({
    fetchImpl,
    baseUrl: "https://download.example",
    manifestPath: "components/win-x64/stable/manifest.json",
    publicKeys: { [MANIFEST_KEY_ID]: publicKey },
    channel: "stable",
    appVersion: "1.3.0",
  });
  assert.equal(verified.verification.sequence, 2);
  const checked = await checkRemoteObject({
    fetchImpl,
    baseUrl: "https://download.example",
    relativePath: manifest.payload.components[0].artifactPath,
    expectedSize: artifactBody.length,
    expectedSha256: "a".repeat(64),
  }).catch((error) => error);
  assert.match(checked.message, /sha256 mismatch/);
});

test("validator accepts compressed HEAD responses when Range and full hash still verify", async () => {
  const body = Buffer.from("compressed-text-manifest");
  const baseFetch = fakeFetch(new Map([["manifests/beta/latest.json", { body }]]));
  const result = await checkRemoteObject({
    fetchImpl: async (input, init = {}) => {
      const response = await baseFetch(input, init);
      if (init.method !== "HEAD") return response;
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.set("content-encoding", "br");
      return new Response(null, { status: response.status, headers });
    },
    baseUrl: "https://download.example",
    relativePath: "manifests/beta/latest.json",
    expectedSize: body.length,
    expectedSha256: createHash("sha256").update(body).digest("hex"),
  });
  assert.equal(result.size, body.length);
  assert.equal(result.sha256, createHash("sha256").update(body).digest("hex"));
});

test("validator report and URLs are sanitized", () => {
  const report = createValidationReport({
    primaryUrl: "https://user:secret@example.invalid/feed?token=secret",
  });
  recordCheck(report, {
    id: "secret",
    status: "fail",
    details: { url: "https://user:secret@example.invalid/a?token=secret" },
    error: new Error("-----BEGIN PRIVATE KEY----- secret -----END PRIVATE KEY-----"),
  });
  assert.equal(report.sources.primary, "https://example.invalid/feed");
  assert.equal(report.checks[0].details.url, "https://example.invalid/a");
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE KEY|token=secret|user:secret/);
  assert.equal(objectUrl("https://example.invalid/root/", "a/b.zip"), "https://example.invalid/root/a/b.zip");
  assert.equal(sanitizeText("R2 secret value", { R2_SECRET_ACCESS_KEY: "secret value" }), "R2 [redacted]");
});

test("release artifacts named by basename resolve beside latest.yml", () => {
  assert.equal(
    resolveReleaseArtifactPath("app/win-x64/test/latest.yml", "Moonshine-Image-Setup-1.3.0.exe"),
    "app/win-x64/test/Moonshine-Image-Setup-1.3.0.exe",
  );
  assert.equal(
    resolveReleaseArtifactPath("manifests/test/latest.json", "app/win-x64/test/Moonshine-Image-Setup-1.3.0.exe"),
    "app/win-x64/test/Moonshine-Image-Setup-1.3.0.exe",
  );
});

test("source-failover mode passes only when the independent mirror remains available", () => {
  assert.deepEqual(
    evaluateSourceAvailability({
      mode: "source-failover",
      primaryOk: false,
      mirrorConfigured: true,
      mirrorOk: true,
    }),
    {
      status: "pass",
      selectedSource: "mirror",
      failoverExercised: true,
      reason: "mirror remained available while the primary source was unavailable",
    },
  );
  assert.equal(evaluateSourceAvailability({
    mode: "network",
    primaryOk: false,
    mirrorConfigured: true,
    mirrorOk: true,
  }).status, "fail");
  assert.equal(evaluateSourceAvailability({
    mode: "source-failover",
    primaryOk: false,
    mirrorConfigured: true,
    mirrorOk: false,
  }).status, "fail");
});

test("managed environment inspection accepts a safe active pointer", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-validation-environment-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "environments", "cpu", "spec"), { recursive: true });
  fs.writeFileSync(path.join(root, "active.json"), JSON.stringify({
    flavor: "cpu",
    path: "environments/cpu/spec",
    pythonExecutableRelative: "python.exe",
    sequence: 1,
  }));
  fs.writeFileSync(path.join(root, "environments", "cpu", "spec", "python.exe"), "python");
  const result = await inspectManagedEnvironment({ environmentRoot: root, expectedFlavor: "cpu" });
  assert.equal(result.flavor, "cpu");
  assert.equal(result.python, "environments/cpu/spec/python.exe");
});

test("managed environment inspection finds the application user-data pointer and nested venv", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-validation-user-data-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const environmentPath = path.join(root, "environments", "win-x64", "cpu", "spec");
  fs.mkdirSync(path.join(environmentPath, "venv", "Scripts"), { recursive: true });
  fs.writeFileSync(path.join(environmentPath, "venv", "Scripts", "python.exe"), "python");
  fs.writeFileSync(path.join(root, "environments", "active.json"), JSON.stringify({
    accelerator: "cpu",
    path: "environments/win-x64/cpu/spec",
    pythonExecutableRelative: "venv/Scripts/python.exe",
    specHash: "a".repeat(64),
  }));
  const result = await inspectManagedEnvironment({ environmentRoot: root, expectedFlavor: "cpu" });
  assert.equal(result.python, "environments/win-x64/cpu/spec/venv/Scripts/python.exe");
  assert.equal(result.pythonExecutable, path.join(environmentPath, "venv", "Scripts", "python.exe"));
  assert.equal(result.specHash, "a".repeat(64));
});

test("managed environment inspection rejects staging and escaping Python pointers", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-validation-unsafe-pointer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const environmentPath = path.join(root, "environments", "win-x64", "cpu", "spec");
  fs.mkdirSync(path.join(environmentPath, "venv", "Scripts"), { recursive: true });
  fs.writeFileSync(path.join(environmentPath, "venv", "Scripts", "python.exe"), "python");
  fs.writeFileSync(path.join(root, "environments", "active.json"), JSON.stringify({
    accelerator: "cpu",
    path: "environments/win-x64/cpu/spec",
    pythonExecutableRelative: "../../.staging/python.exe",
  }));
  await assert.rejects(
    inspectManagedEnvironment({ environmentRoot: root, expectedFlavor: "cpu" }),
    /unsafe Python path/i,
  );
});

test("local installation inspection tolerates absent optional preload and requires packaged resources", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-validation-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = [
    "resources/app.asar",
    "resources/backend/server/main.py",
    "resources/backend/server/requirements-cpu.lock.txt",
    "resources/backend/server/requirements-cu130.lock.txt",
    "resources/ffmpeg/win-x64/ffmpeg.exe",
    "Moonshine-Image.exe",
  ];
  for (const relative of files) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, relative.endsWith(".exe") ? Buffer.from("MZfixture") : "fixture");
  }
  const protectedFiles = files.filter((relative) => relative.startsWith("resources/backend/") || relative.startsWith("resources/ffmpeg/"));
  const integrityManifest = {
    schemaVersion: 1,
    appVersion: "1.3.1",
    runtimeFlavor: "app-only",
    resourceMode: "app-only",
    hashAlgorithm: "sha256",
    entries: protectedFiles.map((relative) => {
      const target = path.join(root, relative);
      return {
        path: relative.slice("resources/".length).replace(/\\/g, "/"),
        size: fs.statSync(target).size,
        sha256: createHash("sha256").update(fs.readFileSync(target)).digest("hex"),
      };
    }),
  };
  const integrityBytes = Buffer.from(`${JSON.stringify(integrityManifest, null, 2)}\n`, "utf8");
  const integrityRoot = path.join(root, "resources", "integrity");
  fs.mkdirSync(integrityRoot, { recursive: true });
  fs.writeFileSync(path.join(integrityRoot, "manifest.json"), integrityBytes);
  fs.writeFileSync(path.join(integrityRoot, "manifest.sig"), `${sign(null, integrityBytes, privateKey).toString("base64")}\n`);
  const result = await inspectLocalInstall({
    installRoot: root,
    appExecutable: path.join(root, "Moonshine-Image.exe"),
    integrityPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  });
  assert.equal(result.missingRequired.length, 0);
  assert.equal(result.integrity.status, "pass", JSON.stringify(result.integrity));
  assert.equal(result.files["resources/preload/electron-preload.cjs"].present, false);
  assert.equal(result.files["resources/preload/electron-preload.cjs"].required, false);

  fs.writeFileSync(path.join(root, "resources", "backend", "server", "main.py"), "tampered");
  const tampered = await inspectLocalInstall({
    installRoot: root,
    integrityPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  });
  assert.equal(tampered.integrity.status, "fail");
  assert.match(tampered.integrity.issues.join("\n"), /size mismatch|hash mismatch/);
});
