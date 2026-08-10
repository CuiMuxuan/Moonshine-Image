import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parse as parseYaml } from "yaml";

import { verifySignedManifest } from "../../src-electron/runtime/manifest-verifier.js";
import {
  assertModelChannelConfirmation,
  createModelReleasePlan,
  publishModelManifest,
  putModelChannelManifest,
} from "../../scripts/release/model-release-lib.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

function descriptor() {
  return {
    models: [
      {
        id: "lama",
        label: "LaMa",
        type: "image",
        family: "lama",
        downloadable: true,
        sourceLinks: [{ type: "huggingface", url: "https://huggingface.co/example/lama.pt" }],
        manualSources: [{ type: "quark", url: "https://pan.quark.cn/s/example" }],
        files: [{ path: "big-lama.pt", size: 5, sha256: "a".repeat(64) }],
        license: { name: "Apache-2.0", url: "https://example.invalid/license" },
      },
      {
        id: "sam3",
        label: "SAM3",
        type: "mask",
        family: "sam3",
        downloadable: true,
        sourceLinks: [{ type: "huggingface", url: "https://huggingface.co/example/sam3.pt" }],
        manualSources: [{ type: "quark", url: "https://pan.quark.cn/s/example" }],
        files: [{ path: "sam3/sam3.pt", size: 8, sha256: "b".repeat(64) }],
        license: {
          name: "SAM License",
          url: "https://github.com/facebookresearch/sam3/blob/main/LICENSE",
          requiresAcceptance: true,
          acceptanceId: "meta-sam-license-v1",
        },
      },
    ],
  };
}

async function readBody(body) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body);
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

class FakeS3Client {
  constructor(id, events = []) {
    this.id = id;
    this.events = events;
    this.objects = new Map();
  }

  async send(command) {
    const input = command.input;
    const name = command.constructor.name;
    const existing = this.objects.get(input.Key);
    this.events.push({ target: this.id, command: name, key: input.Key });
    if (name === "HeadObjectCommand") {
      if (!existing) {
        const error = new Error("not found");
        error.name = "NotFound";
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }
      return {
        ContentLength: existing.body.length,
        ContentType: existing.contentType,
        CacheControl: existing.cacheControl,
        Metadata: existing.metadata,
      };
    }
    if (name === "GetObjectCommand") return { Body: existing.body };
    if (name === "PutObjectCommand") {
      this.objects.set(input.Key, {
        body: await readBody(input.Body),
        contentType: input.ContentType,
        cacheControl: input.CacheControl,
        metadata: input.Metadata,
      });
      return {};
    }
    throw new Error(`Unexpected S3 command: ${name}`);
  }
}

function publicFetch(clients) {
  return async (input, init = {}) => {
    const url = new URL(input);
    const key = url.pathname.slice(1).split("/").map(decodeURIComponent).join("/");
    const object = clients.get(url.origin)?.objects.get(key);
    if (!object) return new Response("missing", { status: 404 });
    const headers = {
      "content-type": object.contentType,
      "content-length": String(object.body.length),
      "cache-control": object.cacheControl,
    };
    if (init.method === "HEAD") return new Response(null, { status: 200, headers });
    const range = new Headers(init.headers).get("range");
    if (range) {
      const [, startText, endText] = /^bytes=(\d+)-(\d+)$/.exec(range);
      const start = Number(startText);
      const end = Math.min(Number(endText), object.body.length - 1);
      return new Response(object.body.subarray(start, end + 1), {
        status: 206,
        headers: {
          ...headers,
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${object.body.length}`,
        },
      });
    }
    return new Response(object.body, { status: 200, headers });
  };
}

test("model release signs only the remote catalog and keeps weight URLs external", async () => {
  const plan = await createModelReleasePlan({
    descriptor: descriptor(),
    appVersion: "1.3.0",
    channel: "beta",
    sequence: 23,
    privateKey,
    primaryBaseUrl: "https://download.moonshine.email",
    mirrorBaseUrl: "https://mirror.example.invalid",
  });
  assert.equal(plan.object.key, "models/beta/manifest.json");
  assert.equal(plan.payload.models.length, 2);
  assert.ok(plan.payload.models.every((model) => model.sourceLinks[0].url.startsWith("https://huggingface.co/")));
  assert.ok(!plan.object.key.endsWith(".pt"));
  assert.equal(plan.mirror.parity, "byte-identical");
  const verified = verifySignedManifest(plan.manifest, {
    publicKeys: { "moonshine-app-manifest-v1": publicKey },
    expectedChannel: "beta",
    expectedAppVersion: "1.3.0",
    expectedPlatform: "win32",
    expectedArch: "x64",
  });
  assert.equal(verified.sequence, 23);
});

test("model manifests are byte-identical when review timestamps are fixed", async () => {
  const options = {
    descriptor: descriptor(),
    appVersion: "1.3.0",
    channel: "test",
    sequence: 1,
    publishedAt: "2026-08-08T00:00:00.000Z",
    expiresAt: "2026-09-07T00:00:00.000Z",
    privateKey,
  };
  const first = await createModelReleasePlan(options);
  const second = await createModelReleasePlan(options);

  assert.equal(first.object.sha256, second.object.sha256);
  assert.deepEqual(first.object.body, second.object.body);
});

test("model release dry-run performs no network calls and needs no private key", async () => {
  const plan = await createModelReleasePlan({
    descriptor: descriptor(),
    appVersion: "1.3.0",
    channel: "test",
    sequence: 1,
  });
  const result = await publishModelManifest({
    plan,
    targets: [{ id: "primary", config: { bucket: "dry-run", publicBaseUrl: "https://download.moonshine.email" } }],
    dryRun: true,
    fetchImpl: () => assert.fail("dry-run must not access the network"),
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.targets[0].key, "models/test/manifest.json");
});

test("model release publishes the mirror before the primary and enforces sequence monotonicity", async () => {
  const events = [];
  const primary = new FakeS3Client("primary", events);
  const mirror = new FakeS3Client("mirror", events);
  const plan = await createModelReleasePlan({
    descriptor: descriptor(),
    appVersion: "1.3.0",
    channel: "test",
    sequence: 5,
    privateKey,
    mirrorBaseUrl: "https://mirror.example.invalid",
  });
  const targets = [
    { id: "primary", client: primary, config: { bucket: "primary", publicBaseUrl: "https://download.moonshine.email" } },
    { id: "mirror", client: mirror, config: { bucket: "mirror", publicBaseUrl: "https://mirror.example.invalid" } },
  ];
  const result = await publishModelManifest({
    plan,
    targets,
    confirmation: "test:1.3.0",
    fetchImpl: publicFetch(new Map([
      ["https://download.moonshine.email", primary],
      ["https://mirror.example.invalid", mirror],
    ])),
    attempts: 1,
    retryDelayMs: 0,
  });
  assert.equal(result.targets.length, 2);
  assert.deepEqual(
    events.filter((event) => event.command === "PutObjectCommand").map((event) => event.target),
    ["mirror", "primary"],
  );
  assert.equal(primary.objects.size, 1);
  assert.equal(primary.objects.get("models/test/manifest.json").metadata.modelsequence, "5");

  const older = await createModelReleasePlan({
    descriptor: descriptor(),
    appVersion: "1.3.0",
    channel: "test",
    sequence: 4,
    privateKey,
  });
  await assert.rejects(
    putModelChannelManifest({ client: primary, bucket: "primary", plan: older }),
    /Refusing to roll.*sequence 5/,
  );
  assert.throws(() => assertModelChannelConfirmation("stable:1.3.0", plan), /test:1\.3\.0/);
});

test("model release rejects insecure automatic sources and ungated SAM3 metadata", async () => {
  await assert.rejects(
    createModelReleasePlan({
      descriptor: { models: [{ ...descriptor().models[0], sourceLinks: [{ url: "http://example.invalid/model" }] }] },
      appVersion: "1.3.0",
      sequence: 1,
    }),
    /HTTPS URL/,
  );
  await assert.rejects(
    createModelReleasePlan({
      descriptor: {
        models: [{
          ...descriptor().models[1],
          license: { name: "SAM License", url: "https://example.invalid/license" },
        }],
      },
      appVersion: "1.3.0",
      sequence: 1,
    }),
    /license acceptance gate/,
  );
});

test("Windows workflow keeps model and component publication out of the app-only path", () => {
  const workflow = parseYaml(fs.readFileSync(path.resolve(".github/workflows/release-windows.yml"), "utf8"));
  const immutableCommands = workflow.jobs["build-and-upload-immutable"].steps
    .map((step) => step.run || "")
    .join("\n");
  assert.doesNotMatch(immutableCommands, /release:(?:model|component):/);
  assert.doesNotMatch(JSON.stringify(workflow.jobs), /release:(?:model|component):/);
  assert.match(immutableCommands, /build:offline:bundle:win/);
  assert.ok(workflow.on.workflow_dispatch.inputs.offline_payload_root);
});
