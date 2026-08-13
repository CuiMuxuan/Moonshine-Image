import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const cacheRoot = path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache");
const legacyNsisDir = path.join(cacheRoot, "nsis", "nsis-3.0.4.1");
const requiredResourcePlugins = ["UAC.dll", "WinShell.dll", "nsis7z.dll"];

const isDirectory = async (target) => {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
};

const isFile = async (target) => {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
};

const findResourceRoot = async () => {
  const candidates = [
    path.join(cacheRoot, "nsis", "nsis-resources-3.4.1"),
    path.join(cacheRoot, "nsis-resources-3.4.1"),
  ];

  for (const candidate of candidates) {
    if (await isDirectory(path.join(candidate, "plugins", "x86-unicode"))) return candidate;
    if (!(await isDirectory(candidate))) continue;

    for (const entry of await readdir(candidate, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(candidate, entry.name);
      if (await isDirectory(path.join(nested, "plugins", "x86-unicode"))) return nested;
    }
  }

  throw new Error("未找到 electron-builder 的 NSIS 资源缓存。请先运行一次普通 Windows 安装器构建以下载该工具集。");
};

const copyResourcePluginsWithoutStdUtils = async (resourceRoot) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "moonshine-image-nsis-"));
  const sourcePlugins = path.join(resourceRoot, "plugins");
  const targetPlugins = path.join(temporaryRoot, "plugins");

  for (const architecture of ["x86-unicode", "x86-ansi"]) {
    const source = path.join(sourcePlugins, architecture);
    const target = path.join(targetPlugins, architecture);
    if (!(await isDirectory(source))) continue;
    await cp(source, target, {
      recursive: true,
      filter: (entry) => path.basename(entry).toLowerCase() !== "stdutils.dll",
    });
  }

  for (const plugin of requiredResourcePlugins) {
    if (!(await isFile(path.join(targetPlugins, "x86-unicode", plugin)))) {
      throw new Error(`NSIS 资源缓存缺少 ${plugin}。`);
    }
  }

  return temporaryRoot;
};

if (process.platform !== "win32") {
  throw new Error("build:electron:installer:local 只能在 Windows 上运行。");
}

if (!(await isFile(path.join(legacyNsisDir, "Bin", "makensis.exe")))) {
  throw new Error("未找到包含 StdUtils 的本机 NSIS 工具集。请先完成 electron-builder 的 NSIS 缓存下载。");
}

if (!(await isFile(path.join(legacyNsisDir, "Plugins", "x86-unicode", "StdUtils.dll")))) {
  throw new Error("本机 NSIS 工具集缺少 StdUtils.dll，无法构建带自定义卸载选项的安装器。");
}

const resourceRoot = await findResourceRoot();
const isolatedResources = await copyResourcePluginsWithoutStdUtils(resourceRoot);
console.log(`Using NSIS compiler: ${legacyNsisDir}`);
console.log(`Using isolated NSIS resources: ${isolatedResources}`);

const quasarCli = path.join(process.cwd(), "node_modules", "@quasar", "app-vite", "bin", "quasar.js");
if (!(await isFile(quasarCli))) {
  throw new Error("未找到项目的 Quasar CLI。请先运行 npm install。");
}

const result = spawnSync(process.execPath, [quasarCli, "build", "-m", "electron", "-b", "builder", "-T", "win", "-A", "x64"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ELECTRON_BUILDER_NSIS_DIR: legacyNsisDir,
    ELECTRON_BUILDER_NSIS_RESOURCES_DIR: isolatedResources,
  },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
