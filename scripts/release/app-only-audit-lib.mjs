import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";
import { resolveAppEdition } from "../../src-electron/updater/edition.js";

import {
  INTEGRITY_MANIFEST_FILE,
  INTEGRITY_PUBLIC_KEY_PEM,
  INTEGRITY_RESOURCE_DIR,
  INTEGRITY_SIGNATURE_FILE,
  PACKAGED_BACKEND_RESOURCE_DIR,
  PACKAGED_FFMPEG_RESOURCE_DIR,
  PACKAGED_MODELS_RESOURCE_DIR,
  PACKAGED_RUNTIME_RESOURCE_DIR,
} from "../../src-electron/integrity/public-key.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sha512Base64File(filePath) {
  return crypto.createHash("sha512").update(fs.readFileSync(filePath)).digest("base64");
}

function toPosixPath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function listRegularFiles(rootDir) {
  const result = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const currentPath = queue.pop();
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const absolutePath = path.join(currentPath, entry.name);
      assert(!entry.isSymbolicLink(), `App-only resources must not contain symlinks: ${absolutePath}`);
      if (entry.isDirectory()) {
        queue.push(absolutePath);
      } else if (entry.isFile()) {
        result.push(absolutePath);
      }
    }
  }
  return result.sort();
}

function resolveManifestEntry(resourcesRoot, entryPath) {
  assert(typeof entryPath === "string" && entryPath.length > 0, "Integrity entry path is required");
  const normalized = entryPath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  assert(
    !path.posix.isAbsolute(normalized)
      && segments.every((segment) => segment && segment !== "." && segment !== ".."),
    `Unsafe integrity entry path: ${entryPath}`,
  );
  const absolutePath = path.resolve(resourcesRoot, ...segments);
  const relativePath = path.relative(resourcesRoot, absolutePath);
  assert(
    relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath),
    `Integrity entry escapes resources root: ${entryPath}`,
  );
  return absolutePath;
}

function auditIntegrity(resourcesRoot, integrityPublicKeyPem) {
  const integrityRoot = path.join(resourcesRoot, INTEGRITY_RESOURCE_DIR);
  const manifestPath = path.join(integrityRoot, INTEGRITY_MANIFEST_FILE);
  const signaturePath = path.join(integrityRoot, INTEGRITY_SIGNATURE_FILE);
  assert(fs.existsSync(manifestPath), `Missing integrity manifest: ${manifestPath}`);
  assert(fs.existsSync(signaturePath), `Missing integrity signature: ${signaturePath}`);

  const manifestBytes = fs.readFileSync(manifestPath);
  const signature = fs.readFileSync(signaturePath, "utf8").trim();
  assert(signature, "Integrity signature is empty");
  assert(
    crypto.verify(null, manifestBytes, integrityPublicKeyPem, Buffer.from(signature, "base64")),
    "Integrity manifest signature verification failed",
  );

  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert(manifest.schemaVersion === 1, `Unsupported integrity schema: ${manifest.schemaVersion}`);
  assert(manifest.hashAlgorithm === "sha256", "Integrity manifest must use sha256");
  assert(manifest.resourceMode === "app-only", "Integrity manifest resourceMode must be app-only");
  assert(Array.isArray(manifest.entries) && manifest.entries.length > 0, "Integrity manifest has no entries");

  const allowedPrefixes = new Set([
    `${PACKAGED_BACKEND_RESOURCE_DIR}/`,
    `${PACKAGED_FFMPEG_RESOURCE_DIR}/`,
  ]);
  const entryPaths = new Set();
  for (const entry of manifest.entries) {
    assert(entry && typeof entry === "object", "Integrity entry must be an object");
    assert(
      [...allowedPrefixes].some((prefix) => entry.path.startsWith(prefix)),
      `App-only integrity entry must be under backend/ or ffmpeg/: ${entry.path}`,
    );
    assert(!entryPaths.has(entry.path), `Duplicate integrity entry: ${entry.path}`);
    entryPaths.add(entry.path);
    assert(Number.isSafeInteger(entry.size) && entry.size >= 0, `Invalid entry size: ${entry.path}`);
    assert(/^[a-f0-9]{64}$/.test(entry.sha256), `Invalid entry sha256: ${entry.path}`);
    const absolutePath = resolveManifestEntry(resourcesRoot, entry.path);
    assert(fs.existsSync(absolutePath), `Protected resource is missing: ${entry.path}`);
    const stats = fs.lstatSync(absolutePath);
    assert(stats.isFile() && !stats.isSymbolicLink(), `Protected resource is not a regular file: ${entry.path}`);
    assert(stats.size === entry.size, `Protected resource size mismatch: ${entry.path}`);
    assert(sha256File(absolutePath) === entry.sha256, `Protected resource hash mismatch: ${entry.path}`);
  }

  const packagedResourcePaths = [];
  for (const resourceName of [PACKAGED_BACKEND_RESOURCE_DIR, PACKAGED_FFMPEG_RESOURCE_DIR]) {
    const resourceRoot = path.join(resourcesRoot, resourceName);
    assert(fs.existsSync(resourceRoot), `Missing app-only ${resourceName} resources: ${resourceRoot}`);
    packagedResourcePaths.push(
      ...listRegularFiles(resourceRoot).map((absolutePath) =>
        toPosixPath(path.relative(resourcesRoot, absolutePath)),
      ),
    );
  }
  const unprotected = packagedResourcePaths.filter((entryPath) => !entryPaths.has(entryPath));
  const unprotectedBackend = unprotected.filter((entryPath) =>
    entryPath.startsWith(`${PACKAGED_BACKEND_RESOURCE_DIR}/`),
  );
  assert(
    unprotectedBackend.length === 0,
    `Unprotected backend resources: ${unprotectedBackend.join(", ")}`,
  );
  assert(unprotected.length === 0, `Unprotected app-only resources: ${unprotected.join(", ")}`);
  assert(
    packagedResourcePaths.length === entryPaths.size,
    "Integrity manifest contains unexpected app-only entries",
  );

  const forbiddenResourceDirs = [
    PACKAGED_RUNTIME_RESOURCE_DIR,
    PACKAGED_MODELS_RESOURCE_DIR,
  ];
  for (const directoryName of forbiddenResourceDirs) {
    assert(
      !fs.existsSync(path.join(resourcesRoot, directoryName)),
      `App-only package contains forbidden resource directory: ${directoryName}`,
    );
  }

  return {
    resourceMode: manifest.resourceMode,
    entryCount: manifest.entries.length,
    prefixes: [...new Set(manifest.entries.map((entry) => entry.path.split("/")[0]))],
  };
}

function auditUpdateMetadata(artifactDir, expectedVersion, expectedIdentity) {
  const metadataFile = expectedIdentity.channel === "test" ? "test.yml" : "latest.yml";
  const metadataPath = path.join(artifactDir, metadataFile);
  assert(fs.existsSync(metadataPath), `Missing update metadata: ${metadataPath}`);
  const latest = parseYaml(fs.readFileSync(metadataPath, "utf8"));
  assert(String(latest?.version || "") === expectedVersion, `${metadataFile} version does not match the release version`);
  assert(Array.isArray(latest.files) && latest.files.length === 1, `${metadataFile} must contain exactly one installer`);

  const fileEntry = latest.files[0];
  const installerName = String(latest.path || fileEntry?.url || "");
  assert(installerName && path.basename(installerName) === installerName, `${metadataFile} installer path is unsafe`);
  assert(installerName.toLowerCase().endsWith(".exe"), `${metadataFile} installer must be an exe`);
  const expectedInstallerName = expectedIdentity.artifactName
    .replace("${version}", expectedVersion)
    .replace("${ext}", "exe");
  assert(installerName === expectedInstallerName, `${metadataFile} installer does not match the edition identity`);
  assert(fileEntry.url === installerName, `${metadataFile} path and files[0].url must match`);
  assert(fileEntry.sha512 === latest.sha512, `${metadataFile} sha512 fields must match`);

  const installerPath = path.join(artifactDir, installerName);
  const blockmapPath = `${installerPath}.blockmap`;
  assert(fs.existsSync(installerPath), `Missing installer: ${installerPath}`);
  assert(fs.existsSync(blockmapPath), `Missing installer blockmap: ${blockmapPath}`);
  const installerSize = fs.statSync(installerPath).size;
  assert(installerSize === fileEntry.size, `${metadataFile} installer size does not match the exe`);
  assert(sha512Base64File(installerPath) === fileEntry.sha512, `${metadataFile} installer sha512 does not match the exe`);
  assert(fs.statSync(blockmapPath).size > 0, "Installer blockmap is empty");

  return {
    metadataFile,
    version: expectedVersion,
    installerName,
    installerBytes: installerSize,
    blockmapBytes: fs.statSync(blockmapPath).size,
    sha512: fileEntry.sha512,
  };
}

export function auditAppOnlyPackage({
  artifactDir,
  expectedVersion,
  integrityPublicKeyPem = INTEGRITY_PUBLIC_KEY_PEM,
} = {}) {
  const resolvedArtifactDir = path.resolve(String(artifactDir || ""));
  assert(artifactDir, "artifactDir is required");
  assert(expectedVersion, "expectedVersion is required");
  const identity = resolveAppEdition(expectedVersion);
  const resourcesRoot = path.join(resolvedArtifactDir, "win-unpacked", "resources");
  assert(fs.existsSync(resourcesRoot), `Missing unpacked resources: ${resourcesRoot}`);
  return {
    artifactDir: resolvedArtifactDir,
    edition: identity.edition,
    identity,
    integrity: auditIntegrity(resourcesRoot, integrityPublicKeyPem),
    updateMetadata: auditUpdateMetadata(resolvedArtifactDir, String(expectedVersion), identity),
  };
}
