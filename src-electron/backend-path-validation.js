export const BACKEND_PATH_CJK_WARNING_MESSAGE =
  "项目路径中包含中文。兼容性测试已覆盖图片、视频和模型读取，Moonshine 将继续运行；若第三方扩展仍出现路径兼容问题，请临时改用不含中文的路径。";

const CJK_PATH_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

export function containsCjkCharacter(value) {
  return CJK_PATH_PATTERN.test(String(value || ""));
}

export function buildBackendPathCompatibilityResult(paths = {}) {
  const warningPaths = [];

  if (paths.backendProjectPath && containsCjkCharacter(paths.backendProjectPath)) {
    warningPaths.push({
      field: "backendProjectPath",
      label: "服务项目路径",
      path: paths.backendProjectPath,
    });
  }

  if (paths.modelDir && containsCjkCharacter(paths.modelDir)) {
    warningPaths.push({
      field: "modelDir",
      label: "模型路径",
      path: paths.modelDir,
    });
  }

  if (paths.bundledMode && containsCjkCharacter(paths.effectiveModelDir)) {
    warningPaths.push({
      field: "effectiveModelDir",
      label: "内置模型路径",
      path: paths.effectiveModelDir,
    });
  }

  if (warningPaths.length > 0) {
    return {
      success: true,
      valid: true,
      warning: true,
      severity: "warning",
      code: "BACKEND_PATH_CONTAINS_CJK",
      message: BACKEND_PATH_CJK_WARNING_MESSAGE,
      warningPaths,
      invalidPaths: warningPaths,
      paths,
    };
  }

  return {
    success: true,
    valid: true,
    warning: false,
    severity: "",
    code: "",
    message: "",
    warningPaths: [],
    invalidPaths: [],
    paths,
  };
}
