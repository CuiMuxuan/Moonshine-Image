import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  session,
  Menu,
  shell,
  protocol,
} from "electron";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import fs from "fs";
import https from "https";
import { spawn, exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);
// 后端服务进程
let backendProcess = null;
global.projectPath = "";
// 默认配置
const DEFAULT_CONFIG = {
  general: {
    backendPort: 8080,
    launchMode: "cuda", // 'cuda' | 'cpu'
    modelPath: "",
    backendProjectPath: "",
    defaultModel: "lama",
  },
  fileManagement: {
    downloadPath: "",
    tempPath: "",
    imageFolderName: "images",
    videoFolderName: "videos",
  },
  advanced: {
    imageHistoryLimit: 10,
    imageWarningSize: 5, // MB
    stateSaveLimit: 100, // MB
    imageProcessingMethod: "base64",
  },
  video: {
    maxFrameCount: 10000,
    frameExtractionFormat: "png",
    defaultFrameRate: 30,
    maxKeyframes: 100,
    autoNextFrameInterval: 0.1,
    tempFramesPath: "",
    supportedFormats: ["mp4", "mov", "avi", "mkv", "wmv"],
    maxConcurrentFrameProcessing: 4,
    enableFrameSkipping: true,
    memoryOptimization: true,
    autoSaveInterval: 30,
    maxDraftRetention: 7,
  },
};

// 全局配置对象
let globalConfig = { ...DEFAULT_CONFIG };

const TARGET_PYTHON_VERSION = "3.11.5";
const MIN_SYSTEM_PYTHON_MINOR = 10;
const MAX_SYSTEM_PYTHON_MINOR = 12;

function quoteArg(arg) {
  return `"${String(arg).replace(/"/g, '\\"')}"`;
}

async function execCommand(command, options = {}) {
  return execAsync(command, {
    env: { ...process.env },
    shell: true,
    ...options,
  });
}

function parsePythonVersion(text) {
  const match = String(text || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    text: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

function isSystemPythonVersionSupported(versionInfo) {
  return (
    versionInfo &&
    versionInfo.major === 3 &&
    versionInfo.minor >= MIN_SYSTEM_PYTHON_MINOR &&
    versionInfo.minor <= MAX_SYSTEM_PYTHON_MINOR
  );
}

function getDefaultBackendProjectPath() {
  const appDir = path.dirname(app.getAppPath());
  return path.join(appDir, "IOPaint");
}

function getVenvPythonPathByVenvPath(venvPath) {
  return os.platform() === "win32"
    ? path.join(venvPath, "Scripts", "python.exe")
    : path.join(venvPath, "bin", "python");
}

function getProjectVenvInfo(projectPath) {
  const candidates = [".venv", "venv"];
  for (const candidateName of candidates) {
    const candidatePath = path.join(projectPath, candidateName);
    if (!fs.existsSync(candidatePath)) {
      continue;
    }

    if (!fs.statSync(candidatePath).isDirectory()) {
      return {
        exists: true,
        valid: false,
        venvName: candidateName,
        venvPath: candidatePath,
        error: `${candidateName} 存在，但不是目录。`,
      };
    }

    const pythonPath = getVenvPythonPathByVenvPath(candidatePath);
    const pyvenvCfgPath = path.join(candidatePath, "pyvenv.cfg");
    const isValid = fs.existsSync(pythonPath) && fs.existsSync(pyvenvCfgPath);
    if (!isValid) {
      return {
        exists: true,
        valid: false,
        venvName: candidateName,
        venvPath: candidatePath,
        pythonPath,
        error: `${candidateName} 存在，但不是有效的 Python 虚拟环境。`,
      };
    }

    return {
      exists: true,
      valid: true,
      venvName: candidateName,
      venvPath: candidatePath,
      pythonPath,
    };
  }

  return {
    exists: false,
    valid: false,
  };
}

async function getPythonVersionFromCommand(pythonCommand, options = {}) {
  try {
    const { stdout, stderr } = await execCommand(`${pythonCommand} --version`, {
      timeout: 15000,
      ...options,
    });
    const combined = `${stdout || ""}\n${stderr || ""}`.trim();
    const version = parsePythonVersion(combined);
    if (!version) {
      return {
        success: false,
        error: `无法从输出中解析 Python 版本: ${combined}`,
      };
    }
    return { success: true, version };
  } catch (error) {
    return {
      success: false,
      error: error.message || "Python 版本检测命令执行失败。",
    };
  }
}

async function detectSystemPython() {
  const commandCandidates =
    os.platform() === "win32"
      ? ["python", "py -3", "py", "python3"]
      : ["python3", "python"];

  for (const cmd of commandCandidates) {
    const versionResult = await getPythonVersionFromCommand(cmd);
    if (versionResult.success) {
      return {
        success: true,
        command: cmd,
        version: versionResult.version,
      };
    }
  }

  if (os.platform() === "win32") {
    const userName = os.userInfo().username;
    const pathCandidates = [
      "C:\\Python311\\python.exe",
      "C:\\Python310\\python.exe",
      `C:\\Users\\${userName}\\AppData\\Local\\Programs\\Python\\Python311\\python.exe`,
      `C:\\Users\\${userName}\\AppData\\Local\\Programs\\Python\\Python310\\python.exe`,
    ];

    for (const pythonPath of pathCandidates) {
      if (!fs.existsSync(pythonPath)) {
        continue;
      }
      const versionResult = await getPythonVersionFromCommand(
        quoteArg(pythonPath)
      );
      if (versionResult.success) {
        return {
          success: true,
          command: quoteArg(pythonPath),
          version: versionResult.version,
          path: pythonPath,
        };
      }
    }
  }

  return {
    success: false,
    error: "未检测到系统 Python 可执行文件。",
  };
}

async function detectConda() {
  try {
    const { stdout, stderr } = await execCommand("conda --version", {
      timeout: 15000,
    });
    const message = `${stdout || ""}\n${stderr || ""}`.trim();
    if (!message) {
      return { success: false, error: "Conda 命令返回为空。" };
    }
    return { success: true, version: message };
  } catch (error) {
    return { success: false, error: error.message || "未检测到 Conda。" };
  }
}

async function createProjectVenvWithPython(projectPath, pythonCommand, sendLog) {
  sendLog?.(`正在使用 ${pythonCommand} 创建项目虚拟环境...`, "info");
  await execCommand(`${pythonCommand} -m venv .venv`, {
    cwd: projectPath,
    timeout: 180000,
  });

  const venvInfo = getProjectVenvInfo(projectPath);
  if (!venvInfo.exists || !venvInfo.valid) {
    throw new Error("虚拟环境创建结束，但 .venv 无效。");
  }
  return venvInfo;
}

async function bootstrapProjectVenvWithConda(projectPath, sendLog) {
  const tempEnvName = `moonshine-image-bootstrap-${Date.now()}`;
  let createdTempEnv = false;
  try {
    sendLog?.(
      `正在创建临时 conda 环境 (${tempEnvName})，Python 版本 ${TARGET_PYTHON_VERSION}...`,
      "info"
    );
    await execCommand(
      `conda create -n ${tempEnvName} python=${TARGET_PYTHON_VERSION} -y`,
      { timeout: 600000 }
    );
    createdTempEnv = true;

    sendLog?.("正在通过 conda 的 Python 在后端项目中创建 .venv ...", "info");
    await execCommand(`conda run -n ${tempEnvName} python -m venv .venv`, {
      cwd: projectPath,
      timeout: 600000,
    });

    const venvInfo = getProjectVenvInfo(projectPath);
    if (!venvInfo.exists || !venvInfo.valid) {
      throw new Error("Conda 引导创建完成，但 .venv 无效。");
    }
    return venvInfo;
  } finally {
    if (createdTempEnv) {
      try {
        sendLog?.(`正在删除临时 conda 环境 (${tempEnvName})...`, "info");
        await execCommand(`conda env remove -n ${tempEnvName} -y`, {
          timeout: 180000,
        });
      } catch (cleanupError) {
        sendLog?.(
          `删除临时 conda 环境失败: ${cleanupError.message}`,
          "warning"
        );
      }
    }
  }
}

function buildManualVenvGuide(projectPath) {
  const safeProjectPath = projectPath || "<后端项目路径>";
  return {
    downloadUrl:
      "https://www.python.org/ftp/python/3.11.5/python-3.11.5-amd64.exe",
    commands: [
      `cd /d "${safeProjectPath}"`,
      "py -3.11 -m venv .venv",
      ".\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple",
    ],
  };
}

function validateProjectPath(inputPath) {
  const defaultProjectPath = getDefaultBackendProjectPath();
  const defaultProjectParentPath = path.dirname(defaultProjectPath);
  let checkPath = inputPath;
  if (!checkPath) {
    const defaultPath = defaultProjectPath;
    if (fs.existsSync(defaultPath)) {
      checkPath = defaultPath;
    } else {
      return {
        success: false,
        code: "PROJECT_NOT_SELECTED",
        error: "未检测到后端项目路径。",
        defaultProjectPath,
        defaultProjectParentPath,
      };
    }
  }

  if (!fs.existsSync(checkPath)) {
    return {
      success: false,
      code: "PROJECT_PATH_NOT_FOUND",
      error: `后端项目路径不存在: ${checkPath}`,
      currentCheckPath: checkPath,
      defaultProjectPath,
      defaultProjectParentPath,
    };
  }

  const requiredFiles = ["requirements.txt", "main.py"];
  const requiredDirs = ["iopaint"];
  const missingFiles = requiredFiles.filter(
    (fileName) => !fs.existsSync(path.join(checkPath, fileName))
  );
  const missingDirs = requiredDirs.filter((dirName) => {
    const dirPath = path.join(checkPath, dirName);
    return !fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory();
  });

  if (missingFiles.length > 0 || missingDirs.length > 0) {
    return {
      success: false,
      code: "PROJECT_STRUCTURE_INVALID",
      error: "后端项目结构不完整。",
      missingFiles,
      missingDirs,
      defaultProjectPath,
      defaultProjectParentPath,
    };
  }

  return { success: true, path: checkPath };
}

// 获取配置文件路径
function getConfigPath() {
  const userDataPath = app.getPath("userData");
  const configDir = path.join(userDataPath, "config");

  // 确保配置目录存在
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  return path.join(configDir, "config.json");
}

// 验证配置文件格式
function validateConfig(config) {
  try {
    // 验证必要字段
    if (!config.general || !config.fileManagement || !config.advanced) {
      return false;
    }

    // 验证端口号范围
    const port = config.general.backendPort;
    if (typeof port !== "number" || port < 1024 || port > 65535) {
      return false;
    }

    // 验证启动方式
    if (!["cuda", "cpu"].includes(config.general.launchMode)) {
      return false;
    }

    // 验证数字字段
    const numFields = [
      config.advanced.imageHistoryLimit,
      config.advanced.imageWarningSize,
      config.advanced.stateSaveLimit,
    ];

    if (numFields.some((field) => typeof field !== "number" || field < 0)) {
      return false;
    }

    // 验证图片处理方式
    if (
      config.advanced?.imageProcessingMethod &&
      !["base64", "path"].includes(config.advanced.imageProcessingMethod)
    ) {
      return false;
    }
    return true;
  } catch (error) {
    console.error("配置验证失败:", error);
    return false;
  }
}

// 加载配置文件
function loadAppConfig() {
  try {
    const configPath = getConfigPath();

    if (fs.existsSync(configPath)) {
      const configData = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (validateConfig(configData)) {
        globalConfig = { ...DEFAULT_CONFIG, ...configData };
        console.log("配置文件加载成功");
      } else {
        console.warn("配置文件格式无效，使用默认配置");
        createDefaultConfig();
      }
    } else {
      console.log("配置文件不存在，创建默认配置");
      createDefaultConfig();
    }

    // 设置全局配置
    global.appConfig = {
      ...globalConfig,
      api: {
        port: globalConfig.general.backendPort,
        baseURL: `http://localhost:${globalConfig.general.backendPort}`,
      },
    };
  } catch (error) {
    console.error("加载配置失败:", error);
    createDefaultConfig();
  }
}

// 创建默认配置文件
function createDefaultConfig() {
  try {
    const configPath = getConfigPath();

    // 设置默认路径
    const userDataPath = app.getPath("userData");
    const userPath = app.getPath("home");
    DEFAULT_CONFIG.fileManagement.downloadPath = path.join(
      userDataPath,
      "downloads"
    );
    DEFAULT_CONFIG.fileManagement.tempPath = path.join(userDataPath, "temp");
    DEFAULT_CONFIG.general.modelPath = path.join(
      userPath,
      ".cache",
      "torch",
      "hub",
      "checkpoints"
    );
    const appDir = path.dirname(app.getAppPath());
    DEFAULT_CONFIG.general.backendProjectPath = path.join(appDir, "IOPaint");
    DEFAULT_CONFIG.general.defaultModel = "lama";
    DEFAULT_CONFIG.video.tempFramesPath = path.join(
      userDataPath,
      "temp",
      "video_frames"
    );
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    globalConfig = { ...DEFAULT_CONFIG };

    // 创建必要的目录
    [
      DEFAULT_CONFIG.fileManagement.downloadPath,
      DEFAULT_CONFIG.fileManagement.tempPath,
    ].forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });

    console.log("默认配置文件创建成功");
  } catch (error) {
    console.error("创建默认配置失败:", error);
  }
}

// IPC 处理程序 - 获取配置
ipcMain.handle("get-app-config", async () => {
  return global.appConfig || globalConfig;
});

// IPC 处理程序 - 保存配置
ipcMain.handle("save-app-config", async (event, newConfig) => {
  try {
    // 验证新配置
    if (!newConfig || typeof newConfig !== "object") {
      console.error("配置格式无效:", newConfig);
      return { success: false, error: "配置格式无效" };
    }
    if (!validateConfig(newConfig)) {
      console.error("配置验证失败:", newConfig);
      return { success: false, error: "配置格式无效" };
    }
    const configPath = getConfigPath();
    console.log("保存配置到:", configPath);
    // 保存到文件
    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
    // 更新全局配置
    globalConfig = { ...newConfig };
    global.appConfig = {
      ...globalConfig,
      api: {
        port: globalConfig.general.backendPort,
        baseURL: `http://localhost:${globalConfig.general.backendPort}`,
      },
    };
    console.log("配置保存成功");
    return { success: true };
  } catch (error) {
    console.error("保存配置失败:", error);
    return { success: false, error: error.message };
  }
});

// IPC 处理程序 - 状态持久化
ipcMain.handle("save-app-state", async (event, stateData) => {
  try {
    const statePath = path.join(app.getPath("userData"), "app-state.json");
    // 检查状态大小限制
    const stateSize = Buffer.byteLength(JSON.stringify(stateData), "utf8");
    const limitMB = globalConfig.advanced.stateSaveLimit;
    const limitBytes = limitMB * 1024 * 1024;

    if (stateSize > limitBytes) {
      return {
        success: false,
        error: `状态数据过大 (${(stateSize / 1024 / 1024).toFixed(
          2
        )}MB > ${limitMB}MB)`,
        oversized: true,
      };
    }
    fs.writeFileSync(statePath, JSON.stringify(stateData, null, 2));
    return { success: true };
  } catch (error) {
    console.error("保存状态失败:", error);
    return { success: false, error: error.message };
  }
});

// IPC 处理程序 - 恢复状态
ipcMain.handle("load-app-state", async () => {
  try {
    const statePath = path.join(app.getPath("userData"), "app-state.json");

    if (fs.existsSync(statePath)) {
      const stateData = JSON.parse(fs.readFileSync(statePath, "utf8"));
      return { success: true, data: stateData };
    } else {
      return { success: true, data: null };
    }
  } catch (error) {
    console.error("加载状态失败:", error);
    return { success: false, error: error.message };
  }
});

function clearAppStateFile() {
  const statePath = path.join(app.getPath("userData"), "app-state.json");
  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
  }
}

// IPC 处理程序 - 清除状态
ipcMain.handle("clear-app-state", async () => {
  try {
    clearAppStateFile();
    return { success: true };
  } catch (error) {
    console.error("清除状态失败:", error);
    return { success: false, error: error.message };
  }
});
// IPC 处理程序 - 检查状态文件是否存在
ipcMain.handle("check-app-state-exists", async () => {
  try {
    const statePath = path.join(app.getPath("userData"), "app-state.json");
    return fs.existsSync(statePath);
  } catch (error) {
    console.error("检查状态文件失败:", error);
    return false;
  }
});

// IPC 处理程序 - 保存文件
const saveFileHandler = async (event, { filePath, blob }) => {
  try {
    // 确保目录存在
    const directory = path.dirname(filePath);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }

    // 检查文件是否已存在
    if (fs.existsSync(filePath)) {
      // 如果文件已存在，添加时间戳避免覆盖
      const fileExt = path.extname(filePath);
      const baseName = path.basename(filePath, fileExt);
      const dirName = path.dirname(filePath);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      filePath = path.join(dirName, `${baseName}_${timestamp}${fileExt}`);
    }

    // 将 ArrayBuffer 写入文件
    fs.writeFileSync(filePath, Buffer.from(blob));

    return filePath;
  } catch (error) {
    console.error("保存文件失败:", error);
    throw error;
  }
};
ipcMain.handle("save-file", saveFileHandler);
// 添加别名处理程序，以提高兼容性
ipcMain.handle("saveFile", saveFileHandler);
// IPC 处理程序 - 选择目录
ipcMain.handle("select-directory", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "选择保存路径",
  });
  return { canceled, filePaths };
});

// 处理打开外部链接的请求
ipcMain.handle("open-external-link", async (event, url) => {
  try {
    await shell.openExternal(url);
    return true;
  } catch (err) {
    console.error("无法打开外部链接:", err);
    return false;
  }
});
// 兼容旧版本的同步请求
ipcMain.on("open-external-link", (event, url) => {
  shell.openExternal(url).catch((err) => {
    console.error("无法打开外部链接:", err);
  });
  event.returnValue = true; // 对于 sendSync 需要返回值
});

// 注册获取资源路径的 IPC 处理程序
ipcMain.handle("get-resources-path", () => {
  try {
    // 在打包后的应用中，资源路径通常位于应用目录下的 resources 文件夹
    return path.dirname(app.getAppPath());
  } catch (error) {
    console.error("获取资源路径失败:", error);
    return "./resources";
  }
});

// IPC 处理程序 - 读取文件内容
ipcMain.handle("read-file", async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: `文件不存在: ${filePath}` };
    }

    const stats = fs.statSync(filePath);
    const buffer = fs.readFileSync(filePath);

    return {
      success: true,
      data: {
        name: path.basename(filePath),
        size: stats.size,
        type: getMimeType(filePath),
        lastModified: stats.mtime.getTime(),
        buffer: Array.from(buffer),
        path: filePath,
      },
    };
  } catch (error) {
    console.error("读取文件失败:", error);
    return { success: false, error: error.message };
  }
});
// IPC 处理程序 - 显示丢失文件提示
ipcMain.on("show-missing-files", (event, missingFiles) => {
  if (missingFiles && missingFiles.length > 0) {
    const message = `以下文件已不存在:\n${missingFiles.join("\n")}`;
    dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "文件丢失提示",
      message: message,
      buttons: ["确定"],
    });
  }
});

// IPC 处理程序 - 确保目录存在
ipcMain.handle("ensure-directory", async (event, dirPath) => {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    return { success: true };
  } catch (error) {
    console.error("创建目录失败:", error);
    return { success: false, error: error.message };
  }
});

// IPC 处理程序 - 删除文件
ipcMain.handle("delete-file", async (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return { success: true };
  } catch (error) {
    console.error("删除文件失败:", error);
    return { success: false, error: error.message };
  }
});
// IPC 处理程序 - 复制文件
ipcMain.handle("copy-file", async (event, { source, target }) => {
  try {
    // 检查源文件是否存在
    if (!fs.existsSync(source)) {
      throw new Error(`源文件不存在: ${source}`);
    }

    // 确保目标目录存在
    const targetDir = path.dirname(target);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // 如果目标文件已存在，添加时间戳避免覆盖
    let finalTarget = target;
    if (fs.existsSync(target)) {
      const fileExt = path.extname(target);
      const baseName = path.basename(target, fileExt);
      const dirName = path.dirname(target);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      finalTarget = path.join(dirName, `${baseName}_${timestamp}${fileExt}`);
    }

    // 复制文件
    fs.copyFileSync(source, finalTarget);

    console.log(`文件复制成功: ${source} -> ${finalTarget}`);
    return { success: true, targetPath: finalTarget };
  } catch (error) {
    console.error("复制文件失败:", error);
    return { success: false, error: error.message };
  }
});
// IPC 处理程序 - 选择文件
ipcMain.handle("select-file", async (event, options = {}) => {
  const dialogOptions = {
    title: options.title || "选择文件",
    filters: options.filters || [],
    properties: options.properties || ["openFile"],
  };

  const { canceled, filePaths } = await dialog.showOpenDialog(dialogOptions);
  return { canceled, filePaths };
});

// 添加新的选择文件夹处理程序
ipcMain.handle("select-folder", async (event, options = {}) => {
  const dialogOptions = {
    title: options.title || "选择文件夹",
    properties: ["openDirectory"],
  };

  const { canceled, filePaths } = await dialog.showOpenDialog(dialogOptions);
  return { canceled, filePaths };
});

// IPC 处理程序 - 检查 Python 环境
ipcMain.handle("check-python", async (event) => {
  const sendLog = (message, type = "info") => {
    event.sender.send("backend-output", { message, type });
  };

  try {
    // 获取系统环境变量
    const systemEnv = { ...process.env };
    sendLog("正在检测 Python 环境...", "info");

    // Windows 系统特殊处理
    if (os.platform() === "win32") {
      // 尝试多种 Python 命令
      const pythonCommands = ["python", "py", "python3"];
      sendLog(`尝试检测 Python 命令: ${pythonCommands.join(", ")}`, "info");

      for (const cmd of pythonCommands) {
        try {
          sendLog(`正在尝试命令: ${cmd} --version`, "info");
          const { stdout } = await execAsync(`${cmd} --version`, {
            env: systemEnv,
            shell: true,
            timeout: 10000,
          });
          if (stdout) {
            sendLog(
              `✓ 命令 ${cmd} --version执行成功: ${stdout.trim()}`,
              "success"
            );
            return {
              success: true,
              version: stdout.trim(),
              type: "python",
              command: cmd,
            };
          }
        } catch (cmdError) {
          sendLog(`✗ 命令 ${cmd} 失败: ${cmdError.message}`, "warning");
          continue;
        }
      }

      // 尝试从常见安装路径查找 Python
      const commonPaths = [
        "C:\\Python311\\python.exe",
        "C:\\Python310\\python.exe",
        "C:\\Python39\\python.exe",
        "C:\\Users\\" +
          os.userInfo().username +
          "\\AppData\\Local\\Programs\\Python\\Python311\\python.exe",
        "C:\\Users\\" +
          os.userInfo().username +
          "\\AppData\\Local\\Programs\\Python\\Python310\\python.exe",
      ];

      sendLog("尝试从常见安装路径查找 Python...", "info");
      for (const pythonPath of commonPaths) {
        try {
          sendLog(`检查路径: ${pythonPath}`, "info");
          if (fs.existsSync(pythonPath)) {
            sendLog(`✓ 找到 Python 可执行文件: ${pythonPath}`, "success");
            const { stdout } = await execAsync(`"${pythonPath}" --version`, {
              env: systemEnv,
              shell: true,
              timeout: 10000,
            });
            if (stdout) {
              sendLog(`✓ Python 版本检测成功: ${stdout.trim()}`, "success");
              return {
                success: true,
                version: stdout.trim(),
                type: "python",
                path: pythonPath,
              };
            }
          } else {
            sendLog(`✗ 路径不存在: ${pythonPath}`, "warning");
          }
        } catch (pathError) {
          sendLog(
            `✗ 路径检测失败 ${pythonPath}: ${pathError.message}`,
            "warning"
          );
          continue;
        }
      }
    } else {
      // Unix-like 系统
      sendLog("检测 Unix-like 系统的 Python 环境...", "info");
      try {
        sendLog("尝试命令: python --version", "info");
        const { stdout: pythonStdout } = await execAsync("python --version", {
          env: systemEnv,
          shell: true,
          timeout: 10000,
        });
        if (pythonStdout) {
          sendLog(`✓ python 命令成功: ${pythonStdout.trim()}`, "success");
          return {
            success: true,
            version: pythonStdout.trim(),
            type: "python",
          };
        }
      } catch (pythonError) {
        sendLog(`✗ python 命令失败: ${pythonError.message}`, "warning");
        try {
          sendLog("尝试命令: python3 --version", "info");
          const { stdout: python3Stdout } = await execAsync(
            "python3 --version",
            {
              env: systemEnv,
              shell: true,
              timeout: 10000,
            }
          );
          if (python3Stdout) {
            sendLog(`✓ python3 命令成功: ${python3Stdout.trim()}`, "success");
            return {
              success: true,
              version: python3Stdout.trim(),
              type: "python",
            };
          }
        } catch (python3Error) {
          sendLog(`✗ python3 命令失败: ${python3Error.message}`, "warning");
          // 继续尝试 conda
        }
      }
    }

    // 尝试检测 conda
    sendLog("尝试检测 conda 环境...", "info");
    try {
      const { stdout: condaStdout } = await execAsync("conda -V", {
        env: systemEnv,
        shell: true,
        timeout: 10000,
      });
      if (condaStdout) {
        sendLog(`✓ 找到 conda: ${condaStdout.trim()}`, "success");
        try {
          // 检查 moonshine-image 环境是否存在
          sendLog("检查 moonshine-image 环境...", "info");
          const { stdout: envCheckStdout } = await execAsync("conda env list", {
            env: systemEnv,
            shell: true,
            timeout: 10000,
          });

          if (!envCheckStdout.includes("moonshine-image")) {
            // 创建 moonshine-image 环境
            sendLog("创建 moonshine-image conda 环境...", "info");
            await execAsync(
              "conda create -n moonshine-image python=3.11.5 -y",
              {
                env: systemEnv,
                shell: true,
                timeout: 300000,
              }
            );
            sendLog("✓ moonshine-image 环境创建成功", "success");
          } else {
            sendLog("✓ moonshine-image 环境已存在", "success");
          }

          // 激活环境并检查 Python 版本
          sendLog("激活 moonshine-image 环境并检查 Python 版本...", "info");
          const activateCmd =
            os.platform() === "win32"
              ? "conda activate moonshine-image && python --version"
              : "source activate moonshine-image && python --version";

          const { stdout: envPythonStdout } = await execAsync(activateCmd, {
            env: systemEnv,
            shell: true,
            timeout: 30000,
          });

          sendLog(
            `✓ conda 环境 Python 版本: ${envPythonStdout.trim()}`,
            "success"
          );
          return {
            success: true,
            version: envPythonStdout.trim(),
            type: "conda",
          };
        } catch (envError) {
          sendLog(`✗ conda 环境操作失败: ${envError.message}`, "error");
          return {
            success: false,
            error: `找到 conda (${condaStdout.trim()})，但创建或激活环境失败: ${
              envError.message
            }`,
          };
        }
      }
    } catch (condaError) {
      sendLog(`✗ conda 检测失败: ${condaError.message}`, "warning");
      sendLog("未检测到可用的 Python 环境", "error");
      return {
        success: false,
        error: `未检测到可用的 Python 环境。请确保 Python 已正确安装并添加到系统 PATH 中。详细错误: ${condaError.message}`,
      };
    }
  } catch (error) {
    sendLog(`Python 环境检测过程中发生错误: ${error.message}`, "error");
    return {
      success: false,
      error: `Python 环境检测失败: ${error.message}`,
    };
  }
});

// IPC 处理程序 - 设置 Python 环境变量
ipcMain.handle("set-python-env", async (event, pythonPath) => {
  try {
    const currentEnv = process.env.PATH || "";
    // 检查路径是否已存在于 PATH 中
    if (!currentEnv.includes(pythonPath)) {
      // Windows 系统下添加路径到环境变量
      process.env.PATH = `${pythonPath};${currentEnv}`;
    }
    return { success: true, message: "Python 环境变量设置成功" };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// IPC 处理程序 - 检查 conda 虚拟环境
ipcMain.handle("check-conda-venv", async () => {
  try {
    // 获取系统环境变量
    const systemEnv = { ...process.env };

    // 检查 moonshine-image 环境是否存在
    const { stdout } = await execAsync("conda env list", {
      env: systemEnv,
      shell: true,
      timeout: 10000,
    });

    const envExists = stdout.includes("moonshine-image");
    return {
      success: envExists,
      message: envExists ? "conda 虚拟环境已存在" : "conda 虚拟环境不存在",
    };
  } catch (error) {
    return {
      success: false,
      error: `检查 conda 虚拟环境失败: ${error.message}`,
    };
  }
});

// IPC 处理程序 - 检查 conda 依赖
ipcMain.handle("check-conda-dependencies", async () => {
  try {
    // 获取系统环境变量
    const systemEnv = { ...process.env };

    // 激活 moonshine-image 环境并检查依赖
    const activateCmd =
      os.platform() === "win32"
        ? "conda activate moonshine-image && conda list"
        : "source activate moonshine-image && conda list";

    const { stdout } = await execAsync(activateCmd, {
      env: systemEnv,
      shell: true,
      timeout: 30000,
    });

    // 简单判断依赖是否已安装，可根据实际需求修改判断逻辑
    return { success: stdout.split("\n").length > 10, message: stdout };
  } catch (error) {
    return { success: false, error: `检查 conda 依赖失败: ${error.message}` };
  }
});
// IPC 处理程序 - 检查项目
// IPC 婢跺嫮鎮婄粙瀣碍 - 濡偓閺屻儵銆嶉惄?
ipcMain.handle("check-project", async (event, selectPath) => {
  try {
    const result = validateProjectPath(selectPath || global.projectPath);
    if (!result.success) {
      return result;
    }

    global.projectPath = result.path;
    return {
      success: true,
      path: result.path,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

ipcMain.handle("prepare-project-python", async (event, selectPath) => {
  const sendLog = (message, type = "info") => {
    event.sender.send("backend-output", { message, type });
  };

  try {
    const projectResult = validateProjectPath(selectPath || global.projectPath);
    if (!projectResult.success) {
      return projectResult;
    }

    global.projectPath = projectResult.path;
    const workingPath = projectResult.path;
    sendLog(`后端项目路径：${workingPath}`, "info");

    const existingVenv = getProjectVenvInfo(workingPath);
    if (existingVenv.exists) {
      if (!existingVenv.valid) {
        const manualGuide = buildManualVenvGuide(workingPath);
        return {
          success: false,
          code: "INVALID_PROJECT_VENV",
          error:
            "后端项目中存在虚拟环境目录，但不是有效虚拟环境，请手动处理。",
          manualGuide,
          venvPath: existingVenv.venvPath,
          venvName: existingVenv.venvName,
        };
      }

      const versionResult = await getPythonVersionFromCommand(
        quoteArg(existingVenv.pythonPath)
      );
      return {
        success: true,
        path: workingPath,
        pythonVersion: versionResult.success ? versionResult.version.text : "",
        pythonSource: "项目虚拟环境",
        venvPath: existingVenv.venvPath,
        venvName: existingVenv.venvName,
        pythonPath: existingVenv.pythonPath,
      };
    }

    const systemPython = await detectSystemPython();
    if (systemPython.success) {
      if (!isSystemPythonVersionSupported(systemPython.version)) {
        const manualGuide = buildManualVenvGuide(workingPath);
        return {
          success: false,
          code: "SYSTEM_PYTHON_UNSUPPORTED",
          error: `检测到系统 Python 版本 ${systemPython.version.text}。支持范围为 3.10.x 到 3.12.x，请手动在后端项目中创建 Python ${TARGET_PYTHON_VERSION} 的 .venv。`,
          manualGuide,
          detectedPythonVersion: systemPython.version.text,
        };
      }

      const venvInfo = await createProjectVenvWithPython(
        workingPath,
        systemPython.command,
        sendLog
      );
      const versionResult = await getPythonVersionFromCommand(
        quoteArg(venvInfo.pythonPath)
      );
      return {
        success: true,
        path: workingPath,
        pythonVersion: versionResult.success ? versionResult.version.text : "",
        pythonSource: "系统 Python 创建的虚拟环境",
        venvPath: venvInfo.venvPath,
        venvName: venvInfo.venvName,
        pythonPath: venvInfo.pythonPath,
      };
    }

    const condaResult = await detectConda();
    if (condaResult.success) {
      const venvInfo = await bootstrapProjectVenvWithConda(workingPath, sendLog);
      const versionResult = await getPythonVersionFromCommand(
        quoteArg(venvInfo.pythonPath)
      );
      return {
        success: true,
        path: workingPath,
        pythonVersion: versionResult.success ? versionResult.version.text : "",
        pythonSource: "conda 引导创建的虚拟环境",
        venvPath: venvInfo.venvPath,
        venvName: venvInfo.venvName,
        pythonPath: venvInfo.pythonPath,
      };
    }

    sendLog(
      `未检测到系统 Python 和 conda，正在尝试安装 Python ${TARGET_PYTHON_VERSION}...`,
      "warning"
    );
    const installResult = await installPython3115(sendLog);
    if (installResult.success) {
      const detectedAfterInstall = await detectSystemPython();
      if (
        detectedAfterInstall.success &&
        isSystemPythonVersionSupported(detectedAfterInstall.version)
      ) {
        const venvInfo = await createProjectVenvWithPython(
          workingPath,
          detectedAfterInstall.command,
          sendLog
        );
        const versionResult = await getPythonVersionFromCommand(
          quoteArg(venvInfo.pythonPath)
        );
        return {
          success: true,
          path: workingPath,
          pythonVersion: versionResult.success ? versionResult.version.text : "",
          pythonSource: "安装 Python 后创建的虚拟环境",
          venvPath: venvInfo.venvPath,
          venvName: venvInfo.venvName,
          pythonPath: venvInfo.pythonPath,
        };
      }
    }

    const manualGuide = buildManualVenvGuide(workingPath);
    return {
      success: false,
      code: "PYTHON_AUTO_SETUP_FAILED",
      error: `自动准备 Python 环境失败。请手动安装 Python ${TARGET_PYTHON_VERSION}，并在后端项目中创建 .venv。`,
      manualGuide,
    };
  } catch (error) {
    return {
      success: false,
      code: "PREPARE_PROJECT_PYTHON_FAILED",
      error: error.message,
    };
  }
});

// IPC set project path
ipcMain.handle("set-project-path", async (event, selectPath) => {
  try {
    if (fs.existsSync(selectPath)) {
      global.projectPath = selectPath;
      return { success: true };
    }
    return {
      success: false,
      error: "后端项目路径不存在。",
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});
ipcMain.handle("check-venv", async () => {
  try {
    if (!global.projectPath) {
      return { success: false, error: "后端项目路径未设置。" };
    }

    const venvInfo = getProjectVenvInfo(global.projectPath);
    return {
      success: venvInfo.exists && venvInfo.valid,
      exists: venvInfo.exists,
      valid: venvInfo.valid,
      venvPath: venvInfo.venvPath,
      venvName: venvInfo.venvName,
      error: venvInfo.valid ? undefined : venvInfo.error,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

// IPC 婢跺嫮鎮婄粙瀣碍 - 濡偓閺屻儰绶风挧?
ipcMain.handle("check-dependencies", async () => {
  try {
    if (!global.projectPath) {
      return { success: false, error: "后端项目路径未设置。" };
    }

    const venvInfo = getProjectVenvInfo(global.projectPath);
    if (!venvInfo.exists || !venvInfo.valid) {
      return { success: false };
    }

    try {
      await execCommand(
        `${quoteArg(venvInfo.pythonPath)} -c "import fastapi,uvicorn,numpy,PIL"`,
        {
          cwd: global.projectPath,
          timeout: 30000,
        }
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

// IPC 婢跺嫮鎮婄粙瀣碍 - 鐎瑰顥?Python
async function installPython3115(sendLog) {
  try {
    const pythonUrls = {
      win32: "https://www.python.org/ftp/python/3.11.5/python-3.11.5-amd64.exe",
      darwin:
        "https://www.python.org/ftp/python/3.11.5/python-3.11.5-macos11.pkg",
      linux: "https://www.python.org/ftp/python/3.11.5/Python-3.11.5.tgz",
    };
    const platform = os.platform();
    const downloadUrl = pythonUrls[platform];
    if (!downloadUrl) {
      return {
        success: false,
        error: `当前操作系统暂不支持自动安装，请手动安装 Python ${TARGET_PYTHON_VERSION}。`,
      };
    }

    const downloadDir = path.join(os.tmpdir(), "python-installer");
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
    const fileName = path.basename(downloadUrl);
    const filePath = path.join(downloadDir, fileName);

    sendLog?.(`正在下载 Python 安装包: ${downloadUrl}`, "info");
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      https
        .get(downloadUrl, (response) => {
          response.pipe(file);
          file.on("finish", () => {
            file.close();
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("python-install-path", filePath);
            }
            resolve();
          });
        })
        .on("error", (err) => {
          fs.unlink(filePath, () => {});
          reject(err);
        });
    });

    sendLog?.("Python 安装包下载完成，正在执行安装...", "info");
    if (platform === "win32") {
      await execCommand(
        `${quoteArg(filePath)} /quiet InstallAllUsers=1 PrependPath=1 Include_test=0`,
        { timeout: 600000 }
      );
    } else if (platform === "darwin") {
      await execCommand(`sudo installer -pkg ${quoteArg(filePath)} -target /`, {
        timeout: 600000,
      });
    } else {
      return {
        success: false,
        error: `Linux 暂不支持自动安装，请手动安装 Python ${TARGET_PYTHON_VERSION}。`,
      };
    }

    fs.unlink(filePath, () => {});
    return {
      success: true,
      message: `Python ${TARGET_PYTHON_VERSION} 安装完成。`,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
}

ipcMain.handle("install-python", async () => {
  return installPython3115();
});

// IPC create venv
ipcMain.handle("create-venv", async (event, projectPath) => {
  const sendLog = (message, type = "info") => {
    event.sender.send("backend-output", { message, type });
  };

  try {
    const projectResult = validateProjectPath(projectPath || global.projectPath);
    if (!projectResult.success) {
      return projectResult;
    }

    global.projectPath = projectResult.path;
    const workingPath = projectResult.path;
    const venvInfo = getProjectVenvInfo(workingPath);
    if (venvInfo.exists) {
      if (!venvInfo.valid) {
        return {
          success: false,
          code: "INVALID_PROJECT_VENV",
          error:
            "后端项目中存在虚拟环境目录，但不是有效虚拟环境，请手动处理。",
          manualGuide: buildManualVenvGuide(workingPath),
        };
      }
      return {
        success: true,
        message: "项目虚拟环境已存在。",
      };
    }

    const systemPython = await detectSystemPython();
    if (!systemPython.success) {
      return {
        success: false,
        code: "SYSTEM_PYTHON_NOT_FOUND",
        error: "未检测到系统 Python。",
      };
    }

    if (!isSystemPythonVersionSupported(systemPython.version)) {
      return {
        success: false,
        code: "SYSTEM_PYTHON_UNSUPPORTED",
        error: `检测到系统 Python 版本 ${systemPython.version.text}，请手动创建 Python ${TARGET_PYTHON_VERSION} 的 .venv。`,
        manualGuide: buildManualVenvGuide(workingPath),
      };
    }

    await createProjectVenvWithPython(workingPath, systemPython.command, sendLog);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

// IPC create conda venv
ipcMain.handle("create-conda-venv", async (event) => {
  const sendLog = (message, type = "info") => {
    event.sender.send("backend-output", { message, type });
  };

  try {
    const systemEnv = { ...process.env };
    sendLog("正在创建 conda 虚拟环境...", "info");

    // 检查 moonshine-image 环境是否已存在
    const { stdout: envListStdout } = await execAsync("conda env list", {
      env: systemEnv,
      shell: true,
      timeout: 10000,
    });

    if (!envListStdout.includes("moonshine-image")) {
      sendLog("创建 moonshine-image conda 环境...", "info");
      await execAsync("conda create -n moonshine-image python=3.11.5 -y", {
        env: systemEnv,
        shell: true,
        timeout: 300000,
      });
      sendLog("✓ moonshine-image 环境创建成功", "success");
    } else {
      sendLog("✓ moonshine-image 环境已存在", "success");
    }

    return { success: true };
  } catch (error) {
    sendLog(`conda 虚拟环境创建失败: ${error.message}`, "error");
    return { success: false, error: error.message };
  }
});
// IPC 处理程序 - 安装依赖
ipcMain.handle("install-dependencies", async (event, projectPath) => {
  try {
    // 如果没有传入路径参数，使用全局变量
    const workingPath = projectPath || global.projectPath;

    if (!workingPath) {
      return { success: false, error: "项目路径未设置" };
    }

    const venvInfo = getProjectVenvInfo(workingPath);
    if (!venvInfo.exists || !venvInfo.valid) {
      return {
        success: false,
        error: "项目虚拟环境缺失或无效，请先创建或修复 .venv。",
      };
    }

    const venvPython = venvInfo.pythonPath;
    // const pipCommand = `"${venvPython}" -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple`;

    // 发送开始消息
    mainWindow.webContents.send("backend-output", {
      type: "info",
      message: "开始安装依赖包...",
    });

    // 使用 spawn 而不是 execAsync 来获取实时输出
    const installProcess = spawn(
      venvPython,
      [
        "-m",
        "pip",
        "install",
        "-r",
        "requirements.txt",
        "-i",
        "https://pypi.tuna.tsinghua.edu.cn/simple",
      ],
      {
        cwd: workingPath,
        stdio: "pipe",
      }
    );

    // 监听输出
    installProcess.stdout.on("data", (data) => {
      mainWindow.webContents.send("backend-output", {
        type: "info",
        message: data.toString(),
      });
    });

    installProcess.stderr.on("data", (data) => {
      mainWindow.webContents.send("backend-output", {
        type: "warning",
        message: data.toString(),
      });
    });

    return new Promise((resolve) => {
      installProcess.on("close", (code) => {
        if (code === 0) {
          mainWindow.webContents.send("backend-output", {
            type: "success",
            message: "依赖安装成功",
          });
          resolve({ success: true, message: "依赖安装成功" });
        } else {
          mainWindow.webContents.send("backend-output", {
            type: "error",
            message: `依赖安装失败，退出码: ${code}`,
          });
          resolve({ success: false, error: `安装失败，退出码: ${code}` });
        }
      });
    });
  } catch (error) {
    mainWindow.webContents.send("backend-output", {
      type: "error",
      message: `依赖安装失败: ${error.message}`,
    });
    return {
      success: false,
      error: error.message,
      stderr: error.stderr,
    };
  }
});
// IPC 处理程序 - 安装 conda 依赖
ipcMain.handle("install-conda-dependencies", async (event) => {
  const sendLog = (message, type = "info") => {
    event.sender.send("backend-output", { message, type });
  };

  try {
    if (!global.projectPath) {
      return { success: false, error: "项目路径未设置" };
    }

    const systemEnv = { ...process.env };
    sendLog("开始安装 conda 环境依赖...", "info");

    // 激活环境并安装依赖
    const activateAndInstallCmd =
      os.platform() === "win32"
        ? `conda activate moonshine-image && pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple`
        : `source activate moonshine-image && pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple`;

    const installProcess = spawn("cmd", ["/c", activateAndInstallCmd], {
      cwd: global.projectPath,
      stdio: "pipe",
      env: systemEnv,
      shell: true,
    });

    // 监听输出
    installProcess.stdout.on("data", (data) => {
      sendLog(data.toString(), "info");
    });

    installProcess.stderr.on("data", (data) => {
      sendLog(data.toString(), "warning");
    });

    return new Promise((resolve) => {
      installProcess.on("close", (code) => {
        if (code === 0) {
          sendLog("conda 环境依赖安装成功", "success");
          resolve({ success: true });
        } else {
          sendLog(`conda 环境依赖安装失败，退出码: ${code}`, "error");
          resolve({ success: false, error: `安装失败，退出码: ${code}` });
        }
      });
    });
  } catch (error) {
    sendLog(`conda 环境依赖安装失败: ${error.message}`, "error");
    return { success: false, error: error.message };
  }
});
// IPC 处理程序 - 启动后端服务
ipcMain.handle("start-backend-service", async (event, config) => {
  try {
    if (backendProcess) {
      return {
        success: false,
        error: "服务已在运行中",
      };
    }

    if (!global.projectPath) {
      return { success: false, error: "项目路径未设置" };
    }

    const venvInfo = getProjectVenvInfo(global.projectPath);
    if (!venvInfo.exists || !venvInfo.valid) {
      return {
        success: false,
        error: "项目虚拟环境缺失或无效，请先创建或修复 .venv。",
      };
    }

    const venvPython = venvInfo.pythonPath;
    const args = [
      "main.py",
      "start",
      `--model=${config.model}`,
      `--device=${config.device}`,
      `--port=${config.port}`,
    ];

    if (config.modelDir) {
      args.push(`--model-dir=${config.modelDir}`);
    }
    backendProcess = spawn(venvPython, args, {
      cwd: global.projectPath,
      stdio: "pipe",
    });

    backendProcess.stdout.on("data", (data) => {
      mainWindow.webContents.send("backend-output", {
        type: "info",
        message: data.toString(),
      });
    });

    backendProcess.stderr.on("data", (data) => {
      mainWindow.webContents.send("backend-output", {
        type: "info",
        message: data.toString(),
      });
    });

    backendProcess.on("close", (code, signal) => {
      const exitInfo = signal
        ? `信号: ${signal}`
        : `退出码: ${code !== null ? code : "正常退出"}`;
      backendProcess = null;
      mainWindow.webContents.send("backend-output", {
        type: "info",
        message: `服务已停止，${exitInfo}`,
      });
    });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

// IPC 处理程序 - 停止后端服务
ipcMain.handle("stop-backend-service", async () => {
  try {
    if (!backendProcess) {
      return {
        success: false,
        error: "服务未运行",
      };
    }

    return new Promise((resolve) => {
      // 监听进程退出事件
      backendProcess.on("exit", (code, signal) => {
        const exitInfo = signal
          ? `信号: ${signal}`
          : `退出码: ${code !== null ? code : "正常退出"}`;
        mainWindow.webContents.send("backend-output", {
          type: "info",
          message: `服务已停止，${exitInfo}`,
        });
        backendProcess = null;
        resolve({ success: true });
      });

      // 发送终止信号
      backendProcess.kill("SIGTERM");

      // 设置超时，如果进程没有正常退出则强制杀死
      setTimeout(() => {
        if (backendProcess) {
          backendProcess.kill("SIGKILL");
          mainWindow.webContents.send("backend-output", {
            type: "warning",
            message: "服务进程被强制终止",
          });
          backendProcess = null;
          resolve({ success: true });
        }
      }, 5000);
    });
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});
// IPC 处理程序 - 检查后端服务状态
ipcMain.handle("check-backend-status", async () => {
  try {
    return {
      success: true,
      running: backendProcess !== null,
      pid: backendProcess ? backendProcess.pid : null,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});
// IPC 处理程序 - 执行命令
ipcMain.handle("execute-command", async (event, { command, cwd }) => {
  try {
    // 获取系统环境变量
    const systemEnv = { ...process.env };

    const { stdout, stderr } = await execAsync(command, {
      cwd: cwd || global.projectPath,
      env: systemEnv,
      shell: true,
      timeout: 30000, // 30秒超时
    });

    return {
      success: true,
      output: stdout || stderr,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

// IPC 处理程序 - 获取文件统计信息
ipcMain.handle("get-file-stats", async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: `文件不存在: ${filePath}` };
    }

    const stats = fs.statSync(filePath);
    return {
      success: true,
      data: {
        size: stats.size,
        name: path.basename(filePath),
        lastModified: stats.mtime.getTime(),
        type: getMimeType(filePath),
      },
    };
  } catch (error) {
    console.error("获取文件统计信息失败:", error);
    return { success: false, error: error.message };
  }
});

// IPC 处理程序 - 带进度的文件读取
ipcMain.handle("read-file-with-progress", async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: `文件不存在: ${filePath}` };
    }

    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const chunkSize = Math.max(1024 * 64, Math.floor(fileSize / 100)); // 至少64KB，最多100个进度更新

    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath, {
        highWaterMark: chunkSize,
      });
      const chunks = [];
      let bytesRead = 0;

      stream.on("data", (chunk) => {
        chunks.push(chunk);
        bytesRead += chunk.length;

        // 发送进度更新
        const progress = Math.round((bytesRead / fileSize) * 100);
        event.sender.send("file-read-progress", {
          filePath,
          bytesRead,
          totalSize: fileSize,
          progress,
        });
      });

      stream.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          success: true,
          data: {
            name: path.basename(filePath),
            size: fileSize,
            type: getMimeType(filePath),
            lastModified: stats.mtime.getTime(),
            buffer: Array.from(buffer),
            path: filePath,
          },
        });
      });

      stream.on("error", (error) => {
        console.error("文件读取失败:", error);
        reject({ success: false, error: error.message });
      });
    });
  } catch (error) {
    console.error("文件读取失败:", error);
    return { success: false, error: error.message };
  }
});
// 保存临时视频文件
ipcMain.handle("save-temp-video", async (event, { fileName, buffer }) => {
  try {
    const tempDir = path.join(app.getPath("temp"), "moonshine-videos");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempPath = path.join(tempDir, `${Date.now()}_${fileName}`);
    fs.writeFileSync(tempPath, Buffer.from(buffer));

    return tempPath;
  } catch (error) {
    console.error("保存临时视频文件失败:", error);
    throw error;
  }
});

// 清理临时文件
ipcMain.handle("cleanup-temp-file", async (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error("清理临时文件失败:", error);
  }
});
// 清理临时文件
ipcMain.handle("cleanup-temp-files", async (event, tempDir) => {
  try {
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        const filePath = path.join(tempDir, file);
        fs.unlinkSync(filePath);
      }
      fs.rmdirSync(tempDir);
    }
  } catch (error) {
    console.error("清理临时文件失败:", error);
  }
});
// 获取文件MIME类型的辅助函数
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".avi": "video/avi",
    ".mov": "video/quicktime",
    ".wmv": "video/x-ms-wmv",
    ".flv": "video/x-flv",
    ".mkv": "video/x-matroska",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

// needed in case process is undefined under Linux
const platform = process.platform || os.platform();
const currentDir = fileURLToPath(new URL(".", import.meta.url));

let mainWindow;

async function createWindow() {
  /**
   * Initial window options
   */
  mainWindow = new BrowserWindow({
    icon: path.resolve(currentDir, "icons/icon.png"), // tray icon
    width: 1080,
    height: 720,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      // More info: https://v2.quasar.dev/quasar-cli-vite/developing-electron-apps/electron-preload-script
      preload: path.resolve(
        currentDir,
        path.join(
          process.env.QUASAR_ELECTRON_PRELOAD_FOLDER,
          "electron-preload" + process.env.QUASAR_ELECTRON_PRELOAD_EXTENSION
        )
      ),
    },
  });
  // 根据环境设置菜单
  if (process.env.DEV) {
    // 开发环境：保留默认菜单
    const template = [
      {
        label: "文件",
        submenu: [
          {
            label: "重新加载",
            accelerator: "CmdOrCtrl+R",
            click: () => mainWindow.reload(),
          },
          {
            label: "强制重新加载",
            accelerator: "CmdOrCtrl+Shift+R",
            click: () => mainWindow.webContents.reloadIgnoringCache(),
          },
          {
            label: "开发者工具",
            accelerator: "F12",
            click: () => mainWindow.webContents.toggleDevTools(),
          },
          { type: "separator" },
          {
            label: "退出",
            accelerator: process.platform === "darwin" ? "Cmd+Q" : "Ctrl+Q",
            click: () => app.quit(),
          },
        ],
      },
      {
        label: "配置",
        submenu: [
          {
            label: "重置配置",
            click: () => {
              createDefaultConfig();
              mainWindow.webContents.send("config-reset");
            },
          },
          {
            label: "清除状态",
            click: async () => {
              clearAppStateFile();
              mainWindow.webContents.send("state-cleared");
            },
          },
        ],
      },
    ];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  } else {
    // 生产环境：去除菜单栏
    Menu.setApplicationMenu(null);
  }

  // 设置应用名称
  app.setName("Moonshine-Image");

  // Set Content Security Policy
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self' data:; " +
            "script-src 'self' 'unsafe-inline'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "worker-src 'self' blob:; " +
            "img-src 'self' data: blob: atom:; " +
            "media-src 'self' data: blob: atom:; " +
            "font-src 'self'; " +
            "connect-src 'self' http://localhost:* http://127.0.0.1:* data:; " +
            "object-src 'none';",
        ],
      },
    });
  });
  if (process.env.DEV) {
    await mainWindow.loadURL(process.env.APP_URL);
  } else {
    await mainWindow.loadFile("index.html");
  }

  if (process.env.DEBUGGING) {
    // if on DEV or Production with debug enabled
    mainWindow.webContents.openDevTools();
  } else {
    // we're on production; no access to devtools pls
    mainWindow.webContents.on("devtools-opened", () => {
      mainWindow.webContents.closeDevTools();
    });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // 注册atom协议用于本地文件访问
  protocol.registerFileProtocol("atom", (request, callback) => {
    try {
      let url = request.url.substr(7); // 移除 'atom://' 前缀

      // URL解码处理中文字符
      url = decodeURIComponent(url);

      // 修复Windows路径格式：添加冒号
      if (
        process.platform === "win32" &&
        url.match(/^[A-Za-z]\//) &&
        !url.includes(":")
      ) {
        url = url.charAt(0) + ":" + url.slice(1);
      }

      const filePath = path.normalize(url);

      console.log("尝试访问文件:", filePath);

      // 安全检查：确保文件存在
      if (fs.existsSync(filePath)) {
        callback({ path: filePath });
      } else {
        console.error("文件不存在:", filePath);
        callback({ error: -6 }); // FILE_NOT_FOUND
      }
    } catch (error) {
      console.error("协议处理错误:", error);
      callback({ error: -2 }); // GENERIC_FAILURE
    }
  });
  loadAppConfig();
  createWindow();
});
app.on("before-quit", async (event) => {
  if (backendProcess && !backendProcess.killed) {
    event.preventDefault(); // 阻止立即退出
    try {
      // 检查进程是否仍然存在
      if (backendProcess.pid) {
        // 发送终止信号
        if (process.platform === "win32") {
          // Windows 使用 taskkill
          spawn("taskkill", ["/pid", backendProcess.pid, "/f", "/t"]);
        } else {
          // Unix-like 系统使用 SIGTERM
          backendProcess.kill("SIGTERM");
        }

        // 等待进程退出，最多等待5秒
        const exitPromise = new Promise((resolve) => {
          if (backendProcess) {
            backendProcess.on("exit", () => {
              console.log("后端进程已退出");
              resolve();
            });
            backendProcess.on("error", (error) => {
              console.log("后端进程退出时出错:", error.message);
              resolve();
            });
          } else {
            resolve();
          }
        });

        const timeoutPromise = new Promise((resolve) => {
          setTimeout(() => {
            console.log("等待后端进程退出超时");
            resolve();
          }, 5000);
        });

        await Promise.race([exitPromise, timeoutPromise]);

        // 如果进程仍在运行，强制终止
        if (backendProcess && !backendProcess.killed && backendProcess.pid) {
          console.log("强制终止后端进程");
          if (process.platform === "win32") {
            spawn("taskkill", ["/pid", backendProcess.pid, "/f", "/t"]);
          } else {
            backendProcess.kill("SIGKILL");
          }
        }
      }

      backendProcess = null;
    } catch (error) {
      console.error("关闭后端服务时出错:", error);
      // 即使出错也要清理进程引用
      backendProcess = null;
    }

    app.quit();
  }
});

app.on("window-all-closed", () => {
  // 确保后端进程被清理
  if (backendProcess && !backendProcess.killed) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", backendProcess.pid, "/f", "/t"]);
      } else {
        backendProcess.kill("SIGKILL");
      }
    } catch (error) {
      console.error("清理后端进程时出错:", error);
    }
    backendProcess = null;
  }

  if (platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});
