const BACKEND_TRANSITION_STATES = new Set(["starting", "stopping"]);

function toTaskCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

export function evaluateAppUpdateInstallReadiness(options = {}) {
  const activeProcessingTaskCount = toTaskCount(options.activeProcessingTaskCount);
  const activeFfmpegTaskCount = toTaskCount(options.activeFfmpegTaskCount);
  const backendStatus = options.backendStatus || {};
  const backendState = String(backendStatus.state || "stopped");
  const reasons = [];

  if (options.applicationQuitRequested) {
    reasons.push("应用正在退出。");
  }
  if (activeProcessingTaskCount > 0) {
    reasons.push(`仍有 ${activeProcessingTaskCount} 个图片或视频任务正在处理。`);
  }
  if (activeFfmpegTaskCount > 0) {
    reasons.push(`仍有 ${activeFfmpegTaskCount} 个 FFmpeg 任务正在运行。`);
  }
  if (BACKEND_TRANSITION_STATES.has(backendState)) {
    reasons.push(
      backendState === "starting"
        ? "服务正在启动，请等待启动完成后重试。"
        : "服务正在停止，请等待停止完成后重试。",
    );
  }

  const allowed = reasons.length === 0;
  const requiresBackendStop =
    allowed && Boolean(backendStatus.processRunning || backendState === "running");

  return {
    allowed,
    reason: reasons.join(" "),
    activeProcessingTaskCount,
    activeFfmpegTaskCount,
    backendState,
    requiresBackendStop,
  };
}

function blockedAfterBackendStop(readiness, failure) {
  const message =
    failure?.error ||
    failure?.message ||
    failure?.recoveryHint ||
    "服务停止失败，暂不能安装更新。";
  return {
    ...readiness,
    allowed: false,
    reason: String(message),
    requiresBackendStop: true,
    code: "APP_UPDATE_BACKEND_STOP_FAILED",
    backendCode: failure?.code || null,
  };
}

export async function prepareAppUpdateInstall(options = {}) {
  if (typeof options.getReadiness !== "function") {
    throw new TypeError("prepareAppUpdateInstall requires getReadiness.");
  }
  if (typeof options.stopBackend !== "function") {
    throw new TypeError("prepareAppUpdateInstall requires stopBackend.");
  }

  const initialReadiness = (await options.getReadiness()) || {};
  if (!initialReadiness.allowed || !initialReadiness.requiresBackendStop) {
    return initialReadiness;
  }

  let stopResult;
  try {
    stopResult = await options.stopBackend();
  } catch (error) {
    return blockedAfterBackendStop(initialReadiness, error);
  }
  if (!stopResult?.success) {
    return blockedAfterBackendStop(initialReadiness, stopResult);
  }

  const finalReadiness = (await options.getReadiness()) || {};
  if (!finalReadiness.allowed) return finalReadiness;
  if (finalReadiness.requiresBackendStop) {
    return {
      ...finalReadiness,
      allowed: false,
      reason: "服务未能完全停止，暂不能安装更新。",
      code: "APP_UPDATE_BACKEND_STILL_RUNNING",
    };
  }
  return { ...finalReadiness, backendStopped: true };
}
