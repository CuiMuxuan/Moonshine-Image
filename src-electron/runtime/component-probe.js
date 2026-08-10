import fs from "node:fs/promises";
import path from "node:path";

import { createIsolatedPythonEnv } from "../python-runtime.js";
import { runStartupProcess } from "../startup-process.js";
import { assertSafeRelativePath } from "./manifest-verifier.js";
import { COMPONENT_IDS, writeJsonAtomic } from "./runtime-layout.js";

const READY_FILE = ".moonshine-runtime-ready.json";
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

function expectedRuntimeFlavor(id) {
  if (id === COMPONENT_IDS.PYTHON_CPU) return "cpu";
  if (id === COMPONENT_IDS.PYTHON_CU130) return "cu130";
  return "";
}

function safeRelative(value, label) {
  return assertSafeRelativePath(String(value || "").trim(), label);
}

function resolveInside(root, relative, label) {
  const normalized = safeRelative(relative, label);
  const rootPath = path.resolve(root);
  const resolved = path.resolve(rootPath, normalized);
  const outside = path.relative(rootPath, resolved);
  if (outside === ".." || outside.startsWith(`..${path.sep}`) || path.isAbsolute(outside)) {
    throw new Error(`${label} escapes the component root`);
  }
  return { relative: normalized, path: resolved };
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid: ${error.message}`);
  }
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function runProbeProcess({
  command,
  args,
  cwd,
  env,
  signal,
  timeoutMs,
  runProcessImpl,
  label,
}) {
  const result = await runProcessImpl(command, args, {
    cwd,
    env,
    signal,
    timeoutMs,
    spawnOptions: { windowsHide: true },
    failureCode: "RUNTIME_COMPONENT_PROBE_FAILED",
    userMessage: `${label} health check failed.`,
    stage: "runtime-component-probe",
  });
  return {
    stdout: String(result?.stdout || ""),
    stderr: String(result?.stderr || ""),
  };
}

async function probePythonComponent({
  component,
  root,
  signal,
  timeoutMs,
  runProcessImpl,
  platform,
  baseEnv,
}) {
  const metadata = await readJson(path.join(root, "runtime-manifest.json"), "runtime-manifest.json");
  if (!Number.isSafeInteger(metadata.schemaVersion) || metadata.schemaVersion < 4) {
    throw new Error("Runtime component manifest schemaVersion must be at least 4");
  }
  const expectedFlavor = expectedRuntimeFlavor(component.id);
  if (metadata.runtimeFlavor !== expectedFlavor) {
    throw new Error(`Runtime flavor ${metadata.runtimeFlavor || "missing"} does not match ${expectedFlavor}`);
  }
  if (metadata.modelBundle !== "external-models") {
    throw new Error("Runtime component contains a bundled model policy");
  }
  const samEntries = Object.values(metadata.samRuntime || {}).filter((value) => value && typeof value === "object");
  if (samEntries.length === 0 || samEntries.some((value) => value.modelWeightsBundled !== false)) {
    throw new Error("Runtime component model weight policy is not external-only");
  }
  const manifestEntrypoint = resolveInside(root, metadata.pythonExecutable, "runtime pythonExecutable");
  const entrypoint = resolveInside(root, component.entrypoint || manifestEntrypoint.relative, "component entrypoint");
  if (entrypoint.relative !== manifestEntrypoint.relative) {
    throw new Error("Component entrypoint does not match runtime-manifest.json");
  }
  const envRoot = resolveInside(root, metadata.envDir, "runtime envDir");
  const condaUnpack = resolveInside(root, metadata.condaUnpackExecutable, "runtime condaUnpackExecutable");
  if (!(await fileExists(entrypoint.path))) throw new Error(`Python executable is missing: ${entrypoint.relative}`);
  if (!(await fileExists(condaUnpack.path))) throw new Error(`conda-unpack executable is missing: ${condaUnpack.relative}`);

  const env = createIsolatedPythonEnv({
    baseEnv,
    envRoot: envRoot.path,
    platform,
    overrides: {
      MOONSHINE_PACKAGED_RUNTIME: "1",
      MOONSHINE_RUNTIME_FLAVOR: expectedFlavor,
      MOONSHINE_MODEL_BUNDLE: "external-models",
    },
  });
  const readyPath = path.join(root, READY_FILE);
  const identity = {
    schemaVersion: 1,
    componentId: component.id,
    version: component.version || null,
    sha256: component.sha256 || null,
    runtimeBuiltAt: metadata.builtAt || null,
  };
  const ready = await readJson(readyPath, READY_FILE).catch(() => null);
  const readyMatches = ready && Object.entries(identity).every(([key, value]) => ready[key] === value);
  if (!readyMatches) {
    await runProbeProcess({
      command: condaUnpack.path,
      args: [],
      cwd: envRoot.path,
      env,
      signal,
      timeoutMs,
      runProcessImpl,
      label: "Runtime relocation",
    });
  }
  const versionResult = await runProbeProcess({
    command: entrypoint.path,
    args: ["--version"],
    cwd: envRoot.path,
    env,
    signal,
    timeoutMs,
    runProcessImpl,
    label: "Python runtime",
  });
  if (!readyMatches) await writeJsonAtomic(readyPath, identity);
  return {
    success: true,
    entrypoint: entrypoint.relative,
    version: (versionResult.stdout || versionResult.stderr).trim().split(/\r?\n/, 1)[0] || "",
    relocated: !readyMatches,
  };
}

async function probeFfmpegComponent({
  component,
  root,
  signal,
  timeoutMs,
  runProcessImpl,
  baseEnv,
}) {
  const entrypoint = resolveInside(root, component.entrypoint || "ffmpeg.exe", "component entrypoint");
  if (!(await fileExists(entrypoint.path))) throw new Error(`FFmpeg executable is missing: ${entrypoint.relative}`);
  const result = await runProbeProcess({
    command: entrypoint.path,
    args: ["-version"],
    cwd: root,
    env: baseEnv,
    signal,
    timeoutMs,
    runProcessImpl,
    label: "FFmpeg",
  });
  return {
    success: true,
    entrypoint: entrypoint.relative,
    version: (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0] || "",
  };
}

export async function probeManagedComponent({
  component,
  root,
  signal,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  runProcessImpl = runStartupProcess,
  platform = process.platform,
  baseEnv = process.env,
} = {}) {
  const componentRoot = path.resolve(String(root || ""));
  if (component?.id === COMPONENT_IDS.FFMPEG) {
    return probeFfmpegComponent({ component, root: componentRoot, signal, timeoutMs, runProcessImpl, baseEnv });
  }
  if (component?.id === COMPONENT_IDS.PYTHON_CPU || component?.id === COMPONENT_IDS.PYTHON_CU130) {
    return probePythonComponent({
      component,
      root: componentRoot,
      signal,
      timeoutMs,
      runProcessImpl,
      platform,
      baseEnv,
    });
  }
  throw new Error(`Unsupported component probe id: ${component?.id || "missing"}`);
}

export { DEFAULT_PROBE_TIMEOUT_MS, READY_FILE };
