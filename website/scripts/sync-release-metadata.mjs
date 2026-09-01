#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertSafeRelativePath,
  verifySignedManifest,
} from "../../src-electron/runtime/manifest-verifier.js";
import {
  EMBEDDED_RELEASE_KEY_ID,
  EMBEDDED_RELEASE_PUBLIC_KEY_PEM,
} from "../../src-electron/runtime/release-public-key.generated.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST_URL = "https://download.moonshine.email/manifests/stable/latest.json";
const DEFAULT_OUTPUT_PATH = path.resolve(__dirname, "..", "release", "latest.json");
const DOWNLOAD_ORIGIN = "https://download.moonshine.email/";
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function parseTrustedManifestUrl(value) {
  const url = new URL(requiredText(value, "Stable manifest URL"));
  if (
    url.protocol !== "https:"
    || url.hostname !== "download.moonshine.email"
    || url.username
    || url.password
    || url.pathname !== "/manifests/stable/latest.json"
    || url.search
    || url.hash
  ) {
    throw new Error("Stable manifest URL must be the canonical Moonshine HTTPS manifest URL");
  }
  return url;
}

function assertInstallerPath(value, version) {
  const installerPath = assertSafeRelativePath(value, "payload.app.installerPath");
  const expectedPath = `app/win-x64/stable/Moonshine-Image-Setup-${version}.exe`;
  if (installerPath !== expectedPath) {
    throw new Error("payload.app.installerPath does not match the signed stable Windows installer");
  }
  return installerPath;
}

function buildWebsiteMetadata(manifest, source) {
  const { payload, payloadSha256 } = verifySignedManifest(manifest, {
    publicKeys: { [EMBEDDED_RELEASE_KEY_ID]: EMBEDDED_RELEASE_PUBLIC_KEY_PEM },
    expectedKeyId: EMBEDDED_RELEASE_KEY_ID,
    expectedChannel: "stable",
    expectedPlatform: "win32",
    expectedArch: "x64",
  });

  if (!payload.app || typeof payload.app !== "object" || Array.isArray(payload.app)) {
    throw new Error("Signed stable manifest does not contain app metadata");
  }

  const version = requiredText(payload.appVersion, "payload.appVersion");
  const installerPath = assertInstallerPath(payload.app.installerPath, version);
  const installerSha256 = requiredText(payload.app.installerSha256, "payload.app.installerSha256").toLowerCase();
  if (!SHA256_PATTERN.test(installerSha256)) {
    throw new Error("payload.app.installerSha256 must be a SHA-256 digest");
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source,
    version,
    channel: payload.channel,
    platform: payload.platform,
    arch: payload.arch,
    sequence: payload.sequence,
    publishedAt: payload.publishedAt,
    expiresAt: payload.expiresAt,
    installerUrl: new URL(installerPath, DOWNLOAD_ORIGIN).toString(),
    installerPath,
    installerSha256,
    payloadSha256,
    payload,
    signature: manifest.signature,
  };
}

async function fetchManifest(source) {
  const response = await fetch(source, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Stable manifest request failed with HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 1024 * 1024) {
    throw new Error("Stable manifest response is unexpectedly large");
  }

  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > 1024 * 1024) {
    throw new Error("Stable manifest response is unexpectedly large");
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`Stable manifest is not valid JSON: ${error.message}`);
  }
}

async function main() {
  const source = parseTrustedManifestUrl(
    process.env.MOONSHINE_WEBSITE_STABLE_MANIFEST_URL || DEFAULT_MANIFEST_URL,
  ).toString();
  const outputPath = path.resolve(
    process.env.MOONSHINE_WEBSITE_RELEASE_METADATA_PATH || DEFAULT_OUTPUT_PATH,
  );
  const manifest = await fetchManifest(source);
  const metadata = buildWebsiteMetadata(manifest, source);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ outputPath, version: metadata.version, installerUrl: metadata.installerUrl })}\n`);
}

main().catch((error) => {
  process.stderr.write(`Website release metadata sync failed: ${error.message}\n`);
  process.exitCode = 1;
});
