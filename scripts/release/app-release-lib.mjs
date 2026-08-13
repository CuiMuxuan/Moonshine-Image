import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { parse as parseYaml } from "yaml";
import { assertEditionChannel } from "../../src-electron/updater/edition.js";

export const DEFAULT_BUCKET = "moonshine-image-app-release-prod";
export const DEFAULT_PUBLIC_BASE_URL = "https://download.moonshine.email";
export const DEFAULT_RELEASE_PREFIX = "app/win-x64";
export const STABLE_MANIFEST_NAME = "latest.yml";
export const APP_MANIFEST_PREFIX = "manifests";
export const APP_MANIFEST_NAME = "latest.json";
export const APP_RELEASE_CHANNELS = Object.freeze(["test", "stable"]);

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const STABLE_MANIFEST_CACHE_CONTROL = "no-cache, no-store, must-revalidate";
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const CONFIG_KEYS = [
  "R2_ACCOUNT_ID",
  "R2_ENDPOINT",
  "R2_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_REGION",
  "R2_PUBLIC_BASE_URL",
  "R2_RELEASE_PREFIX",
];

function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

export function normalizeVersion(value) {
  const version = requiredText(value, "version").replace(/^v/i, "");
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  return version;
}

export function normalizeReleaseChannel(value = "stable") {
  const channel = requiredText(value, "channel").toLowerCase();
  if (!APP_RELEASE_CHANNELS.includes(channel)) {
    throw new Error(`Unsupported release channel: ${channel}`);
  }
  return channel;
}

export function normalizeReleasePrefix(value = DEFAULT_RELEASE_PREFIX) {
  const prefix = requiredText(value, "R2_RELEASE_PREFIX")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const segments = prefix.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("R2_RELEASE_PREFIX must contain only safe path segments");
  }
  return segments.join("/");
}

export function parseKeyValueText(text, { source = "configuration" } = {}) {
  const values = {};
  const lines = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator < 1) {
      throw new Error(`${source}:${index + 1} must use KEY=VALUE syntax`);
    }

    const key = trimmed.slice(0, separator).trim();
    if (!KEY_PATTERN.test(key)) {
      throw new Error(`${source}:${index + 1} contains an invalid variable name`);
    }
    if (Object.hasOwn(values, key)) {
      throw new Error(`${source}:${index + 1} repeats ${key}`);
    }

    let value = trimmed.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

export function loadKeyValueFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  return parseKeyValueText(fs.readFileSync(resolvedPath, "utf8"), {
    source: resolvedPath,
  });
}

function normalizeHttpsUrl(value, label) {
  const url = new URL(requiredText(value, label));
  if (url.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function resolveR2Config({
  env = process.env,
  configFile,
  requireCredentials = true,
} = {}) {
  const fileValues = configFile ? loadKeyValueFile(configFile) : {};
  const values = { ...fileValues };

  for (const key of CONFIG_KEYS) {
    if (env[key] !== undefined && String(env[key]).trim() !== "") {
      values[key] = String(env[key]).trim();
    }
  }

  const accountId = String(values.R2_ACCOUNT_ID ?? "").trim();
  const endpointValue =
    String(values.R2_ENDPOINT ?? "").trim() ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");
  const endpoint = endpointValue
    ? normalizeHttpsUrl(endpointValue, "R2_ENDPOINT")
    : "";
  const accessKeyId = String(values.R2_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = String(values.R2_SECRET_ACCESS_KEY ?? "").trim();

  if (requireCredentials) {
    requiredText(endpoint, "R2_ENDPOINT or R2_ACCOUNT_ID");
    requiredText(accessKeyId, "R2_ACCESS_KEY_ID");
    requiredText(secretAccessKey, "R2_SECRET_ACCESS_KEY");
  }

  return {
    endpoint,
    bucket: String(values.R2_BUCKET || DEFAULT_BUCKET).trim(),
    accessKeyId,
    secretAccessKey,
    region: String(values.R2_REGION || "auto").trim(),
    publicBaseUrl: normalizeHttpsUrl(
      values.R2_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL,
      "R2_PUBLIC_BASE_URL"
    ),
    releasePrefix: normalizeReleasePrefix(
      values.R2_RELEASE_PREFIX || DEFAULT_RELEASE_PREFIX
    ),
  };
}

export function createR2Client(config) {
  requiredText(config.endpoint, "R2 endpoint");
  requiredText(config.accessKeyId, "R2 access key ID");
  requiredText(config.secretAccessKey, "R2 secret access key");
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region || "auto",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

function safeArtifactName(value, label) {
  const raw = requiredText(value, label);
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) || raw.includes("?") || raw.includes("#")) {
    throw new Error(`${label} must be a relative artifact filename`);
  }

  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new Error(`${label} contains invalid URL encoding`);
  }

  if (
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded === "." ||
    decoded === ".." ||
    path.basename(decoded) !== decoded
  ) {
    throw new Error(`${label} must not contain a directory path`);
  }
  return decoded;
}

function resolveExistingFile(filePath, label) {
  const resolvedPath = path.resolve(filePath);
  const stat = fs.statSync(resolvedPath, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    throw new Error(`${label} does not exist: ${resolvedPath}`);
  }
  if (stat.size < 1) {
    throw new Error(`${label} is empty: ${resolvedPath}`);
  }
  return { path: resolvedPath, size: stat.size };
}

export async function hashFile(filePath, algorithm = "sha256", encoding = "hex") {
  const hash = createHash(algorithm);
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest(encoding);
}

async function createArtifact(filePath, type) {
  const file = resolveExistingFile(filePath, type);
  return {
    type,
    path: file.path,
    name: path.basename(file.path),
    size: file.size,
    sha256: await hashFile(file.path),
  };
}

export async function loadReleaseDescriptor({
  artifactDir = "dist/electron/Packaged",
  manifestPath,
  installerPath,
  blockmapPath,
  appManifestPath,
  channel = "stable",
  version,
} = {}) {
  const resolvedArtifactDir = path.resolve(artifactDir);
  const expectedChannel = normalizeReleaseChannel(channel);
  const resolvedManifestPath = path.resolve(
    manifestPath || path.join(resolvedArtifactDir, STABLE_MANIFEST_NAME)
  );
  const manifestFile = resolveExistingFile(resolvedManifestPath, "latest.yml");

  let manifest;
  try {
    manifest = parseYaml(fs.readFileSync(manifestFile.path, "utf8"));
  } catch (error) {
    throw new Error(`latest.yml could not be parsed: ${error.message}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("latest.yml must contain a YAML object");
  }

  const manifestVersion = normalizeVersion(manifest.version);
  const expectedVersion = version ? normalizeVersion(version) : manifestVersion;
  if (manifestVersion !== expectedVersion) {
    throw new Error(
      `latest.yml version ${manifestVersion} does not match requested version ${expectedVersion}`
    );
  }
  const edition = assertEditionChannel(expectedVersion, expectedChannel);

  const manifestInstallerValue =
    manifest.path ||
    manifest.files?.find((entry) => String(entry?.url || "").toLowerCase().endsWith(".exe"))
      ?.url ||
    manifest.files?.[0]?.url;
  const manifestInstallerName = safeArtifactName(
    manifestInstallerValue,
    "latest.yml installer path"
  );
  const resolvedInstallerPath = path.resolve(
    installerPath || path.join(resolvedArtifactDir, manifestInstallerName)
  );
  if (path.basename(resolvedInstallerPath) !== manifestInstallerName) {
    throw new Error("The installer filename must match latest.yml");
  }

  const resolvedBlockmapPath = path.resolve(
    blockmapPath || `${resolvedInstallerPath}.blockmap`
  );
  if (path.basename(resolvedBlockmapPath) !== `${manifestInstallerName}.blockmap`) {
    throw new Error("The blockmap filename must match the installer filename");
  }

  const installer = await createArtifact(resolvedInstallerPath, "installer");
  const blockmap = await createArtifact(resolvedBlockmapPath, "blockmap");
  const manifestArtifact = await createArtifact(manifestFile.path, "manifest");
  let appManifestArtifact = null;
  let appManifest = null;
  if (appManifestPath) {
    appManifestArtifact = await createArtifact(path.resolve(appManifestPath), "app manifest");
    try {
      appManifest = JSON.parse(fs.readFileSync(appManifestArtifact.path, "utf8"));
    } catch (error) {
      throw new Error(`Signed app manifest could not be parsed: ${error.message}`);
    }
    if (!appManifest?.payload || !appManifest?.signature) {
      throw new Error("Signed app manifest must contain payload and signature");
    }
    if (normalizeVersion(appManifest.payload.appVersion) !== expectedVersion) {
      throw new Error("Signed app manifest version does not match the release version");
    }
    if (normalizeReleaseChannel(appManifest.payload.channel) !== expectedChannel) {
      throw new Error("Signed app manifest channel does not match the release channel");
    }
  }

  const manifestFileEntry = manifest.files?.find(
    (entry) => safeArtifactName(entry?.url, "latest.yml files[].url") === installer.name
  );
  if (manifestFileEntry?.size !== undefined && Number(manifestFileEntry.size) !== installer.size) {
    throw new Error("The installer size does not match latest.yml");
  }
  if (manifestFileEntry?.sha512) {
    const actualSha512 = await hashFile(installer.path, "sha512", "base64");
    if (actualSha512 !== String(manifestFileEntry.sha512).trim()) {
      throw new Error("The installer sha512 does not match latest.yml");
    }
  }

  return {
    version: expectedVersion,
    edition: edition.edition,
    identity: edition,
    channel: expectedChannel,
    artifactDir: resolvedArtifactDir,
    manifest,
    installer,
    blockmap,
    manifestArtifact,
    appManifest,
    appManifestArtifact,
  };
}

function joinObjectKey(...segments) {
  return segments
    .flatMap((segment) => String(segment).replace(/\\/g, "/").split("/"))
    .filter(Boolean)
    .join("/");
}

export function buildReleaseObjects(
  descriptor,
  releasePrefix = DEFAULT_RELEASE_PREFIX,
  { channel = descriptor.channel || "stable" } = {},
) {
  const prefix = normalizeReleasePrefix(releasePrefix);
  const releaseChannel = normalizeReleaseChannel(channel);
  assertEditionChannel(descriptor.version, releaseChannel);
  const channelPrefix = joinObjectKey(prefix, releaseChannel);
  const manifestArchivePrefix = joinObjectKey(
    prefix,
    "manifests",
    normalizeVersion(descriptor.version)
  );

  const channelManifest = {
    ...descriptor.manifestArtifact,
    key: joinObjectKey(channelPrefix, STABLE_MANIFEST_NAME),
    contentType: "application/yaml; charset=utf-8",
    cacheControl: STABLE_MANIFEST_CACHE_CONTROL,
    immutable: false,
  };

  const objects = {
    installer: {
      ...descriptor.installer,
      key: joinObjectKey(channelPrefix, safeArtifactName(descriptor.installer.name, "installer")),
      contentType: "application/vnd.microsoft.portable-executable",
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      immutable: true,
    },
    blockmap: {
      ...descriptor.blockmap,
      key: joinObjectKey(channelPrefix, safeArtifactName(descriptor.blockmap.name, "blockmap")),
      contentType: "application/octet-stream",
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      immutable: true,
    },
    archivedManifest: {
      ...descriptor.manifestArtifact,
      key: joinObjectKey(manifestArchivePrefix, STABLE_MANIFEST_NAME),
      contentType: "application/yaml; charset=utf-8",
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      immutable: true,
    },
    channelManifest,
    ...(descriptor.appManifestArtifact
      ? {
          archivedAppManifest: {
            ...descriptor.appManifestArtifact,
            key: joinObjectKey(
              APP_MANIFEST_PREFIX,
              normalizeVersion(descriptor.version),
              ...(releaseChannel === "stable" ? [] : [releaseChannel]),
              APP_MANIFEST_NAME,
            ),
            contentType: "application/json; charset=utf-8",
            cacheControl: IMMUTABLE_CACHE_CONTROL,
            immutable: true,
          },
          channelAppManifest: {
            ...descriptor.appManifestArtifact,
            key: joinObjectKey(APP_MANIFEST_PREFIX, releaseChannel, APP_MANIFEST_NAME),
            contentType: "application/json; charset=utf-8",
            cacheControl: STABLE_MANIFEST_CACHE_CONTROL,
            immutable: false,
          },
        }
      : {}),
  };

  if (releaseChannel === "stable") {
    objects.stableManifest = objects.channelManifest;
    if (objects.channelAppManifest) objects.stableAppManifest = objects.channelAppManifest;
  }
  return objects;
}

export function publicObjectUrl(publicBaseUrl, key, { cacheBust } = {}) {
  const base = normalizeHttpsUrl(publicBaseUrl, "public base URL");
  const encodedKey = String(key)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = new URL(`${base}/${encodedKey}`);
  if (cacheBust) {
    url.searchParams.set("verify", String(cacheBust));
  }
  return url.toString();
}

function isNotFound(error) {
  return (
    error?.$metadata?.httpStatusCode === 404 ||
    error?.name === "NotFound" ||
    error?.name === "NoSuchKey" ||
    error?.Code === "NoSuchKey"
  );
}

function isPreconditionFailed(error) {
  return (
    error?.$metadata?.httpStatusCode === 412 ||
    error?.name === "PreconditionFailed" ||
    error?.Code === "PreconditionFailed"
  );
}

export async function headObjectOrNull(client, bucket, key) {
  try {
    return await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

function assertHeadMatches(head, object) {
  if (Number(head.ContentLength) !== object.size) {
    throw new Error(`R2 object ${object.key} has an unexpected content length`);
  }
  const remoteSha256 = String(head.Metadata?.sha256 || "").toLowerCase();
  if (!remoteSha256 || remoteSha256 !== object.sha256.toLowerCase()) {
    throw new Error(`R2 object ${object.key} has an unexpected sha256 metadata value`);
  }
  const expectedType = object.contentType.split(";", 1)[0].toLowerCase();
  const actualType = String(head.ContentType || "").split(";", 1)[0].toLowerCase();
  if (actualType !== expectedType) {
    throw new Error(`R2 object ${object.key} has an unexpected content type`);
  }
  if (String(head.CacheControl || "") !== object.cacheControl) {
    throw new Error(`R2 object ${object.key} has an unexpected cache policy`);
  }
}

async function hashBody(body) {
  if (body === undefined || body === null) {
    throw new Error("R2 returned an empty object body");
  }
  const hash = createHash("sha256");

  if (typeof body === "string" || body instanceof Uint8Array || Buffer.isBuffer(body)) {
    hash.update(body);
    return hash.digest("hex");
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) {
      hash.update(chunk);
    }
    return hash.digest("hex");
  }
  if (typeof body.transformToByteArray === "function") {
    hash.update(await body.transformToByteArray());
    return hash.digest("hex");
  }
  throw new Error("R2 returned an unsupported object body");
}

export async function verifyS3Object({ client, bucket, object }) {
  const head = await headObjectOrNull(client, bucket, object.key);
  if (!head) {
    throw new Error(`R2 object is missing: ${object.key}`);
  }
  assertHeadMatches(head, object);

  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: object.key })
  );
  const actualSha256 = await hashBody(response.Body);
  if (actualSha256 !== object.sha256) {
    throw new Error(`R2 object ${object.key} failed the full sha256 check`);
  }
  return { size: object.size, sha256: actualSha256 };
}

function objectMetadata(object, version) {
  return {
    sha256: object.sha256,
    releaseversion: normalizeVersion(version),
  };
}

export async function putImmutableObject({ client, bucket, object, version }) {
  const existing = await headObjectOrNull(client, bucket, object.key);
  if (existing) {
    assertHeadMatches(existing, object);
    await verifyS3Object({ client, bucket, object });
    return { action: "reused", key: object.key };
  }

  let preconditionRace = false;
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: object.key,
        Body: fs.createReadStream(object.path),
        ContentLength: object.size,
        ContentType: object.contentType,
        CacheControl: object.cacheControl,
        Metadata: objectMetadata(object, version),
        IfNoneMatch: "*",
      })
    );
  } catch (error) {
    if (!isPreconditionFailed(error)) {
      throw error;
    }
    preconditionRace = true;
  }

  await verifyS3Object({ client, bucket, object });
  return { action: preconditionRace ? "reused" : "uploaded", key: object.key };
}

export async function putStableManifest({ client, bucket, object, version }) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: object.key,
      Body: fs.createReadStream(object.path),
      ContentLength: object.size,
      ContentType: object.contentType,
      CacheControl: object.cacheControl,
      Metadata: objectMetadata(object, version),
    })
  );
  await verifyS3Object({ client, bucket, object });
  return { action: "published", key: object.key };
}

function headerMatchesContentType(actual, expected) {
  if (!actual) return false;
  return (
    String(actual).split(";", 1)[0].trim().toLowerCase() ===
    String(expected).split(";", 1)[0].trim().toLowerCase()
  );
}

function headerContainsCacheDirectives(actual, expected) {
  if (!expected) return true;
  if (!actual) return false;
  const actualDirectives = new Set(
    String(actual)
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return String(expected)
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .every((value) => actualDirectives.has(value));
}

async function hashWebBody(body) {
  if (!body) {
    throw new Error("Public download returned an empty response body");
  }
  const hash = createHash("sha256");
  for await (const chunk of body) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retry(label, operation, { attempts, retryDelayMs }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts && retryDelayMs > 0) {
        await delay(retryDelayMs * attempt);
      }
    }
  }
  throw new Error(`${label} failed after ${attempts} attempt(s): ${lastError.message}`);
}

export async function verifyPublicObject({
  fetchImpl = globalThis.fetch,
  publicBaseUrl,
  object,
  attempts = 6,
  retryDelayMs = 2_000,
  requestTimeoutMs = 300_000,
  cacheBust,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A Fetch API implementation is required");
  }
  const url = publicObjectUrl(publicBaseUrl, object.key, { cacheBust });

  return retry(
    `Public verification for ${object.key}`,
    async () => {
      const head = await fetchImpl(url, {
        method: "HEAD",
        cache: "no-store",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!head.ok) {
        throw new Error(`HEAD returned HTTP ${head.status}`);
      }
      const headLength = head.headers.get("content-length");
      const headEncoding = String(head.headers.get("content-encoding") || "").trim();
      if (headLength !== null && Number(headLength) !== object.size) {
        throw new Error("HEAD returned an unexpected content length");
      }
      if (headLength === null && !headEncoding) {
        throw new Error("HEAD omitted content length without declaring content encoding");
      }
      if (!headerMatchesContentType(head.headers.get("content-type"), object.contentType)) {
        throw new Error("HEAD returned an unexpected content type");
      }
      if (!headerContainsCacheDirectives(head.headers.get("cache-control"), object.cacheControl)) {
        throw new Error("HEAD returned unexpected Cache-Control directives");
      }

      const rangeEnd = Math.min(object.size - 1, 1_023);
      const range = await fetchImpl(url, {
        method: "GET",
        headers: { Range: `bytes=0-${rangeEnd}` },
        cache: "no-store",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (range.status !== 206) {
        throw new Error(`Range GET returned HTTP ${range.status}; expected 206`);
      }
      const expectedRange = `bytes 0-${rangeEnd}/${object.size}`;
      if (range.headers.get("content-range") !== expectedRange) {
        throw new Error("Range GET returned an unexpected Content-Range header");
      }
      const rangeBody = await range.arrayBuffer();
      if (rangeBody.byteLength !== rangeEnd + 1) {
        throw new Error("Range GET returned an unexpected response length");
      }

      const full = await fetchImpl(url, {
        method: "GET",
        cache: "no-store",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!full.ok) {
        throw new Error(`Full GET returned HTTP ${full.status}`);
      }
      const actualSha256 = await hashWebBody(full.body);
      if (actualSha256 !== object.sha256) {
        throw new Error("Full GET failed the sha256 check");
      }
      return { url, size: object.size, sha256: actualSha256 };
    },
    { attempts, retryDelayMs }
  );
}

function plannedObject(object, publicBaseUrl) {
  return {
    type: object.type,
    key: object.key,
    url: publicObjectUrl(publicBaseUrl, object.key),
    size: object.size,
    sha256: object.sha256,
    cacheControl: object.cacheControl,
  };
}

async function verifyOneObject({
  client,
  config,
  object,
  publicOnly,
  fetchImpl,
  attempts,
  retryDelayMs,
  requestTimeoutMs,
  cacheBust,
}) {
  if (!publicOnly) {
    await verifyS3Object({ client, bucket: config.bucket, object });
  }
  await verifyPublicObject({
    fetchImpl,
    publicBaseUrl: config.publicBaseUrl,
    object,
    attempts,
    retryDelayMs,
    requestTimeoutMs,
    cacheBust,
  });
  return plannedObject(object, config.publicBaseUrl);
}

export async function uploadImmutableRelease({
  client,
  config,
  descriptor,
  channel = descriptor.channel || "stable",
  dryRun = false,
  fetchImpl = globalThis.fetch,
  attempts = 6,
  retryDelayMs = 2_000,
  requestTimeoutMs = 300_000,
}) {
  const releaseChannel = normalizeReleaseChannel(channel);
  const objects = buildReleaseObjects(descriptor, config.releasePrefix, { channel: releaseChannel });
  const immutableObjects = [
    objects.installer,
    objects.blockmap,
    objects.archivedManifest,
    ...(objects.archivedAppManifest ? [objects.archivedAppManifest] : []),
  ];
  const plan = immutableObjects.map((object) => plannedObject(object, config.publicBaseUrl));
  if (dryRun) {
    return { phase: "immutable", channel: releaseChannel, dryRun: true, objects: plan };
  }

  const results = [];
  for (const object of immutableObjects) {
    const upload = await putImmutableObject({
      client,
      bucket: config.bucket,
      object,
      version: descriptor.version,
    });
    const verification = await verifyPublicObject({
      fetchImpl,
      publicBaseUrl: config.publicBaseUrl,
      object,
      attempts,
      retryDelayMs,
      requestTimeoutMs,
      // A re-uploaded immutable key can remain at an edge with stale bytes.
      // Verify a deterministic query variant so the upload gate checks R2's
      // current object rather than a cached response for the bare URL.
      cacheBust: object.sha256.slice(0, 16),
    });
    results.push({ ...plannedObject(object, config.publicBaseUrl), action: upload.action, verification });
  }
  return { phase: "immutable", channel: releaseChannel, dryRun: false, objects: results };
}

export function assertStableConfirmation(confirmation, version) {
  const expected = normalizeVersion(version);
  if (String(confirmation ?? "").trim() !== expected) {
    throw new Error(
      `Stable publication requires --confirm-stable ${expected} after manual approval`
    );
  }
}

export function assertChannelConfirmation(confirmation, channel, version) {
  const expectedChannel = normalizeReleaseChannel(channel);
  const expectedVersion = normalizeVersion(version);
  const expected = `${expectedChannel}:${expectedVersion}`;
  if (String(confirmation ?? "").trim() !== expected) {
    throw new Error(
      `Channel publication requires --confirm-channel ${expected} after manual approval`,
    );
  }
}

export async function publishChannelRelease({
  client,
  config,
  descriptor,
  channel = descriptor.channel || "stable",
  confirmation,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  attempts = 6,
  retryDelayMs = 2_000,
  requestTimeoutMs = 300_000,
}) {
  const releaseChannel = normalizeReleaseChannel(channel);
  const objects = buildReleaseObjects(descriptor, config.releasePrefix, { channel: releaseChannel });
  if (!dryRun) assertChannelConfirmation(confirmation, releaseChannel, descriptor.version);

  const channelObjects = [
    objects.channelManifest,
    ...(objects.channelAppManifest ? [objects.channelAppManifest] : []),
  ];
  const plan = channelObjects.map((object) => plannedObject(object, config.publicBaseUrl));
  if (dryRun) {
    return { phase: releaseChannel, channel: releaseChannel, dryRun: true, objects: plan };
  }

  for (const object of [
    objects.installer,
    objects.blockmap,
    objects.archivedManifest,
    ...(objects.archivedAppManifest ? [objects.archivedAppManifest] : []),
  ]) {
    await verifyOneObject({
      client,
      config,
      object,
      publicOnly: false,
      fetchImpl,
      attempts,
      retryDelayMs,
      requestTimeoutMs,
      cacheBust: object.sha256.slice(0, 16),
    });
  }

  const results = [];
  for (const object of channelObjects) {
    const publish = await putStableManifest({
      client,
      bucket: config.bucket,
      object,
      version: descriptor.version,
    });
    const verification = await verifyPublicObject({
      fetchImpl,
      publicBaseUrl: config.publicBaseUrl,
      object,
      attempts,
      retryDelayMs,
      requestTimeoutMs,
      cacheBust: object.sha256.slice(0, 16),
    });
    results.push({ ...plannedObject(object, config.publicBaseUrl), action: publish.action, verification });
  }

  return { phase: releaseChannel, channel: releaseChannel, dryRun: false, objects: results };
}

export async function publishStableRelease({
  client,
  config,
  descriptor,
  confirmation,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  attempts = 6,
  retryDelayMs = 2_000,
  requestTimeoutMs = 300_000,
}) {
  if (!dryRun) assertStableConfirmation(confirmation, descriptor.version);
  return publishChannelRelease({
    client,
    config,
    descriptor,
    channel: "stable",
    confirmation: `stable:${descriptor.version}`,
    dryRun,
    fetchImpl,
    attempts,
    retryDelayMs,
    requestTimeoutMs,
  });
}

export async function verifyRelease({
  client,
  config,
  descriptor,
  scope = "immutable",
  channel = descriptor.channel || "stable",
  publicOnly = false,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  attempts = 6,
  retryDelayMs = 2_000,
  requestTimeoutMs = 300_000,
}) {
  if (!new Set(["immutable", "channel", "stable"]).has(scope)) {
    throw new Error("Verification scope must be immutable, channel, or stable");
  }
  const releaseChannel = normalizeReleaseChannel(channel);
  const objects = buildReleaseObjects(descriptor, config.releasePrefix, { channel: releaseChannel });
  const effectiveScope = scope === "stable" ? "channel" : scope;
  const selected =
    effectiveScope === "channel"
      ? [
          objects.channelManifest,
          ...(objects.channelAppManifest ? [objects.channelAppManifest] : []),
          objects.installer,
          objects.blockmap,
        ]
      : [
          objects.installer,
          objects.blockmap,
          objects.archivedManifest,
          ...(objects.archivedAppManifest ? [objects.archivedAppManifest] : []),
        ];
  const plan = selected.map((object) => plannedObject(object, config.publicBaseUrl));
  if (dryRun) {
    return { phase: `verify-${releaseChannel}`, channel: releaseChannel, publicOnly, dryRun: true, objects: plan };
  }

  const results = [];
  for (const object of selected) {
    const verification = await verifyOneObject({
      client,
      config,
      object,
      publicOnly,
      fetchImpl,
      attempts,
      retryDelayMs,
      requestTimeoutMs,
      cacheBust: object.sha256.slice(0, 16),
    });
    results.push(verification);
  }
  return { phase: `verify-${releaseChannel}`, channel: releaseChannel, publicOnly, dryRun: false, objects: results };
}

export function parseCliArgs(argv, { boolean = [], values = [] } = {}) {
  const booleanFlags = new Set(boolean);
  const valueFlags = new Set(values);
  const result = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const [rawName, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (booleanFlags.has(rawName)) {
      if (inlineValue !== undefined) {
        throw new Error(`--${rawName} does not accept a value`);
      }
      result[rawName] = true;
      continue;
    }
    if (!valueFlags.has(rawName)) {
      throw new Error(`Unknown option: --${rawName}`);
    }
    const value = inlineValue !== undefined ? inlineValue : argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${rawName} requires a value`);
    }
    result[rawName] = value;
  }
  return result;
}

export function commonCliOptions(args) {
  const attempts = Number.parseInt(args.attempts || "6", 10);
  const retryDelayMs = Number.parseInt(args["retry-delay-ms"] || "2000", 10);
  const requestTimeoutMs = Number.parseInt(
    args["request-timeout-ms"] || "300000",
    10,
  );
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) {
    throw new Error("--attempts must be an integer from 1 to 20");
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 60_000) {
    throw new Error("--retry-delay-ms must be an integer from 0 to 60000");
  }
  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1_000 ||
    requestTimeoutMs > 3_600_000
  ) {
    throw new Error("--request-timeout-ms must be an integer from 1000 to 3600000");
  }
  return { attempts, retryDelayMs, requestTimeoutMs };
}

export function writeReleaseReport(report, reportPath) {
  const payload = {
    generatedAt: new Date().toISOString(),
    ...report,
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (reportPath) {
    const resolvedPath = path.resolve(reportPath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, serialized, "utf8");
  }
  process.stdout.write(serialized);
}

export function safeCliError(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [
    process.env.R2_ACCESS_KEY_ID,
    process.env.R2_SECRET_ACCESS_KEY,
  ]) {
    if (secret && String(secret).length >= 4) {
      message = message.split(String(secret)).join("[redacted]");
    }
  }
  return message;
}
