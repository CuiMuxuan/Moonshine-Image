import path from "node:path";

export const WINDOWS_PACKAGING_LAYOUT = Object.freeze({
  artifactRoot: "dist/electron/Packaged",
  builderUnpackedDirName: "win-unpacked",
  platform: "win32",
  arch: "x64",
});

function requireSegment(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized || /[\\/]/.test(normalized)) {
    throw new Error(`${label} must be a non-empty path segment.`);
  }
  return normalized;
}

export function getPortableAppDirName({
  productName,
  platform = WINDOWS_PACKAGING_LAYOUT.platform,
  arch = WINDOWS_PACKAGING_LAYOUT.arch,
} = {}) {
  return [
    requireSegment(productName, "productName"),
    requireSegment(platform, "platform"),
    requireSegment(arch, "arch"),
  ].join("-");
}

export function getPortableZipName({
  productName,
  version,
  arch = WINDOWS_PACKAGING_LAYOUT.arch,
} = {}) {
  return `${requireSegment(productName, "productName")}-Portable-${requireSegment(
    version,
    "version"
  )}-win-${requireSegment(arch, "arch")}.zip`;
}

export function resolveWindowsPackagingLayout({ repoRoot, productName, version } = {}) {
  const resolvedRepoRoot = path.resolve(String(repoRoot || "."));
  const artifactRoot = path.resolve(resolvedRepoRoot, WINDOWS_PACKAGING_LAYOUT.artifactRoot);
  const portableAppDirName = getPortableAppDirName({ productName });

  return Object.freeze({
    artifactRoot,
    builderUnpackedDir: path.join(
      artifactRoot,
      WINDOWS_PACKAGING_LAYOUT.builderUnpackedDirName
    ),
    portableAppDirName,
    portableAppDir: path.join(artifactRoot, portableAppDirName),
    portableZipName: getPortableZipName({ productName, version }),
    portableZipPath: path.join(
      artifactRoot,
      getPortableZipName({ productName, version })
    ),
    installerName: `${requireSegment(productName, "productName")}-Setup-${requireSegment(
      version,
      "version"
    )}.exe`,
    installerPath: path.join(
      artifactRoot,
      `${requireSegment(productName, "productName")}-Setup-${requireSegment(
        version,
        "version"
      )}.exe`
    ),
  });
}
