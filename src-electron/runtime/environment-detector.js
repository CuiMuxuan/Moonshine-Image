import { runStartupProcess } from "../startup-process.js";

export const DEFAULT_NVIDIA_SMI_TIMEOUT_MS = 5_000;
export const DEFAULT_MINIMUM_DRIVER_MAJOR = 570;
export const ACCELERATORS = Object.freeze(["cpu", "cu130"]);

function normalizePreference(value) {
  const preference = String(value ?? "auto").trim().toLowerCase();
  if (!["auto", ...ACCELERATORS].includes(preference)) {
    const error = new Error(`Unsupported accelerator preference: ${preference || "missing"}`);
    error.code = "ENVIRONMENT_ACCELERATOR_UNSUPPORTED";
    throw error;
  }
  return preference;
}

function normalizeResult(result) {
  if (typeof result === "string") {
    return { success: true, code: 0, stdout: result, stderr: "" };
  }
  if (!result || typeof result !== "object") {
    return { success: false, code: 1, stdout: "", stderr: "", error: new Error("Empty nvidia-smi result") };
  }
  const code = result.code ?? result.exitCode ?? (result.success === false ? 1 : 0);
  return {
    ...result,
    code: Number.isFinite(Number(code)) ? Number(code) : 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    success: result.success !== false && Number(code) === 0,
  };
}

function parseDriverVersion(text) {
  const match = String(text || "").match(/\b(\d{3,4})\.([0-9]+)(?:\.([0-9]+))?\b/);
  return match ? match[0] : "";
}

function parseGpuName(text) {
  const firstLine = String(text || "").split(/\r?\n/u).find((line) => line.trim()) || "";
  const comma = firstLine.lastIndexOf(",");
  return (comma >= 0 ? firstLine.slice(0, comma) : firstLine.replace(/\b\d{3,4}\.[0-9.]+.*$/u, ""))
    .trim();
}

function driverMajor(version) {
  const match = String(version || "").match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

function resultText(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`.trim();
}

function evaluateNvidiaResult(result, minimumDriverMajor = DEFAULT_MINIMUM_DRIVER_MAJOR) {
  const normalized = normalizeResult(result);
  const text = resultText(normalized);
  const driverVersion = String(normalized.driverVersion || parseDriverVersion(text));
  const gpuName = String(normalized.gpuName || normalized.name || parseGpuName(normalized.stdout)).trim();
  const parsedMajor = normalized.driverMajor ?? driverMajor(driverVersion);
  const requiredMajor = Number(minimumDriverMajor);
  const hasRequiredMajor = Number.isFinite(requiredMajor) && requiredMajor > 0;
  const compatible = normalized.success &&
    (normalized.compatible === true || (
      hasRequiredMajor && Number.isFinite(Number(parsedMajor)) && Number(parsedMajor) >= requiredMajor
    ));
  let reason = "";
  if (!normalized.success) {
    reason = normalized.error?.message || normalized.stderr.trim() || "nvidia-smi is unavailable";
  } else if (!driverVersion || !Number.isFinite(Number(parsedMajor))) {
    reason = "nvidia-smi did not report a usable driver version";
  } else if (!compatible) {
    reason = `NVIDIA driver ${driverVersion} is below the cu130 minimum (${requiredMajor})`;
  }
  return {
    available: normalized.success,
    compatible: Boolean(compatible),
    driverVersion: driverVersion || null,
    gpuName: gpuName || null,
    driverMajor: Number.isFinite(Number(parsedMajor)) ? Number(parsedMajor) : null,
    reason,
    result: normalized,
  };
}

export function isCu130Compatible(result, options = {}) {
  return evaluateNvidiaResult(result, options.minimumDriverMajor).compatible;
}

export async function defaultNvidiaSmiRunner({
  command = "nvidia-smi",
  args = ["--query-gpu=name,driver_version", "--format=csv,noheader"],
  timeoutMs = DEFAULT_NVIDIA_SMI_TIMEOUT_MS,
  signal,
  ...options
} = {}) {
  try {
    const result = await runStartupProcess(command, args, {
      timeoutMs,
      signal,
      stage: "environment-nvidia-smi",
      failureCode: "ENVIRONMENT_NVIDIA_SMI_FAILED",
      userMessage: "NVIDIA environment detection failed.",
      spawnOptions: { windowsHide: true },
      ...options,
    });
    return { ...result, code: result.exitCode ?? result.code ?? 0, success: true };
  } catch (error) {
    const diagnostic = error?.diagnostic || {};
    return {
      success: false,
      code: diagnostic.exitCode ?? error?.code ?? 1,
      stdout: diagnostic.stdout || "",
      stderr: diagnostic.stderr || error?.message || "",
      error,
    };
  }
}

async function invokeRunner(runner, options) {
  if (typeof runner === "function") return runner(options.command, options.args, options);
  if (runner && typeof runner.run === "function") return runner.run(options.command, options.args, options);
  if (runner && typeof runner.probe === "function") return runner.probe(options);
  return defaultNvidiaSmiRunner(options);
}

export async function detectAccelerator({
  preference = "auto",
  runner = defaultNvidiaSmiRunner,
  minimumDriverMajor = DEFAULT_MINIMUM_DRIVER_MAJOR,
  command = "nvidia-smi",
  args = ["--query-gpu=name,driver_version", "--format=csv,noheader"],
  timeoutMs = DEFAULT_NVIDIA_SMI_TIMEOUT_MS,
  signal,
  onEvent,
} = {}) {
  const normalizedPreference = normalizePreference(preference);
  if (normalizedPreference === "cpu") {
    return {
      preference: normalizedPreference,
      selectedAccelerator: "cpu",
      reason: "manual-cpu",
      nvidia: { available: false, compatible: false, skipped: true, reason: "manual-cpu" },
      events: [],
    };
  }

  let raw;
  try {
    raw = await invokeRunner(runner, { command, args, timeoutMs, signal });
  } catch (error) {
    raw = { success: false, code: error?.code || 1, stderr: error?.message || String(error), error };
  }
  const nvidia = evaluateNvidiaResult(raw, minimumDriverMajor);
  const events = [];
  const emitEvent = (event) => {
    const normalizedEvent = {
      phase: "detect-accelerator",
      source: "nvidia-smi",
      ...event,
    };
    events.push(normalizedEvent);
    onEvent?.(normalizedEvent);
  };
  if (normalizedPreference === "cu130") {
    if (!nvidia.compatible) {
      const error = new Error(
        nvidia.driverMajor && Number(minimumDriverMajor) > nvidia.driverMajor
          ? "英伟达驱动低于 CUDA 13.0 最低所需版本，请更新英伟达驱动。"
          : nvidia.reason || "当前机器不具备可用的 NVIDIA/cu130 能力。",
      );
      error.code = "ENVIRONMENT_CU130_UNAVAILABLE";
      const message = `${nvidia.gpuName || "NVIDIA GPU"} driver ${nvidia.driverVersion || "unknown"} `
        + `does not satisfy the CUDA 13.0 minimum (${Number(minimumDriverMajor)}+).`;
      const event = {
        type: "cu130-driver-incompatible",
        level: "error",
        status: "error",
        logOnly: true,
        terminalType: "error",
        terminal: true,
        message,
        gpuName: nvidia.gpuName,
        driverVersion: nvidia.driverVersion,
        minimumDriverMajor: Number(minimumDriverMajor),
        selectedAccelerator: null,
      };
      emitEvent(event);
      error.details = { preference: normalizedPreference, nvidia, event, events };
      throw error;
    }
    return {
      preference: normalizedPreference,
      selectedAccelerator: "cu130",
      reason: "manual-cu130",
      nvidia,
      events,
    };
  }

  if (nvidia.compatible) {
    return {
      preference: normalizedPreference,
      selectedAccelerator: "cu130",
      reason: "auto-nvidia-compatible",
      nvidia,
      events,
    };
  }
  const fallbackEvent = {
    type: "cu130-fallback-cpu",
    level: "warning",
    status: "warning",
    logOnly: true,
    terminalType: "warning",
    terminal: true,
    message: `${nvidia.gpuName || "NVIDIA GPU"} driver ${nvidia.driverVersion || "unknown"} `
      + `does not satisfy the CUDA 13.0 minimum (${Number(minimumDriverMajor)}+); falling back to CPU.`,
    gpuName: nvidia.gpuName,
    driverVersion: nvidia.driverVersion,
    minimumDriverMajor: Number(minimumDriverMajor),
    selectedAccelerator: "cpu",
  };
  emitEvent(fallbackEvent);
  return {
    preference: normalizedPreference,
    selectedAccelerator: "cpu",
    reason: nvidia.reason || "auto-nvidia-incompatible",
    nvidia,
    event: fallbackEvent,
    events,
  };
}

export const normalizeAcceleratorPreference = normalizePreference;
export { evaluateNvidiaResult, parseDriverVersion, parseGpuName };
