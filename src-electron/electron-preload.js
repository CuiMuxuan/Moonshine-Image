/**
 * This file is used specifically for security reasons.
 * Here you can access Nodejs stuff and inject functionality into
 * the renderer thread (accessible there through the "window" object)
 *
 * WARNING!
 * If you import anything from node_modules, then make sure that the package is specified
 * in package.json > dependencies and NOT in devDependencies
 *
 * Example (injects window.myAPI.doAThing() into renderer thread):
 *
 *   import { contextBridge } from 'electron'
 *
 *   contextBridge.exposeInMainWorld('myAPI', {
 *     doAThing: () => {}
 *   })
 *
 * WARNING!
 * If accessing Node functionality (like importing @electron/remote) then in your
 * electron-main.js you will need to set the following when you instantiate BrowserWindow:
 *
 * mainWindow = new BrowserWindow({
 *   // ...
 *   webPreferences: {
 *     // ...
 *     sandbox: false // <-- to be able to import @electron/remote in preload script
 *   }
 * }
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");
const fs = require('fs').promises
const path = require('path')

const getByteLength = (value) => {
  if (!value) return 0;
  if (Buffer.isBuffer(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value === "string") return Buffer.byteLength(value);
  return 0;
};

// 暴露 Electron API 给渲染进程
contextBridge.exposeInMainWorld("electron", {
  ipcRenderer: {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    send: (channel, ...args) => ipcRenderer.send(channel, ...args),
    on: (channel, listener) => {
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    removeListener: (channel, listener) =>
      ipcRenderer.removeListener(channel, listener),
    // 保存应用配置
    saveAppConfig: (configData) =>
      ipcRenderer.invoke("save-app-config", configData),
    // 获取应用配置
    getAppConfig: () => ipcRenderer.invoke("get-app-config"),
    // SAM3 中文词表配置
    getSam3Lexicon: () => ipcRenderer.invoke("get-sam3-lexicon"),
    saveSam3Lexicon: (lexiconData) =>
      ipcRenderer.invoke("save-sam3-lexicon", lexiconData),
    // 后端管理相关 API
    checkPython: () => ipcRenderer.invoke("check-python"),
    checkProject: () => ipcRenderer.invoke("check-project"),
    checkVenv: () => ipcRenderer.invoke("check-venv"),
    checkDependencies: () => ipcRenderer.invoke("check-dependencies"),
    installPython: () => ipcRenderer.invoke("install-python"),
    setProjectPath: (path) => ipcRenderer.invoke("set-project-path", path),
    createVenv: () => ipcRenderer.invoke("create-venv"),
    installDependencies: () => ipcRenderer.invoke("install-dependencies"),
    startBackendService: (config) =>
      ipcRenderer.invoke("start-backend-service", config),
    stopBackendService: () => ipcRenderer.invoke("stop-backend-service"),
    executeCommand: (options) => ipcRenderer.invoke("execute-command", options),
    copyFile: async (src, dest) => {
      return await fs.copyFile(src, dest);
    },

    readdir: async (dirPath) => {
      return await fs.readdir(dirPath);
    },

    writeFile: async (filePath, data, options = {}) => {
      const checkResult = await ipcRenderer.invoke("ensure-disk-space", {
        targetPath: filePath,
        requiredBytes: options.requiredBytes ?? getByteLength(data),
        safetyBytes: options.safetyBytes,
        operation: options.operation || "写入文件",
      });
      if (!checkResult?.success) {
        throw new Error(checkResult?.error || "磁盘空间不足，无法写入文件。");
      }
      return await fs.writeFile(filePath, data);
    },

    writeFileBase64: async (filePath, base64Content, options = {}) => {
      const buffer = Buffer.from(base64Content, "base64");
      const checkResult = await ipcRenderer.invoke("ensure-disk-space", {
        targetPath: filePath,
        requiredBytes: options.requiredBytes ?? buffer.byteLength,
        safetyBytes: options.safetyBytes,
        operation: options.operation || "写入文件",
      });
      if (!checkResult?.success) {
        throw new Error(checkResult?.error || "磁盘空间不足，无法写入文件。");
      }
      return await fs.writeFile(filePath, buffer);
    },

    joinPath: (...paths) => {
      return path.join(...paths);
    },

    getPathForFile: (file) => {
      if (!file || typeof webUtils?.getPathForFile !== "function") {
        return "";
      }
      return webUtils.getPathForFile(file);
    },

    saveFile: async (options) => {
      return await ipcRenderer.invoke("save-file", options);
    },
  },
  // 获取资源路径的方法
  getResourcesPath: () => {
    try {
      // 在预加载脚本中，我们无法直接访问 app 对象
      // 使用 ipcRenderer 向主进程请求资源路径
      return ipcRenderer.invoke("get-resources-path");
    } catch (error) {
      console.error("获取资源路径失败:", error);
      return "./resources";
    }
  },
  // 打开外部链接
  openExternal: (url) => ipcRenderer.invoke("open-external-link", url),
});
