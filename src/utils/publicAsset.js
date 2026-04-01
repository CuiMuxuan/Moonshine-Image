export const resolvePublicAssetPath = (assetPath = "") => {
  const rawPath = String(assetPath || "");
  if (!rawPath) return "";

  if (/^(?:[a-z]+:)?\/\//i.test(rawPath) || /^(?:data|blob|file):/i.test(rawPath)) {
    return rawPath;
  }

  const normalizedPath = rawPath.replace(/^\/+/, "");
  const baseUrl = import.meta.env.BASE_URL || "/";
  const normalizedBaseUrl = baseUrl
    ? baseUrl.endsWith("/")
      ? baseUrl
      : `${baseUrl}/`
    : "";

  return `${normalizedBaseUrl}${normalizedPath}`;
};
