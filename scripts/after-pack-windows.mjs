import path from "node:path";

import { rcedit } from "rcedit";

function windowsVersion(value) {
  const parts = String(value || "0.0.0")
    .split(".")
    .slice(0, 4)
    .map((part) => String(Number.parseInt(part, 10) || 0));
  while (parts.length < 4) parts.push("0");
  return parts.join(".");
}

export async function applyWindowsExecutableResources({
  executablePath,
  iconPath,
  version,
  productName = "Moonshine-Image",
  companyName = "CuiMuxuan",
  copyright = "Copyright (c) 2026 CuiMuxuan",
} = {}) {
  await rcedit(executablePath, {
    icon: iconPath,
    "file-version": windowsVersion(version),
    "product-version": windowsVersion(version),
    "version-string": {
      CompanyName: companyName,
      FileDescription: productName,
      InternalName: productName,
      LegalCopyright: copyright,
      OriginalFilename: `${productName}.exe`,
      ProductName: productName,
    },
  });
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const appInfo = context.packager.appInfo;
  const productName = appInfo.productFilename || appInfo.productName || "Moonshine-Image";
  await applyWindowsExecutableResources({
    executablePath: path.join(context.appOutDir, `${productName}.exe`),
    iconPath: path.resolve(context.packager.projectDir, "src-electron", "icons", "icon.ico"),
    version: appInfo.version,
    productName,
    companyName: "CuiMuxuan",
    copyright: appInfo.copyright,
  });
}
