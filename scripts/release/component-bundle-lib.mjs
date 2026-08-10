import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { normalizeComponentId } from "./component-release-lib.mjs";
import { normalizeVersion } from "./app-release-lib.mjs";

const require = createRequire(import.meta.url);
const { path7za } = require("7zip-bin");

export const COMPONENT_BUNDLE_SCHEMA_VERSION = 1;
export const COMPONENT_BUNDLE_DEFINITIONS = Object.freeze({
  "python-cpu": Object.freeze({
    kind: "python-runtime",
    accelerator: "cpu",
    entrypoint: "env/python.exe",
    requiredFiles: ["env/python.exe", "env/Scripts/conda-unpack.exe", "runtime-manifest.json"],
  }),
  "python-cu130": Object.freeze({
    kind: "python-runtime",
    accelerator: "cu130",
    entrypoint: "env/python.exe",
    requiredFiles: ["env/python.exe", "env/Scripts/conda-unpack.exe", "runtime-manifest.json"],
  }),
  ffmpeg: Object.freeze({
    kind: "ffmpeg",
    entrypoint: "ffmpeg.exe",
    requiredFiles: ["ffmpeg.exe", "ffprobe.exe"],
  }),
});

const MODEL_WEIGHT_EXTENSIONS = new Set([".ckpt", ".onnx", ".safetensors", ".tflite"]);
const MODEL_WEIGHT_NAME_PATTERN = /(?:^|[/\\])(?:big[-_]?lama|sam(?:2|3|3\.1)?[^/\\]*)\.(?:pt|pth|bin)$/i;
const LARGE_WEIGHT_BYTES = 16 * 1024 * 1024;

function requiredText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function resolveDirectory(value, label) {
  const resolved = path.resolve(requiredText(value, label));
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error(`${label} must be an existing directory: ${resolved}`);
  return resolved;
}

function isPathWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertNoPathOverlap(outputDir, sourceRoots) {
  for (const sourceRoot of sourceRoots) {
    if (isPathWithin(sourceRoot, outputDir) || isPathWithin(outputDir, sourceRoot)) {
      throw new Error(`Output directory must not overlap a component source directory: ${outputDir}`);
    }
  }
}

function resolveRelative(root, relative, label) {
  const normalized = String(relative ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a safe relative path`);
  }
  const resolved = path.resolve(root, normalized);
  if (!isPathWithin(root, resolved)) throw new Error(`${label} escapes its source directory`);
  return { relative: normalized, path: resolved };
}

async function walkTree(root, current = root, state = { files: 0, bytes: 0, paths: [] }) {
  const entries = await fsp.readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const entryPath = path.join(current, entry.name);
    const relative = path.relative(root, entryPath).replace(/\\/g, "/");
    if (entry.isSymbolicLink()) {
      throw new Error(`Component source contains a symlink or junction: ${relative}`);
    }
    if (entry.isDirectory()) {
      await walkTree(root, entryPath, state);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Component source contains an unsupported entry: ${relative}`);
    const stat = await fsp.stat(entryPath);
    const extension = path.extname(entry.name).toLowerCase();
    if (
      (MODEL_WEIGHT_EXTENSIONS.has(extension) && stat.size >= LARGE_WEIGHT_BYTES) ||
      MODEL_WEIGHT_NAME_PATTERN.test(relative)
    ) {
      throw new Error(`Model weight is not allowed in a Runtime/FFmpeg component: ${relative}`);
    }
    state.files += 1;
    state.bytes += stat.size;
    if (state.paths.length < 64) state.paths.push(relative);
  }
  return state;
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function assertRequiredFiles(root, requiredFiles, label) {
  for (const requiredFile of requiredFiles) {
    const resolved = resolveRelative(root, requiredFile, `${label} required file`).path;
    const stat = await fsp.stat(resolved).catch(() => null);
    if (!stat?.isFile() || stat.size < 1) {
      throw new Error(`${label} is missing required file: ${requiredFile}`);
    }
  }
}

async function validateRuntimeSource({ id, root }) {
  const definition = COMPONENT_BUNDLE_DEFINITIONS[id];
  const manifestPath = path.join(root, "runtime-manifest.json");
  const runtimeManifest = await readJson(manifestPath, `${id} runtime-manifest.json`);
  if (Number(runtimeManifest.schemaVersion) < 4) {
    throw new Error(`${id} runtime manifest schemaVersion must be at least 4`);
  }
  if (runtimeManifest.runtimeFlavor !== definition.accelerator) {
    throw new Error(`${id} runtime flavor mismatch: ${runtimeManifest.runtimeFlavor || "missing"}`);
  }
  if (runtimeManifest.modelBundle !== "external-models") {
    throw new Error(`${id} must be built with modelBundle=external-models; found ${runtimeManifest.modelBundle || "missing"}`);
  }
  const samRuntime = runtimeManifest.samRuntime;
  if (!samRuntime || typeof samRuntime !== "object") {
    throw new Error(`${id} runtime manifest is missing samRuntime metadata`);
  }
  const samEntries = Object.values(samRuntime).filter((value) => value && typeof value === "object");
  if (samEntries.length === 0 || samEntries.some((value) => value.modelWeightsBundled !== false)) {
    throw new Error(`${id} runtime manifest allows bundled model weights`);
  }
  const envDir = resolveRelative(root, runtimeManifest.envDir, `${id} envDir`);
  const pythonExecutable = resolveRelative(root, runtimeManifest.pythonExecutable, `${id} pythonExecutable`);
  const condaUnpackExecutable = resolveRelative(root, runtimeManifest.condaUnpackExecutable, `${id} condaUnpackExecutable`);
  if (!pythonExecutable.relative.startsWith(`${envDir.relative}/`)) {
    throw new Error(`${id} pythonExecutable must be inside envDir`);
  }
  if (!condaUnpackExecutable.relative.startsWith(`${envDir.relative}/`)) {
    throw new Error(`${id} condaUnpackExecutable must be inside envDir`);
  }
  await assertRequiredFiles(root, definition.requiredFiles, id);
  const tree = await walkTree(root);
  return {
    tree,
    runtimeManifest,
    entrypoint: pythonExecutable.relative,
    condaUnpackExecutable: condaUnpackExecutable.relative,
  };
}

async function validateFfmpegSource({ root }) {
  const candidates = ["ffmpeg.exe", "bin/ffmpeg.exe"];
  const entrypoint = candidates.find((candidate) => fs.existsSync(path.join(root, candidate)));
  if (!entrypoint) throw new Error("ffmpeg source is missing ffmpeg.exe");
  const probe = entrypoint.startsWith("bin/") ? "bin/ffprobe.exe" : "ffprobe.exe";
  await assertRequiredFiles(root, [entrypoint, probe], "ffmpeg");
  const tree = await walkTree(root);
  return { tree, entrypoint };
}

export async function validateComponentSource({ id: rawId, root: rawRoot } = {}) {
  const id = normalizeComponentId(rawId);
  const definition = COMPONENT_BUNDLE_DEFINITIONS[id];
  if (!definition) throw new Error(`Unsupported component bundle id: ${id}`);
  const root = resolveDirectory(rawRoot, `${id} source root`);
  const result = id === "ffmpeg"
    ? await validateFfmpegSource({ root })
    : await validateRuntimeSource({ id, root });
  return { id, root, ...result };
}

function resolveSevenZipPath(explicitPath) {
  const configured = String(explicitPath || process.env.MOONSHINE_7ZIP_PATH || path7za).trim();
  if (!configured) throw new Error("7-Zip executable path is empty");
  if (configured !== "7za" && !fs.existsSync(configured)) {
    throw new Error(`7-Zip executable does not exist: ${configured}`);
  }
  return configured;
}

function createOutputCollector({ captureAll = false, maxBytes }) {
  const chunks = [];
  let totalBytes = 0;

  return {
    append(value) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (captureAll) {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) return false;
        chunks.push(chunk);
        return true;
      }

      chunks.push(chunk);
      totalBytes += chunk.length;
      while (totalBytes > maxBytes && chunks.length > 1) {
        totalBytes -= chunks.shift().length;
      }
      if (totalBytes > maxBytes) {
        const last = chunks[0];
        chunks[0] = last.subarray(last.length - maxBytes);
        totalBytes = chunks[0].length;
      }
      return true;
    },
    text() {
      return Buffer.concat(chunks, totalBytes).toString("utf8");
    },
  };
}

export function runSevenZip(executable, args, cwd, { captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const stdout = createOutputCollector({
      captureAll: captureStdout,
      maxBytes: captureStdout ? 256 * 1024 * 1024 : 64 * 1024,
    });
    const stderr = createOutputCollector({ maxBytes: 64 * 1024 });
    let overflowError = null;
    let child;

    try {
      child = spawn(executable, args, {
        cwd,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new Error(`7-Zip failed to start: ${error.message}`));
      return;
    }

    child.stdout.on("data", (chunk) => {
      if (!stdout.append(chunk) && !overflowError) {
        overflowError = new Error("7-Zip listing exceeded the 256 MiB safety limit");
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    child.once("error", (error) => reject(new Error(`7-Zip failed to start: ${error.message}`)));
    child.once("close", (status, signal) => {
      if (overflowError) {
        reject(overflowError);
        return;
      }
      if (status !== 0) {
        const detail = String(stderr.text() || stdout.text()).trim().slice(-2000);
        const suffix = signal ? ` (signal ${signal})` : "";
        reject(new Error(`7-Zip failed with exit code ${status}${suffix}: ${detail}`));
        return;
      }
      resolve({ stdout: stdout.text(), stderr: stderr.text() });
    });
  });
}

function parseZipEntries(listing) {
  return String(listing)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Path = "))
    .map((line) => line.slice("Path = ".length).trim().replace(/\\/g, "/"))
    .filter((entry) => entry && !entry.endsWith(".zip"));
}

export async function createZipArchive({ sourceRoot, outputPath, requiredEntry, sevenZipPath, overwrite = false } = {}) {
  const root = resolveDirectory(sourceRoot, "source root");
  const target = path.resolve(requiredText(outputPath, "output path"));
  if (isPathWithin(root, target) || isPathWithin(target, root)) {
    throw new Error("Archive output must not overlap its source directory");
  }
  if (!overwrite && fs.existsSync(target)) throw new Error(`Archive already exists: ${target}`);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const executable = resolveSevenZipPath(sevenZipPath);
  const topLevel = (await fsp.readdir(root, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => entry.name);
  if (topLevel.length === 0) throw new Error(`Source directory is empty: ${root}`);
  const temporary = `${target}.partial-${process.pid}-${Date.now()}.zip`;
  await fsp.rm(temporary, { force: true });
  try {
    await runSevenZip(executable, ["a", "-tzip", "-mx=9", "-mmt=on", "-bsp0", "-bb0", temporary, ...topLevel], root);
    await runSevenZip(executable, ["t", "-tzip", "-bsp0", "-bb0", temporary], root);
    const listing = await runSevenZip(executable, ["l", "-slt", "-tzip", "-bsp0", "-bb0", temporary], root, {
      captureStdout: true,
    });
    const entries = parseZipEntries(listing.stdout);
    const expectedEntry = String(requiredEntry || "").replace(/\\/g, "/");
    if (expectedEntry && !entries.includes(expectedEntry)) {
      throw new Error(`Archive is missing required entrypoint: ${expectedEntry}`);
    }
    const stat = await fsp.stat(temporary);
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(temporary)) hash.update(chunk);
    await fsp.rm(target, { force: true });
    await fsp.rename(temporary, target);
    return { path: target, size: stat.size, sha256: hash.digest("hex"), entries };
  } catch (error) {
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await fsp.rename(temporary, filePath);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error.code)) throw error;
    await fsp.rm(filePath, { force: true });
    await fsp.rename(temporary, filePath);
  }
}

export async function buildComponentBundles({
  version,
  outputDir,
  runtimeCpuRoot,
  runtimeCu130Root,
  ffmpegRoot,
  sevenZipPath,
  overwrite = false,
} = {}) {
  const normalizedVersion = normalizeVersion(version);
  const destination = path.resolve(requiredText(outputDir, "output directory"));
  const sourceRoots = [runtimeCpuRoot, runtimeCu130Root, ffmpegRoot].map((root, index) =>
    resolveDirectory(root, ["CPU runtime root", "cu130 runtime root", "FFmpeg root"][index])
  );
  assertNoPathOverlap(destination, sourceRoots);
  const sources = await Promise.all([
    validateComponentSource({ id: "python-cpu", root: sourceRoots[0] }),
    validateComponentSource({ id: "python-cu130", root: sourceRoots[1] }),
    validateComponentSource({ id: "ffmpeg", root: sourceRoots[2] }),
  ]);
  await fsp.mkdir(destination, { recursive: true });
  const artifactNames = ["python-cpu.zip", "python-cu130.zip", "ffmpeg.zip"];
  if (!overwrite) {
    const existing = ["components.json", "component-bundle-report.json", ...artifactNames]
      .filter((name) => fs.existsSync(path.join(destination, name)));
    if (existing.length) throw new Error(`Refusing to overwrite existing component outputs: ${existing.join(", ")}`);
  }
  const artifacts = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const artifactName = artifactNames[index];
    const archive = await createZipArchive({
      sourceRoot: source.root,
      outputPath: path.join(destination, artifactName),
      requiredEntry: source.entrypoint,
      sevenZipPath,
      overwrite,
    });
    const definition = COMPONENT_BUNDLE_DEFINITIONS[source.id];
    artifacts.push({
      id: source.id,
      kind: definition.kind,
      ...(definition.accelerator ? { accelerator: definition.accelerator } : {}),
      version: normalizedVersion,
      file: artifactName,
      name: artifactName,
      artifactPath: `components/win-x64/releases/${normalizedVersion}/${artifactName}`,
      entrypoint: source.entrypoint,
      sourceRoot: source.root,
      sourceFiles: source.tree.files,
      sourceBytes: source.tree.bytes,
      archiveBytes: archive.size,
      sha256: archive.sha256,
      archiveEntries: archive.entries.length,
    });
  }
  const descriptor = {
    schemaVersion: COMPONENT_BUNDLE_SCHEMA_VERSION,
    version: normalizedVersion,
    components: artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      ...(artifact.accelerator ? { accelerator: artifact.accelerator } : {}),
      version: artifact.version,
      file: artifact.file,
      name: artifact.name,
      artifactPath: artifact.artifactPath,
      entrypoint: artifact.entrypoint,
    })),
  };
  const report = {
    schemaVersion: COMPONENT_BUNDLE_SCHEMA_VERSION,
    version: normalizedVersion,
    platform: "win32",
    arch: "x64",
    createdAt: new Date().toISOString(),
    components: artifacts,
  };
  await writeJsonAtomic(path.join(destination, "components.json"), descriptor);
  await writeJsonAtomic(path.join(destination, "component-bundle-report.json"), report);
  return {
    outputDir: destination,
    descriptorPath: path.join(destination, "components.json"),
    reportPath: path.join(destination, "component-bundle-report.json"),
    descriptor,
    report,
  };
}

export { resolveSevenZipPath };
