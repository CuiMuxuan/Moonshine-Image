import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  session,
  Menu,
  shell,
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
let projectPath = "";
// 默认配置
const DEFAULT_CONFIG = {
  general: {
    backendPort: 8080,
    launchMode: "cuda", // 'cuda' | 'cpu'
    modelPath: "",
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
  },
};

// 全局配置对象
let globalConfig = { ...DEFAULT_CONFIG };

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

// IPC 处理程序 - 清除状态
ipcMain.handle("clear-app-state", async () => {
  try {
    const statePath = path.join(app.getPath("userData"), "app-state.json");

    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }

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
ipcMain.handle("save-file", async (event, { filePath, blob }) => {
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
});
// 添加别名处理程序，以提高兼容性
ipcMain.handle("saveFile", async (event, { filePath, blob }) => {
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
});
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
  const sendLog = (message, type = 'info') => {
    event.sender.send('backend-output', { message, type });
  };

  try {
    // 获取系统环境变量
    const systemEnv = { ...process.env };
    sendLog('正在检测 Python 环境...', 'info');

    // Windows 系统特殊处理
    if (os.platform() === 'win32') {
      // 尝试多种 Python 命令
      const pythonCommands = ['python', 'py', 'python3'];
      sendLog(`尝试检测 Python 命令: ${pythonCommands.join(', ')}`, 'info');

      for (const cmd of pythonCommands) {
        try {
          sendLog(`正在尝试命令: ${cmd} --version`, 'info');
          const { stdout } = await execAsync(`${cmd} --version`, {
            env: systemEnv,
            shell: true,
            timeout: 10000
          });
          if (stdout) {
            sendLog(`✓ 命令 ${cmd} 执行成功: ${stdout.trim()}`, 'success');
            return {
              success: true,
              version: stdout.trim(),
              type: 'python',
              command: cmd
            };
          }
        } catch (cmdError) {
          sendLog(`✗ 命令 ${cmd} 失败: ${cmdError.message}`, 'warning');
          continue;
        }
      }

      // 尝试从常见安装路径查找 Python
      const commonPaths = [
        'C:\\Python311\\python.exe',
        'C:\\Python310\\python.exe',
        'C:\\Python39\\python.exe',
        'C:\\Users\\' + os.userInfo().username + '\\AppData\\Local\\Programs\\Python\\Python311\\python.exe',
        'C:\\Users\\' + os.userInfo().username + '\\AppData\\Local\\Programs\\Python\\Python310\\python.exe'
      ];

      sendLog('尝试从常见安装路径查找 Python...', 'info');
      for (const pythonPath of commonPaths) {
        try {
          sendLog(`检查路径: ${pythonPath}`, 'info');
          if (fs.existsSync(pythonPath)) {
            sendLog(`✓ 找到 Python 可执行文件: ${pythonPath}`, 'success');
            const { stdout } = await execAsync(`"${pythonPath}" --version`, {
              env: systemEnv,
              shell: true,
              timeout: 10000
            });
            if (stdout) {
              sendLog(`✓ Python 版本检测成功: ${stdout.trim()}`, 'success');
              return {
                success: true,
                version: stdout.trim(),
                type: 'python',
                path: pythonPath
              };
            }
          } else {
            sendLog(`✗ 路径不存在: ${pythonPath}`, 'warning');
          }
        } catch (pathError) {
          sendLog(`✗ 路径检测失败 ${pythonPath}: ${pathError.message}`, 'warning');
          continue;
        }
      }
    } else {
      // Unix-like 系统
      sendLog('检测 Unix-like 系统的 Python 环境...', 'info');
      try {
        sendLog('尝试命令: python --version', 'info');
        const { stdout: pythonStdout } = await execAsync("python --version", {
          env: systemEnv,
          shell: true,
          timeout: 10000
        });
        if (pythonStdout) {
          sendLog(`✓ python 命令成功: ${pythonStdout.trim()}`, 'success');
          return {
            success: true,
            version: pythonStdout.trim(),
            type: 'python'
          };
        }
      } catch (pythonError) {
        sendLog(`✗ python 命令失败: ${pythonError.message}`, 'warning');
        try {
          sendLog('尝试命令: python3 --version', 'info');
          const { stdout: python3Stdout } = await execAsync("python3 --version", {
            env: systemEnv,
            shell: true,
            timeout: 10000
          });
          if (python3Stdout) {
            sendLog(`✓ python3 命令成功: ${python3Stdout.trim()}`, 'success');
            return {
              success: true,
              version: python3Stdout.trim(),
              type: 'python'
            };
          }
        } catch (python3Error) {
          sendLog(`✗ python3 命令失败: ${python3Error.message}`, 'warning');
          // 继续尝试 conda
        }
      }
    }

    // 尝试检测 conda
    sendLog('尝试检测 conda 环境...', 'info');
    try {
      const { stdout: condaStdout } = await execAsync("conda -V", {
        env: systemEnv,
        shell: true,
        timeout: 10000
      });
      if (condaStdout) {
        sendLog(`✓ 找到 conda: ${condaStdout.trim()}`, 'success');
        try {
          // 检查 moonshine-image 环境是否存在
          sendLog('检查 moonshine-image 环境...', 'info');
          const { stdout: envCheckStdout } = await execAsync("conda env list", {
            env: systemEnv,
            shell: true,
            timeout: 10000
          });

          if (!envCheckStdout.includes('moonshine-image')) {
            // 创建 moonshine-image 环境
            sendLog('创建 moonshine-image conda 环境...', 'info');
            await execAsync("conda create -n moonshine-image python=3.11.5 -y", {
              env: systemEnv,
              shell: true,
              timeout: 300000
            });
            sendLog('✓ moonshine-image 环境创建成功', 'success');
          } else {
            sendLog('✓ moonshine-image 环境已存在', 'success');
          }

          // 激活环境并检查 Python 版本
          sendLog('激活 moonshine-image 环境并检查 Python 版本...', 'info');
          const activateCmd = os.platform() === 'win32'
            ? "conda activate moonshine-image && python --version"
            : "source activate moonshine-image && python --version";

          const { stdout: envPythonStdout } = await execAsync(activateCmd, {
            env: systemEnv,
            shell: true,
            timeout: 30000
          });

          sendLog(`✓ conda 环境 Python 版本: ${envPythonStdout.trim()}`, 'success');
          return {
            success: true,
            version: envPythonStdout.trim(),
            type: 'conda'
          };
        } catch (envError) {
          sendLog(`✗ conda 环境操作失败: ${envError.message}`, 'error');
          return {
            success: false,
            error: `找到 conda (${condaStdout.trim()})，但创建或激活环境失败: ${envError.message}`
          };
        }
      }
    } catch (condaError) {
      sendLog(`✗ conda 检测失败: ${condaError.message}`, 'warning');
      sendLog('未检测到可用的 Python 环境', 'error');
      return {
        success: false,
        error: `未检测到可用的 Python 环境。请确保 Python 已正确安装并添加到系统 PATH 中。详细错误: ${condaError.message}`
      };
    }
  } catch (error) {
    sendLog(`Python 环境检测过程中发生错误: ${error.message}`, 'error');
    return {
      success: false,
      error: `Python 环境检测失败: ${error.message}`
    };
  }
});

// IPC 处理程序 - 设置 Python 环境变量
ipcMain.handle('set-python-env', async (event, pythonPath) => {
  try {
    const currentEnv = process.env.PATH || '';
    // 检查路径是否已存在于 PATH 中
    if (!currentEnv.includes(pythonPath)) {
      // Windows 系统下添加路径到环境变量
      process.env.PATH = `${pythonPath};${currentEnv}`;
    }
    return { success: true, message: 'Python 环境变量设置成功' };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// IPC 处理程序 - 检查 conda 虚拟环境
ipcMain.handle('check-conda-venv', async () => {
  try {
    // 获取系统环境变量
    const systemEnv = { ...process.env };

    // 检查 moonshine-image 环境是否存在
    const { stdout } = await execAsync('conda env list', {
      env: systemEnv,
      shell: true,
      timeout: 10000
    });

    const envExists = stdout.includes('moonshine-image');
    return {
      success: envExists,
      message: envExists ? 'conda 虚拟环境已存在' : 'conda 虚拟环境不存在'
    };
  } catch (error) {
    return { success: false, error: `检查 conda 虚拟环境失败: ${error.message}` };
  }
});

// IPC 处理程序 - 检查 conda 依赖
ipcMain.handle('check-conda-dependencies', async () => {
  try {
    // 获取系统环境变量
    const systemEnv = { ...process.env };

    // 激活 moonshine-image 环境并检查依赖
    const activateCmd = os.platform() === 'win32'
      ? 'conda activate moonshine-image && conda list'
      : 'source activate moonshine-image && conda list';

    const { stdout } = await execAsync(activateCmd, {
      env: systemEnv,
      shell: true,
      timeout: 30000
    });

    // 简单判断依赖是否已安装，可根据实际需求修改判断逻辑
    return { success: stdout.split('\n').length > 10, message: stdout };
  } catch (error) {
    return { success: false, error: `检查 conda 依赖失败: ${error.message}` };
  }
});
// IPC 处理程序 - 检查项目
ipcMain.handle("check-project", async (event, selectPath) => {
  try {
    let checkPath = selectPath;
    // 设置全局项目路径
    projectPath = checkPath;

    // 如果没有提供路径，使用默认逻辑
    if (!checkPath) {
      // 检查同级目录下的 IOPaint 文件夹
      const appDir = path.dirname(app.getAppPath());
      const iopaintPath = path.join(appDir, "IOPaint");
      console.log(iopaintPath);
      if (fs.existsSync(iopaintPath)) {
        checkPath = iopaintPath;
      } else {
        return {
          success: false,
          error: "未找到 IOPaint 项目",
        };
      }
    }

    // 检查路径是否存在
    if (!fs.existsSync(checkPath)) {
      return {
        success: false,
        error: "项目路径不存在",
      };
    }

    // 检查必要文件
    const requiredFiles = ["requirements.txt", "main.py"];

    const requiredDirs = ["iopaint"];

    const missingFiles = [];
    const missingDirs = [];

    // 检查文件
    for (const file of requiredFiles) {
      const filePath = path.join(checkPath, file);
      if (!fs.existsSync(filePath)) {
        missingFiles.push(file);
      }
    }

    // 检查目录
    for (const dir of requiredDirs) {
      const dirPath = path.join(checkPath, dir);
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        missingDirs.push(dir);
      }
    }

    if (missingFiles.length > 0 || missingDirs.length > 0) {
      let errorMsg = "项目结构不完整：";
      if (missingFiles.length > 0) {
        errorMsg += `\n缺少文件: ${missingFiles.join(", ")}`;
      }
      if (missingDirs.length > 0) {
        errorMsg += `\n缺少目录: ${missingDirs.join(", ")}`;
      }

      return {
        success: false,
        error: errorMsg,
        missingFiles,
        missingDirs,
      };
    }

    // 设置全局项目路径
    projectPath = checkPath;

    return {
      success: true,
      path: checkPath,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

// IPC 处理程序 - 设置项目路径
ipcMain.handle("set-project-path", async (event, selectPath) => {
  try {
    if (fs.existsSync(selectPath)) {
      projectPath = selectPath;
      return { success: true };
    }
    return {
      success: false,
      error: "路径不存在",
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

// IPC 处理程序 - 检查虚拟环境
ipcMain.handle("check-venv", async () => {
  try {
    if (!projectPath) {
      return { success: false, error: "项目路径未设置" };
    }

    const venvPath = path.join(projectPath, "venv");
    return {
      success: fs.existsSync(venvPath),
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

// IPC 处理程序 - 检查依赖
ipcMain.handle("check-dependencies", async () => {
  try {
    if (!projectPath) {
      return { success: false, error: "项目路径未设置" };
    }

    const venvPath = path.join(projectPath, "venv");
    const sitePackagesPath = os.platform() === 'win32'
      ? path.join(venvPath, "Lib", "site-packages")
      : path.join(venvPath, "lib", "python3.11", "site-packages");

    if (fs.existsSync(sitePackagesPath)) {
      const packages = fs.readdirSync(sitePackagesPath);
      return {
        success: packages.length > 200, // 简单判断依赖是否已安装
      };
    }

    return { success: false };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

// IPC 处理程序 - 安装 Python
ipcMain.handle("install-python", async () => {
  try {
    // Python 3.11.5 下载链接
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
        error: "不支持的操作系统，请手动安装 Python 3.11.5",
      };
    }
    // 创建下载目录
    const downloadDir = path.join(os.tmpdir(), "python-installer");
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }

    const fileName = path.basename(downloadUrl);
    const filePath = path.join(downloadDir, fileName);

    // 下载Python安装包
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      https
        .get(downloadUrl, (response) => {
          response.pipe(file);
          file.on("finish", () => {
            file.close();
            // 发送下载路径到前端
            mainWindow.webContents.send('python-install-path', filePath);
            resolve();
          });
        })
        .on("error", (err) => {
          fs.unlink(filePath, () => {});
          reject(err);
        });
    });

    // 执行安装
    if (platform === "win32") {
      // Windows 静默安装
      await execAsync(
        `"${filePath}" /quiet InstallAllUsers=1 PrependPath=1 Include_test=0`
      );
    } else if (platform === "darwin") {
      // macOS 安装
      await execAsync(`sudo installer -pkg "${filePath}" -target /`);
    } else {
      // Linux 编译安装（简化版）
      return {
        success: false,
        error: "Linux系统请手动安装 Python 3.11.5",
      };
    }
    // 清理安装文件
    fs.unlink(filePath, () => {});
    return {
      success: true,
      message: "Python 3.11.5 安装成功",
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
});

// IPC 处理程序 - 创建虚拟环境
ipcMain.handle("create-venv", async (event, projectPath) => {
  try {
    const workingPath = projectPath || global.projectPath;
    if (!workingPath) {
      return { success: false, error: "项目路径未设置" };
    }

    // 获取系统环境变量
    const systemEnv = { ...process.env };

    // 发送开始消息
    mainWindow.webContents.send("backend-output", {
      type: "info",
      message: "开始创建虚拟环境...",
    });

    // 尝试多种 Python 命令
    const pythonCommands = os.platform() === 'win32' ? ['python', 'py', 'python3'] : ['python', 'python3'];
    let success = false;
    let lastError = null;

    for (const cmd of pythonCommands) {
      try {
        await execAsync(`${cmd} -m venv ./venv`, {
          cwd: workingPath,
          env: systemEnv,
          shell: true,
          timeout: 60000
        });
        success = true;
        break;
      } catch (error) {
        lastError = error;
        console.log(`使用 ${cmd} 创建虚拟环境失败:`, error.message);
        continue;
      }
    }

    if (!success) {
      throw lastError || new Error('所有 Python 命令都失败了');
    }

    // 发送成功消息
    mainWindow.webContents.send("backend-output", {
      type: "success",
      message: "虚拟环境创建成功",
    });
    return { success: true };
  } catch (error) {
    // 发送错误消息
    mainWindow.webContents.send("backend-output", {
      type: "error",
      message: `虚拟环境创建失败: ${error.message}`,
    });
    return {
      success: false,
      error: error.message,
    };
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

    const venvPython = os.platform() === 'win32'
      ? path.join(workingPath, "venv", "Scripts", "python.exe")
      : path.join(workingPath, "venv", "bin", "python");
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

// IPC 处理程序 - 启动后端服务
ipcMain.handle("start-backend-service", async (event, config) => {
  try {
    if (backendProcess) {
      return {
        success: false,
        error: "服务已在运行中",
      };
    }

    if (!projectPath) {
      return { success: false, error: "项目路径未设置" };
    }

    const venvPython = os.platform() === 'win32'
      ? path.join(projectPath, "venv", "Scripts", "python.exe")
      : path.join(projectPath, "venv", "bin", "python");
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
      cwd: projectPath,
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
      cwd: cwd || projectPath,
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

// 应用退出时清理后端进程
app.on("before-quit", () => {
  if (backendProcess) {
    backendProcess.kill("SIGTERM");
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
    width: 1000,
    height: 600,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
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
              await ipcMain.emit("clear-app-state");
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
    const apiPort = globalConfig.general.backendPort;
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self' data:; " +
            "script-src 'self' 'unsafe-inline'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob:; " +
            "font-src 'self'; " +
            "connect-src 'self' http://localhost:" +
            apiPort +
            " http://127.0.0.1:" +
            apiPort +
            " data:; " +
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
  loadAppConfig();
  createWindow();
});

app.on("window-all-closed", () => {
  if (platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});
