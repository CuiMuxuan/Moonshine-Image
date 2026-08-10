import fs from "node:fs";
import { createHash } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";

import {
  headObjectOrNull,
  normalizeVersion,
  publicObjectUrl,
  verifyPublicObject,
  verifyS3Object,
} from "./app-release-lib.mjs";
import {
  buildMirrorParityPlan,
  normalizeComponentChannel,
} from "./component-release-lib.mjs";
import {
  MANIFEST_KEY_ID,
  MANIFEST_SCHEMA_VERSION,
  validateManifestPayload,
} from "../../src-electron/runtime/manifest-verifier.js";
import { signManifestPayload } from "./manifest-signing.mjs";

export const MODEL_MANIFEST_PREFIX = "models";
export const MODEL_MANIFEST_CACHE_CONTROL = "no-cache, no-store, must-revalidate";

function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function loadModels(descriptor) {
  const input = typeof descriptor === "string"
    ? JSON.parse(fs.readFileSync(descriptor, "utf8"))
    : descriptor;
  const models = Array.isArray(input) ? input : input?.models;
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("Model registry descriptor must contain a non-empty models array");
  }
  return JSON.parse(JSON.stringify(models));
}

export function modelManifestKey(channel = "stable") {
  return `${MODEL_MANIFEST_PREFIX}/${normalizeComponentChannel(channel)}/manifest.json`;
}

export function buildModelManifestPayload({
  descriptor,
  appVersion,
  channel = "stable",
  sequence,
  publishedAt = new Date().toISOString(),
  expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  platform = "win32",
  arch = "x64",
} = {}) {
  const payload = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    channel: normalizeComponentChannel(channel),
    sequence: Number(sequence),
    appVersion: normalizeVersion(appVersion),
    platform: requiredText(platform, "platform"),
    arch: requiredText(arch, "arch"),
    publishedAt: requiredText(publishedAt, "publishedAt"),
    expiresAt: requiredText(expiresAt, "expiresAt"),
    models: loadModels(descriptor),
  };
  validateManifestPayload(payload, {
    expectedChannel: payload.channel,
    expectedAppVersion: payload.appVersion,
    expectedPlatform: payload.platform,
    expectedArch: payload.arch,
  });
  return payload;
}

export async function createModelReleasePlan({
  descriptor,
  appVersion,
  channel = "stable",
  sequence,
  publishedAt,
  expiresAt,
  privateKey,
  keyId = MANIFEST_KEY_ID,
  primaryBaseUrl = "https://download.moonshine.email",
  mirrorBaseUrl,
} = {}) {
  const payload = buildModelManifestPayload({
    descriptor,
    appVersion,
    channel,
    sequence,
    publishedAt,
    expiresAt,
  });
  const manifest = privateKey ? signManifestPayload(payload, { privateKey, keyId }) : null;
  const body = Buffer.from(`${JSON.stringify(manifest || { payload }, null, 2)}\n`, "utf8");
  const object = {
    type: "model-manifest",
    key: modelManifestKey(payload.channel),
    size: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    contentType: "application/json; charset=utf-8",
    cacheControl: MODEL_MANIFEST_CACHE_CONTROL,
    immutable: false,
    body,
  };
  return {
    schemaVersion: 1,
    version: payload.appVersion,
    channel: payload.channel,
    sequence: payload.sequence,
    signed: Boolean(manifest),
    keyId: manifest?.signature?.keyId || null,
    payload,
    manifest,
    object,
    mirror: buildMirrorParityPlan({
      objects: [object],
      primaryBaseUrl,
      mirrorBaseUrl,
    }),
  };
}

export function assertModelChannelConfirmation(confirmation, plan) {
  const expected = `${normalizeComponentChannel(plan.channel)}:${normalizeVersion(plan.version)}`;
  if (String(confirmation ?? "").trim() !== expected) {
    throw new Error(`Model manifest publication requires --confirm-channel ${expected} after manual approval`);
  }
  return expected;
}

function normalizeTargets(targets, requireClient) {
  if (!Array.isArray(targets) || targets.length === 0) throw new Error("At least one model manifest target is required");
  const ids = new Set();
  const origins = new Set();
  return targets.map((target, index) => {
    const id = requiredText(target?.id || `target-${index + 1}`, "target id");
    const bucket = requiredText(target?.config?.bucket, `${id} bucket`);
    const publicBaseUrl = requiredText(target?.config?.publicBaseUrl, `${id} public base URL`);
    const url = new URL(publicBaseUrl);
    if (url.protocol !== "https:") throw new Error(`${id} public base URL must use HTTPS`);
    if (ids.has(id)) throw new Error(`Duplicate model manifest target id: ${id}`);
    if (origins.has(url.origin)) throw new Error("Model manifest mirrors must use genuinely separate HTTPS origins");
    if (requireClient && !target.client) throw new Error(`${id} requires an S3 client`);
    ids.add(id);
    origins.add(url.origin);
    return { id, bucket, publicBaseUrl, client: target.client };
  });
}

export async function putModelChannelManifest({ client, bucket, plan }) {
  const object = plan.object;
  const existing = await headObjectOrNull(client, bucket, object.key);
  if (existing) {
    const remoteSequence = Number(existing.Metadata?.modelsequence);
    if (!Number.isSafeInteger(remoteSequence) || remoteSequence < 1) {
      throw new Error(`Existing model manifest ${object.key} has no trusted sequence metadata`);
    }
    if (remoteSequence > plan.sequence) {
      throw new Error(`Refusing to roll model manifest ${object.key} back from sequence ${remoteSequence}`);
    }
    if (remoteSequence === plan.sequence) {
      if (String(existing.Metadata?.sha256 || "").toLowerCase() !== object.sha256) {
        throw new Error(`Model manifest sequence ${plan.sequence} already contains different bytes`);
      }
      await verifyS3Object({ client, bucket, object });
      return { action: "reused", key: object.key };
    }
  }
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: object.key,
    Body: object.body,
    ContentLength: object.size,
    ContentType: object.contentType,
    CacheControl: object.cacheControl,
    Metadata: {
      sha256: object.sha256,
      releaseversion: normalizeVersion(plan.version),
      modelchannel: normalizeComponentChannel(plan.channel),
      modelsequence: String(plan.sequence),
    },
  }));
  await verifyS3Object({ client, bucket, object });
  return { action: "published", key: object.key };
}

function plannedObject(plan, target) {
  return {
    key: plan.object.key,
    url: publicObjectUrl(target.publicBaseUrl, plan.object.key),
    size: plan.object.size,
    sha256: plan.object.sha256,
    cacheControl: plan.object.cacheControl,
  };
}

export async function publishModelManifest({
  plan,
  targets,
  confirmation,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  attempts = 6,
  retryDelayMs = 2_000,
  requestTimeoutMs = 300_000,
} = {}) {
  const normalizedTargets = normalizeTargets(targets, !dryRun);
  const plans = normalizedTargets.map((target) => ({ id: target.id, bucket: target.bucket, ...plannedObject(plan, target) }));
  if (dryRun) return { phase: "model-manifest", dryRun: true, targets: plans };
  if (!plan.signed || !plan.manifest?.signature) throw new Error("Model manifest publication requires a signature");
  assertModelChannelConfirmation(confirmation, plan);

  const results = [];
  for (const target of [...normalizedTargets].reverse()) {
    const publish = await putModelChannelManifest({ client: target.client, bucket: target.bucket, plan });
    const verification = await verifyPublicObject({
      fetchImpl,
      publicBaseUrl: target.publicBaseUrl,
      object: plan.object,
      attempts,
      retryDelayMs,
      requestTimeoutMs,
      cacheBust: plan.object.sha256.slice(0, 16),
    });
    results.push({ id: target.id, bucket: target.bucket, ...plannedObject(plan, target), action: publish.action, verification });
  }
  return { phase: "model-manifest", dryRun: false, targets: results.reverse() };
}

export function sanitizeModelReleasePlan(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    version: plan.version,
    channel: plan.channel,
    sequence: plan.sequence,
    signed: plan.signed,
    keyId: plan.keyId,
    modelCount: plan.payload.models.length,
    object: {
      key: plan.object.key,
      size: plan.object.size,
      sha256: plan.object.sha256,
      cacheControl: plan.object.cacheControl,
    },
    mirror: plan.mirror,
  };
}

