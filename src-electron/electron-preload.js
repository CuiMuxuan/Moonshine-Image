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

const getExternalEnvironmentCandidateId = (value) =>
  String(
    value && typeof value === "object" ? value.candidateId || "" : value || ""
  ).trim();

const ALLOWED_INVOKE_CHANNELS = new Set([
  "abort-file-write-stream",
  "app-restart",
  "app-update-check",
  "app-update-download",
  "app-update-get-install-readiness",
  "app-update-get-state",
  "app-update-install",
  "app-update-set-channel",
  "cancel-ffmpeg-task",
  "check-app-state-exists",
  "check-backend-status",
  "check-dependencies",
  "check-disk-space",
  "check-ffmpeg-runtime",
  "check-project",
  "check-python",
  "check-venv",
  "cleanup-app-temp-files",
  "cleanup-temp-directory",
  "cleanup-temp-file",
  "cleanup-temp-files",
  "cleanup-video-processing-temp",
  "clear-app-state",
  "close-file-write-stream",
  "compute-video-file-fingerprint",
  "copy-file",
  "create-venv",
  "delete-file",
  "ensure-directory",
  "ensure-disk-space",
  "environment-cancel",
  "environment-check",
  "environment-ensure",
  "environment-external-activate",
  "environment-external-forget",
  "environment-external-probe",
  "environment-external-select-directory",
  "environment-get-backend-spec",
  "environment-get-state",
  "environment-open-path",
  "environment-rollback",
  "environment-set-accelerator",
  "environment-update-plan",
  "environment-update-status",
  "environment-update-switch",
  "ffmpeg-concat-segments",
  "ffmpeg-encode-frame-sequence",
  "ffmpeg-extract-frame-sequence",
  "ffmpeg-mux-audio",
  "ffprobe-media",
  "get-app-config",
  "get-file-stats",
  "get-files-stats",
  "get-resources-path",
  "get-sam3-lexicon",
  "get-video-processing-registry-path",
  "install-dependencies",
  "install-python",
  "list-image-files",
  "load-app-state",
  "mcp-get-activity",
  "mcp-get-approvals",
  "mcp-get-client-configuration",
  "mcp-get-client-sessions",
  "mcp-get-config",
  "mcp-get-state",
  "mcp-disconnect-client",
  "mcp-open-artifact-in-editor",
  "mcp-probe-external-proxy",
  "mcp-resolve-approval",
  "mcp-save-config",
  "mcp-select-root",
  "model-manifest-get-state",
  "model-manifest-refresh",
  "open-external-link",
  "open-file-write-stream",
  "open-startup-log",
  "prepare-project-python",
  "read-file",
  "read-file-with-progress",
  "remove-directory-recursive",
  "runtime-cancel",
  "runtime-check",
  "runtime-ensure",
  "runtime-get-backend-spec",
  "runtime-get-state",
  "runtime-rollback",
  "runtime-set-channel",
  "save-app-config",
  "save-app-state",
  "save-file",
  "save-sam3-lexicon",
  "save-temp-video",
  "saveFile",
  "select-directory",
  "select-file",
  "select-folder",
  "set-project-path",
  "show-item-in-folder",
  "start-backend-service",
  "stop-backend-service",
  "tray-get-state",
  "validate-backend-paths",
  "write-file-stream-chunk",
]);

const ALLOWED_SEND_CHANNELS = new Set([
  "renderer-ready",
  "set-active-processing-task",
  "show-missing-files",
]);
const ALLOWED_EVENT_CHANNELS = new Set([
  "app-update-state",
  "backend-output",
  "backend-service-state",
  "config-reset",
  "config-updated",
  "environment-state",
  "file-read-progress",
  "model-manifest-state",
  "mcp-open-artifact",
  "python-install-path",
  "runtime-state",
  "state-cleared",
  "tray-navigate",
  "tray-state",
]);

const assertAllowedChannel = (channel, allowedChannels) => {
  if (typeof channel !== "string" || !allowedChannels.has(channel)) {
    throw new Error("IPC channel is not allowlisted.");
  }
  return channel;
};

// 暴露 Electron API 给渲染进程
contextBridge.exposeInMainWorld("electron", {
  ipcRenderer: {
    invoke: (channel, ...args) =>
      ipcRenderer.invoke(assertAllowedChannel(channel, ALLOWED_INVOKE_CHANNELS), ...args),
    send: (channel, ...args) =>
      ipcRenderer.send(assertAllowedChannel(channel, ALLOWED_SEND_CHANNELS), ...args),
    on: (channel, listener) => {
      const allowedChannel = assertAllowedChannel(channel, ALLOWED_EVENT_CHANNELS);
      if (typeof listener !== "function") return () => {};
      // IpcRendererEvent is an Electron-only object and cannot cross the
      // contextBridge structured-clone boundary. Renderer listeners only need
      // the event payload, so keep the event local to preload and pass null.
      const handler = (_event, ...args) => {
        listener(null, ...args);
      };
      ipcRenderer.on(allowedChannel, handler);
      return () => ipcRenderer.removeListener(allowedChannel, handler);
    },
    removeListener: (channel, listener) =>
      ipcRenderer.removeListener(assertAllowedChannel(channel, ALLOWED_EVENT_CHANNELS), listener),
    // 保存应用配置
    saveAppConfig: (configData) =>
      ipcRenderer.invoke("save-app-config", configData),
    // 获取应用配置
    getAppConfig: () => ipcRenderer.invoke("get-app-config"),
    // 应用更新
    getAppUpdateState: () => ipcRenderer.invoke("app-update-get-state"),
    setAppUpdateChannel: (channel) => ipcRenderer.invoke("app-update-set-channel", channel),
    checkForAppUpdate: () => ipcRenderer.invoke("app-update-check"),
    downloadAppUpdate: () => ipcRenderer.invoke("app-update-download"),
    installAppUpdate: () => ipcRenderer.invoke("app-update-install"),
    getAppUpdateInstallReadiness: () =>
      ipcRenderer.invoke("app-update-get-install-readiness"),
    restartApplication: () => ipcRenderer.invoke("app-restart"),
    // Managed runtime and component updates
    getRuntimeState: () => ipcRenderer.invoke("runtime-get-state"),
    setRuntimeChannel: (channel) => ipcRenderer.invoke("runtime-set-channel", channel),
    checkRuntime: (options = {}) => ipcRenderer.invoke("runtime-check", options),
    ensureRuntime: (options = {}) => ipcRenderer.invoke("runtime-ensure", options),
    cancelRuntime: () => ipcRenderer.invoke("runtime-cancel"),
    rollbackRuntime: () => ipcRenderer.invoke("runtime-rollback"),
    getRuntimeBackendSpec: () => ipcRenderer.invoke("runtime-get-backend-spec"),
    getEnvironmentState: () => ipcRenderer.invoke("environment-get-state"),
    setEnvironmentAccelerator: (accelerator) =>
      ipcRenderer.invoke("environment-set-accelerator", accelerator),
    checkEnvironment: (options = {}) =>
      ipcRenderer.invoke("environment-check", options),
    ensureEnvironment: (options = {}) =>
      ipcRenderer.invoke("environment-ensure", options),
    cancelEnvironmentPreparation: () => ipcRenderer.invoke("environment-cancel"),
    rollbackEnvironment: () => ipcRenderer.invoke("environment-rollback"),
    getEnvironmentBackendSpec: () => ipcRenderer.invoke("environment-get-backend-spec"),
    getEnvironmentUpdateStatus: (options = {}) =>
      ipcRenderer.invoke("environment-update-status", options),
    getEnvironmentUpdatePlan: (options = {}) =>
      ipcRenderer.invoke("environment-update-plan", options),
    switchEnvironment: (options = {}) =>
      ipcRenderer.invoke("environment-update-switch", options),
    openEnvironmentPath: () => ipcRenderer.invoke("environment-open-path"),
    selectExternalEnvironmentDirectory: () =>
      ipcRenderer.invoke("environment-external-select-directory"),
    probeExternalEnvironment: (candidate = {}) =>
      ipcRenderer.invoke("environment-external-probe", {
        candidateId: getExternalEnvironmentCandidateId(candidate),
      }),
    activateExternalEnvironment: (candidate = {}) =>
      ipcRenderer.invoke("environment-external-activate", {
        candidateId: getExternalEnvironmentCandidateId(candidate),
      }),
    forgetExternalEnvironment: () =>
      ipcRenderer.invoke("environment-external-forget"),
    getModelManifestState: () => ipcRenderer.invoke("model-manifest-get-state"),
    refreshModelManifest: (options = {}) => ipcRenderer.invoke("model-manifest-refresh", options),
    onRuntimeState: (listener) => {
      if (typeof listener !== "function") return () => {};
      let active = true;
      const handler = (_event, state) => {
        if (active) listener(state);
      };
      ipcRenderer.on("runtime-state", handler);
      return () => {
        if (!active) return;
        active = false;
        ipcRenderer.removeListener("runtime-state", handler);
      };
    },
    onEnvironmentState: (listener) => {
      if (typeof listener !== "function") return () => {};
      let active = true;
      const handler = (_event, state) => {
        if (active) listener(state);
      };
      ipcRenderer.on("runtime-state", handler);
      return () => {
        if (!active) return;
        active = false;
        ipcRenderer.removeListener("runtime-state", handler);
      };
    },
    onModelManifestState: (listener) => {
      if (typeof listener !== "function") return () => {};
      let active = true;
      const handler = (_event, state) => {
        if (active) listener(state);
      };
      ipcRenderer.on("model-manifest-state", handler);
      return () => {
        if (!active) return;
        active = false;
        ipcRenderer.removeListener("model-manifest-state", handler);
      };
    },
    onAppUpdateState: (listener) => {
      if (typeof listener !== "function") return () => {};
      let active = true;
      const handler = (_event, state) => {
        if (active) listener(state);
      };
      ipcRenderer.on("app-update-state", handler);
      return () => {
        if (!active) return;
        active = false;
        ipcRenderer.removeListener("app-update-state", handler);
      };
    },
    getTrayState: () => ipcRenderer.invoke("tray-get-state"),
    getMcpState: () => ipcRenderer.invoke("mcp-get-state"),
    getMcpActivity: (after = 0) => ipcRenderer.invoke("mcp-get-activity", after),
    getMcpConfig: () => ipcRenderer.invoke("mcp-get-config"),
    saveMcpConfig: (config) => ipcRenderer.invoke("mcp-save-config", config),
    selectMcpRoot: () => ipcRenderer.invoke("mcp-select-root"),
    getMcpClientConfiguration: () => ipcRenderer.invoke("mcp-get-client-configuration"),
    probeMcpExternalProxy: () => ipcRenderer.invoke("mcp-probe-external-proxy"),
    getMcpClientSessions: () => ipcRenderer.invoke("mcp-get-client-sessions"),
    disconnectMcpClient: (sessionId) => ipcRenderer.invoke("mcp-disconnect-client", sessionId),
    getMcpApprovals: () => ipcRenderer.invoke("mcp-get-approvals"),
    resolveMcpApproval: (approvalId, decision) =>
      ipcRenderer.invoke("mcp-resolve-approval", approvalId, decision),
    openMcpArtifactInEditor: (jobId, artifactId) =>
      ipcRenderer.invoke("mcp-open-artifact-in-editor", jobId, artifactId),
    onTrayState: (listener) => {
      if (typeof listener !== "function") return () => {};
      const handler = (_event, state) => {
        listener(state);
      };
      ipcRenderer.on("tray-state", handler);
      return () => ipcRenderer.removeListener("tray-state", handler);
    },
    onTrayNavigation: (listener) => {
      if (typeof listener !== "function") return () => {};
      const handler = (_event, request) => {
        listener(request);
      };
      ipcRenderer.on("tray-navigate", handler);
      return () => ipcRenderer.removeListener("tray-navigate", handler);
    },
    onMcpOpenArtifact: (listener) => {
      if (typeof listener !== "function") return () => {};
      const handler = (_event, payload) => {
        listener(payload);
      };
      ipcRenderer.on("mcp-open-artifact", handler);
      return () => ipcRenderer.removeListener("mcp-open-artifact", handler);
    },
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
