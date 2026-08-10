import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const COMPONENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const COMPONENT_IDS = Object.freeze({
  PYTHON_CPU: "python-cpu",
  PYTHON_CU130: "python-cu130",
  FFMPEG: "ffmpeg",
});

export class RuntimeLayoutError extends Error {
  constructor(message, code = "RUNTIME_LAYOUT_INVALID") {
    super(message);
    this.name = "RuntimeLayoutError";
    this.code = code;
  }
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new RuntimeLayoutError(`${label} is required`, "RUNTIME_LAYOUT_PATH_REQUIRED");
  }
  return path.resolve(value);
}

export function normalizeComponentId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  if (!COMPONENT_ID_PATTERN.test(id)) {
    throw new RuntimeLayoutError(`Invalid component id: ${id}`, "RUNTIME_COMPONENT_ID_INVALID");
  }
  return id;
}

export function normalizeComponentVersion(value) {
  const version = String(value ?? "").trim();
  if (!VERSION_PATTERN.test(version) || version === "." || version === "..") {
    throw new RuntimeLayoutError(`Invalid component version: ${version}`, "RUNTIME_COMPONENT_VERSION_INVALID");
  }
  return version;
}

export function normalizeOperationId(value) {
  const operationId = String(value ?? "").trim();
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new RuntimeLayoutError("Invalid runtime operation id", "RUNTIME_OPERATION_ID_INVALID");
  }
  return operationId;
}

export function assertPathWithin(rootPath, targetPath, label = "path") {
  const root = requiredPath(rootPath, "rootPath");
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new RuntimeLayoutError(`${label} escapes its root`, "RUNTIME_PATH_TRAVERSAL");
  }
  return target;
}

function resolveLocalAppData({ localAppData, env = process.env } = {}) {
  const configured = String(localAppData ?? "").trim();
  if (configured) return path.resolve(configured);
  const fromEnv = String(env.LOCALAPPDATA ?? "").trim();
  if (fromEnv) return path.resolve(fromEnv, "Moonshine-Image", "components");
  return "";
}

export function createRuntimeLayout({ localAppData, userData, env = process.env } = {}) {
  const configuredLocal = resolveLocalAppData({ localAppData, env });
  const fallback = requiredPath(userData || path.join(os.tmpdir(), "Moonshine-Image-userData"), "userData");
  const root = configuredLocal || path.join(fallback, "components");
  const downloads = assertPathWithin(root, path.join(root, "downloads"), "downloads");
  const staging = assertPathWithin(root, path.join(root, "staging"), "staging");
  const runtimes = assertPathWithin(root, path.join(root, "runtimes"), "runtimes");
  const ffmpeg = assertPathWithin(root, path.join(root, "ffmpeg"), "ffmpeg");
  return Object.freeze({
    root,
    downloads,
    staging,
    runtimes,
    ffmpeg,
    activePointer: path.join(root, "active.json"),
    verifiedManifest: path.join(root, "verified-manifest.json"),
    verifiedModelManifest: path.join(root, "verified-model-manifest.json"),
    channelPreferences: path.join(root, "channel.json"),
    lockFile: path.join(root, "runtime.lock"),
  });
}

export function resolveComponentDirectory(layout, componentId, version) {
  const id = normalizeComponentId(componentId);
  const normalizedVersion = normalizeComponentVersion(version);
  let parent;
  if (id === COMPONENT_IDS.FFMPEG) {
    parent = layout.ffmpeg;
  } else {
    parent = path.join(layout.runtimes, id);
  }
  return assertPathWithin(layout.root, path.join(parent, normalizedVersion), "component directory");
}

export function resolveStagingDirectory(layout, operationId, componentId) {
  const operation = normalizeOperationId(operationId);
  const id = normalizeComponentId(componentId);
  return assertPathWithin(layout.root, path.join(layout.staging, operation, id), "staging directory");
}

export function resolveDownloadPaths(layout, artifact = {}) {
  const artifactPath = String(artifact.artifactPath ?? artifact.path ?? "").trim();
  if (!artifactPath) throw new RuntimeLayoutError("artifactPath is required", "RUNTIME_ARTIFACT_PATH_REQUIRED");
  const segments = artifactPath.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new RuntimeLayoutError("artifactPath contains unsafe segments", "RUNTIME_PATH_TRAVERSAL");
  }
  const digest = String(artifact.sha256 ?? "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new RuntimeLayoutError("artifact.sha256 must be a 64-character hex digest", "RUNTIME_ARTIFACT_HASH_INVALID");
  }
  const filename = `${path.basename(artifactPath)}.${digest.slice(0, 16)}`;
  const destination = assertPathWithin(layout.downloads, path.join(layout.downloads, filename), "download path");
  return Object.freeze({
    destination,
    partial: `${destination}.part`,
    metadata: `${destination}.meta.json`,
  });
}

async function ensureParent(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

export async function ensureRuntimeDirectories(layout) {
  await Promise.all([
    fsp.mkdir(layout.root, { recursive: true }),
    fsp.mkdir(layout.downloads, { recursive: true }),
    fsp.mkdir(layout.staging, { recursive: true }),
    fsp.mkdir(layout.runtimes, { recursive: true }),
    fsp.mkdir(layout.ffmpeg, { recursive: true }),
  ]);
  return layout;
}

async function replaceFileAtomic(tempPath, targetPath) {
  try {
    await fsp.rename(tempPath, targetPath);
    return;
  } catch (error) {
    if (!(["EEXIST", "EPERM", "ENOTEMPTY"].includes(error.code))) throw error;
  }
  const backupPath = `${targetPath}.previous-${process.pid}-${Date.now()}`;
  try {
    await fsp.rename(targetPath, backupPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await fsp.rename(tempPath, targetPath);
  } finally {
    await fsp.rm(backupPath, { force: true }).catch(() => {});
  }
}

export async function writeJsonAtomic(filePath, value) {
  const targetPath = path.resolve(filePath);
  await ensureParent(targetPath);
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await replaceFileAtomic(tempPath, targetPath);
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
  }
  return targetPath;
}

export async function readJson(filePath, { defaultValue = null } = {}) {
  try {
    return JSON.parse(await fsp.readFile(path.resolve(filePath), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return defaultValue;
    throw error;
  }
}

export async function writeActivePointer(layout, pointer) {
  if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) {
    throw new RuntimeLayoutError("active pointer must be an object", "RUNTIME_POINTER_INVALID");
  }
  return writeJsonAtomic(layout.activePointer, pointer);
}

export async function writeVerifiedManifest(layout, manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new RuntimeLayoutError("verified manifest must be an object", "RUNTIME_MANIFEST_INVALID");
  }
  return writeJsonAtomic(layout.verifiedManifest, manifest);
}

export function isRegularFilePath(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
