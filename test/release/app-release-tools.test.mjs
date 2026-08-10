import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  assertChannelConfirmation,
  assertStableConfirmation,
  buildReleaseObjects,
  commonCliOptions,
  loadReleaseDescriptor,
  parseCliArgs,
  parseKeyValueText,
  publishStableRelease,
  publishChannelRelease,
  putImmutableObject,
  resolveR2Config,
  uploadImmutableRelease,
  verifyPublicObject,
  verifyS3Object,
} from "../../scripts/release/app-release-lib.mjs";

function digest(value, algorithm = "sha256", encoding = "hex") {
  return createHash(algorithm).update(value).digest(encoding);
}

function createReleaseFixture(t, version = "1.3.0") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-app-release-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const installerName = `Moonshine-Image-Setup-${version}.exe`;
  const installer = Buffer.from("installer-payload-for-release-tests");
  const blockmap = Buffer.from("blockmap-payload-for-release-tests");
  fs.writeFileSync(path.join(dir, installerName), installer);
  fs.writeFileSync(path.join(dir, `${installerName}.blockmap`), blockmap);
  fs.writeFileSync(
    path.join(dir, "latest.yml"),
    stringifyYaml({
      version,
      files: [
        {
          url: installerName,
          sha512: digest(installer, "sha512", "base64"),
          size: installer.length,
        },
      ],
      path: installerName,
      sha512: digest(installer, "sha512", "base64"),
      releaseDate: "2026-08-07T00:00:00.000Z",
    })
  );
  return { dir, installer, blockmap };
}

async function readBody(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

class FakeS3Client {
  constructor() {
    this.commands = [];
    this.objects = new Map();
  }

  async send(command) {
    this.commands.push(command);
    const name = command.constructor.name;
    const input = command.input;
    const existing = this.objects.get(input.Key);

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
      const body = await readBody(input.Body);
      this.objects.set(input.Key, {
        body,
        contentType: input.ContentType,
        cacheControl: input.CacheControl,
        metadata: input.Metadata,
      });
      return {};
    }
    throw new Error(`Unexpected S3 command: ${name}`);
  }
}

function createPublicFetch(client) {
  return async (input, init = {}) => {
    const url = new URL(input);
    const key = url.pathname
      .replace(/^\//, "")
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
    const object = client.objects.get(key);
    if (!object) return new Response("missing", { status: 404 });

    const commonHeaders = {
      "content-type": object.contentType,
      "content-length": String(object.body.length),
      "cache-control": object.cacheControl,
    };
    if (init.method === "HEAD") {
      return new Response(null, { status: 200, headers: commonHeaders });
    }
    const range = new Headers(init.headers).get("range");
    if (range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      assert.ok(match, `unexpected Range header: ${range}`);
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), object.body.length - 1);
      return new Response(object.body.subarray(start, end + 1), {
        status: 206,
        headers: {
          ...commonHeaders,
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${object.body.length}`,
        },
      });
    }
    return new Response(object.body, { status: 200, headers: commonHeaders });
  };
}

const releaseConfig = {
  bucket: "moonshine-image-app-release-prod",
  publicBaseUrl: "https://download.moonshine.email",
  releasePrefix: "app/win-x64",
};

test("KEY=VALUE parsing is strict without exposing or evaluating values", () => {
  const values = parseKeyValueText(
    '\uFEFF# release credentials\nR2_BUCKET = bucket\nR2_ENDPOINT="https://id.r2.cloudflarestorage.com"\nTOKEN=a=b=c\n'
  );
  assert.deepEqual(values, {
    R2_BUCKET: "bucket",
    R2_ENDPOINT: "https://id.r2.cloudflarestorage.com",
    TOKEN: "a=b=c",
  });
  assert.throws(
    () => parseKeyValueText("R2_BUCKET=one\nR2_BUCKET=two"),
    /repeats R2_BUCKET/
  );
  assert.throws(() => parseKeyValueText("not valid"), /KEY=VALUE/);
});

test("R2 configuration derives the endpoint and applies explicit environment overrides", () => {
  const config = resolveR2Config({
    env: {
      R2_ACCOUNT_ID: "account-id",
      R2_ACCESS_KEY_ID: "access-id",
      R2_SECRET_ACCESS_KEY: "secret",
      R2_BUCKET: "release-bucket",
    },
  });
  assert.equal(config.endpoint, "https://account-id.r2.cloudflarestorage.com");
  assert.equal(config.bucket, "release-bucket");
  assert.equal(config.publicBaseUrl, "https://download.moonshine.email");
  assert.equal(config.releasePrefix, "app/win-x64");
});

test("release descriptor validates latest.yml and produces deterministic keys", async (t) => {
  const fixture = createReleaseFixture(t);
  const descriptor = await loadReleaseDescriptor({
    artifactDir: fixture.dir,
    version: "1.3.0",
  });
  const objects = buildReleaseObjects(descriptor);

  assert.equal(objects.installer.key, "app/win-x64/stable/Moonshine-Image-Setup-1.3.0.exe");
  assert.equal(
    objects.blockmap.key,
    "app/win-x64/stable/Moonshine-Image-Setup-1.3.0.exe.blockmap"
  );
  assert.equal(objects.archivedManifest.key, "app/win-x64/manifests/1.3.0/latest.yml");
  assert.equal(objects.stableManifest.key, "app/win-x64/stable/latest.yml");
  assert.equal(objects.installer.sha256, digest(fixture.installer));
  assert.match(objects.installer.cacheControl, /immutable/);
  assert.equal(objects.stableManifest.cacheControl, "no-cache, no-store, must-revalidate");
});

test("signed app manifest is an optional immutable object with a stable pointer", () => {
  const descriptor = {
    version: "1.3.0",
    installer: { name: "Moonshine-Image-Setup-1.3.0.exe", path: "x", size: 4, sha256: "a".repeat(64) },
    blockmap: { name: "Moonshine-Image-Setup-1.3.0.exe.blockmap", path: "y", size: 4, sha256: "b".repeat(64) },
    manifestArtifact: { name: "latest.yml", path: "z", size: 4, sha256: "c".repeat(64) },
    appManifestArtifact: { name: "app-manifest.json", path: "m", size: 4, sha256: "d".repeat(64) },
  };
  const objects = buildReleaseObjects(descriptor);
  assert.equal(objects.archivedAppManifest.key, "manifests/1.3.0/latest.json");
  assert.equal(objects.stableAppManifest.key, "manifests/stable/latest.json");
  assert.equal(objects.stableAppManifest.immutable, false);

  const betaObjects = buildReleaseObjects(descriptor, releaseConfig.releasePrefix, { channel: "beta" });
  assert.equal(betaObjects.archivedAppManifest.key, "manifests/1.3.0/beta/latest.json");
  assert.equal(betaObjects.channelAppManifest.key, "manifests/beta/latest.json");
  assert.equal(betaObjects.stableAppManifest, undefined);
});

test("release descriptor rejects version and artifact mismatches", async (t) => {
  const fixture = createReleaseFixture(t);
  await assert.rejects(
    loadReleaseDescriptor({ artifactDir: fixture.dir, version: "1.3.1" }),
    /does not match requested version/
  );
  await assert.rejects(
    loadReleaseDescriptor({
      artifactDir: fixture.dir,
      installerPath: path.join(fixture.dir, "different.exe"),
    }),
    /filename must match latest.yml/
  );
});

test("immutable upload uses Put, Head, and Get without bucket listing", async (t) => {
  const fixture = createReleaseFixture(t);
  const descriptor = await loadReleaseDescriptor({ artifactDir: fixture.dir });
  const object = buildReleaseObjects(descriptor).installer;
  const client = new FakeS3Client();

  const first = await putImmutableObject({
    client,
    bucket: releaseConfig.bucket,
    object,
    version: descriptor.version,
  });
  const second = await putImmutableObject({
    client,
    bucket: releaseConfig.bucket,
    object,
    version: descriptor.version,
  });

  assert.equal(first.action, "uploaded");
  assert.equal(second.action, "reused");
  assert.ok(client.commands.some((command) => command.constructor.name === "PutObjectCommand"));
  assert.ok(client.commands.some((command) => command.constructor.name === "HeadObjectCommand"));
  assert.ok(client.commands.some((command) => command.constructor.name === "GetObjectCommand"));
  assert.ok(client.commands.every((command) => !command.constructor.name.includes("List")));
  const put = client.commands.find((command) => command.constructor.name === "PutObjectCommand");
  assert.equal(put.input.IfNoneMatch, "*");
  assert.equal(put.input.Metadata.sha256, object.sha256);
});

test("S3 verification streams bodies before using aggregate helpers", async () => {
  const body = Buffer.from("streamed-r2-object");
  const object = {
    key: "components/runtime.zip",
    size: body.length,
    sha256: digest(body),
    contentType: "application/zip",
    cacheControl: "public, max-age=31536000, immutable",
  };
  let aggregateCalled = false;
  const streamingBody = {
    async *[Symbol.asyncIterator]() {
      yield body.subarray(0, 7);
      yield body.subarray(7);
    },
    async transformToByteArray() {
      aggregateCalled = true;
      throw new Error("data is too long");
    },
  };
  const client = {
    async send(command) {
      if (command.constructor.name === "HeadObjectCommand") {
        return {
          ContentLength: object.size,
          ContentType: object.contentType,
          CacheControl: object.cacheControl,
          Metadata: { sha256: object.sha256 },
        };
      }
      if (command.constructor.name === "GetObjectCommand") {
        return { Body: streamingBody };
      }
      throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
    },
  };

  const result = await verifyS3Object({ client, bucket: "release", object });
  assert.equal(result.sha256, object.sha256);
  assert.equal(aggregateCalled, false);
});

test("immutable upload refuses to overwrite a conflicting deterministic key", async (t) => {
  const fixture = createReleaseFixture(t);
  const descriptor = await loadReleaseDescriptor({ artifactDir: fixture.dir });
  const object = buildReleaseObjects(descriptor).installer;
  const client = new FakeS3Client();
  client.objects.set(object.key, {
    body: Buffer.alloc(object.size, 0x78),
    contentType: object.contentType,
    cacheControl: object.cacheControl,
    metadata: { sha256: object.sha256 },
  });

  await assert.rejects(
    putImmutableObject({
      client,
      bucket: releaseConfig.bucket,
      object,
      version: descriptor.version,
    }),
    /full sha256 check/
  );
  assert.equal(
    client.commands.filter((command) => command.constructor.name === "PutObjectCommand").length,
    0
  );
});

test("public verification requires HEAD, byte range, and full sha256", async () => {
  const body = Buffer.from("public-object-payload");
  const object = {
    key: "app/win-x64/stable/file.exe",
    size: body.length,
    sha256: digest(body),
    contentType: "application/vnd.microsoft.portable-executable",
    cacheControl: "public, max-age=31536000, immutable",
  };
  const client = new FakeS3Client();
  client.objects.set(object.key, {
    body,
    contentType: object.contentType,
    cacheControl: object.cacheControl,
    metadata: { sha256: object.sha256 },
  });
  const calls = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    return createPublicFetch(client)(...args);
  };

  const result = await verifyPublicObject({
    fetchImpl,
    publicBaseUrl: releaseConfig.publicBaseUrl,
    object,
    attempts: 1,
    retryDelayMs: 0,
  });
  assert.equal(result.sha256, object.sha256);
  assert.deepEqual(
    calls.map(([, init]) => [init.method, new Headers(init.headers).get("range")]),
    [
      ["HEAD", null],
      ["GET", `bytes=0-${body.length - 1}`],
      ["GET", null],
    ]
  );
  assert.ok(calls.every(([, init]) => init.signal instanceof AbortSignal));

  const compressedHead = await verifyPublicObject({
    fetchImpl: async (input, init = {}) => {
      const response = await createPublicFetch(client)(input, init);
      if (init.method !== "HEAD") return response;
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.set("content-encoding", "br");
      return new Response(null, { status: response.status, headers });
    },
    publicBaseUrl: releaseConfig.publicBaseUrl,
    object,
    attempts: 1,
    retryDelayMs: 0,
  });
  assert.equal(compressedHead.sha256, object.sha256);

  await assert.rejects(
    verifyPublicObject({
      fetchImpl: async (input, init = {}) => {
        const response = await createPublicFetch(client)(input, init);
        if (init.method !== "HEAD") return response;
        const headers = new Headers(response.headers);
        headers.set("cache-control", "no-store");
        return new Response(null, { status: response.status, headers });
      },
      publicBaseUrl: releaseConfig.publicBaseUrl,
      object,
      attempts: 1,
      retryDelayMs: 0,
    }),
    /Cache-Control/,
  );
});

test("dry-run plans immutable objects without calling R2 or the public domain", async (t) => {
  const fixture = createReleaseFixture(t);
  const descriptor = await loadReleaseDescriptor({ artifactDir: fixture.dir });
  const result = await uploadImmutableRelease({
    config: releaseConfig,
    descriptor,
    dryRun: true,
    fetchImpl: () => assert.fail("fetch must not run in dry-run"),
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.objects.length, 3);
  assert.ok(result.objects.every((object) => !object.key.endsWith("stable/latest.yml")));
});

test("stable publication is separately confirmed and writes latest.yml last", async (t) => {
  const fixture = createReleaseFixture(t);
  const descriptor = await loadReleaseDescriptor({ artifactDir: fixture.dir });
  const client = new FakeS3Client();
  const fetchCalls = [];
  const fetchImpl = async (input, init = {}) => {
    fetchCalls.push(new URL(input).toString());
    return createPublicFetch(client)(input, init);
  };

  await uploadImmutableRelease({
    client,
    config: releaseConfig,
    descriptor,
    fetchImpl,
    attempts: 1,
    retryDelayMs: 0,
  });
  await assert.rejects(
    publishStableRelease({
      client,
      config: releaseConfig,
      descriptor,
      confirmation: "1.3.1",
      fetchImpl,
      attempts: 1,
      retryDelayMs: 0,
    }),
    /requires --confirm-stable 1.3.0/
  );

  const result = await publishStableRelease({
    client,
    config: releaseConfig,
    descriptor,
    confirmation: "1.3.0",
    fetchImpl,
    attempts: 1,
    retryDelayMs: 0,
  });
  const stable = client.objects.get("app/win-x64/stable/latest.yml");
  assert.equal(result.phase, "stable");
  assert.ok(stable);
  assert.equal(stable.cacheControl, "no-cache, no-store, must-revalidate");
  assert.equal(digest(stable.body), descriptor.manifestArtifact.sha256);
  assert.equal(
    client.commands.filter((command) => command.constructor.name === "PutObjectCommand").at(-1)
      .input.Key,
    "app/win-x64/stable/latest.yml"
  );
  assert.ok(fetchCalls.length > 0);
  assert.ok(fetchCalls.every((url) => url.includes("verify=")));
});

test("beta channel uses its own immutable path and requires channel confirmation", async (t) => {
  const fixture = createReleaseFixture(t);
  const descriptor = await loadReleaseDescriptor({ artifactDir: fixture.dir, channel: "beta" });
  const objects = buildReleaseObjects(descriptor, releaseConfig.releasePrefix, { channel: "beta" });
  assert.equal(objects.installer.key, "app/win-x64/beta/Moonshine-Image-Setup-1.3.0.exe");
  assert.equal(objects.channelManifest.key, "app/win-x64/beta/latest.yml");

  const client = new FakeS3Client();
  const fetchImpl = createPublicFetch(client);
  await uploadImmutableRelease({
    client,
    config: releaseConfig,
    descriptor,
    channel: "beta",
    fetchImpl,
    attempts: 1,
    retryDelayMs: 0,
  });
  await assert.rejects(
    publishChannelRelease({
      client,
      config: releaseConfig,
      descriptor,
      channel: "beta",
      confirmation: "1.3.0",
      fetchImpl,
      attempts: 1,
      retryDelayMs: 0,
    }),
    /requires --confirm-channel beta:1.3.0/,
  );
  const result = await publishChannelRelease({
    client,
    config: releaseConfig,
    descriptor,
    channel: "beta",
    confirmation: "beta:1.3.0",
    fetchImpl,
    attempts: 1,
    retryDelayMs: 0,
  });
  assert.equal(result.phase, "beta");
  assert.ok(client.objects.get("app/win-x64/beta/latest.yml"));
  assert.equal(digest(client.objects.get("app/win-x64/beta/latest.yml").body), descriptor.manifestArtifact.sha256);
  assert.doesNotThrow(() => assertChannelConfirmation("beta:1.3.0", "beta", "1.3.0"));
});

test("CLI parser rejects unknown and ambiguous options", () => {
  assert.deepEqual(
    parseCliArgs(["--dry-run", "--version=1.3.0"], {
      boolean: ["dry-run"],
      values: ["version"],
    }),
    { "dry-run": true, version: "1.3.0" }
  );
  assert.throws(
    () => parseCliArgs(["--publish-stable"], { boolean: ["dry-run"] }),
    /Unknown option/
  );
  assert.deepEqual(commonCliOptions({}), {
    attempts: 6,
    retryDelayMs: 2_000,
    requestTimeoutMs: 300_000,
  });
  assert.throws(
    () => commonCliOptions({ "request-timeout-ms": "999" }),
    /request-timeout-ms/,
  );
  assert.throws(() => assertStableConfirmation(undefined, "1.3.0"), /manual approval/);
});

test("app feed verifier forwards the selected channel while loading the descriptor", () => {
  const source = fs.readFileSync(
    path.resolve("scripts/release/verify-app-feed.mjs"),
    "utf8",
  );
  assert.match(
    source,
    /loadReleaseDescriptor\(\{[\s\S]*?channel: args\.channel,[\s\S]*?\}\);/,
  );
});

test("Windows workflow keeps stable publication behind a protected job", () => {
  const workflowPath = path.resolve(".github/workflows/release-windows.yml");
  const workflow = parseYaml(fs.readFileSync(workflowPath, "utf8"));
  const immutableJob = workflow.jobs["build-and-upload-immutable"];
  const stableJob = workflow.jobs["publish-stable"];
  const channelJob = workflow.jobs["publish-channel"];
  const immutableCommands = immutableJob.steps.map((step) => step.run || "").join("\n");
  const stableCommands = stableJob.steps.map((step) => step.run || "").join("\n");
  const channelCommands = channelJob.steps.map((step) => step.run || "").join("\n");

  assert.equal(stableJob.environment.name, "app-release-stable");
  assert.match(String(stableJob.if), /publish_stable/);
  assert.doesNotMatch(immutableCommands, /release:app:publish-stable/);
  assert.match(stableCommands, /release:app:publish-stable/);
  assert.match(stableCommands, /--confirm-stable/);
  assert.match(stableCommands, /release-artifacts\/electron\/Packaged/);
  assert.match(immutableCommands, /--channel "\$env:RESOURCE_CHANNEL"/);
  assert.match(channelCommands, /release:app:publish-channel/);
  assert.match(channelCommands, /--confirm-channel/);
  assert.match(String(channelJob.if), /publish_channel/);
});
