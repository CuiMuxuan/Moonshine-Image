import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalizeJson } from "../../src-electron/runtime/manifest-verifier.js";
import { RuntimeManager, RUNTIME_STATUS } from "../../src-electron/runtime/runtime-manager.js";
import {
  createRuntimeLayout,
  readJson,
  resolveComponentDirectory,
} from "../../src-electron/runtime/runtime-layout.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

function makeManifest(sequence, versions = { python: "1.0.0", ffmpeg: "7.0.0" }) {
  const now = Date.now();
  const payload = {
    schemaVersion: 1,
    channel: "stable",
    sequence,
    appVersion: "1.3.0",
    platform: "win32",
    arch: "x64",
    publishedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(),
    components: [
      {
        id: "python-cpu",
        kind: "python-runtime",
        version: versions.python,
        artifactPath: `components/python-cpu-${versions.python}.zip`,
        size: 10,
        sha256: "a".repeat(64 - String(sequence).length) + String(sequence),
        entrypoint: "python.exe",
      },
      {
        id: "ffmpeg",
        kind: "ffmpeg",
        version: versions.ffmpeg,
        artifactPath: `components/ffmpeg-${versions.ffmpeg}.zip`,
        size: 5,
        sha256: "b".repeat(64 - String(sequence).length) + String(sequence),
        entrypoint: "ffmpeg.exe",
      },
    ],
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

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-manager-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const layout = createRuntimeLayout({ localAppData: path.join(directory, "components"), userData: directory });
  let manifest = makeManifest(1);
  const fetchImpl = async (url) => {
    if (url.startsWith("https://primary.example")) return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify(manifest), { status: 200, headers: { "content-type": "application/json" } });
  };
  const extracted = [];
  const manager = new RuntimeManager({
    layout,
    sources: [
      { id: "primary", baseUrl: "https://primary.example" },
      { id: "mirror", baseUrl: "https://mirror.example" },
    ],
    publicKeys: { "moonshine-app-manifest-v1": publicKey },
    fetchImpl,
    appVersion: "1.3.0",
    now: () => Date.now(),
    probeComponent: async (component, root) => {
      const entrypoint = path.join(root, component.entrypoint || "python.exe");
      try {
        await fs.access(entrypoint);
        return { success: true, entrypoint: component.entrypoint || "python.exe" };
      } catch {
        return { success: false, error: "entrypoint missing" };
      }
    },
    downloadImpl: async ({ artifact, paths }) => {
      await fs.mkdir(path.dirname(paths.destination), { recursive: true });
      await fs.writeFile(paths.destination, Buffer.alloc(artifact.size, artifact.id === "ffmpeg" ? 0x62 : 0x61));
      return { path: paths.destination, sourceId: "mirror" };
    },
    extractImpl: async ({ destination }) => {
      await fs.mkdir(destination, { recursive: true });
      const isFfmpeg = destination.includes(`${path.sep}ffmpeg`);
      await fs.writeFile(path.join(destination, isFfmpeg ? "ffmpeg.exe" : "python.exe"), "probe");
      extracted.push(destination);
      return { destination };
    },
    canActivate: async () => true,
  });
  return { directory, layout, manager, setManifest: (next) => { manifest = next; }, extracted };
}

test("RuntimeManager checks a signed manifest and installs CPU plus FFmpeg atomically", async (t) => {
  const { manager, layout } = await setup(t);
  const checked = await manager.check();
  assert.equal(checked.success, true);
  assert.equal(checked.state.status, RUNTIME_STATUS.NEEDS_DOWNLOAD);
  assert.equal(checked.state.lastSourceId, "mirror");
  const result = await manager.ensure({ accelerator: "cpu" });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.state.status, RUNTIME_STATUS.READY);
  assert.equal(result.components["python-cpu"].version, "1.0.0");
  const pointer = await readJson(layout.activePointer);
  assert.ok(pointer.components.ffmpeg);
  assert.equal(pointer.components["python-cpu"].entrypoint, "python.exe");
  assert.ok(manager.getActiveBackendSpec().pythonExecutable.endsWith(`${path.sep}python.exe`));

  const restored = new RuntimeManager({ layout });
  await restored.initialize();
  assert.equal(restored.getState().selectedAccelerator, "cpu");
  assert.equal(restored.getState().activeComponents["python-cpu"].version, "1.0.0");
  assert.ok(restored.getActiveBackendSpec().pythonExecutable.endsWith(`${path.sep}python.exe`));
});

test("RuntimeManager serializes operations and rolls back to the previous verified pointer", async (t) => {
  const setupResult = await setup(t);
  const { manager, setManifest, layout } = setupResult;
  const first = manager.check();
  const busy = await manager.check();
  assert.equal((await first).success, true);
  assert.equal(busy.code, "RUNTIME_BUSY");
  assert.equal((await manager.ensure({ accelerator: "cpu" })).success, true);
  setManifest(makeManifest(2, { python: "2.0.0", ffmpeg: "8.0.0" }));
  assert.equal((await manager.ensure({ accelerator: "cpu" })).success, true);
  const current = await readJson(layout.activePointer);
  assert.equal(current.components["python-cpu"].version, "2.0.0");
  const rollback = await manager.rollback();
  assert.equal(rollback.success, true);
  assert.equal(rollback.pointer.components["python-cpu"].version, "1.0.0");
});

test("RuntimeManager leaves the old pointer unchanged when activation is blocked", async (t) => {
  const { manager, layout, extracted } = await setup(t);
  manager.canActivate = async () => false;
  const result = await manager.ensure({ accelerator: "cpu" });
  assert.equal(result.success, false);
  assert.equal(result.code, "RUNTIME_ACTIVATION_BLOCKED");
  assert.equal(await readJson(layout.activePointer), null);
  assert.equal(extracted.length, 2);

  manager.canActivate = async () => true;
  const retried = await manager.ensure({ accelerator: "cpu" });
  assert.equal(retried.success, true, JSON.stringify(retried));
  assert.equal(extracted.length, 2, "healthy downloaded components should be reused without extraction");
});

test("RuntimeManager rejects a same-version manifest with different component bytes", async (t) => {
  const { manager, setManifest, layout, extracted } = await setup(t);
  assert.equal((await manager.ensure({ accelerator: "cpu" })).success, true);
  const originalPointer = await readJson(layout.activePointer);

  setManifest(makeManifest(2));
  const result = await manager.ensure({ accelerator: "cpu" });
  assert.equal(result.success, false);
  assert.equal(result.code, "RUNTIME_COMPONENT_VERSION_COLLISION");
  assert.deepEqual(await readJson(layout.activePointer), originalPointer);
  assert.equal(extracted.length, 2, "a version collision must be rejected before downloading or extracting");
});

test("RuntimeManager keeps an unhealthy active component intact and cleans repair staging when activation is blocked", async (t) => {
  const { manager, layout, extracted } = await setup(t);
  assert.equal((await manager.ensure({ accelerator: "cpu" })).success, true);
  const target = resolveComponentDirectory(layout, "python-cpu", "1.0.0");
  await fs.rm(path.join(target, "python.exe"));
  manager.canActivate = async () => false;

  const result = await manager.ensure({ accelerator: "cpu" });
  assert.equal(result.success, false);
  assert.equal(result.code, "RUNTIME_ACTIVATION_BLOCKED");
  assert.equal(await fs.stat(path.join(target, "python.exe")).catch((error) => error.code), "ENOENT");
  const repairStaging = extracted.at(-1);
  assert.equal(await fs.stat(repairStaging).catch((error) => error.code), "ENOENT");
});

test("RuntimeManager persists and restores the selected channel", async (t) => {
  const first = await setup(t);
  assert.equal((await first.manager.setChannel("beta")).success, true);
  const second = await setup(t);
  await fs.mkdir(path.dirname(second.layout.channelPreferences), { recursive: true });
  await fs.copyFile(first.layout.channelPreferences, second.layout.channelPreferences).catch(() => {});
  await second.manager.initialize();
  assert.equal(second.manager.getState().channel, "beta");
  const stored = await readJson(first.layout.channelPreferences);
  assert.equal(stored.channel, "beta");
});
