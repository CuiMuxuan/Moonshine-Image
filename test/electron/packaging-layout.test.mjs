import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  WINDOWS_PACKAGING_LAYOUT,
  getPortableAppDirName,
  getPortableZipName,
  resolveWindowsPackagingLayout,
} from "../../scripts/packaging-layout.mjs";

test("Windows packaging layout keeps builder and portable directories distinct", () => {
  assert.equal(WINDOWS_PACKAGING_LAYOUT.artifactRoot, "dist/electron/Packaged");
  assert.equal(WINDOWS_PACKAGING_LAYOUT.builderUnpackedDirName, "win-unpacked");
  assert.equal(
    getPortableAppDirName({ productName: "Moonshine-Image" }),
    "Moonshine-Image-win32-x64"
  );
  assert.equal(
    getPortableAppDirName({ productName: "Moonshine-Image-Test" }),
    "Moonshine-Image-Test-win32-x64"
  );
});

test("portable archive names are versioned and edition-aware", () => {
  assert.equal(
    getPortableZipName({ productName: "Moonshine-Image", version: "1.3.5" }),
    "Moonshine-Image-Portable-1.3.5-win-x64.zip"
  );
  assert.equal(
    getPortableZipName({ productName: "Moonshine-Image-Test", version: "1.3.5-test.1" }),
    "Moonshine-Image-Test-Portable-1.3.5-test.1-win-x64.zip"
  );
});

test("resolved layout uses one canonical artifact root", () => {
  const repoRoot = path.resolve("C:/workspace/moonshine");
  const layout = resolveWindowsPackagingLayout({
    repoRoot,
    productName: "Moonshine-Image",
    version: "1.3.5",
  });

  assert.equal(
    layout.artifactRoot,
    path.resolve(repoRoot, "dist/electron/Packaged")
  );
  assert.equal(layout.builderUnpackedDir, path.join(layout.artifactRoot, "win-unpacked"));
  assert.equal(
    layout.portableAppDir,
    path.join(layout.artifactRoot, "Moonshine-Image-win32-x64")
  );
  assert.equal(
    layout.installerPath,
    path.join(layout.artifactRoot, "Moonshine-Image-Setup-1.3.5.exe")
  );
});

test("packaging names reject path-like identity values", () => {
  assert.throws(
    () => getPortableAppDirName({ productName: "../Moonshine-Image" }),
    /path segment/
  );
});
