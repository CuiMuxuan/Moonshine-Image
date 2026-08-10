import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

import {
  MANIFEST_KEY_ID,
  verifySignedManifest,
} from "../../src-electron/runtime/manifest-verifier.js";

const SECRET_ENV_NAMES = [
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_ACCOUNT_ID",
  "R2_ENDPOINT",
  "MOONSHINE_MANIFEST_PRIVATE_KEY_PEM",
];

function nowIso() {
  return new Date().toISOString();
}

export function sanitizeUrl(value) {
  try {
    const url = new URL(String(value));
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[redacted-url]";
  }
}

export function sanitizeText(value, secrets = process.env) {
  let text = String(value ?? "");
  for (const name of SECRET_ENV_NAMES) {
    const secret = String(secrets?.[name] || "");
    if (secret.length >= 4) text = text.split(secret).join("[redacted]");
  }
  text = text.replace(
    /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
    "[redacted-key]",
  );
  return text.replace(/[A-Za-z]:\\Users\\[^\s"']+/gi, "[local-path]");
}

export function createValidationReport({ mode = "network", primaryUrl, mirrorUrl } = {}) {
  return {
    schemaVersion: 1,
    validatorVersion: "1.0.0",
    mode,
    startedAt: nowIso(),
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      osRelease: os.release(),
    },
    sources: {
      primary: primaryUrl ? sanitizeUrl(primaryUrl) : null,
      mirror: mirrorUrl ? sanitizeUrl(mirrorUrl) : null,
    },
    checks: [],
    summary: { passed: 0, failed: 0, skipped: 0 },
  };
}

export function recordCheck(report, { id, status, details = {}, error } = {}) {
  const normalizedStatus = ["pass", "fail", "skip"].includes(status) ? status : "fail";
  const entry = {
    id: String(id || "unnamed"),
    status: normalizedStatus,
    details: sanitizeValue(details),
  };
  if (error) entry.error = sanitizeText(error?.message || error);
  report.checks.push(entry);
  report.summary[normalizedStatus === "pass" ? "passed" : normalizedStatus === "fail" ? "failed" : "skipped"] += 1;
  return entry;
}

export function evaluateSourceAvailability({
  mode = "network",
  primaryOk,
  mirrorConfigured = false,
  mirrorOk = false,
} = {}) {
  if (!mirrorConfigured) {
    return {
      status: primaryOk ? "pass" : "fail",
      selectedSource: primaryOk ? "primary" : null,
      failoverExercised: false,
      reason: primaryOk ? "primary source is available" : "primary source is unavailable",
    };
  }
  if (primaryOk) {
    return {
      status: mirrorOk ? "pass" : "fail",
      selectedSource: "primary",
      failoverExercised: false,
      reason: mirrorOk ? "primary and mirror are available" : "mirror source is unavailable",
    };
  }
  if (mirrorOk && mode === "source-failover") {
    return {
      status: "pass",
      selectedSource: "mirror",
      failoverExercised: true,
      reason: "mirror remained available while the primary source was unavailable",
    };
  }
  return {
    status: "fail",
    selectedSource: mirrorOk ? "mirror" : null,
    failoverExercised: false,
    reason: mirrorOk
      ? "primary source is unavailable outside an explicit source-failover exercise"
      : "all configured release sources are unavailable",
  };
}

function sanitizeValue(value, key = "") {
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, item]) => [
        childKey,
        /url/i.test(childKey) && typeof item === "string"
          ? sanitizeUrl(item)
          : sanitizeValue(item, childKey),
      ]),
    );
  }
  return value;
}

export function finalizeValidationReport(report) {
  return {
    ...report,
    finishedAt: nowIso(),
    ok: report.summary.failed === 0,
  };
}

export async function writeValidationReport(report, { reportPath, reportDir } = {}) {
  const finalReport = finalizeValidationReport(report);
  const outputPath = path.resolve(
    reportPath || path.join(reportDir || process.cwd(), "moonshine-release-validation.json"),
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(finalReport, null, 2)}\n`, "utf8");
  return { outputPath, report: finalReport };
}

function timeoutSignal(milliseconds) {
  return typeof AbortSignal?.timeout === "function"
    ? AbortSignal.timeout(milliseconds)
    : undefined;
}

export function objectUrl(baseUrl, relativePath) {
  const base = new URL(String(baseUrl));
  if (base.protocol !== "https:") throw new Error("Validation sources must use HTTPS");
  base.username = "";
  base.password = "";
  base.search = "";
  base.hash = "";
  base.pathname = base.pathname.replace(/\/+$/, "");
  const encoded = String(relativePath)
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base.toString().replace(/\/$/, "")}/${encoded}`;
}

// electron-builder writes a basename in latest.yml while the feed itself may
// live under a channel directory. Resolve that basename beside latest.yml;
// paths that already contain a directory remain root-relative release paths.
export function resolveReleaseArtifactPath(indexPath, artifactPath) {
  const artifact = String(artifactPath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!artifact) throw new Error("Release artifact path is empty");
  if (artifact.includes("/")) return artifact;
  const index = String(indexPath ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const directory = index.includes("/") ? index.slice(0, index.lastIndexOf("/")) : "";
  return directory ? `${directory}/${artifact}` : artifact;
}

async function responseBytes(response) {
  if (!response?.body) return Buffer.from(await response.arrayBuffer());
  const chunks = [];
  for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function fetchJson(fetchImpl, url, { timeoutMs = 120_000 } = {}) {
  const response = await fetchImpl(url, {
    method: "GET",
    cache: "no-store",
    signal: timeoutSignal(timeoutMs),
  });
  if (!response.ok) throw new Error(`GET ${sanitizeUrl(url)} returned HTTP ${response.status}`);
  const bytes = await responseBytes(response);
  try {
    return { value: JSON.parse(bytes.toString("utf8")), bytes };
  } catch (error) {
    throw new Error(`Invalid JSON from ${sanitizeUrl(url)}: ${error.message}`);
  }
}

export async function verifyManifestDocument({
  fetchImpl = globalThis.fetch,
  baseUrl,
  manifestPath,
  publicKeys,
  channel,
  appVersion,
  timeoutMs = 120_000,
  minimumSequence,
} = {}) {
  const url = objectUrl(baseUrl, manifestPath);
  const { value, bytes } = await fetchJson(fetchImpl, url, { timeoutMs });
  const verification = verifySignedManifest(value, {
    publicKeys,
    expectedKeyId: MANIFEST_KEY_ID,
    expectedChannel: channel,
    expectedPlatform: "win32",
    expectedArch: "x64",
    expectedAppVersion: appVersion,
    minimumSequence,
  });
  return { url, manifest: value, bytes, verification };
}

function headerNumber(headers, name) {
  const rawValue = headers.get(name);
  if (rawValue === null || String(rawValue).trim() === "") return null;
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : null;
}

export async function checkRemoteObject({
  fetchImpl = globalThis.fetch,
  baseUrl,
  relativePath,
  expectedSize,
  expectedSha256,
  timeoutMs = 300_000,
  fullDownload = true,
  returnBody = false,
} = {}) {
  const url = objectUrl(baseUrl, relativePath);
  const head = await fetchImpl(url, {
    method: "HEAD",
    cache: "no-store",
    signal: timeoutSignal(timeoutMs),
  });
  if (!head.ok) throw new Error(`HEAD ${sanitizeUrl(url)} returned HTTP ${head.status}`);
  const headSize = headerNumber(head.headers, "content-length");
  const headEncoding = String(head.headers.get("content-encoding") || "").trim();
  if (expectedSize !== undefined && headSize !== null && headSize !== Number(expectedSize)) {
    throw new Error(`HEAD size mismatch for ${relativePath}`);
  }
  if (expectedSize !== undefined && headSize === null && !headEncoding) {
    throw new Error(`HEAD omitted size without declaring content encoding for ${relativePath}`);
  }

  const rangeEnd = Math.min(Math.max((Number(expectedSize) || headSize || 1) - 1, 0), 1023);
  const range = await fetchImpl(url, {
    method: "GET",
    headers: { Range: `bytes=0-${rangeEnd}` },
    cache: "no-store",
    signal: timeoutSignal(timeoutMs),
  });
  if (range.status !== 206) throw new Error(`Range GET ${relativePath} returned HTTP ${range.status}`);
  const rangeHeader = range.headers.get("content-range") || "";
  const expectedTotal = Number(expectedSize ?? headSize);
  if (Number.isFinite(expectedTotal) && expectedTotal > 0) {
    const expectedRange = `bytes 0-${rangeEnd}/${expectedTotal}`;
    if (rangeHeader !== expectedRange) throw new Error(`Range Content-Range mismatch for ${relativePath}`);
  }
  const rangeBytes = await responseBytes(range);
  if (rangeBytes.length !== rangeEnd + 1) throw new Error(`Range length mismatch for ${relativePath}`);

  let actualSha256 = null;
  let bodyBytes = null;
  if (fullDownload) {
    const full = await fetchImpl(url, {
      method: "GET",
      cache: "no-store",
      signal: timeoutSignal(timeoutMs),
    });
    if (!full.ok) throw new Error(`GET ${relativePath} returned HTTP ${full.status}`);
    const hash = createHash("sha256");
    const bodyChunks = returnBody ? [] : null;
    let size = 0;
    if (full.body) {
      for await (const chunk of full.body) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        hash.update(buffer);
        bodyChunks?.push(buffer);
      }
    } else {
      const buffer = Buffer.from(await full.arrayBuffer());
      size = buffer.length;
      hash.update(buffer);
      bodyBytes = returnBody ? buffer : null;
    }
    actualSha256 = hash.digest("hex");
    if (returnBody && !bodyBytes) bodyBytes = Buffer.concat(bodyChunks || []);
    if (expectedSize !== undefined && size !== Number(expectedSize)) {
      throw new Error(`GET size mismatch for ${relativePath}`);
    }
    if (expectedSha256 && actualSha256 !== String(expectedSha256).toLowerCase()) {
      throw new Error(`GET sha256 mismatch for ${relativePath}`);
    }
  }
  return {
    url: sanitizeUrl(url),
    size: headSize ?? (expectedSize === undefined ? null : Number(expectedSize)),
    sha256: actualSha256,
    fullDownload,
    ...(bodyBytes ? { body: bodyBytes } : {}),
  };
}

export async function inspectLocalInstall({ installRoot, appExecutable, runExecutable = false, timeoutMs = 60_000 } = {}) {
  const result = { installRoot: installRoot ? path.resolve(installRoot) : null, appExecutable: null, files: {} };
  if (installRoot) {
    const root = path.resolve(installRoot);
    for (const relative of ["resources/app.asar", "resources/preload/electron-preload.cjs"]) {
      const target = path.join(root, relative);
      result.files[relative] = (await fs.stat(target, { throwIfNoEntry: false }))?.isFile?.() || false;
    }
  }
  if (appExecutable) {
    const executable = path.resolve(appExecutable);
    result.appExecutable = executable;
    const stat = await fs.stat(executable, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(`Application executable does not exist: ${executable}`);
    if (runExecutable) await runCommand(executable, ["--version"], timeoutMs);
  }
  return result;
}

export async function inspectManagedEnvironment({ environmentRoot, expectedFlavor } = {}) {
  const root = path.resolve(String(environmentRoot || ""));
  if (!environmentRoot) throw new Error("environmentRoot is required");
  const activePath = path.join(root, "active.json");
  const active = JSON.parse(await fs.readFile(activePath, "utf8"));
  const flavor = String(active.flavor || active.accelerator || "").toLowerCase();
  if (expectedFlavor && flavor && flavor !== String(expectedFlavor).toLowerCase()) {
    throw new Error(`Managed environment flavor mismatch: expected ${expectedFlavor}, received ${flavor}`);
  }
  const environmentPath = path.resolve(root, String(active.path || active.environmentPath || ""));
  const rootRelative = path.relative(root, environmentPath);
  if (!rootRelative || rootRelative.startsWith(`..${path.sep}`) || path.isAbsolute(rootRelative)) {
    throw new Error("Managed environment active path escapes environment root");
  }
  const pythonCandidates = [
    path.join(environmentPath, "python.exe"),
    path.join(environmentPath, "Scripts", "python.exe"),
    path.join(environmentPath, "bin", "python"),
  ];
  let pythonPath = null;
  for (const candidate of pythonCandidates) {
    const stats = await fs.stat(candidate, { throwIfNoEntry: false });
    if (stats?.isFile?.()) {
      pythonPath = candidate;
      break;
    }
  }
  if (!pythonPath) throw new Error("Managed environment Python executable is missing");
  return {
    root,
    flavor: flavor || null,
    environmentPath,
    python: path.relative(root, pythonPath).replace(/\\/g, "/"),
    activeSequence: active.sequence ?? null,
  };
}

function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out: ${command}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Command exited ${code}: ${sanitizeText(Buffer.concat(stderr).toString("utf8"))}`));
      else resolve({ code, stdout: sanitizeText(Buffer.concat(stdout).toString("utf8")) });
    });
  });
}

export async function runCommandProbe(command, args = [], timeoutMs = 60_000) {
  return runCommand(command, args, timeoutMs);
}
