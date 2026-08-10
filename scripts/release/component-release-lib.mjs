import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  assertSafeRelativePath,
  MANIFEST_CHANNELS,
  MANIFEST_KEY_ID,
  MANIFEST_SCHEMA_VERSION,
  verifySignedManifest,
} from "../../src-electron/runtime/manifest-verifier.js";
import { signManifestPayload } from "./manifest-signing.mjs";
import { normalizeVersion } from "./app-release-lib.mjs";

export const COMPONENT_RELEASE_PREFIX = "components/win-x64";
export const COMPONENT_RELEASES_PREFIX = `${COMPONENT_RELEASE_PREFIX}/releases`;
export const COMPONENT_MANIFEST_CACHE_CONTROL = "no-cache, no-store, must-revalidate";
export const COMPONENT_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

const COMPONENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export function normalizeComponentId(value) {
  const id = requiredText(value, "component id").toLowerCase();
  if (!COMPONENT_ID_PATTERN.test(id)) {
    throw new Error(`Invalid component id: ${id}`);
  }
  return id;
}

export function normalizeComponentChannel(value = "stable") {
  const channel = requiredText(value, "channel").toLowerCase();
  if (!MANIFEST_CHANNELS.includes(channel)) {
    throw new Error(`Unsupported component channel: ${channel}`);
  }
  return channel;
}

export function normalizeSequence(value) {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("sequence must be a positive safe integer");
  }
  return sequence;
}

function normalizeHttpsUrl(value, label) {
  const url = new URL(requiredText(value, label));
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function publicObjectUrl(publicBaseUrl, key) {
  const base = normalizeHttpsUrl(publicBaseUrl, "public base URL");
  const encoded = String(key)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/${encoded}`;
}

function safeObjectKey(value, label) {
  const key = requiredText(value, label).replace(/\\/g, "/").replace(/^\/+/, "");
  assertSafeRelativePath(key, label);
  return key;
}

function safeArtifactName(value, label) {
  const name = requiredText(value, label);
  if (
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".." ||
    name.includes("?") ||
    name.includes("#") ||
    path.basename(name) !== name
  ) {
    throw new Error(`${label} must be a filename without a directory path`);
  }
  return name;
}

export async function hashFile(filePath, algorithm = "sha256") {
  const hash = createHash(algorithm);
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function resolveArtifactFile(fileValue, baseDir, label) {
  const raw = requiredText(fileValue, label);
  const resolved = path.resolve(baseDir || process.cwd(), raw);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size < 1) {
    throw new Error(`${label} does not exist or is empty: ${resolved}`);
  }
  return { path: resolved, size: stat.size };
}

export async function loadComponentArtifacts({ descriptor, baseDir = process.cwd() } = {}) {
  const input = typeof descriptor === "string" ? JSON.parse(fs.readFileSync(descriptor, "utf8")) : descriptor;
  const entries = Array.isArray(input) ? input : input?.components;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Component descriptor must contain a non-empty components array");
  }

  const ids = new Set();
  const artifacts = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Each component descriptor must be an object");
    }
    const id = normalizeComponentId(entry.id);
    if (ids.has(id)) throw new Error(`Duplicate component id: ${id}`);
    ids.add(id);
    const version = normalizeVersion(entry.version);
    const file = resolveArtifactFile(entry.file || entry.path, baseDir, `${id} artifact`);
    const name = safeArtifactName(entry.name || path.basename(file.path), `${id} artifact name`);
    const artifactPath = safeObjectKey(
      entry.artifactPath || `${COMPONENT_RELEASES_PREFIX}/${version}/${name}`,
      `${id} artifactPath`,
    );
    if (!artifactPath.startsWith(`${COMPONENT_RELEASES_PREFIX}/`)) {
      throw new Error(`${id} artifactPath must be under ${COMPONENT_RELEASES_PREFIX}`);
    }
    artifacts.push({
      id,
      kind: requiredText(entry.kind, `${id} kind`),
      version,
      accelerator: entry.accelerator ? requiredText(entry.accelerator, `${id} accelerator`) : undefined,
      entrypoint: entry.entrypoint ? safeObjectKey(entry.entrypoint, `${id} entrypoint`) : undefined,
      artifactPath,
      path: file.path,
      name,
      size: file.size,
      sha256: await hashFile(file.path),
    });
  }
  return artifacts;
}

export function buildComponentManifestPayload({
  appVersion,
  channel = "stable",
  sequence,
  components,
  publishedAt = new Date().toISOString(),
  expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  platform = "win32",
  arch = "x64",
} = {}) {
  const normalizedChannel = normalizeComponentChannel(channel);
  const normalizedSequence = normalizeSequence(sequence);
  const normalizedComponents = Array.isArray(components) ? components : [];
  if (!normalizedComponents.length) throw new Error("At least one component is required");
  const payload = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    channel: normalizedChannel,
    sequence: normalizedSequence,
    appVersion: normalizeVersion(appVersion),
    platform: requiredText(platform, "platform"),
    arch: requiredText(arch, "arch"),
    publishedAt: requiredText(publishedAt, "publishedAt"),
    expiresAt: requiredText(expiresAt, "expiresAt"),
    components: normalizedComponents.map((component) => ({
      id: normalizeComponentId(component.id),
      kind: requiredText(component.kind, `${component.id} kind`),
      version: normalizeVersion(component.version),
      ...(component.accelerator ? { accelerator: String(component.accelerator).trim() } : {}),
      artifactPath: safeObjectKey(component.artifactPath, `${component.id} artifactPath`),
      size: component.size,
      sha256: String(component.sha256 || "").toLowerCase(),
      ...(component.entrypoint ? { entrypoint: safeObjectKey(component.entrypoint, `${component.id} entrypoint`) } : {}),
    })),
  };
  for (const component of payload.components) {
    if (!Number.isSafeInteger(component.size) || component.size < 1) {
      throw new Error(`${component.id} size must be a positive safe integer`);
    }
    if (!SHA256_PATTERN.test(component.sha256)) {
      throw new Error(`${component.id} sha256 must be a 64-character hex string`);
    }
  }
  return payload;
}

export function buildComponentObjects({ components, manifestPath, manifestBytes, channel = "stable" } = {}) {
  const normalizedChannel = normalizeComponentChannel(channel);
  if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length < 1) {
    throw new Error("manifestBytes must be a non-empty Buffer");
  }
  const manifestKey = safeObjectKey(
    manifestPath || `${COMPONENT_RELEASE_PREFIX}/${normalizedChannel}/manifest.json`,
    "manifest path",
  );
  const objects = (components || []).map((component) => ({
    type: "component",
    id: component.id,
    path: component.path,
    name: component.name,
    key: safeObjectKey(component.artifactPath, `${component.id} artifactPath`),
    size: component.size,
    sha256: component.sha256,
    contentType: "application/zip",
    cacheControl: COMPONENT_ASSET_CACHE_CONTROL,
    immutable: true,
  }));
  const keys = new Set();
  for (const object of objects) {
    if (keys.has(object.key)) throw new Error(`Duplicate component object key: ${object.key}`);
    keys.add(object.key);
  }
  objects.push({
    type: "component-manifest",
    key: manifestKey,
    size: manifestBytes.length,
    sha256: createHash("sha256").update(manifestBytes).digest("hex"),
    contentType: "application/json; charset=utf-8",
    cacheControl: COMPONENT_MANIFEST_CACHE_CONTROL,
    immutable: false,
    body: manifestBytes,
  });
  return objects;
}

export function buildMirrorParityPlan({ objects, primaryBaseUrl, mirrorBaseUrl } = {}) {
  if (!mirrorBaseUrl) return null;
  const primary = normalizeHttpsUrl(primaryBaseUrl, "primary base URL");
  const mirror = normalizeHttpsUrl(mirrorBaseUrl, "mirror base URL");
  if (new URL(primary).origin === new URL(mirror).origin) {
    throw new Error("Mirror base URL must be a genuinely separate origin");
  }
  const toEntry = (baseUrl) => objects.map((object) => ({
    type: object.type,
    key: object.key,
    url: publicObjectUrl(baseUrl, object.key),
    size: object.size,
    sha256: object.sha256,
  }));
  return { primary: toEntry(primary), mirror: toEntry(mirror), parity: "byte-identical" };
}

export function assertMirrorParity(primaryObjects, mirrorObjects) {
  if (!Array.isArray(primaryObjects) || !Array.isArray(mirrorObjects) || primaryObjects.length !== mirrorObjects.length) {
    throw new Error("Primary and mirror object plans must contain the same number of objects");
  }
  const byKey = new Map(mirrorObjects.map((object) => [object.key, object]));
  for (const primary of primaryObjects) {
    const mirror = byKey.get(primary.key);
    if (!mirror || mirror.size !== primary.size || String(mirror.sha256).toLowerCase() !== String(primary.sha256).toLowerCase()) {
      throw new Error(`Mirror parity mismatch for ${primary.key}`);
    }
  }
  return true;
}

export async function createComponentReleasePlan({
  descriptor,
  baseDir = process.cwd(),
  appVersion,
  channel = "stable",
  sequence,
  publishedAt,
  expiresAt,
  platform = "win32",
  arch = "x64",
  privateKey,
  keyId = MANIFEST_KEY_ID,
  manifestPath,
  primaryBaseUrl = "https://download.moonshine.email",
  mirrorBaseUrl,
} = {}) {
  const components = await loadComponentArtifacts({ descriptor, baseDir });
  const payload = buildComponentManifestPayload({
    appVersion,
    channel,
    sequence,
    components,
    publishedAt,
    expiresAt,
    platform,
    arch,
  });
  const manifest = privateKey ? signManifestPayload(payload, { privateKey, keyId }) : null;
  const manifestBytes = Buffer.from(JSON.stringify(manifest || { payload }, null, 2) + "\n", "utf8");
  const objects = buildComponentObjects({
    components,
    manifestPath,
    manifestBytes,
    channel,
  });
  return {
    schemaVersion: 1,
    version: normalizeVersion(appVersion),
    channel: normalizeComponentChannel(channel),
    sequence: normalizeSequence(sequence),
    signed: Boolean(manifest),
    keyId: manifest?.signature?.keyId || null,
    payload,
    manifest,
    objects,
    mirror: buildMirrorParityPlan({ objects, primaryBaseUrl, mirrorBaseUrl }),
  };
}

export function assertSignedComponentManifest(manifest, options = {}) {
  if (!manifest?.signature) throw new Error("Component manifest must be signed before publication");
  return verifySignedManifest(manifest, options);
}

export function sanitizeComponentPlan(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    version: plan.version,
    channel: plan.channel,
    sequence: plan.sequence,
    signed: plan.signed,
    keyId: plan.keyId,
    objects: plan.objects.map(({ type, id, key, size, sha256, contentType, cacheControl }) => ({
      type,
      ...(id ? { id } : {}),
      key,
      size,
      sha256,
      contentType,
      cacheControl,
    })),
    mirror: plan.mirror,
  };
}
