import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_CHANNELS = Object.freeze(["test", "beta", "stable"]);
export const MANIFEST_KEY_ID = "moonshine-app-manifest-v1";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MODEL_ID_PATTERN = /^[a-z][a-z0-9_.-]{1,63}$/;
const LICENSE_ACCEPTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;

export class ManifestVerificationError extends Error {
  constructor(message, code = "MANIFEST_INVALID", details = {}) {
    super(message);
    this.name = "ManifestVerificationError";
    this.code = code;
    this.details = details;
  }
}

function fail(message, code, details) {
  throw new ManifestVerificationError(message, code, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value, stack = new Set()) {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";

  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("Manifest contains a non-finite number", "MANIFEST_NON_CANONICAL");
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      fail("Manifest contains an unsupported number", "MANIFEST_NON_CANONICAL");
    }
    return encoded;
  }

  if (typeof value !== "object") {
    fail("Manifest contains an unsupported value", "MANIFEST_NON_CANONICAL");
  }
  if (stack.has(value)) {
    fail("Manifest contains a cyclic value", "MANIFEST_NON_CANONICAL");
  }
  stack.add(value);

  let result;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => canonicalize(item, stack)).join(",")}]`;
  } else {
    if (!isPlainObject(value)) {
      fail("Manifest values must be JSON objects or arrays", "MANIFEST_NON_CANONICAL");
    }
    result = `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], stack)}`)
      .join(",")}}`;
  }
  stack.delete(value);
  return result;
}

/**
 * RFC 8785-style canonical JSON for the JSON-compatible manifest values.
 * ECMAScript's JSON number and string serialization is used after recursively
 * sorting object keys, which is the representation used by the release signer.
 */
export function canonicalizeJson(value) {
  return Buffer.from(canonicalize(value), "utf8");
}

export function parseManifest(input) {
  if (typeof input === "string" || Buffer.isBuffer(input) || input instanceof Uint8Array) {
    try {
      return JSON.parse(Buffer.from(input).toString("utf8"));
    } catch (error) {
      fail(`Manifest JSON is invalid: ${error.message}`, "MANIFEST_PARSE_FAILED");
    }
  }
  return input;
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} is required`, "MANIFEST_FIELD_INVALID", { field: label });
  }
  return value.trim();
}

function validateVersion(value, label) {
  const version = requiredText(value, label);
  if (!VERSION_PATTERN.test(version)) {
    fail(`${label} has an invalid version`, "MANIFEST_FIELD_INVALID", { field: label });
  }
  return version;
}

function validateSha256(value, label) {
  const hash = requiredText(value, label).toLowerCase();
  if (!SHA256_PATTERN.test(hash)) {
    fail(`${label} must be a 64-character SHA-256 hex string`, "MANIFEST_FIELD_INVALID", {
      field: label,
    });
  }
  return hash;
}

function decodeBase64(value, label, expectedLength = null) {
  const encoded = requiredText(value, label);
  if (!BASE64_PATTERN.test(encoded) || encoded.length % 4 !== 0) {
    fail(`${label} is not valid base64`, "MANIFEST_FIELD_INVALID", { field: label });
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    fail(`${label} is not canonical base64`, "MANIFEST_FIELD_INVALID", { field: label });
  }
  if (expectedLength !== null && decoded.length !== expectedLength) {
    fail(`${label} has an unexpected length`, "MANIFEST_FIELD_INVALID", { field: label });
  }
  return decoded;
}

export function assertSafeRelativePath(value, label = "artifactPath") {
  const raw = requiredText(value, label);
  if (raw.includes("\0") || raw.includes("?") || raw.includes("#")) {
    fail(`${label} contains a forbidden character`, "MANIFEST_PATH_INVALID", { field: label });
  }

  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    fail(`${label} contains invalid URL encoding`, "MANIFEST_PATH_INVALID", { field: label });
  }
  const normalized = decoded.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    fail(`${label} must be a safe relative path`, "MANIFEST_PATH_INVALID", { field: label });
  }
  return normalized;
}

function validateDate(value, label) {
  const text = requiredText(value, label);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    fail(`${label} is not a valid ISO timestamp`, "MANIFEST_FIELD_INVALID", { field: label });
  }
  return { value: text, timestamp };
}

function validateHttpsUrl(value, label, { allowEmpty = false } = {}) {
  const text = String(value ?? "").trim();
  if (!text && allowEmpty) return "";
  if (!text) fail(`${label} is required`, "MANIFEST_FIELD_INVALID", { field: label });
  let url;
  try {
    url = new URL(text);
  } catch {
    fail(`${label} must be a valid HTTPS URL`, "MANIFEST_FIELD_INVALID", { field: label });
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    fail(`${label} must be a credential-free HTTPS URL`, "MANIFEST_FIELD_INVALID", { field: label });
  }
  return text;
}

function validateModelRegistry(models) {
  if (!Array.isArray(models) || models.length === 0) {
    fail("payload.models must be a non-empty array", "MANIFEST_FIELD_INVALID", {
      field: "payload.models",
    });
  }
  const ids = new Set();
  for (const [index, model] of models.entries()) {
    if (!isPlainObject(model)) {
      fail(`payload.models[${index}] must be an object`, "MANIFEST_FIELD_INVALID");
    }
    const prefix = `payload.models[${index}]`;
    const id = requiredText(model.id, `${prefix}.id`).toLowerCase();
    if (!MODEL_ID_PATTERN.test(id)) {
      fail(`${prefix}.id is invalid`, "MANIFEST_FIELD_INVALID", { field: `${prefix}.id` });
    }
    if (ids.has(id)) fail(`Duplicate model id: ${id}`, "MANIFEST_FIELD_INVALID");
    ids.add(id);
    requiredText(model.type, `${prefix}.type`);
    if (typeof model.downloadable !== "boolean") {
      fail(`${prefix}.downloadable must be a boolean`, "MANIFEST_FIELD_INVALID");
    }

    const files = model.files;
    if (!Array.isArray(files) || files.length === 0) {
      fail(`${prefix}.files must be a non-empty array`, "MANIFEST_FIELD_INVALID");
    }
    const filePaths = new Set();
    for (const [fileIndex, file] of files.entries()) {
      const filePrefix = `${prefix}.files[${fileIndex}]`;
      if (!isPlainObject(file)) fail(`${filePrefix} must be an object`, "MANIFEST_FIELD_INVALID");
      const filePath = assertSafeRelativePath(file.path, `${filePrefix}.path`);
      if (filePaths.has(filePath)) fail(`Duplicate model file path: ${filePath}`, "MANIFEST_FIELD_INVALID");
      filePaths.add(filePath);
      if (!Number.isSafeInteger(file.size) || file.size < 1) {
        fail(`${filePrefix}.size must be a positive safe integer`, "MANIFEST_FIELD_INVALID");
      }
      validateSha256(file.sha256, `${filePrefix}.sha256`);
      if (file.legacyPaths !== undefined) {
        if (!Array.isArray(file.legacyPaths)) {
          fail(`${filePrefix}.legacyPaths must be an array`, "MANIFEST_FIELD_INVALID");
        }
        file.legacyPaths.forEach((legacyPath, legacyIndex) =>
          assertSafeRelativePath(legacyPath, `${filePrefix}.legacyPaths[${legacyIndex}]`));
      }
    }

    const sourceLinks = model.sourceLinks ?? [];
    if (!Array.isArray(sourceLinks)) {
      fail(`${prefix}.sourceLinks must be an array`, "MANIFEST_FIELD_INVALID");
    }
    if (model.downloadable && sourceLinks.length === 0) {
      fail(`${prefix}.sourceLinks is required for downloadable models`, "MANIFEST_FIELD_INVALID");
    }
    sourceLinks.forEach((source, sourceIndex) => {
      if (!isPlainObject(source)) {
        fail(`${prefix}.sourceLinks[${sourceIndex}] must be an object`, "MANIFEST_FIELD_INVALID");
      }
      validateHttpsUrl(source.url, `${prefix}.sourceLinks[${sourceIndex}].url`);
    });
    const manualSources = model.manualSources ?? [];
    if (!Array.isArray(manualSources)) {
      fail(`${prefix}.manualSources must be an array`, "MANIFEST_FIELD_INVALID");
    }
    manualSources.forEach((source, sourceIndex) => {
      if (!isPlainObject(source)) {
        fail(`${prefix}.manualSources[${sourceIndex}] must be an object`, "MANIFEST_FIELD_INVALID");
      }
      validateHttpsUrl(source.url, `${prefix}.manualSources[${sourceIndex}].url`);
    });

    const license = model.license;
    if (license !== undefined) {
      if (!isPlainObject(license)) fail(`${prefix}.license must be an object`, "MANIFEST_FIELD_INVALID");
      requiredText(license.name, `${prefix}.license.name`);
      validateHttpsUrl(license.url, `${prefix}.license.url`, { allowEmpty: true });
      if (license.requiresAcceptance !== undefined && typeof license.requiresAcceptance !== "boolean") {
        fail(`${prefix}.license.requiresAcceptance must be a boolean`, "MANIFEST_FIELD_INVALID");
      }
      if (license.requiresAcceptance) {
        const acceptanceId = requiredText(license.acceptanceId, `${prefix}.license.acceptanceId`);
        if (!LICENSE_ACCEPTANCE_ID_PATTERN.test(acceptanceId)) {
          fail(`${prefix}.license.acceptanceId is invalid`, "MANIFEST_FIELD_INVALID");
        }
      }
    }
    const family = String(model.family || "").trim().toLowerCase();
    if ((family === "sam3" || id.startsWith("sam3")) && !license?.requiresAcceptance) {
      fail(`${prefix} requires an explicit SAM license acceptance gate`, "MANIFEST_LICENSE_GATE_REQUIRED");
    }
  }
}

function validatePayload(payload, options) {
  if (!isPlainObject(payload)) {
    fail("Manifest payload must be an object", "MANIFEST_FIELD_INVALID", { field: "payload" });
  }
  if (payload.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail("Manifest schemaVersion is not supported", "MANIFEST_SCHEMA_UNSUPPORTED", {
      schemaVersion: payload.schemaVersion,
    });
  }

  const channel = requiredText(payload.channel, "payload.channel");
  if (!MANIFEST_CHANNELS.includes(channel)) {
    fail(`Unsupported manifest channel: ${channel}`, "MANIFEST_FIELD_INVALID", {
      field: "payload.channel",
    });
  }
  if (options.expectedChannel && channel !== options.expectedChannel) {
    fail("Manifest channel does not match the requested channel", "MANIFEST_CHANNEL_MISMATCH");
  }

  if (!Number.isSafeInteger(payload.sequence) || payload.sequence < 1) {
    fail("payload.sequence must be a positive safe integer", "MANIFEST_FIELD_INVALID", {
      field: "payload.sequence",
    });
  }
  if (
    options.minimumSequence !== undefined &&
    (!Number.isSafeInteger(options.minimumSequence) || payload.sequence < options.minimumSequence)
  ) {
    fail("Manifest sequence is older than the locally accepted sequence", "MANIFEST_ROLLBACK");
  }

  const appVersion = validateVersion(payload.appVersion, "payload.appVersion");
  if (options.expectedAppVersion && appVersion !== options.expectedAppVersion) {
    fail("Manifest appVersion does not match the running application", "MANIFEST_VERSION_MISMATCH");
  }
  const platform = requiredText(payload.platform, "payload.platform");
  const arch = requiredText(payload.arch, "payload.arch");
  if (options.expectedPlatform && platform !== options.expectedPlatform) {
    fail("Manifest platform does not match the current platform", "MANIFEST_PLATFORM_MISMATCH");
  }
  if (options.expectedArch && arch !== options.expectedArch) {
    fail("Manifest architecture does not match the current architecture", "MANIFEST_ARCH_MISMATCH");
  }

  const published = validateDate(payload.publishedAt, "payload.publishedAt");
  const expires = validateDate(payload.expiresAt, "payload.expiresAt");
  if (expires.timestamp <= published.timestamp) {
    fail("payload.expiresAt must be after publishedAt", "MANIFEST_FIELD_INVALID");
  }
  const now = options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now());
  const clockSkewMs = Math.max(0, Number(options.clockSkewMs ?? 5 * 60 * 1000));
  if (!Number.isFinite(now)) {
    fail("Verifier clock is invalid", "MANIFEST_CLOCK_INVALID");
  }
  if (published.timestamp - now > clockSkewMs) {
    fail("Manifest is published in the future", "MANIFEST_NOT_YET_VALID");
  }
  if (now - expires.timestamp > clockSkewMs) {
    fail("Manifest has expired", "MANIFEST_EXPIRED");
  }

  if (payload.app !== undefined) {
    if (!isPlainObject(payload.app)) {
      fail("payload.app must be an object", "MANIFEST_FIELD_INVALID", { field: "payload.app" });
    }
    assertSafeRelativePath(payload.app.latestYmlPath, "payload.app.latestYmlPath");
    validateSha256(payload.app.latestYmlSha256, "payload.app.latestYmlSha256");
    validateSha256(payload.app.installerSha256, "payload.app.installerSha256");
    decodeBase64(payload.app.installerSha512, "payload.app.installerSha512");
  }

  if (payload.components !== undefined) {
    if (!Array.isArray(payload.components)) {
      fail("payload.components must be an array", "MANIFEST_FIELD_INVALID", {
        field: "payload.components",
      });
    }
    const ids = new Set();
    for (const [index, component] of payload.components.entries()) {
      if (!isPlainObject(component)) {
        fail(`payload.components[${index}] must be an object`, "MANIFEST_FIELD_INVALID");
      }
      const id = requiredText(component.id, `payload.components[${index}].id`);
      if (ids.has(id)) {
        fail(`Duplicate component id: ${id}`, "MANIFEST_FIELD_INVALID");
      }
      ids.add(id);
      requiredText(component.kind, `payload.components[${index}].kind`);
      validateVersion(component.version, `payload.components[${index}].version`);
      assertSafeRelativePath(component.artifactPath, `payload.components[${index}].artifactPath`);
      if (!Number.isSafeInteger(component.size) || component.size < 1) {
        fail(`payload.components[${index}].size must be a positive safe integer`, "MANIFEST_FIELD_INVALID");
      }
      validateSha256(component.sha256, `payload.components[${index}].sha256`);
      if (component.entrypoint !== undefined) {
        assertSafeRelativePath(component.entrypoint, `payload.components[${index}].entrypoint`);
      }
    }
  }

  if (payload.models !== undefined) {
    validateModelRegistry(payload.models);
  }

  if (
    payload.app === undefined &&
    (!Array.isArray(payload.components) || payload.components.length === 0) &&
    (!Array.isArray(payload.models) || payload.models.length === 0)
  ) {
    fail("Manifest must contain app, components or models", "MANIFEST_FIELD_INVALID");
  }
  return { channel, sequence: payload.sequence, appVersion, platform, arch };
}

function resolvePublicKey(publicKeys, keyId) {
  const value = publicKeys instanceof Map ? publicKeys.get(keyId) : publicKeys?.[keyId];
  if (!value) {
    fail(`No trusted public key is configured for ${keyId}`, "MANIFEST_UNKNOWN_KEY", { keyId });
  }
  try {
    return value.type === "public" || value.asymmetricKeyType ? value : createPublicKey(value);
  } catch (error) {
    fail(`Trusted public key is invalid: ${error.message}`, "MANIFEST_TRUST_CONFIG_INVALID", { keyId });
  }
}

export function validateManifestPayload(payload, options = {}) {
  const validation = validatePayload(payload, options);
  return { payload, ...validation };
}

export function verifySignedManifest(input, options = {}) {
  const manifest = parseManifest(input);
  if (!isPlainObject(manifest) || !isPlainObject(manifest.payload) || !isPlainObject(manifest.signature)) {
    fail("Manifest must contain payload and signature objects", "MANIFEST_FIELD_INVALID");
  }

  const signature = manifest.signature;
  if (signature.algorithm !== "Ed25519") {
    fail("Manifest signature algorithm is not supported", "MANIFEST_ALGORITHM_UNSUPPORTED");
  }
  const keyId = requiredText(signature.keyId, "signature.keyId");
  if (options.expectedKeyId && keyId !== options.expectedKeyId) {
    fail("Manifest keyId is not allowed", "MANIFEST_UNKNOWN_KEY", { keyId });
  }
  const signatureBytes = decodeBase64(signature.value, "signature.value", 64);
  const validation = validatePayload(manifest.payload, options);
  const canonicalPayload = canonicalizeJson(manifest.payload);
  const publicKey = resolvePublicKey(options.publicKeys, keyId);
  let valid = false;
  try {
    valid = verifySignature(null, canonicalPayload, publicKey, signatureBytes);
  } catch (error) {
    fail(`Manifest signature verification failed: ${error.message}`, "MANIFEST_SIGNATURE_INVALID");
  }
  if (!valid) {
    fail("Manifest signature verification failed", "MANIFEST_SIGNATURE_INVALID", { keyId });
  }

  return {
    manifest,
    payload: manifest.payload,
    signature: { algorithm: "Ed25519", keyId },
    canonicalPayload,
    payloadSha256: createHash("sha256").update(canonicalPayload).digest("hex"),
    ...validation,
  };
}
