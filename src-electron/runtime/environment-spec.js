import { createHash } from "node:crypto";

export const ENVIRONMENT_SPEC_SCHEMA = 1;
export const DEFAULT_PYTHON_VERSION = "3.12.10";
export const ACCELERATOR_PREFERENCES = Object.freeze(["auto", "cpu", "cu130"]);
export const BUNDLED_FFMPEG_SPEC_HASH = createHash("sha256")
  .update("moonshine-image:app-bundled-ffmpeg:v1")
  .digest("hex");

const HASH_PATTERN = /^[a-f0-9]{64}$/i;

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
    if (!Number.isFinite(value)) throw new TypeError("Environment spec contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("Environment spec contains an unsupported value");
  if (stack.has(value)) throw new TypeError("Environment spec contains a cyclic value");
  stack.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => canonicalize(item, stack)).join(",")}]`;
  } else {
    if (!isPlainObject(value)) throw new TypeError("Environment spec values must be plain objects");
    result = `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], stack)}`)
      .join(",")}}`;
  }
  stack.delete(value);
  return result;
}

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function normalizeHash(value, label) {
  const hash = requiredText(value, label).toLowerCase();
  if (!HASH_PATTERN.test(hash)) {
    throw new TypeError(`${label} must be a 64-character SHA-256 hex string`);
  }
  return hash;
}

export function normalizeAcceleratorPreference(value = "auto") {
  const preference = String(value ?? "auto").trim().toLowerCase();
  if (!ACCELERATOR_PREFERENCES.includes(preference)) {
    throw new TypeError(`Unsupported accelerator preference: ${preference || "missing"}`);
  }
  return preference;
}

function normalizeAccelerator(value) {
  const accelerator = String(value ?? "").trim().toLowerCase();
  if (accelerator !== "cpu" && accelerator !== "cu130") {
    throw new TypeError(`Environment accelerator must be cpu or cu130: ${accelerator || "missing"}`);
  }
  return accelerator;
}

function normalizeVersion(value, label) {
  return requiredText(value, label);
}

/**
 * Returns the identity fields used to decide whether a local environment can be reused.
 * Deliberately excludes timestamps and specHash so equivalent inputs hash identically.
 */
export function createEnvironmentSpec({
  schema = ENVIRONMENT_SPEC_SCHEMA,
  appVersion,
  pythonVersion = DEFAULT_PYTHON_VERSION,
  accelerator,
  requirementsLockHash,
  ffmpegHash,
  sam3WheelHash,
} = {}) {
  if (schema !== ENVIRONMENT_SPEC_SCHEMA) {
    throw new TypeError(`Unsupported environment spec schema: ${schema}`);
  }
  const spec = {
    schema: ENVIRONMENT_SPEC_SCHEMA,
    appVersion: normalizeVersion(appVersion, "appVersion"),
    pythonVersion: normalizeVersion(pythonVersion, "pythonVersion"),
    accelerator: normalizeAccelerator(accelerator),
    requirementsLockHash: normalizeHash(requirementsLockHash, "requirementsLockHash"),
    ffmpegHash: normalizeHash(ffmpegHash, "ffmpegHash"),
  };
  if (sam3WheelHash !== undefined && sam3WheelHash !== null && String(sam3WheelHash).trim()) {
    spec.sam3WheelHash = normalizeHash(sam3WheelHash, "sam3WheelHash");
  }
  return Object.freeze(spec);
}

export function canonicalizeEnvironmentSpec(spec) {
  const base = createEnvironmentSpec(spec);
  return Buffer.from(canonicalize(base), "utf8");
}

export function computeEnvironmentSpecHash(spec) {
  return createHash("sha256").update(canonicalizeEnvironmentSpec(spec)).digest("hex");
}

export function buildEnvironmentSpec(options = {}) {
  const spec = createEnvironmentSpec(options);
  return Object.freeze({ ...spec, specHash: computeEnvironmentSpecHash(spec) });
}

export function verifyEnvironmentSpecHash(spec) {
  if (!spec || typeof spec !== "object") return false;
  const expected = computeEnvironmentSpecHash(spec);
  return String(spec.specHash || "").toLowerCase() === expected;
}

export function isEnvironmentSpec(value) {
  try {
    return Boolean(value && verifyEnvironmentSpecHash(value));
  } catch {
    return false;
  }
}
