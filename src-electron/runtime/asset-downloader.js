import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import extractZip from "extract-zip";

import { assertSafeRelativePath } from "./manifest-verifier.js";
import {
  buildSourceUrl,
  classifyHttpStatus,
  classifySourceError,
  ReleaseSourceError,
  ReleaseSourcePool,
  SOURCE_ERROR_KIND,
} from "./release-source.js";
import { readJson, writeJsonAtomic } from "./runtime-layout.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_ATTEMPTS_PER_SOURCE = 3;
const DEFAULT_RETRY_DELAY_MS = 750;
const DEFAULT_DISK_SAFETY_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ZIP_ENTRIES = 200_000;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 16 * 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class AssetDownloadError extends ReleaseSourceError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "AssetDownloadError";
    this.code = options.code || "ASSET_DOWNLOAD_FAILED";
  }
}

function downloadError(message, { kind, code, sourceId, status, cause } = {}) {
  return new AssetDownloadError(message, { kind, code, sourceId, status, cause });
}

function validateArtifact(artifact) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw downloadError("Artifact descriptor must be an object", {
      kind: SOURCE_ERROR_KIND.CONFIGURATION,
      code: "ASSET_DESCRIPTOR_INVALID",
    });
  }
  const artifactPath = assertSafeRelativePath(
    artifact.artifactPath ?? artifact.path,
    "artifact.artifactPath"
  );
  const sha256 = String(artifact.sha256 ?? "").trim().toLowerCase();
  if (!SHA256_PATTERN.test(sha256)) {
    throw downloadError("Artifact SHA-256 is invalid", {
      kind: SOURCE_ERROR_KIND.CONFIGURATION,
      code: "ASSET_HASH_INVALID",
    });
  }
  const size = Number(artifact.size);
  if (!Number.isSafeInteger(size) || size < 1) {
    throw downloadError("Artifact size must be a positive safe integer", {
      kind: SOURCE_ERROR_KIND.CONFIGURATION,
      code: "ASSET_SIZE_INVALID",
    });
  }
  return { ...artifact, artifactPath, sha256, size };
}

function validateDownloadPaths(paths) {
  if (!paths || typeof paths !== "object") {
    throw downloadError("Download paths are required", {
      kind: SOURCE_ERROR_KIND.CONFIGURATION,
      code: "ASSET_PATHS_INVALID",
    });
  }
  const destination = path.resolve(String(paths.destination ?? ""));
  const partial = path.resolve(String(paths.partial ?? `${destination}.part`));
  const metadata = path.resolve(String(paths.metadata ?? `${destination}.meta.json`));
  if (!paths.destination || destination === partial || destination === metadata || partial === metadata) {
    throw downloadError("Download paths must be distinct absolute paths", {
      kind: SOURCE_ERROR_KIND.CONFIGURATION,
      code: "ASSET_PATHS_INVALID",
    });
  }
  return { destination, partial, metadata };
}

function delay(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    if (!signal) return;
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException("Operation aborted", "AbortError"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function createRequestSignal(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal.reason || new DOMException("Operation aborted", "AbortError"));
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

async function fetchWithTimeout(fetchImpl, url, init, { signal, timeoutMs, sourceId }) {
  const request = createRequestSignal(signal, timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: request.signal });
  } catch (error) {
    if (signal?.aborted) {
      throw downloadError("Asset download was cancelled", {
        kind: SOURCE_ERROR_KIND.CANCELLED,
        code: "ASSET_DOWNLOAD_CANCELLED",
        sourceId,
        cause: error,
      });
    }
    if (request.timedOut()) {
      throw downloadError("Asset request timed out", {
        kind: SOURCE_ERROR_KIND.NETWORK,
        code: "ASSET_REQUEST_TIMEOUT",
        sourceId,
        cause: error,
      });
    }
    throw classifySourceError(error, sourceId);
  } finally {
    request.cleanup();
  }
}

async function fileSize(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

export async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function removeDownloadState(paths) {
  await Promise.all([
    fsp.rm(paths.partial, { force: true }),
    fsp.rm(paths.metadata, { force: true }),
  ]);
}

async function defaultEnsureDiskSpace({ targetPath, requiredBytes, safetyBytes }) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  if (typeof fsp.statfs !== "function") return { availableBytes: null };
  const stats = await fsp.statfs(path.dirname(targetPath));
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  if (Number.isFinite(availableBytes) && availableBytes < requiredBytes + safetyBytes) {
    throw downloadError("Insufficient disk space for the component download", {
      kind: SOURCE_ERROR_KIND.DISK,
      code: "ASSET_DISK_SPACE_INSUFFICIENT",
    });
  }
  return { availableBytes };
}

function headInfo(response, artifact, sourceId) {
  if (!response.ok) throw classifyHttpStatus(response.status, sourceId);
  const contentLength = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(contentLength) || contentLength !== artifact.size) {
    throw downloadError("Release source reported an unexpected artifact size", {
      kind: SOURCE_ERROR_KIND.INTEGRITY,
      code: "ASSET_REMOTE_SIZE_MISMATCH",
      sourceId,
    });
  }
  return {
    contentLength,
    etag: response.headers.get("etag")?.trim() || null,
    acceptsRanges: /(?:^|,)\s*bytes\s*(?:,|$)/i.test(response.headers.get("accept-ranges") || ""),
  };
}

function contentRangeMatches(value, start, size) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(value || ""));
  if (!match) return false;
  return Number(match[1]) === start && Number(match[3]) === size && Number(match[2]) === size - 1;
}

async function promoteDownloadedFile(paths, artifact) {
  const destinationSize = await fileSize(paths.destination);
  if (destinationSize === artifact.size) {
    const existingHash = await hashFile(paths.destination);
    if (existingHash === artifact.sha256) {
      await removeDownloadState(paths);
      return { reused: true };
    }
  }
  if (destinationSize > 0) await fsp.rm(paths.destination, { force: true });
  await fsp.rename(paths.partial, paths.destination);
  await fsp.rm(paths.metadata, { force: true });
  return { reused: false };
}

async function prepareResume({ paths, artifact, url, head }) {
  const partialSize = await fileSize(paths.partial);
  const metadata = await readJson(paths.metadata, { defaultValue: null }).catch(() => null);
  const compatible = Boolean(
    partialSize > 0 &&
    partialSize < artifact.size &&
    head.acceptsRanges &&
    head.etag &&
    metadata?.schemaVersion === 1 &&
    metadata.url === url &&
    metadata.etag === head.etag &&
    metadata.size === artifact.size &&
    metadata.sha256 === artifact.sha256
  );
  if (!compatible && partialSize > 0) await removeDownloadState(paths);
  return compatible ? partialSize : 0;
}

async function streamResponseToFile({ response, paths, artifact, start, signal, onProgress, sourceId }) {
  if (!response.body) {
    throw downloadError("Release source returned an empty response body", {
      kind: SOURCE_ERROR_KIND.NETWORK,
      code: "ASSET_EMPTY_RESPONSE",
      sourceId,
    });
  }
  let writeStart = start;
  if (start > 0) {
    if (response.status === 200) writeStart = 0;
    else if (response.status !== 206 || !contentRangeMatches(response.headers.get("content-range"), start, artifact.size)) {
      throw downloadError("Release source returned an invalid range response", {
        kind: SOURCE_ERROR_KIND.INTEGRITY,
        code: "ASSET_RANGE_INVALID",
        sourceId,
      });
    }
  } else if (response.status !== 200) {
    throw downloadError(`Release source returned HTTP ${response.status} for a full download`, {
      kind: SOURCE_ERROR_KIND.HTTP,
      code: "ASSET_HTTP_STATUS",
      sourceId,
      status: response.status,
    });
  }

  const handle = await fsp.open(paths.partial, writeStart > 0 ? "a" : "w");
  let transferred = writeStart;
  try {
    for await (const chunk of response.body) {
      if (signal?.aborted) {
        throw downloadError("Asset download was cancelled", {
          kind: SOURCE_ERROR_KIND.CANCELLED,
          code: "ASSET_DOWNLOAD_CANCELLED",
          sourceId,
        });
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      transferred += buffer.length;
      if (transferred > artifact.size) {
        throw downloadError("Downloaded artifact is larger than its signed size", {
          kind: SOURCE_ERROR_KIND.INTEGRITY,
          code: "ASSET_SIZE_OVERFLOW",
          sourceId,
        });
      }
      await handle.write(buffer);
      try {
        onProgress?.({ transferred, total: artifact.size, percent: (transferred / artifact.size) * 100 });
      } catch {
        // UI progress reporting must not corrupt a verified download.
      }
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { transferred, resumedFrom: writeStart };
}

async function downloadFromSource(options, source) {
  const { artifact, paths, fetchImpl, timeoutMs, signal, ensureDiskSpace, diskSafetyBytes, onProgress } = options;
  const url = buildSourceUrl(source, artifact.artifactPath);
  await fsp.mkdir(path.dirname(paths.destination), { recursive: true });

  const existingSize = await fileSize(paths.destination);
  if (existingSize === artifact.size && await hashFile(paths.destination) === artifact.sha256) {
    return { path: paths.destination, sourceId: source.id, url, reused: true, resumedFrom: 0 };
  }

  const headResponse = await fetchWithTimeout(fetchImpl, url, { method: "HEAD", cache: "no-store" }, {
    signal,
    timeoutMs,
    sourceId: source.id,
  });
  const head = headInfo(headResponse, artifact, source.id);
  const resumeFrom = await prepareResume({ paths, artifact, url, head });
  await ensureDiskSpace({
    targetPath: paths.partial,
    requiredBytes: artifact.size - resumeFrom,
    safetyBytes: diskSafetyBytes,
    operation: "runtime-component-download",
  });
  await writeJsonAtomic(paths.metadata, {
    schemaVersion: 1,
    url,
    sourceId: source.id,
    etag: head.etag,
    size: artifact.size,
    sha256: artifact.sha256,
  });

  const headers = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-${artifact.size - 1}` } : undefined;
  const response = await fetchWithTimeout(fetchImpl, url, { method: "GET", headers, cache: "no-store" }, {
    signal,
    timeoutMs,
    sourceId: source.id,
  });
  if (!response.ok) throw classifyHttpStatus(response.status, source.id);
  const streamed = await streamResponseToFile({
    response,
    paths,
    artifact,
    start: resumeFrom,
    signal,
    onProgress,
    sourceId: source.id,
  });
  const completedSize = await fileSize(paths.partial);
  if (completedSize !== artifact.size) {
    throw downloadError("Asset download ended before the signed size was reached", {
      kind: SOURCE_ERROR_KIND.NETWORK,
      code: "ASSET_DOWNLOAD_TRUNCATED",
      sourceId: source.id,
    });
  }
  const sha256 = await hashFile(paths.partial);
  if (sha256 !== artifact.sha256) {
    await removeDownloadState(paths);
    throw downloadError("Downloaded artifact failed SHA-256 verification", {
      kind: SOURCE_ERROR_KIND.INTEGRITY,
      code: "ASSET_HASH_MISMATCH",
      sourceId: source.id,
    });
  }
  const promoted = await promoteDownloadedFile(paths, artifact);
  return {
    path: paths.destination,
    sourceId: source.id,
    url,
    size: artifact.size,
    sha256,
    reused: promoted.reused,
    resumedFrom: streamed.resumedFrom,
  };
}

function shouldRetrySameSource(error) {
  if (error.kind === SOURCE_ERROR_KIND.NETWORK) return true;
  if (error.kind !== SOURCE_ERROR_KIND.HTTP) return false;
  return [408, 425, 429].includes(error.status) || Number(error.status) >= 500;
}

export async function downloadArtifact({
  artifact: rawArtifact,
  paths: rawPaths,
  sources,
  sourcePool,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  attemptsPerSource = DEFAULT_ATTEMPTS_PER_SOURCE,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  signal,
  onProgress,
  ensureDiskSpace = defaultEnsureDiskSpace,
  diskSafetyBytes = DEFAULT_DISK_SAFETY_BYTES,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw downloadError("A Fetch API implementation is required", {
      kind: SOURCE_ERROR_KIND.CONFIGURATION,
      code: "ASSET_FETCH_UNAVAILABLE",
    });
  }
  const artifact = validateArtifact(rawArtifact);
  const paths = validateDownloadPaths(rawPaths);
  const pool = sourcePool || new ReleaseSourcePool({ sources });
  const attempts = Math.max(1, Number(attemptsPerSource) || 1);
  const options = {
    artifact,
    paths,
    fetchImpl,
    timeoutMs: Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS),
    signal,
    onProgress,
    ensureDiskSpace,
    diskSafetyBytes: Math.max(0, Number(diskSafetyBytes) || 0),
  };

  const { result, source } = await pool.run(async (candidate) => {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await downloadFromSource(options, candidate);
      } catch (rawError) {
        const error = classifySourceError(rawError, candidate.id);
        lastError = error;
        if (signal?.aborted || !shouldRetrySameSource(error) || attempt === attempts) throw error;
        await delay(retryDelayMs * attempt, signal);
      }
    }
    throw lastError;
  });
  return { ...result, sourceId: source.id, sourceHealth: pool.getHealth() };
}

function zipEntryMode(entry) {
  return (Number(entry.externalFileAttributes) >> 16) & 0xffff;
}

export function validateZipEntry(entry, state = {}, limits = {}) {
  const filename = String(entry?.fileName ?? "");
  if (!filename || filename.includes("\0") || filename.includes("\\")) {
    throw downloadError("ZIP contains an invalid entry path", {
      kind: SOURCE_ERROR_KIND.INTEGRITY,
      code: "ASSET_ZIP_PATH_INVALID",
    });
  }
  const trimmed = filename.endsWith("/") ? filename.slice(0, -1) : filename;
  const segments = trimmed.split("/");
  if (
    !trimmed ||
    trimmed.startsWith("/") ||
    /^[A-Za-z]:\//.test(trimmed) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw downloadError(`ZIP entry escapes the extraction root: ${filename}`, {
      kind: SOURCE_ERROR_KIND.INTEGRITY,
      code: "ASSET_ZIP_PATH_TRAVERSAL",
    });
  }
  const mode = zipEntryMode(entry);
  if ((mode & 0xf000) === 0xa000) {
    throw downloadError(`ZIP symlinks are not allowed: ${filename}`, {
      kind: SOURCE_ERROR_KIND.INTEGRITY,
      code: "ASSET_ZIP_SYMLINK",
    });
  }
  state.entries = Number(state.entries || 0) + 1;
  state.uncompressedBytes = Number(state.uncompressedBytes || 0) + Number(entry.uncompressedSize || 0);
  const maxEntries = Number(limits.maxEntries || DEFAULT_MAX_ZIP_ENTRIES);
  const maxUncompressedBytes = Number(limits.maxUncompressedBytes || DEFAULT_MAX_UNCOMPRESSED_BYTES);
  if (state.entries > maxEntries || state.uncompressedBytes > maxUncompressedBytes) {
    throw downloadError("ZIP exceeds the configured extraction limits", {
      kind: SOURCE_ERROR_KIND.INTEGRITY,
      code: "ASSET_ZIP_LIMIT_EXCEEDED",
    });
  }
  return state;
}

async function verifyExtractedTree(rootPath, currentPath = rootPath) {
  const entries = await fsp.readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(currentPath, entry.name);
    const stat = await fsp.lstat(entryPath);
    if (stat.isSymbolicLink()) {
      throw downloadError(`Extracted component contains a symlink: ${entry.name}`, {
        kind: SOURCE_ERROR_KIND.INTEGRITY,
        code: "ASSET_ZIP_SYMLINK",
      });
    }
    const realPath = await fsp.realpath(entryPath);
    const relative = path.relative(rootPath, realPath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw downloadError("Extracted component escapes the staging directory", {
        kind: SOURCE_ERROR_KIND.INTEGRITY,
        code: "ASSET_ZIP_PATH_TRAVERSAL",
      });
    }
    if (stat.isDirectory()) await verifyExtractedTree(rootPath, entryPath);
  }
}

export async function extractZipSafely({
  archivePath,
  destination,
  extractImpl = extractZip,
  maxEntries = DEFAULT_MAX_ZIP_ENTRIES,
  maxUncompressedBytes = DEFAULT_MAX_UNCOMPRESSED_BYTES,
} = {}) {
  const archive = path.resolve(String(archivePath ?? ""));
  const target = path.resolve(String(destination ?? ""));
  if (!archivePath || !destination || archive === target) {
    throw downloadError("Archive and extraction destination are required", {
      kind: SOURCE_ERROR_KIND.CONFIGURATION,
      code: "ASSET_EXTRACTION_PATH_INVALID",
    });
  }
  const archiveStat = await fsp.stat(archive).catch(() => null);
  if (!archiveStat?.isFile()) {
    throw downloadError("Component archive does not exist", {
      kind: SOURCE_ERROR_KIND.CONFIGURATION,
      code: "ASSET_ARCHIVE_MISSING",
    });
  }
  const existing = await fsp.readdir(target).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  if (existing.length > 0) {
    throw downloadError("Extraction destination must be empty", {
      kind: SOURCE_ERROR_KIND.CONFIGURATION,
      code: "ASSET_EXTRACTION_NOT_EMPTY",
    });
  }
  await fsp.mkdir(target, { recursive: true });
  const state = { entries: 0, uncompressedBytes: 0 };
  try {
    await extractImpl(archive, {
      dir: target,
      onEntry: (entry) => validateZipEntry(entry, state, { maxEntries, maxUncompressedBytes }),
    });
    await verifyExtractedTree(await fsp.realpath(target));
    return { destination: target, ...state };
  } catch (error) {
    await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    throw error instanceof ReleaseSourceError
      ? error
      : downloadError(`Component extraction failed: ${error.message}`, {
        kind: SOURCE_ERROR_KIND.INTEGRITY,
        code: "ASSET_EXTRACTION_FAILED",
        cause: error,
      });
  }
}

export {
  DEFAULT_ATTEMPTS_PER_SOURCE,
  DEFAULT_DISK_SAFETY_BYTES,
  DEFAULT_MAX_UNCOMPRESSED_BYTES,
  DEFAULT_MAX_ZIP_ENTRIES,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
};

