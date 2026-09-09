const releaseMetadataUrl = new URL(
  "release/latest.json",
  document.currentScript.src,
);

const FALLBACK_RELEASE = {
  version: "1.3.8",
  installerUrl:
    "https://download.moonshine.email/app/win-x64/stable/Moonshine-Image-Setup-1.3.8.exe",
  releaseUrl: "https://github.com/CuiMuxuan/Moonshine-Image/releases/latest",
};

function isSafeStableInstaller(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "download.moonshine.email" &&
      /^\/app\/win-x64\/stable\/Moonshine-Image-Setup-[0-9A-Za-z.+-]+\.exe$/.test(
        parsed.pathname,
      )
    );
  } catch {
    return false;
  }
}

function readReleaseMetadata(metadata) {
  const payload = metadata?.payload || metadata;
  const version = String(metadata?.version || payload?.appVersion || "").trim();
  const installerPath = String(
    metadata?.installerPath || payload?.app?.installerPath || "",
  ).trim();
  const installerUrl = String(
    metadata?.installerUrl ||
      (installerPath
        ? `https://download.moonshine.email/${installerPath.replace(/^\/+/, "")}`
        : ""),
  ).trim();
  const releaseUrl = String(
    metadata?.releaseUrl || FALLBACK_RELEASE.releaseUrl,
  ).trim();

  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) ||
    !isSafeStableInstaller(installerUrl)
  ) {
    throw new Error("发布元数据未通过校验");
  }
  return { version, installerUrl, releaseUrl };
}

function applyReleaseMetadata(release, { fallback = false } = {}) {
  document.querySelectorAll("[data-release-version]").forEach((element) => {
    element.textContent = release.version;
  });
  document.querySelectorAll("[data-download-link]").forEach((element) => {
    element.href = release.installerUrl;
  });
  document.querySelectorAll("[data-release-list-link]").forEach((element) => {
    element.href = release.releaseUrl;
  });
  document.querySelectorAll("[data-release-status]").forEach((element) => {
    element.textContent = fallback
      ? `正在使用已验证的 ${release.version} 下载链接`
      : `稳定版 ${release.version} 下载已准备就绪`;
  });
}

async function loadReleaseMetadata() {
  applyReleaseMetadata(FALLBACK_RELEASE, { fallback: true });
  try {
    const response = await fetch(releaseMetadataUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    applyReleaseMetadata(readReleaseMetadata(await response.json()));
  } catch {
    // A deployed fallback keeps the primary download action working if the metadata refresh fails.
  }
}

loadReleaseMetadata();
