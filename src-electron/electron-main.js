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
// 注册保存文件的 IPC 处理程序
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
// 注册选择目录的 IPC 处理程序
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
// 注册保存配置的 IPC 处理程序
ipcMain.handle("save-app-config", async (event, configData) => {
  try {
    const configPath = path.join(app.getPath("userData"), "app-config.json");
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2));

    // 更新全局配置
    global.appConfig = {
      api: {
        port: configData.apiPort || 8080,
        baseURL: `http://localhost:${configData.apiPort || 8080}`,
      },
    };

    return { success: true };
  } catch (error) {
    console.error("保存配置失败:", error);
    return { success: false, error: error.message };
  }
});
// 注册获取配置的 IPC 处理程序
ipcMain.handle("get-app-config", async () => {
  try {
    return global.appConfig || {
      api: {
        port: 8080,
        baseURL: 'http://localhost:8080',
      }
    };
  } catch (error) {
    console.error("获取配置失败:", error);
    return {
      api: {
        port: 8080,
        baseURL: 'http://localhost:8080',
      }
    };
  }
});
// 注册获取资源路径的 IPC 处理程序
ipcMain.handle("get-resources-path", () => {
  try {
    // 在打包后的应用中，资源路径通常位于应用目录下的 resources 文件夹
    return path.dirname(app.getAppPath());
  } catch (error) {
    console.error("获取资源路径失败:", error);
    return './resources';
  }
});

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
  // 设置空菜单，去除默认菜单栏
  Menu.setApplicationMenu(null);
  // 设置应用名称
  app.setName("Moonshine-Image");

  // Set Content Security Policy
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const apiPort = global.appConfig?.api?.port || 8080;
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self' data:; " +
            "script-src 'self' 'unsafe-inline'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: blob:; " +
            "font-src 'self'; " +
            "connect-src 'self' http://localhost:" + apiPort + " http://127.0.0.1:" + apiPort + " data:; " +
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
function loadAppConfig() {
  try {
    // 从用户数据目录加载配置
    const configPath = path.join(app.getPath("userData"), "app-config.json");

    if (fs.existsSync(configPath)) {
      const configData = JSON.parse(fs.readFileSync(configPath, "utf8"));

      // 更新全局配置
      global.appConfig = {
        api: {
          port: configData.apiPort || 8080,
          baseURL: `http://localhost:${configData.apiPort || 8080}`,
        },
      };
    }
  } catch (error) {
    console.error("加载配置失败:", error);
  }
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
