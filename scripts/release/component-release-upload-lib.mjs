import { PutObjectCommand } from "@aws-sdk/client-s3";

import {
  headObjectOrNull,
  normalizeVersion,
  putImmutableObject,
  publicObjectUrl,
  verifyPublicObject,
  verifyS3Object,
} from "./app-release-lib.mjs";
import { normalizeComponentChannel } from "./component-release-lib.mjs";

function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function plannedObject(object, publicBaseUrl) {
  return {
    type: object.type,
    ...(object.id ? { id: object.id } : {}),
    key: object.key,
    url: publicObjectUrl(publicBaseUrl, object.key),
    size: object.size,
    sha256: object.sha256,
    cacheControl: object.cacheControl,
  };
}

function normalizeTarget(target, index, { requireClient }) {
  const id = requiredText(target?.id || `target-${index + 1}`, "target id");
  const config = target?.config;
  if (!config || typeof config !== "object") {
    throw new Error(`Component release target ${id} requires a configuration`);
  }
  requiredText(config.bucket, `${id} bucket`);
  const publicBaseUrl = new URL(requiredText(config.publicBaseUrl, `${id} public base URL`));
  if (publicBaseUrl.protocol !== "https:") {
    throw new Error(`${id} public base URL must use HTTPS`);
  }
  if (requireClient && !target.client) {
    throw new Error(`Component release target ${id} requires an S3 client`);
  }
  return { id, config, client: target.client, origin: publicBaseUrl.origin };
}

function normalizeTargets(targets, { requireClient }) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("At least one component release target is required");
  }
  const normalized = targets.map((target, index) => normalizeTarget(target, index, { requireClient }));
  const ids = new Set();
  const origins = new Set();
  for (const target of normalized) {
    if (ids.has(target.id)) throw new Error(`Duplicate component release target id: ${target.id}`);
    if (origins.has(target.origin)) {
      throw new Error("Component mirror targets must use genuinely separate HTTPS origins");
    }
    ids.add(target.id);
    origins.add(target.origin);
  }
  return normalized;
}

function splitPlanObjects(plan) {
  const objects = Array.isArray(plan?.objects) ? plan.objects : [];
  const immutable = objects.filter((object) => object.immutable === true);
  const manifests = objects.filter((object) => object.type === "component-manifest");
  if (!immutable.length) throw new Error("Component release plan has no immutable component objects");
  if (manifests.length !== 1 || manifests[0].immutable !== false) {
    throw new Error("Component release plan must contain exactly one mutable channel manifest");
  }
  return { immutable, manifest: manifests[0] };
}

export function componentChannelConfirmation(channel, version) {
  return `${normalizeComponentChannel(channel)}:${normalizeVersion(version)}`;
}

export function assertComponentChannelConfirmation(confirmation, { channel, version } = {}) {
  const expected = componentChannelConfirmation(channel, version);
  if (String(confirmation ?? "").trim() !== expected) {
    throw new Error(`Component publication requires --confirm-channel ${expected} after manual approval`);
  }
  return expected;
}

function manifestMetadata(object, plan) {
  return {
    sha256: object.sha256,
    releaseversion: normalizeVersion(plan.version),
    componentchannel: normalizeComponentChannel(plan.channel),
    componentsequence: String(plan.sequence),
  };
}

export async function putComponentChannelManifest({ client, bucket, object, plan }) {
  if (!Buffer.isBuffer(object?.body) || object.body.length !== object.size) {
    throw new Error("Component channel manifest body is missing or has an unexpected size");
  }
  const existing = await headObjectOrNull(client, bucket, object.key);
  if (existing) {
    const remoteSequence = Number(existing.Metadata?.componentsequence);
    if (!Number.isSafeInteger(remoteSequence) || remoteSequence < 1) {
      throw new Error(`Existing component manifest ${object.key} has no trusted sequence metadata`);
    }
    if (remoteSequence > plan.sequence) {
      throw new Error(`Refusing to roll component manifest ${object.key} back from sequence ${remoteSequence}`);
    }
    if (remoteSequence === plan.sequence) {
      const remoteSha256 = String(existing.Metadata?.sha256 || "").toLowerCase();
      if (remoteSha256 !== object.sha256.toLowerCase()) {
        throw new Error(`Component manifest sequence ${plan.sequence} already contains different bytes`);
      }
      await verifyS3Object({ client, bucket, object });
      return { action: "reused", key: object.key, sequence: plan.sequence };
    }
  }

  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: object.key,
    Body: object.body,
    ContentLength: object.size,
    ContentType: object.contentType,
    CacheControl: object.cacheControl,
    Metadata: manifestMetadata(object, plan),
  }));
  await verifyS3Object({ client, bucket, object });
  return { action: "published", key: object.key, sequence: plan.sequence };
}

async function verifyPublic({ target, object, fetchImpl, attempts, retryDelayMs, requestTimeoutMs }) {
  return verifyPublicObject({
    fetchImpl,
    publicBaseUrl: target.config.publicBaseUrl,
    object,
    attempts,
    retryDelayMs,
    requestTimeoutMs,
    cacheBust: object.immutable ? undefined : object.sha256.slice(0, 16),
  });
}

export async function uploadComponentRelease({
  plan,
  targets,
  confirmation,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  attempts = 6,
  retryDelayMs = 2_000,
  requestTimeoutMs = 300_000,
} = {}) {
  const normalizedTargets = normalizeTargets(targets, { requireClient: !dryRun });
  const { immutable, manifest } = splitPlanObjects(plan);
  if (!dryRun) {
    if (!plan?.signed || !plan?.manifest?.signature) {
      throw new Error("Component channel publication requires a signed manifest");
    }
    assertComponentChannelConfirmation(confirmation, plan);
  }

  const targetPlans = normalizedTargets.map((target) => ({
    id: target.id,
    bucket: target.config.bucket,
    publicBaseUrl: target.config.publicBaseUrl,
    objects: [...immutable, manifest].map((object) => plannedObject(object, target.config.publicBaseUrl)),
  }));
  if (dryRun) {
    return {
      phase: "component-channel",
      channel: plan.channel,
      sequence: plan.sequence,
      dryRun: true,
      targets: targetPlans,
    };
  }

  const results = new Map(normalizedTargets.map((target) => [target.id, {
    id: target.id,
    bucket: target.config.bucket,
    publicBaseUrl: target.config.publicBaseUrl,
    objects: [],
  }]));

  // Every target receives and verifies all immutable bytes before any channel pointer changes.
  for (const target of normalizedTargets) {
    for (const object of immutable) {
      const upload = await putImmutableObject({
        client: target.client,
        bucket: target.config.bucket,
        object,
        version: plan.version,
      });
      const verification = await verifyPublic({
        target,
        object,
        fetchImpl,
        attempts,
        retryDelayMs,
        requestTimeoutMs,
      });
      results.get(target.id).objects.push({
        ...plannedObject(object, target.config.publicBaseUrl),
        action: upload.action,
        verification,
      });
    }
  }

  // Mirrors publish first. The primary pointer is the final write in the transaction plan.
  for (const target of [...normalizedTargets].reverse()) {
    const publish = await putComponentChannelManifest({
      client: target.client,
      bucket: target.config.bucket,
      object: manifest,
      plan,
    });
    const verification = await verifyPublic({
      target,
      object: manifest,
      fetchImpl,
      attempts,
      retryDelayMs,
      requestTimeoutMs,
    });
    results.get(target.id).objects.push({
      ...plannedObject(manifest, target.config.publicBaseUrl),
      action: publish.action,
      verification,
    });
  }

  return {
    phase: "component-channel",
    channel: plan.channel,
    sequence: plan.sequence,
    dryRun: false,
    targets: normalizedTargets.map((target) => results.get(target.id)),
  };
}

