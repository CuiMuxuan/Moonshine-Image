import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { parse as parseYaml } from "yaml";

import { signManifestPayload } from "./manifest-signing.mjs";
import { MANIFEST_KEY_ID } from "../../src-electron/runtime/manifest-verifier.js";
import { normalizeVersion } from "./app-release-lib.mjs";

const VERSIONED_APP_PREFIX = "app/win-x64";

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function safeName(value, label) {
  const name = requiredText(value, label);
  if (path.basename(name) !== name || /[\\/?#]/.test(name)) throw new Error(`${label} must be a filename`);
  return name;
}

async function hashFile(filePath, algorithm = "sha256", encoding = "hex") {
  const hash = createHash(algorithm);
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.readableWebStream()) hash.update(Buffer.from(chunk));
  } finally {
    await handle.close();
  }
  return hash.digest(encoding);
}

async function readArtifact(filePath, label) {
  const resolved = path.resolve(filePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || stat.size < 1) throw new Error(`${label} does not exist or is empty: ${resolved}`);
  return {
    path: resolved,
    name: safeName(path.basename(resolved), `${label} name`),
    size: stat.size,
    sha256: await hashFile(resolved),
  };
}

export async function buildAppManifestPayload({
  artifactDir = "dist/electron/Packaged",
  latestYmlPath,
  installerPath,
  blockmapPath,
  appVersion,
  channel = "stable",
  sequence,
  publishedAt = new Date().toISOString(),
  expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  releasePrefix = VERSIONED_APP_PREFIX,
} = {}) {
  const root = path.resolve(artifactDir);
  const manifestPath = path.resolve(latestYmlPath || path.join(root, "latest.yml"));
  const latestYml = await readArtifact(manifestPath, "latest.yml");
  const yaml = parseYaml(await fs.readFile(manifestPath, "utf8"));
  const version = normalizeVersion(appVersion || yaml.version);
  if (normalizeVersion(yaml.version) !== version) throw new Error("latest.yml version does not match appVersion");
  const installerName = safeName(
    yaml.path || yaml.files?.find((entry) => String(entry?.url || "").toLowerCase().endsWith(".exe"))?.url,
    "latest.yml installer path",
  );
  const installer = await readArtifact(installerPath || path.join(root, installerName), "installer");
  if (installer.name !== installerName) throw new Error("Installer filename does not match latest.yml");
  const blockmap = await readArtifact(blockmapPath || `${installer.path}.blockmap`, "blockmap");
  if (blockmap.name !== `${installerName}.blockmap`) throw new Error("Blockmap filename does not match installer");
  const yamlFile = yaml.files?.find((entry) => safeName(entry?.url, "latest.yml files[].url") === installerName);
  if (yamlFile?.size !== undefined && Number(yamlFile.size) !== installer.size) throw new Error("Installer size does not match latest.yml");
  const yamlPrefix = String(releasePrefix).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const normalizedChannel = requiredText(channel, "channel").toLowerCase();
  if (!/^(test|beta|stable)$/.test(normalizedChannel)) throw new Error(`Unsupported channel: ${normalizedChannel}`);
  const normalizedSequence = Number(sequence);
  if (!Number.isSafeInteger(normalizedSequence) || normalizedSequence < 1) throw new Error("sequence must be a positive safe integer");
  return {
    schemaVersion: 1,
    channel: normalizedChannel,
    sequence: normalizedSequence,
    appVersion: version,
    platform: "win32",
    arch: "x64",
    publishedAt,
    expiresAt,
    app: {
      latestYmlPath: `${yamlPrefix}/${normalizedChannel}/latest.yml`,
      latestYmlSha256: latestYml.sha256,
      installerPath: `${yamlPrefix}/${normalizedChannel}/${installer.name}`,
      installerSha256: installer.sha256,
      installerSha512: await hashFile(installer.path, "sha512", "base64"),
      blockmapPath: `${yamlPrefix}/${normalizedChannel}/${blockmap.name}`,
      blockmapSha256: blockmap.sha256,
    },
  };
}

export function signAppManifestPayload(payload, { privateKey, keyId = MANIFEST_KEY_ID } = {}) {
  return signManifestPayload(payload, { privateKey, keyId });
}

export async function signAppManifestFile({ outputPath, privateKey, ...options } = {}) {
  if (!outputPath) throw new Error("outputPath is required");
  if (!privateKey) throw new Error("A manifest private key is required");
  const payload = await buildAppManifestPayload(options);
  const manifest = signAppManifestPayload(payload, { privateKey, keyId: options.keyId });
  const destination = path.resolve(outputPath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { outputPath: destination, manifest, payload };
}
