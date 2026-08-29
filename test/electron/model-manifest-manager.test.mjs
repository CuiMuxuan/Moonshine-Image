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
  ModelManifestManager,
  MODEL_MANIFEST_STATUS,
} from "../../src-electron/runtime/model-manifest-manager.js";
import {
  createRuntimeLayout,
  readJson,
} from "../../src-electron/runtime/runtime-layout.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeys = { "moonshine-app-manifest-v1": publicKey };

function modelRecord(overrides = {}) {
  return {
    id: "lama",
    label: "LaMa",
    type: "image",
    family: "lama",
    downloadable: true,
    sourceLinks: [{ type: "huggingface", url: "https://huggingface.co/example/model.bin" }],
    manualSources: [{ type: "quark", url: "https://pan.quark.cn/s/example" }],
    files: [{ path: "big-lama.pt", size: 5, sha256: "a".repeat(64) }],
    license: { name: "Apache-2.0", url: "https://example.invalid/license" },
    ...overrides,
  };
}

function signedModelManifest(sequence = 1, overrides = {}) {
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
    models: [modelRecord()],
    ...overrides,
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

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-model-manifest-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = createRuntimeLayout({ localAppData: path.join(root, "components"), userData: root });
  let manifest = signedModelManifest(1);
  let online = true;
  const calls = [];
  const manager = new ModelManifestManager({
    layout,
    sources: [
      { id: "primary", baseUrl: "https://primary.example" },
      { id: "mirror", baseUrl: "https://mirror.example" },
    ],
    publicKeys,
    appVersion: "1.3.0",
    platform: "win32",
    arch: "x64",
    fetchImpl: async (url) => {
      calls.push(url);
      if (!online || url.startsWith("https://primary.example")) {
        return new Response("unavailable", { status: 503 });
      }
      return new Response(JSON.stringify(manifest), { status: 200 });
    },
  });
  return {
    layout,
    manager,
    calls,
    setManifest(value) { manifest = value; },
    setOnline(value) { online = value; },
  };
}

test("model manifest verifier accepts HF/Quark metadata and enforces the SAM license gate", () => {
  const sam3 = modelRecord({
    id: "sam3",
    type: "mask",
    family: "sam3",
    files: [{ path: "sam3/sam3.pt", size: 8, sha256: "b".repeat(64) }],
    license: {
      name: "SAM License",
      url: "https://github.com/facebookresearch/sam3/blob/main/LICENSE",
      requiresAcceptance: true,
      acceptanceId: "meta-sam-license-v1",
    },
  });
  const accepted = signedModelManifest(1, { models: [modelRecord(), sam3] });
  assert.equal(verifySignedManifest(accepted, { publicKeys }).payload.models.length, 2);

  const ungated = signedModelManifest(2, {
    models: [{ ...sam3, license: { name: "SAM License", url: sam3.license.url } }],
  });
  assert.throws(
    () => verifySignedManifest(ungated, { publicKeys }),
    (error) => error.code === "MANIFEST_LICENSE_GATE_REQUIRED",
  );
  const insecure = signedModelManifest(3, {
    models: [modelRecord({ sourceLinks: [{ url: "http://example.invalid/model.bin" }] })],
  });
  assert.throws(() => verifySignedManifest(insecure, { publicKeys }), /HTTPS URL/);
});

test("model manifest verifier accepts downloadable sources attached to each file", () => {
  const perFileSource = signedModelManifest(4, {
    models: [modelRecord({
      sourceLinks: [],
      files: [{
        path: "big-lama.pt",
        size: 5,
        sha256: "a".repeat(64),
        sourceLinks: [{ type: "huggingface", url: "https://huggingface.co/example/model.bin" }],
      }],
    })],
  });
  assert.doesNotThrow(() => verifySignedManifest(perFileSource, { publicKeys }));
});

test("ModelManifestManager falls back to the mirror and exposes only a verified backend path", async (t) => {
  const { manager, layout, calls } = await fixture(t);
  const result = await manager.refresh();
  assert.equal(result.success, true);
  assert.equal(result.state.status, MODEL_MANIFEST_STATUS.READY);
  assert.equal(result.state.sourceId, "mirror");
  assert.equal(result.state.modelCount, 1);
  assert.equal((await readJson(layout.verifiedModelManifest)).payload.sequence, 1);
  assert.equal(manager.getBackendEnvironment().MOONSHINE_MODEL_MANIFEST_PATH, layout.verifiedModelManifest);
  assert.equal(manager.getBackendEnvironment().MOONSHINE_REQUIRE_SIGNED_MODEL_MANIFEST, "1");
  assert.ok(calls.some((url) => url === "https://primary.example/models/stable/manifest.json"));
  assert.ok(calls.some((url) => url === "https://mirror.example/models/stable/manifest.json"));
});

test("ModelManifestManager keeps a valid cache during outage and refuses sequence rollback", async (t) => {
  const setup = await fixture(t);
  assert.equal((await setup.manager.refresh()).success, true);
  setup.setManifest(signedModelManifest(0));
  setup.setOnline(false);
  const outage = await setup.manager.refresh();
  assert.equal(outage.success, true);
  assert.equal(outage.code, "MODEL_MANIFEST_USING_CACHE");
  assert.equal(outage.state.status, MODEL_MANIFEST_STATUS.FALLBACK);
  assert.equal(outage.state.sequence, 1);

  setup.setOnline(true);
  setup.setManifest(signedModelManifest(1, { models: [modelRecord({ label: "Different bytes" })] }));
  const collision = await setup.manager.refresh();
  assert.equal(collision.success, true);
  assert.equal(collision.code, "MODEL_MANIFEST_USING_CACHE");
  assert.match(collision.error, /signature|sequence|rollback/i);
  assert.equal((await readJson(setup.layout.verifiedModelManifest)).payload.models[0].label, "LaMa");
});

test("disabled model manifest manager does not require signed registry mode", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-model-manifest-disabled-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = createRuntimeLayout({ localAppData: path.join(root, "components"), userData: root });
  const manager = new ModelManifestManager({ layout });
  assert.equal(manager.getState().status, MODEL_MANIFEST_STATUS.DISABLED);
  assert.deepEqual(manager.getBackendEnvironment(), {});
});
