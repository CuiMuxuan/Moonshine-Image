import path from "node:path";

import { runStartupProcess } from "../startup-process.js";

export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

const TORCH_PROBE_SCRIPT = [
  "import json",
  "import torch",
  "print(json.dumps({'version': getattr(torch, '__version__', ''), 'cuda': bool(torch.cuda.is_available())}))",
].join("; ");

const CUDA_PROBE_SCRIPT = [
  "import json",
  "import torch",
  "print(json.dumps({'available': bool(torch.cuda.is_available()), 'version': getattr(torch.version, 'cuda', None), 'deviceCount': int(torch.cuda.device_count()) if torch.cuda.is_available() else 0}))",
].join("; ");

const BACKEND_PROBE_SCRIPT = [
  "import importlib",
  "importlib.import_module('moonshine_server')",
  "print('ok')",
].join("; ");

function normalizeProcessResult(result) {
  if (!result || typeof result !== "object") {
    return { success: false, code: 1, stdout: "", stderr: "empty process result" };
  }
  const code = result.code ?? result.exitCode ?? (result.success === false ? 1 : 0);
  return {
    ...result,
    success: result.success !== false && Number(code) === 0,
    code: Number.isFinite(Number(code)) ? Number(code) : 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

async function defaultRunner(command, args, options) {
  try {
    const result = await runStartupProcess(command, args, {
      ...options,
      stage: options.stage || "environment-probe",
      failureCode: options.failureCode || "ENVIRONMENT_PROBE_FAILED",
      spawnOptions: { windowsHide: true, ...(options.spawnOptions || {}) },
    });
    return normalizeProcessResult(result);
  } catch (error) {
    const diagnostic = error?.diagnostic || {};
    return normalizeProcessResult({
      success: false,
      code: diagnostic.exitCode ?? error?.code ?? 1,
      stdout: diagnostic.stdout,
      stderr: diagnostic.stderr || error?.message,
      error,
    });
  }
}

async function invokeRunner(runner, command, args, options) {
  if (typeof runner === "function") return runner(command, args, options);
  if (runner && typeof runner.run === "function") return runner.run(command, args, options);
  if (runner && typeof runner.probe === "function") return runner.probe({ command, args, ...options });
  return defaultRunner(command, args, options);
}

function firstLine(value) {
  return String(value || "").trim().split(/\r?\n/, 1)[0] || "";
}

function parseJsonOutput(result) {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  const candidates = [text, ...text.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Probe output can include warnings before its JSON payload.
    }
  }
  return null;
}

function normalizeVersion(value) {
  const text = String(value || "").trim();
  return text.replace(/^Python\s+/i, "").replace(/^ffmpeg version\s+/i, "").split(/\s+/, 1)[0] || "";
}

function makeFailure(label, result) {
  const details = firstLine(result.stderr) || firstLine(result.stdout) || `exit code ${result.code}`;
  return `${label}: ${details}`;
}

function processDiagnostic(result) {
  return {
    code: result.code,
    stdout: String(result.stdout || "").trim().slice(-2_000),
    stderr: String(result.stderr || "").trim().slice(-2_000),
  };
}

function resolvePythonExecutable(root, platform, supplied) {
  if (supplied) return path.resolve(String(supplied));
  const relative = platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python");
  return path.join(path.resolve(root), relative);
}

function resolveFfmpegPath(root, platform, supplied) {
  if (supplied) return path.resolve(String(supplied));
  return path.join(path.resolve(root), platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
}

export async function probeEnvironment({
  root = process.cwd(),
  pythonExecutable,
  ffmpegPath,
  accelerator = "cpu",
  platform = process.platform,
  backendModule = "moonshine_server",
  runner,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  signal,
  baseEnv = process.env,
} = {}) {
  const python = resolvePythonExecutable(root, platform, pythonExecutable);
  const ffmpeg = resolveFfmpegPath(root, platform, ffmpegPath);
  const errors = [];
  const warnings = [];
  const run = async (command, args, label, { cwd = path.resolve(root) } = {}) => {
    try {
      return normalizeProcessResult(await invokeRunner(runner, command, args, {
        cwd,
        env: baseEnv,
        timeoutMs,
        signal,
        stage: `environment-probe-${label}`,
      }));
    } catch (error) {
      return normalizeProcessResult({
        success: false,
        code: error?.code || 1,
        stderr: error?.message || String(error),
        error,
      });
    }
  };

  const pythonResult = await run(python, ["--version"], "python");
  const pythonInfo = {
    ok: pythonResult.success,
    executable: python,
    version: normalizeVersion(pythonResult.stdout || pythonResult.stderr),
    diagnostic: processDiagnostic(pythonResult),
  };
  if (!pythonInfo.ok) errors.push(makeFailure("Python", pythonResult));

  const torchResult = await run(python, ["-c", TORCH_PROBE_SCRIPT], "torch");
  const torchPayload = parseJsonOutput(torchResult);
  const torchInfo = {
    ok: torchResult.success,
    version: normalizeVersion(torchPayload?.version || firstLine(torchResult.stdout)),
    diagnostic: processDiagnostic(torchResult),
  };
  if (!torchInfo.ok) errors.push(makeFailure("PyTorch", torchResult));

  const cudaResult = await run(python, ["-c", CUDA_PROBE_SCRIPT], "cuda");
  const cudaPayload = parseJsonOutput(cudaResult) || {};
  const cudaInfo = {
    ok: cudaResult.success,
    available: cudaResult.success && Boolean(cudaPayload.available),
    version: cudaPayload.version ? String(cudaPayload.version) : null,
    deviceCount: Number.isFinite(Number(cudaPayload.deviceCount)) ? Number(cudaPayload.deviceCount) : 0,
    diagnostic: processDiagnostic(cudaResult),
  };
  if (!cudaInfo.ok) errors.push(makeFailure("CUDA", cudaResult));
  if (String(accelerator).toLowerCase() === "cu130" && (!cudaInfo.ok || !cudaInfo.available)) {
    errors.push("CUDA: cu130 environment did not report an available CUDA device");
  }

  const backendScript = backendModule === "moonshine_server"
    ? BACKEND_PROBE_SCRIPT
    : `import importlib; importlib.import_module(${JSON.stringify(String(backendModule))}); print('ok')`;
  const backendResult = await run(python, ["-c", backendScript], "backend");
  const backendInfo = {
    ok: backendResult.success,
    module: String(backendModule),
    error: backendResult.success ? null : makeFailure("Backend", backendResult),
    diagnostic: processDiagnostic(backendResult),
  };
  if (!backendInfo.ok) errors.push(backendInfo.error);

  const ffmpegResult = await run(ffmpeg, ["-version"], "ffmpeg", {
    cwd: path.dirname(ffmpeg),
  });
  const ffmpegInfo = {
    ok: ffmpegResult.success,
    path: ffmpeg,
    version: normalizeVersion(ffmpegResult.stdout || ffmpegResult.stderr),
    error: ffmpegResult.success ? null : makeFailure("FFmpeg", ffmpegResult),
    diagnostic: processDiagnostic(ffmpegResult),
  };
  if (!ffmpegInfo.ok) warnings.push(ffmpegInfo.error);

  const success = errors.length === 0;
  const degraded = success && !ffmpegInfo.ok;

  return {
    success,
    degraded,
    accelerator: String(accelerator),
    python: pythonInfo,
    torch: torchInfo,
    cuda: cudaInfo,
    backend: backendInfo,
    ffmpeg: ffmpegInfo,
    errors,
    warnings,
    capabilities: {
      core: success,
      image: success,
      video: success && ffmpegInfo.ok,
      ffmpeg: ffmpegInfo.ok,
    },
  };
}

export { BACKEND_PROBE_SCRIPT, CUDA_PROBE_SCRIPT, TORCH_PROBE_SCRIPT, defaultRunner };
