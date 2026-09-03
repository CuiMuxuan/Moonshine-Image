export const REMOTE_UNREACHABLE_USER_MESSAGE =
  "无法连接到远程的下载源，建议稍后重试或手动下载。";
export const REMOTE_UNREACHABLE_ERROR_KIND = "remote_unreachable";

const REMOTE_UNREACHABLE_PATTERN =
  /urlopen\s+error|winerror\s+10060|winerror\s+10061|winerror\s+10065|timed?\s*out|getaddrinfo failed|failed to establish|connection refused|connection reset|name or service not known|temporary failure in name resolution|network is unreachable|no route to host|econnrefused|etimedout|enotfound|由于连接方在一段时间后/i;

const getErrorText = (errorLike) => {
  if (errorLike == null) return "";
  if (typeof errorLike === "string") return errorLike;
  return String(
    errorLike.error ||
      errorLike.message ||
      errorLike.reason ||
      errorLike.cause ||
      ""
  );
};

export const isRemoteUnreachableError = (errorLike) => {
  const kind = String(errorLike?.errorKind || errorLike?.error_kind || "").trim();
  if (kind === REMOTE_UNREACHABLE_ERROR_KIND) return true;
  return REMOTE_UNREACHABLE_PATTERN.test(getErrorText(errorLike));
};

export const getModelDownloadUserMessage = (errorLike) =>
  isRemoteUnreachableError(errorLike) ? REMOTE_UNREACHABLE_USER_MESSAGE : "";

export const getModelDownloadOriginalError = (errorLike) => {
  const original = String(errorLike?.error || "").trim();
  if (original) return original;
  const fallback = getErrorText(errorLike).trim();
  const userMessage = getModelDownloadUserMessage(errorLike);
  return fallback && fallback !== userMessage ? fallback : "";
};

export const getFailedModelDownloadDisplayMessage = (errorLike, fallback = "下载失败") => {
  const userMessage = getModelDownloadUserMessage(errorLike);
  if (userMessage) return userMessage;
  return String(errorLike?.error || errorLike?.message || fallback).trim() || fallback;
};
