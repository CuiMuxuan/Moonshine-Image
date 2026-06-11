export const BACKEND_PATH_CJK_BLOCK_MESSAGE =
  "项目路径中存在中文，可能导致项目运行失败，本次静默启动停止，请在全局配置后端配置中记录当前的项目路径和模型路径，然后将其移动到不含中文的路径下，并选择该路径。";

const normalizeValidationResult = (result = {}) => ({
  success: result?.success !== false,
  valid: result?.valid !== false,
  code: String(result?.code || ""),
  message: String(result?.message || ""),
  invalidPaths: Array.isArray(result?.invalidPaths) ? result.invalidPaths : [],
});

export const formatBackendInvalidPathList = (validationResult = {}) => {
  const normalized = normalizeValidationResult(validationResult);
  if (normalized.invalidPaths.length === 0) {
    return "";
  }

  return normalized.invalidPaths
    .map((item) => `${item?.label || item?.field || "路径"}：${item?.path || ""}`)
    .filter(Boolean)
    .join("\n");
};

export const buildBackendPathBlockedMessage = (
  validationResult = {},
  { includePathList = true } = {}
) => {
  const normalized = normalizeValidationResult(validationResult);
  const baseMessage = normalized.message || BACKEND_PATH_CJK_BLOCK_MESSAGE;
  if (!includePathList) {
    return baseMessage;
  }

  const detail = formatBackendInvalidPathList(normalized);
  return detail ? `${baseMessage}\n${detail}` : baseMessage;
};

const normalizePathText = (value, fallback = "（未设置）") => {
  const text = String(value || "").trim();
  return text || fallback;
};

export const buildBackendPathSelectionBlockedMessage = (
  validationResult = {},
  {
    currentBackendProjectPath = "",
    currentModelDir = "",
    selectedBackendProjectPath = "",
    selectedModelDir = "",
  } = {}
) => {
  const lines = [buildBackendPathBlockedMessage(validationResult, { includePathList: false })];
  lines.push(`当前后端项目路径：${normalizePathText(currentBackendProjectPath)}`);
  lines.push(`当前模型目录路径：${normalizePathText(currentModelDir)}`);

  const selectedProject = String(selectedBackendProjectPath || "").trim();
  if (selectedProject) {
    lines.push(`尝试选择的后端项目路径：${selectedProject}`);
  }

  const selectedModel = String(selectedModelDir || "").trim();
  if (selectedModel) {
    lines.push(`尝试选择的模型目录路径：${selectedModel}`);
  }

  return lines.join("\n");
};

export const validateBackendPaths = async ({
  backendProjectPath = "",
  modelDir = "",
} = {}) => {
  if (!window.electron?.ipcRenderer?.invoke) {
    return {
      success: true,
      valid: true,
      code: "",
      message: "",
      invalidPaths: [],
    };
  }

  try {
    const result = await window.electron.ipcRenderer.invoke("validate-backend-paths", {
      backendProjectPath,
      modelDir,
    });
    return normalizeValidationResult(result);
  } catch (error) {
    return {
      success: false,
      valid: false,
      code: "VALIDATE_BACKEND_PATHS_FAILED",
      message: error?.message || "路径校验失败",
      invalidPaths: [],
    };
  }
};

export const validateBackendPathsForConfig = (generalConfig = {}) =>
  validateBackendPaths({
    backendProjectPath: generalConfig?.backendProjectPath || "",
    modelDir: generalConfig?.modelDir || "",
  });
