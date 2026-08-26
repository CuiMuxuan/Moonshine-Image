import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalizeJson,
  verifySignedManifest,
} from "../../src-electron/runtime/manifest-verifier.js";
import {
  downloadArtifact,
  extractZipSafely,
  validateZipEntry,
} from "../../src-electron/runtime/asset-downloader.js";
import {
  createRuntimeLayout,
  ensureRuntimeDirectories,
  readJson,
  resolveComponentDirectory,
  resolveDownloadPaths,
  writeActivePointer,
} from "../../src-electron/runtime/runtime-layout.js";
import {
  ReleaseSourcePool,
  SOURCE_ERROR_KIND,
} from "../../src-electron/runtime/release-source.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const trustedKeys = { "moonshine-app-manifest-v1": publicKey };

function storedZipEntry(fileName, mode = 0o100600) {
  const name = Buffer.from(fileName, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((mode << 16) >>> 0, 38);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length, 16);
  return Buffer.concat([local, name, central, name, end]);
}

function signedManifest(overrides = {}) {
  const now = new Date();
  const payload = {
    schemaVersion: 1,
    channel: "stable",
    sequence: 10,
    appVersion: "1.3.0",
    platform: "win32",
    arch: "x64",
    publishedAt: new Date(now.getTime() - 1_000).toISOString(),
    expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    app: {
      latestYmlPath: "app/win-x64/stable/latest.yml",
      latestYmlSha256: "a".repeat(64),
      installerSha256: "b".repeat(64),
      installerSha512: Buffer.alloc(64, 3).toString("base64"),
    },
    components: [
      {
        id: "python-cpu",
        kind: "python-runtime",
        version: "3.12.1",
        artifactPath: "components/win-x64/python-cpu-3.12.1.zip",
        size: 8,
        sha256: "c".repeat(64),
        entrypoint: "python.exe",
      },
    ],
    ...overrides,
  };
  const value = sign(null, canonicalizeJson(payload), privateKey).toString("base64");
  return {
    payload,
    signature: { algorithm: "Ed25519", keyId: "moonshine-app-manifest-v1", value },
  };
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-runtime-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function responseFor(body, status, headers = {}) {
  return new Response(body, { status, headers });
}

test("canonical manifest verification accepts a signed payload and rejects tampering", () => {
  const manifest = signedManifest();
  const result = verifySignedManifest(manifest, {
    publicKeys: trustedKeys,
    expectedKeyId: "moonshine-app-manifest-v1",
    expectedChannel: "stable",
    expectedAppVersion: "1.3.0",
    expectedPlatform: "win32",
    expectedArch: "x64",
    minimumSequence: 10,
  });
  assert.equal(result.sequence, 10);
  assert.equal(result.payloadSha256.length, 64);
  assert.deepEqual([...canonicalizeJson({ b: 1, a: 2 })], [...Buffer.from('{"a":2,"b":1}')]);

  const tampered = structuredClone(manifest);
  tampered.payload.components[0].size = 9;
  assert.throws(
    () => verifySignedManifest(tampered, { publicKeys: trustedKeys }),
    (error) => error.code === "MANIFEST_SIGNATURE_INVALID"
  );
});

test("manifest verifier enforces key, sequence, time and path constraints", () => {
  const manifest = signedManifest({ sequence: 4 });
  assert.throws(
    () => verifySignedManifest(manifest, { publicKeys: trustedKeys, minimumSequence: 5 }),
    (error) => error.code === "MANIFEST_ROLLBACK"
  );
  assert.throws(
    () => verifySignedManifest(manifest, { publicKeys: {}, expectedKeyId: "moonshine-app-manifest-v1" }),
    (error) => error.code === "MANIFEST_UNKNOWN_KEY"
  );

  const expired = signedManifest({
    publishedAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2020-01-02T00:00:00.000Z",
  });
  assert.throws(
    () => verifySignedManifest(expired, { publicKeys: trustedKeys, clockSkewMs: 0 }),
    (error) => error.code === "MANIFEST_EXPIRED"
  );

  const unsafe = signedManifest({
    components: [{
      id: "python-cpu",
      kind: "python-runtime",
      version: "3.12.1",
      artifactPath: "components/../escape.zip",
      size: 8,
      sha256: "c".repeat(64),
    }],
  });
  const unsafeSignature = sign(null, canonicalizeJson(unsafe.payload), privateKey).toString("base64");
  unsafe.signature.value = unsafeSignature;
  assert.throws(
    () => verifySignedManifest(unsafe, { publicKeys: trustedKeys }),
    (error) => error.code === "MANIFEST_PATH_INVALID"
  );
});

test("runtime layout keeps component and download paths within the managed root", async (t) => {
  const directory = await temporaryDirectory(t);
  const layout = createRuntimeLayout({ localAppData: path.join(directory, "components"), userData: directory });
  await ensureRuntimeDirectories(layout);
  assert.equal(resolveComponentDirectory(layout, "python-cu130", "2.0.0"), path.join(layout.runtimes, "python-cu130", "2.0.0"));
  const paths = resolveDownloadPaths(layout, {
    artifactPath: "components/python-cu130.zip",
    sha256: "d".repeat(64),
  });
  assert.ok(paths.partial.startsWith(layout.downloads));
  await writeActivePointer(layout, { sequence: 1, components: {} });
  assert.deepEqual(await readJson(layout.activePointer), { sequence: 1, components: {} });
  assert.throws(() => resolveComponentDirectory(layout, "../escape", "1.0.0"), /component id/i);
  assert.throws(() => resolveDownloadPaths(layout, { artifactPath: "../escape.zip", sha256: "d".repeat(64) }), /unsafe|traversal/i);
});

test("downloader falls back to the mirror and verifies the final SHA-256", async (t) => {
  const directory = await temporaryDirectory(t);
  const body = Buffer.from("moonshine-runtime-payload");
  const artifact = {
    artifactPath: "components/win-x64/python-cpu.zip",
    size: body.length,
    sha256: (await import("node:crypto")).createHash("sha256").update(body).digest("hex"),
  };
  const paths = {
    destination: path.join(directory, "downloads", "runtime.zip"),
    partial: path.join(directory, "downloads", "runtime.zip.part"),
    metadata: path.join(directory, "downloads", "runtime.zip.meta.json"),
  };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.startsWith("https://primary.example")) return responseFor("down", 503);
    const range = new Headers(init.headers).get("range");
    const start = range ? Number(/^bytes=(\d+)-/.exec(range)[1]) : 0;
    return responseFor(body.subarray(start), start ? 206 : 200, {
      "content-length": String(body.length),
      etag: '"runtime-v1"',
      "accept-ranges": "bytes",
      ...(start ? { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
    });
  };
  const pool = new ReleaseSourcePool({ sources: [
    { id: "primary", baseUrl: "https://primary.example" },
    { id: "mirror", baseUrl: "https://mirror.example" },
  ], failureCooldownMs: 0 });
  const result = await downloadArtifact({
    artifact,
    paths,
    sourcePool: pool,
    fetchImpl,
    attemptsPerSource: 1,
    retryDelayMs: 0,
    diskSafetyBytes: 0,
  });
  assert.equal(result.sourceId, "mirror");
  assert.equal(result.sha256, artifact.sha256);
  assert.deepEqual(await fs.readFile(paths.destination), body);
  assert.equal(calls.filter((call) => call.init.method === "HEAD").length, 2);
  assert.equal(calls.filter((call) => call.init.method === "GET").length, 1);
});

test("downloader resumes an ETag-matched partial file with a byte range", async (t) => {
  const directory = await temporaryDirectory(t);
  const body = Buffer.from("0123456789abcdef");
  const { createHash } = await import("node:crypto");
  const artifact = {
    artifactPath: "components/ffmpeg.zip",
    size: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
  const paths = {
    destination: path.join(directory, "runtime.zip"),
    partial: path.join(directory, "runtime.zip.part"),
    metadata: path.join(directory, "runtime.zip.meta.json"),
  };
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(paths.partial, body.subarray(0, 6));
  await fs.writeFile(paths.metadata, JSON.stringify({
    schemaVersion: 1,
    url: "https://mirror.example/components/ffmpeg.zip",
    sourceId: "mirror",
    etag: '"ffmpeg-v1"',
    size: body.length,
    sha256: artifact.sha256,
  }));
  const ranges = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === "HEAD") return responseFor(null, 200, {
      "content-length": String(body.length),
      etag: '"ffmpeg-v1"',
      "accept-ranges": "bytes",
    });
    const range = new Headers(init.headers).get("range");
    ranges.push(range);
    const start = Number(/^bytes=(\d+)-/.exec(range)[1]);
    return responseFor(body.subarray(start), 206, {
      "content-length": String(body.length - start),
      "content-range": `bytes ${start}-${body.length - 1}/${body.length}`,
    });
  };
  const result = await downloadArtifact({
    artifact,
    paths,
    sources: [{ id: "mirror", baseUrl: "https://mirror.example" }],
    fetchImpl,
    attemptsPerSource: 1,
    retryDelayMs: 0,
    diskSafetyBytes: 0,
  });
  assert.equal(result.resumedFrom, 6);
  assert.deepEqual(ranges, [`bytes=6-${body.length - 1}`]);
  assert.deepEqual(await fs.readFile(paths.destination), body);
});

test("downloader stops on hash mismatch, cancellation, and disk preflight failure", async (t) => {
  const directory = await temporaryDirectory(t);
  const body = Buffer.from("wrong-payload");
  const artifact = { artifactPath: "components/bad.zip", size: body.length, sha256: "e".repeat(64) };
  const paths = {
    destination: path.join(directory, "bad.zip"),
    partial: path.join(directory, "bad.zip.part"),
    metadata: path.join(directory, "bad.zip.meta.json"),
  };
  const fetchImpl = async (_url, init = {}) => {
    if (init.method === "HEAD") return responseFor(null, 200, {
      "content-length": String(body.length), etag: '"bad"', "accept-ranges": "bytes",
    });
    return responseFor(body, 200, { "content-length": String(body.length) });
  };
  await assert.rejects(
    downloadArtifact({ artifact, paths, sources: [{ id: "one", baseUrl: "https://one.example" }], fetchImpl, attemptsPerSource: 1, retryDelayMs: 0, diskSafetyBytes: 0 }),
    (error) => error.code === "ASSET_HASH_MISMATCH" || /All release sources failed/.test(error.message)
  );
  assert.equal(await fs.stat(paths.destination).catch(() => null), null);

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    downloadArtifact({
      artifact: { ...artifact, sha256: "f".repeat(64) },
      paths: { destination: path.join(directory, "cancel.zip"), partial: path.join(directory, "cancel.part"), metadata: path.join(directory, "cancel.meta") },
      sources: [{ id: "one", baseUrl: "https://one.example" }],
      fetchImpl,
      signal: cancelled.signal,
      attemptsPerSource: 1,
      retryDelayMs: 0,
      diskSafetyBytes: 0,
    }),
    (error) => error.code === "ASSET_DOWNLOAD_CANCELLED" || error.kind === SOURCE_ERROR_KIND.CANCELLED
  );

  await assert.rejects(
    downloadArtifact({
      artifact: { ...artifact, sha256: "f".repeat(64) },
      paths: { destination: path.join(directory, "disk.zip"), partial: path.join(directory, "disk.part"), metadata: path.join(directory, "disk.meta") },
      sources: [{ id: "one", baseUrl: "https://one.example" }],
      fetchImpl,
      ensureDiskSpace: async () => { throw new Error("disk full"); },
      attemptsPerSource: 1,
      retryDelayMs: 0,
      diskSafetyBytes: 0,
    }),
    /All release sources failed|disk full/i
  );
});

test("safe extraction rejects traversal and symlink entries before activation", async (t) => {
  assert.throws(
    () => validateZipEntry({ fileName: "../escape", externalFileAttributes: 0 }),
    (error) => error.code === "ASSET_ZIP_PATH_TRAVERSAL"
  );
  const directory = await temporaryDirectory(t);
  const archive = path.join(directory, "runtime.zip");
  const target = path.join(directory, "staging");
  await fs.writeFile(archive, "fixture");
  await assert.rejects(
    extractZipSafely({
      archivePath: archive,
      destination: target,
      extractImpl: async (_archive, options) => options.onEntry({ fileName: "../escape", externalFileAttributes: 0 }),
    }),
    (error) => error.code === "ASSET_ZIP_PATH_TRAVERSAL"
  );
  assert.equal(await fs.stat(target).catch(() => null), null);
});

test("safe extraction writes regular ZIP entries and rejects real symlink archives", async (t) => {
  const directory = await temporaryDirectory(t);
  const archive = path.join(directory, "runtime.zip");
  const target = path.join(directory, "runtime");
  await fs.writeFile(archive, storedZipEntry("runtime/bin/tool.txt"));

  const extracted = await extractZipSafely({ archivePath: archive, destination: target });
  assert.equal(extracted.entries, 1);
  assert.equal(extracted.uncompressedBytes, 0);
  assert.equal((await fs.stat(path.join(target, "runtime", "bin", "tool.txt"))).isFile(), true);

  const symlinkArchive = path.join(directory, "symlink.zip");
  const symlinkTarget = path.join(directory, "symlink-target");
  await fs.writeFile(symlinkArchive, storedZipEntry("runtime/link", 0o120777));
  await assert.rejects(
    extractZipSafely({ archivePath: symlinkArchive, destination: symlinkTarget }),
    (error) => error.code === "ASSET_ZIP_SYMLINK"
  );
  assert.equal(await fs.stat(symlinkTarget).catch(() => null), null);
});
