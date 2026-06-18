const normalizeMessage = (value) => {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    return value.map(normalizeMessage).filter(Boolean).join("; ");
  }

  if (typeof value === "object") {
    if (Array.isArray(value.loc) && value.msg) {
      return `${value.loc.join(".")}: ${value.msg}`;
    }
    return (
      normalizeMessage(value.message) ||
      normalizeMessage(value.detail) ||
      normalizeMessage(value.error) ||
      (() => {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })()
    );
  }

  return String(value);
};

export const extractErrorDetail = (error, fallback = "操作失败") => {
  const data = error?.response?.data;
  return (
    normalizeMessage(data?.message) ||
    normalizeMessage(data?.detail) ||
    normalizeMessage(data?.error) ||
    normalizeMessage(error?.message) ||
    fallback
  );
};

export const classifyMoonshineError = (error, fallback = "操作失败") => {
  const detail = extractErrorDetail(error, fallback);
  const status = Number(error?.response?.status || 0);
  const lowerDetail = detail.toLowerCase();

  if (error?.code === "ECONNABORTED" || lowerDetail.includes("timeout")) {
    return {
      code: "request-timeout",
      title: "请求未响应",
      message: "Moonshine AI 引擎请求超时，请稍后重试或打开诊断查看运行状态。",
      detail,
      action: "diagnostics",
    };
  }

  if (error?.request && !error?.response) {
    return {
      code: "engine-not-running",
      title: "AI 引擎未启动",
      message: "Moonshine AI 引擎未启动或端口未响应，请打开诊断检查运行时和模型状态。",
      detail,
      action: "diagnostics",
    };
  }

  if (
    status === 507 ||
    lowerDetail.includes("insufficient storage") ||
    detail.includes("磁盘空间不足") ||
    detail.includes("空间不足")
  ) {
    return {
      code: "insufficient-disk-space",
      title: "磁盘空间不足",
      message: detail || "磁盘空间不足，请清理磁盘空间或更换输出/临时目录后重试。",
      detail,
      action: "",
    };
  }

  if (
    status === 404 ||
    lowerDetail.includes("model") && (
      lowerDetail.includes("not found") ||
      lowerDetail.includes("missing") ||
      lowerDetail.includes("checkpoint")
    ) ||
    detail.includes("模型") && (detail.includes("未找到") || detail.includes("缺失"))
  ) {
    return {
      code: "model-not-found",
      title: "AI 模型未找到",
      message: "当前选择的 AI 模型文件缺失，请检查模型目录或打开诊断查看详情。",
      detail,
      action: "diagnostics",
    };
  }

  if (
    lowerDetail.includes("decode") ||
    lowerDetail.includes("encode") ||
    lowerDetail.includes("invalid response") ||
    detail.includes("结果为空") ||
    detail.includes("响应结果") ||
    detail.includes("无法识别")
  ) {
    return {
      code: "invalid-response",
      title: "响应结果无法识别",
      message: "Moonshine AI 引擎返回的处理结果无法识别，请打开诊断查看后端输出。",
      detail,
      action: "diagnostics",
    };
  }

  if (status >= 500) {
    return {
      code: "engine-error",
      title: "AI 引擎处理失败",
      message: `Moonshine AI 引擎处理失败：${detail}`,
      detail,
      action: "diagnostics",
    };
  }

  return {
    code: "unknown",
    title: fallback,
    message: detail || fallback,
    detail,
    action: status >= 400 ? "diagnostics" : "",
  };
};

export const formatMoonshineError = (error, fallback = "操作失败") =>
  classifyMoonshineError(error, fallback).message;

export default {
  extractErrorDetail,
  classifyMoonshineError,
  formatMoonshineError,
};
