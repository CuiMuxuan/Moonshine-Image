import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertMirrorParity,
  assertSignedComponentManifest,
  createComponentReleasePlan,
  normalizeComponentChannel,
} from "../../scripts/release/component-release-lib.mjs";
import {
  assertComponentChannelConfirmation,
  putComponentChannelManifest,
  uploadComponentRelease,
} from "../../scripts/release/component-release-upload-lib.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-component-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "python.zip"), Buffer.from("python-component-bytes"));
  await fs.writeFile(path.join(root, "ffmpeg.zip"), Buffer.from("ffmpeg-component-bytes"));
  return root;
}

function descriptor() {
  return {
    components: [
      {
        id: "python-cpu",
        kind: "python-runtime",
        version: "3.12.1",
        file: "python.zip",
        entrypoint: "python.exe",
        accelerator: "cpu",
      },
      {
        id: "ffmpeg",
        kind: "ffmpeg",
        version: "7.0.0",
        file: "ffmpeg.zip",
        entrypoint: "ffmpeg.exe",
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
    this.commands = [];
    this.objects = new Map();
  }

  async send(command) {
    this.commands.push(command);
    const name = command.constructor.name;
    const input = command.input;
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
    if (name === "GetObjectCommand") {
      if (!existing) throw new Error("missing fake object");
      return { Body: existing.body };
    }
    if (name === "PutObjectCommand") {
      if (input.IfNoneMatch === "*" && existing) {
        const error = new Error("precondition failed");
        error.name = "PreconditionFailed";
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
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

function publicFetchByOrigin(clients) {
  return async (input, init = {}) => {
    const url = new URL(input);
    const client = clients.get(url.origin);
    const key = url.pathname
      .replace(/^\//, "")
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
    const object = client?.objects.get(key);
    if (!object) return new Response("missing", { status: 404 });
    const headers = {
      "content-type": object.contentType,
      "content-length": String(object.body.length),
      "cache-control": object.cacheControl,
    };
    if (init.method === "HEAD") return new Response(null, { status: 200, headers });
    const range = new Headers(init.headers).get("range");
    if (range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), object.body.length - 1);
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

test("component release plan hashes immutable archives and signs the channel manifest", async (t) => {
  const root = await fixture(t);
  const plan = await createComponentReleasePlan({
    descriptor: descriptor(),
    baseDir: root,
    appVersion: "1.3.0",
    channel: "beta",
    sequence: 17,
    privateKey,
    primaryBaseUrl: "https://download.moonshine.email",
    mirrorBaseUrl: "https://mirror.example.invalid/releases",
  });

  assert.equal(plan.signed, true);
  assert.equal(plan.objects.length, 3);
  assert.equal(plan.objects.filter((object) => object.immutable).length, 2);
  assert.equal(plan.objects.at(-1).key, "components/win-x64/beta/manifest.json");
  assert.match(plan.objects[0].key, /^components\/win-x64\/releases\/3\.12\.1\//);
  assert.equal(plan.mirror.parity, "byte-identical");
  assert.deepEqual(
    plan.mirror.primary.map((object) => [object.key, object.size, object.sha256]),
    plan.mirror.mirror.map((object) => [object.key, object.size, object.sha256]),
  );

  const verified = assertSignedComponentManifest(plan.manifest, {
    publicKeys: { "moonshine-app-manifest-v1": publicKey },
    expectedChannel: "beta",
    expectedAppVersion: "1.3.0",
    expectedPlatform: "win32",
    expectedArch: "x64",
    now: Date.now(),
  });
  assert.equal(verified.sequence, 17);
});

test("component release manifests are byte-identical when review timestamps are fixed", async (t) => {
  const root = await fixture(t);
  const options = {
    descriptor: descriptor(),
    baseDir: root,
    appVersion: "1.3.0",
    channel: "test",
    sequence: 1,
    publishedAt: "2026-08-08T00:00:00.000Z",
    expiresAt: "2026-09-07T00:00:00.000Z",
    privateKey,
  };
  const first = await createComponentReleasePlan(options);
  const second = await createComponentReleasePlan(options);
  const firstManifest = first.objects.find((object) => object.type === "component-manifest");
  const secondManifest = second.objects.find((object) => object.type === "component-manifest");

  assert.equal(firstManifest.sha256, secondManifest.sha256);
  assert.deepEqual(firstManifest.body, secondManifest.body);
});

test("component release plan rejects unsafe paths, duplicate keys and non-independent mirrors", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    () => createComponentReleasePlan({
      descriptor: {
        components: [{ ...descriptor().components[0], artifactPath: "../escape.zip" }],
      },
      baseDir: root,
      appVersion: "1.3.0",
      sequence: 1,
      privateKey,
    }),
    /safe relative path|must be under/,
  );
  await assert.rejects(
    () => createComponentReleasePlan({
      descriptor: {
        components: [
          descriptor().components[0],
          { ...descriptor().components[1], artifactPath: "components/win-x64/releases/3.12.1/python.zip" },
        ],
      },
      baseDir: root,
      appVersion: "1.3.0",
      sequence: 1,
      privateKey,
    }),
    /Duplicate component object key/,
  );
  await assert.rejects(
    () => createComponentReleasePlan({
      descriptor: descriptor(),
      baseDir: root,
      appVersion: "1.3.0",
      sequence: 1,
      privateKey,
      primaryBaseUrl: "https://download.moonshine.email",
      mirrorBaseUrl: "https://download.moonshine.email/other",
    }),
    /genuinely separate origin/,
  );
});

test("mirror parity compares immutable bytes rather than display URLs", () => {
  const objects = [{ key: "a.zip", size: 4, sha256: "a".repeat(64) }];
  assert.equal(assertMirrorParity(objects, structuredClone(objects)), true);
  assert.throws(
    () => assertMirrorParity(objects, [{ ...objects[0], sha256: "b".repeat(64) }]),
    /Mirror parity mismatch/,
  );
  assert.equal(normalizeComponentChannel("BETA"), "beta");
});

test("component upload publishes all immutable bytes before mirror and primary channel pointers", async (t) => {
  const root = await fixture(t);
  const plan = await createComponentReleasePlan({
    descriptor: descriptor(),
    baseDir: root,
    appVersion: "1.3.0",
    channel: "beta",
    sequence: 18,
    privateKey,
    primaryBaseUrl: "https://download.moonshine.email",
    mirrorBaseUrl: "https://mirror.example.invalid",
  });
  const events = [];
  const primary = new FakeS3Client("primary", events);
  const mirror = new FakeS3Client("mirror", events);
  const targets = [
    {
      id: "primary",
      client: primary,
      config: {
        bucket: "primary-bucket",
        publicBaseUrl: "https://download.moonshine.email",
      },
    },
    {
      id: "mirror",
      client: mirror,
      config: {
        bucket: "mirror-bucket",
        publicBaseUrl: "https://mirror.example.invalid",
      },
    },
  ];

  const result = await uploadComponentRelease({
    plan,
    targets,
    confirmation: "beta:1.3.0",
    fetchImpl: publicFetchByOrigin(new Map([
      ["https://download.moonshine.email", primary],
      ["https://mirror.example.invalid", mirror],
    ])),
    attempts: 1,
    retryDelayMs: 0,
  });

  assert.equal(result.dryRun, false);
  assert.equal(result.targets.length, 2);
  assert.ok(result.targets.every((target) => target.objects.length === 3));
  const putEvents = events.filter((event) => event.command === "PutObjectCommand");
  assert.deepEqual(
    putEvents.slice(-2).map((event) => [event.target, event.key]),
    [
      ["mirror", "components/win-x64/beta/manifest.json"],
      ["primary", "components/win-x64/beta/manifest.json"],
    ],
  );
  assert.ok([...primary.objects.keys()].every((key) => !key.includes("..")));
  assert.ok(primary.commands.every((command) => !command.constructor.name.includes("List")));
  assert.equal(
    primary.objects.get("components/win-x64/beta/manifest.json").metadata.componentsequence,
    "18",
  );
});

test("component upload dry-run requires neither credentials nor a signature", async (t) => {
  const root = await fixture(t);
  const plan = await createComponentReleasePlan({
    descriptor: descriptor(),
    baseDir: root,
    appVersion: "1.3.0",
    channel: "test",
    sequence: 1,
  });
  const result = await uploadComponentRelease({
    plan,
    targets: [{
      id: "primary",
      config: { bucket: "dry-run", publicBaseUrl: "https://download.moonshine.email" },
    }],
    dryRun: true,
    fetchImpl: () => assert.fail("dry-run must not access the network"),
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.targets[0].objects.length, 3);
});

test("component channel publication rejects missing confirmation, rollback and sequence collisions", async (t) => {
  const root = await fixture(t);
  const plan = await createComponentReleasePlan({
    descriptor: descriptor(),
    baseDir: root,
    appVersion: "1.3.0",
    channel: "stable",
    sequence: 9,
    privateKey,
  });
  const manifest = plan.objects.find((object) => object.type === "component-manifest");
  const client = new FakeS3Client("primary");

  assert.throws(
    () => assertComponentChannelConfirmation("stable:1.3.1", plan),
    /--confirm-channel stable:1\.3\.0/,
  );
  await putComponentChannelManifest({ client, bucket: "release", object: manifest, plan });

  await assert.rejects(
    putComponentChannelManifest({
      client,
      bucket: "release",
      object: manifest,
      plan: { ...plan, sequence: 8 },
    }),
    /Refusing to roll.*sequence 9/,
  );
  const changedBody = Buffer.from(`${manifest.body.toString("utf8")} `);
  await assert.rejects(
    putComponentChannelManifest({
      client,
      bucket: "release",
      object: {
        ...manifest,
        body: changedBody,
        size: changedBody.length,
        sha256: createHash("sha256").update(changedBody).digest("hex"),
      },
      plan,
    }),
    /sequence 9 already contains different bytes/,
  );
});
