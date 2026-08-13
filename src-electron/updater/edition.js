export const APP_EDITION = Object.freeze({
  OFFICIAL: "official",
  TEST: "test",
});

export const APP_EDITION_IDENTITIES = Object.freeze({
  [APP_EDITION.OFFICIAL]: Object.freeze({
    edition: APP_EDITION.OFFICIAL,
    channel: "stable",
    appId: "com.moonshine.image",
    productName: "Moonshine-Image",
    executableName: "Moonshine-Image",
    userDataName: "Moonshine-Image",
    packageName: "moonshine-image",
    artifactName: "Moonshine-Image-Setup-${version}.${ext}",
  }),
  [APP_EDITION.TEST]: Object.freeze({
    edition: APP_EDITION.TEST,
    channel: "test",
    appId: "com.moonshine.image.test",
    productName: "Moonshine-Image-Test",
    executableName: "Moonshine-Image-Test",
    userDataName: "Moonshine-Image-Test",
    packageName: "moonshine-image-test",
    artifactName: "Moonshine-Image-Test-Setup-${version}.${ext}",
  }),
});

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const TEST_PRERELEASE_PATTERN = /^test\.\d+(?:\.[0-9A-Za-z-]+)*$/;

export function resolveAppEdition(version) {
  const normalizedVersion = String(version ?? "").trim().replace(/^v/i, "");
  const match = VERSION_PATTERN.exec(normalizedVersion);
  if (!match) throw new Error(`Invalid application version: ${normalizedVersion || "<empty>"}`);

  const prerelease = match[1] || "";
  if (!prerelease) return APP_EDITION_IDENTITIES[APP_EDITION.OFFICIAL];
  if (TEST_PRERELEASE_PATTERN.test(prerelease)) {
    return APP_EDITION_IDENTITIES[APP_EDITION.TEST];
  }
  throw new Error(`Unsupported application edition prerelease: ${prerelease}`);
}

export function assertEditionChannel(version, channel) {
  const identity = resolveAppEdition(version);
  const normalizedChannel = String(channel ?? "").trim().toLowerCase();
  if (normalizedChannel !== identity.channel) {
    throw new Error(
      `${identity.edition} edition ${String(version).trim()} is locked to the ${identity.channel} channel`,
    );
  }
  return identity;
}
