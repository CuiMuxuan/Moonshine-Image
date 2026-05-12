import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const host = process.env.MOONSHINE_E2E_HOST || "127.0.0.1";
const port = Number(process.env.MOONSHINE_E2E_PORT || 9174);
const baseUrl = `http://${host}:${port}`;
const imageUrl = `${baseUrl}/#/image`;
const videoUrl = `${baseUrl}/#/video`;
const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";

const distDir = path.join(repoRoot, "dist", "spa");
const indexHtmlPath = path.join(distDir, "index.html");

const browserExecutableCandidatesByPlatform = {
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
  ],
};

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

function runCommand({ label, command, args = [] }) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: isWindows && /\.cmd$/i.test(command),
  });

  if (result.error) {
    throw new Error(
      `Command failed (${label}): ${command} ${args.join(" ")}\n${result.error.message}`
    );
  }
  if (result.status !== 0) {
    throw new Error(`Command failed (${label}): ${command} ${args.join(" ")}`);
  }
}

function ensureBuildArtifacts() {
  if (
    process.env.MOONSHINE_E2E_SKIP_BUILD === "1" &&
    fs.existsSync(indexHtmlPath)
  ) {
    return;
  }

  runCommand({
    label: "Build (E2E comprehensive workflow)",
    command: npmCommand,
    args: ["run", "build"],
  });
}

function findExecutableFromPathList(candidates = []) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "";
}

function findExecutableFromCommand(command) {
  const resolver = isWindows ? "where" : "which";
  const result = spawnSync(resolver, [command], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) return "";
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function resolveChromiumExecutable() {
  const envPath = String(process.env.MOONSHINE_E2E_BROWSER_PATH || "").trim();
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const platformCandidates = browserExecutableCandidatesByPlatform[process.platform] || [];
  const fromPathList = findExecutableFromPathList(platformCandidates);
  if (fromPathList) {
    return fromPathList;
  }

  for (const cmd of ["chrome", "google-chrome", "chromium", "msedge"]) {
    const resolved = findExecutableFromCommand(cmd);
    if (resolved && fs.existsSync(resolved)) {
      return resolved;
    }
  }

  throw new Error(
    "No Chromium browser executable found. Set MOONSHINE_E2E_BROWSER_PATH to Chrome/Edge path."
  );
}

function safeResolveAssetPath(requestPath) {
  const normalized = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const resolved = path.join(distDir, normalized);
  if (!resolved.startsWith(distDir)) {
    return "";
  }
  return resolved;
}

function createStaticServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url || "/", baseUrl);
    const pathname = decodeURIComponent(url.pathname || "/");
    const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = safeResolveAssetPath(requested);
    const fallbackPath = indexHtmlPath;
    const targetPath =
      filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()
        ? filePath
        : fallbackPath;

    const ext = path.extname(targetPath).toLowerCase();
    const contentType = contentTypes[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(targetPath).pipe(res);
  });
}

function startStaticServer() {
  const server = createStaticServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

function closeStaticServer(server) {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForPageBridge(page, bridgeName) {
  await page.waitForFunction(
    (name) => Boolean(window[name]),
    bridgeName,
    { timeout: 60000 }
  );
}

const tinyPngBytes = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x03, 0x01, 0x01, 0x00, 0xc9, 0xfe, 0x92, 0xef, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function createMockConfig() {
  return {
    general: {
      backendPort: 8091,
      launchMode: "cpu",
      modelPath: "",
      modelDir: "",
      backendProjectPath: "C:\\Moonshine-E2E",
      defaultModel: "lama",
      autoStart: false,
      language: "zh-CN",
    },
    advanced: {
      imageProcessingMethod: "base64",
      imageOutputFormat: "auto",
      imageOutputQuality: 95,
      imageOutputNamingMode: "original",
      imageOutputFixedPrefix: "moonshine",
    },
    video: {
      frameExtractionFormat: "jpg",
      batchFrameCount: 120,
      historyLimit: 5,
      defaultFrameRate: 30,
      maxKeyframes: 100,
      batchRetryCount: 3,
      failureRetentionCount: 3,
      proxyMaxSide: 1280,
      previewTrialSeconds: 3,
      supportedFormats: ["mp4", "mov", "avi", "mkv", "wmv", "webm"],
    },
    ui: {
      showStartupAnimation: false,
    },
  };
}

async function installElectronMock(context) {
  await context.addInitScript((initialConfig) => {
    window.__MOONSHINE_E2E__ = true;

    const savedConfig = { ...initialConfig };
    const listeners = new Map();

    const normalizePath = (input) => String(input || "").replace(/\//g, "\\");
    const basename = (input) => normalizePath(input).split("\\").filter(Boolean).at(-1) || "";
    const extensionToMime = (name) => {
      const ext = String(name || "").split(".").pop()?.toLowerCase();
      if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
      if (ext === "png") return "image/png";
      if (ext === "webp") return "image/webp";
      if (ext === "mp4") return "video/mp4";
      if (ext === "webm") return "video/webm";
      return "application/octet-stream";
    };

    const buildStats = (filePath) => ({
      success: true,
      path: String(filePath || ""),
      normalizedPath: normalizePath(filePath),
      name: basename(filePath),
      size: 1024,
      type: extensionToMime(filePath),
      mtimeMs: Date.now(),
      lastModified: Date.now(),
    });

    const invoke = async (channel, payload) => {
      switch (channel) {
        case "get-app-config":
          return savedConfig;
        case "save-app-config":
          Object.assign(savedConfig, payload || {});
          return { success: true };
        case "load-app-state":
          return { success: true, noData: true };
        case "save-app-state":
        case "clear-app-state":
          return { success: true };
        case "check-app-state-exists":
          return false;
        case "validate-backend-paths":
          return { valid: true, invalidPaths: [] };
        case "check-backend-status":
          return { success: true, running: false };
        case "check-python":
          return { success: true, version: "Python 3.11.5 (E2E)" };
        case "check-project":
          return { success: true, path: payload || savedConfig.general.backendProjectPath };
        case "check-venv":
        case "check-dependencies":
          return { success: true };
        case "get-resources-path":
          return "C:\\Moonshine-E2E\\resources";
        case "get-file-stats":
          return buildStats(payload);
        case "get-files-stats":
          return {
            success: true,
            files: (Array.isArray(payload) ? payload : []).map(buildStats),
          };
        case "read-file":
          return { success: true, data: "", content: "" };
        case "select-file":
          return { canceled: true, filePaths: [] };
        case "select-folder":
        case "select-directory":
          return { canceled: true, filePaths: [] };
        case "show-item-in-folder":
        case "open-external-link":
        case "ensure-directory":
        case "cleanup-temp-file":
        case "cleanup-temp-files":
        case "cleanup-video-processing-temp":
          return { success: true };
        case "compute-video-file-fingerprint":
          return { success: true, fingerprint: `e2e:${payload || "video"}` };
        case "get-video-processing-registry-path":
          return { success: true, path: "C:\\Moonshine-E2E\\video-registry.json" };
        default:
          return { success: true };
      }
    };

    window.electron = {
      ipcRenderer: {
        invoke,
        on(channel, callback) {
          const callbacks = listeners.get(channel) || new Set();
          callbacks.add(callback);
          listeners.set(channel, callbacks);
        },
        removeListener(channel, callback) {
          listeners.get(channel)?.delete(callback);
        },
        send(channel, payload) {
          listeners.get(channel)?.forEach((callback) => callback({}, payload));
        },
        joinPath(...parts) {
          return parts.filter(Boolean).join("\\");
        },
      },
    };
  }, createMockConfig());
}

async function installApiMocks(page) {
  await page.route("**/api/v1/check_cuda**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ cuda_available: false, device: "cpu" }),
    });
  });
  await page.route("**/api/v1/moonshine/models**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        currentModel: "lama",
        modelDir: "",
        cuda: { available: false },
        models: [
          {
            id: "lama",
            label: "Lama去除模型",
            type: "image",
            installed: true,
            available: true,
            requiresMask: true,
            runCapabilities: {
              scopes: ["selected", "folder"],
              folderInputs: ["imageFolder", "maskFolder"],
            },
          },
          {
            id: "slbr",
            label: "SLBR水印模型",
            type: "image",
            installed: true,
            available: true,
            requiresMask: false,
            runCapabilities: {
              scopes: ["selected", "folder"],
              folderInputs: ["imageFolder"],
            },
          },
        ],
      }),
    });
  });
}

async function createDataUrl(page, options = {}) {
  return page.evaluate(({ width, height, fillStyle }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = fillStyle;
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = Math.max(1, Math.round(Math.min(width, height) / 8));
    ctx.beginPath();
    ctx.moveTo(width * 0.2, height * 0.2);
    ctx.lineTo(width * 0.8, height * 0.8);
    ctx.stroke();
    return canvas.toDataURL("image/png");
  }, {
    width: options.width || 16,
    height: options.height || 16,
    fillStyle: options.fillStyle || "rgba(255,0,0,0.75)",
  });
}

async function testImageWorkflow(page) {
  console.log("Testing image upload, mask lifecycle, and processing undo...");
  await page.goto(imageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('[data-testid="image-page"]', { timeout: 60000 });
  await waitForPageBridge(page, "__MOONSHINE_IMAGE_TEST__");

  const snapshotAfterUpload = await page.evaluate(async (bytes) => {
    const file = new File([new Uint8Array(bytes)], "Moonshine-E2E.UPPER.PNG", {
      type: "image/png",
      lastModified: Date.now(),
    });
    await window.__MOONSHINE_IMAGE_TEST__.addFile(file);
    return window.__MOONSHINE_IMAGE_TEST__.getSnapshot();
  }, Array.from(tinyPngBytes));

  assert(snapshotAfterUpload.fileCount === 1, "Image upload should add one file.");
  assert(
    snapshotAfterUpload.currentFileName === "Moonshine-E2E.UPPER.PNG",
    "Image upload should preserve mixed-case file names."
  );
  assert(snapshotAfterUpload.currentHistoryLength === 1, "Image upload should create original history.");

  const maskUrl = await createDataUrl(page, { fillStyle: "rgba(0,0,0,1)" });
  const resultUrl = await createDataUrl(page, { fillStyle: "rgba(0,128,255,0.85)" });
  const afterMask = await page.evaluate((maskDataUrl) => {
    const snapshot = window.__MOONSHINE_IMAGE_TEST__.getSnapshot();
    window.__MOONSHINE_IMAGE_TEST__.setMask(snapshot.currentFileId, maskDataUrl);
    return window.__MOONSHINE_IMAGE_TEST__.getSnapshot();
  }, maskUrl);

  assert(afterMask.currentHasMask, "Image mask creation should mark the current image as masked.");

  const afterProcessing = await page.evaluate(async (processedUrl) => {
    const snapshot = window.__MOONSHINE_IMAGE_TEST__.getSnapshot();
    await window.__MOONSHINE_IMAGE_TEST__.addProcessingResult(
      snapshot.currentFileId,
      processedUrl,
      { format: "png", mimeType: "image/png", extension: ".png" }
    );
    return window.__MOONSHINE_IMAGE_TEST__.getSnapshot();
  }, resultUrl);

  assert(afterProcessing.currentHistoryLength === 2, "Image processing should append a history item.");

  const afterUndo = await page.evaluate(() => {
    window.__MOONSHINE_IMAGE_TEST__.undoProcessing();
    return window.__MOONSHINE_IMAGE_TEST__.getSnapshot();
  });
  assert(afterUndo.currentHistoryLength === 1, "Image processing undo should remove the latest result.");

  const afterClearMask = await page.evaluate(() => {
    const snapshot = window.__MOONSHINE_IMAGE_TEST__.getSnapshot();
    window.__MOONSHINE_IMAGE_TEST__.clearMask(snapshot.currentFileId);
    return window.__MOONSHINE_IMAGE_TEST__.getSnapshot();
  });
  assert(!afterClearMask.currentHasMask, "Image mask deletion should clear the mask.");
}

async function testVideoWorkflow(page) {
  console.log("Testing video upload, mask drawing undo, mask deletion, and processing undo...");
  await page.goto(videoUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('[data-testid="video-page"]', { timeout: 60000 });
  await waitForPageBridge(page, "__MOONSHINE_VIDEO_TEST__");

  const afterUpload = await page.evaluate(async () => {
    const file = new File(["moonshine-e2e-video"], "Moonshine-E2E.UPPER.MP4", {
      type: "video/mp4",
      lastModified: Date.now(),
    });
    return window.__MOONSHINE_VIDEO_TEST__.loadVideoFile(file, {
      width: 320,
      height: 180,
      duration: 5,
      fps: 30,
    });
  });

  assert(afterUpload.hasVideoFile, "Video upload should mark a video file as loaded.");
  assert(afterUpload.videoFileName === "Moonshine-E2E.UPPER.MP4", "Video upload should preserve file name.");
  assert(afterUpload.videoWidth === 320 && afterUpload.videoHeight === 180, "Video metadata should be stored.");

  const maskCreateResult = await page.evaluate(() =>
    window.__MOONSHINE_VIDEO_TEST__.createMask({
      name: "E2E 蒙版 1",
      startTime: 0,
      endTime: 4,
    })
  );
  assert(maskCreateResult.snapshot.maskCount === 1, "Video mask creation should add one mask.");
  assert(maskCreateResult.maskId, "Video mask creation should return a mask id.");
  assert(maskCreateResult.snapshot.timelineRowCount >= 1, "Video mask creation should sync timeline rows.");

  const drawnMaskUrl = await createDataUrl(page, {
    width: 32,
    height: 18,
    fillStyle: "rgba(255,255,255,0.9)",
  });
  const afterDraw = await page.evaluate((dataUrl) =>
    window.__MOONSHINE_VIDEO_TEST__.commitSelectedMaskBaseMask(dataUrl),
  drawnMaskUrl);
  assert(afterDraw.snapshot.canUndoMaskDraw, "Committing mask drawing should enable mask undo.");
  assert(
    afterDraw.snapshot.selectedMaskBaseMask === drawnMaskUrl,
    "Committed mask drawing should become selected mask base image."
  );

  const afterMaskUndo = await page.evaluate(() =>
    window.__MOONSHINE_VIDEO_TEST__.undoSelectedMaskDraw()
  );
  assert(!afterMaskUndo.snapshot.canUndoMaskDraw, "Mask draw undo should consume the undo step.");
  assert(
    afterMaskUndo.snapshot.selectedMaskBaseMask !== drawnMaskUrl,
    "Mask draw undo should restore the previous base mask."
  );

  const beforeProcessing = await page.evaluate(() =>
    window.__MOONSHINE_VIDEO_TEST__.pushProcessingHistory("E2E 处理前")
  );
  assert(beforeProcessing.entryId, "Video processing history should create an entry.");
  assert(beforeProcessing.snapshot.historyLength === 1, "Video history should contain one undo entry.");

  const afterReplacement = await page.evaluate(() =>
    window.__MOONSHINE_VIDEO_TEST__.replaceWithProcessedMock("Moonshine-E2E-PROCESSED.MP4")
  );
  assert(
    afterReplacement.currentSourceIsReplacement,
    "Processed video replacement should mark the source as replacement."
  );
  assert(
    afterReplacement.currentSourceName === "Moonshine-E2E-PROCESSED.MP4",
    "Processed video replacement should update current source name."
  );

  const afterProcessingUndo = await page.evaluate(() =>
    window.__MOONSHINE_VIDEO_TEST__.undoLatestProcessing()
  );
  assert(afterProcessingUndo.restored, "Video processing undo should restore the prior entry.");
  assert(afterProcessingUndo.snapshot.historyLength === 0, "Video processing undo should clear consumed history.");
  assert(
    afterProcessingUndo.snapshot.currentSourceName === "Moonshine-E2E.UPPER.MP4",
    "Video processing undo should restore original source name."
  );

  const afterMaskDelete = await page.evaluate(() =>
    window.__MOONSHINE_VIDEO_TEST__.removeSelectedMask()
  );
  assert(afterMaskDelete.maskCount === 0, "Video mask deletion should remove the selected mask.");
}

async function testBackendTerminalRefresh(page) {
  console.log("Testing backend manager terminal refresh throttling...");
  await page.goto(imageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('[data-testid="image-page"]', { timeout: 60000 });
  await page.click('[data-testid="open-backend-manager-button"]');
  await page.waitForSelector('[data-testid="backend-terminal-output"]', {
    state: "visible",
    timeout: 60000,
  });
  await waitForPageBridge(page, "__MOONSHINE_BACKEND_MANAGER_TEST__");

  const initial = await page.evaluate(() => {
    const bridge = window.__MOONSHINE_BACKEND_MANAGER_TEST__;
    bridge.clearTerminal();
    bridge.queueTerminalLog("E2E backend progress | 1%", "progress");
    return {
      interval: bridge.getFlushIntervalMs(),
      range: bridge.getFlushIntervalRangeMs(),
      pending: bridge.getPendingTerminalCount(),
      messages: bridge.getTerminalMessages(),
    };
  });

  assert(initial.interval === 1000, "Backend terminal flush interval should be 1000 ms.");
  assert(
    initial.range.min === 500 && initial.range.max === 1000,
    "Backend terminal progress refresh range should be 500-1000 ms."
  );
  assert(initial.pending === 1, "Queued backend progress should wait for the refresh window.");
  assert(
    !initial.messages.includes("E2E backend progress | 1%"),
    "Queued backend progress should not render immediately."
  );

  await page.waitForTimeout(350);
  const beforeMinFlush = await page.evaluate(() => ({
    pending: window.__MOONSHINE_BACKEND_MANAGER_TEST__.getPendingTerminalCount(),
    messages: window.__MOONSHINE_BACKEND_MANAGER_TEST__.getTerminalMessages(),
  }));
  assert(beforeMinFlush.pending === 1, "Backend progress should not flush before 500 ms.");
  assert(
    !beforeMinFlush.messages.includes("E2E backend progress | 1%"),
    "Backend progress should still be hidden before the 500 ms lower bound."
  );

  await page.waitForTimeout(250);
  const afterFlush = await page.evaluate(() => ({
    pending: window.__MOONSHINE_BACKEND_MANAGER_TEST__.getPendingTerminalCount(),
    messages: window.__MOONSHINE_BACKEND_MANAGER_TEST__.getTerminalMessages(),
    lines: window.__MOONSHINE_BACKEND_MANAGER_TEST__.getTerminalLines(),
    renderedLineCount: document.querySelectorAll('[data-testid="backend-terminal-line"]').length,
  }));

  assert(afterFlush.pending === 0, "Backend terminal queue should flush after the refresh window.");
  assert(
    afterFlush.messages.includes("E2E backend progress | 1%"),
    "Backend terminal flushed progress should be visible in terminal messages."
  );
  assert(afterFlush.renderedLineCount >= 2, "Backend terminal should render flushed lines.");

  const progressLine = afterFlush.lines.find((line) => line.message === "E2E backend progress | 1%");
  assert(progressLine?.refreshId, "Backend terminal progress line should expose refresh id.");

  const secondInitial = await page.evaluate(() => {
    const bridge = window.__MOONSHINE_BACKEND_MANAGER_TEST__;
    const before = bridge
      .getTerminalLines()
      .find((line) => line.message === "E2E backend progress | 1%");
    bridge.queueTerminalLog("E2E backend progress | 1%", "progress");
    return {
      beforeRefreshId: before?.refreshId || 0,
      pending: bridge.getPendingTerminalCount(),
    };
  });
  assert(secondInitial.pending === 1, "Repeated same progress text should queue another refresh.");

  await page.waitForTimeout(1100);
  const secondFlush = await page.evaluate(() => {
    const bridge = window.__MOONSHINE_BACKEND_MANAGER_TEST__;
    const line = bridge
      .getTerminalLines()
      .find((item) => item.message === "E2E backend progress | 1%");
    return {
      pending: bridge.getPendingTerminalCount(),
      refreshId: line?.refreshId || 0,
    };
  });

  assert(secondFlush.pending === 0, "Repeated same progress text should flush within 1000 ms.");
  assert(
    secondFlush.refreshId > secondInitial.beforeRefreshId,
    "Repeated same progress text should refresh the existing progress line."
  );

  const normalizedLogs = await page.evaluate(() => {
    const bridge = window.__MOONSHINE_BACKEND_MANAGER_TEST__;
    bridge.clearTerminal();
    bridge.addTerminalLog(
      "2026-05-12 19:57:03.117 | INFO | moonshine_server.api:api_video_batch_inpaint:1181 - [batch_0_90] start video batch: 90 frame(s), model=lama, batch=1/1, stop_on_error=True",
      "info"
    );
    bridge.addTerminalLog(
      "2026-05-12 19:57:04.528 | INFO | moonshine_server.api:api_video_batch_inpaint:1302 - [batch_0_90] finished video batch: model=lama, batch=1/1, total_frames=90, success=90, failed=0, elapsed=1.41s, outputs=['C:\\\\temp\\\\result_000000.jpg','C:\\\\temp\\\\result_000001.jpg']",
      "info"
    );
    return bridge.getTerminalMessages();
  });
  assert(
    normalizedLogs.some((message) => message.includes("开始处理视频批次 1/1：共 90 帧，模型 Lama")),
    "Backend start video batch log should be converted into user-facing copy."
  );
  assert(
    normalizedLogs.some((message) => message.includes("视频批次 1/1 处理完成：共 90 帧，成功 90 帧，失败 0 帧")),
    "Backend finished video batch log should be converted into user-facing copy."
  );
  assert(
    normalizedLogs.every((message) => !message.includes("outputs=") && !message.includes("result_000000")),
    "Backend finished video batch log should hide raw output path lists."
  );

  const wrappedStartLog = await page.evaluate(() => {
    const bridge = window.__MOONSHINE_BACKEND_MANAGER_TEST__;
    bridge.clearTerminal();
    bridge.addTerminalLog(
      "2026-05-12 21:17:00.965 | INFO |\nmoonshine_server.api:api_video_batch_inpaint:1181 - [batch_0_72] start video\nbatch: 72 frame(s), model=lama, batch=1/1",
      "info"
    );
    return bridge.getTerminalMessages();
  });
  assert(
    wrappedStartLog.some((message) =>
      message.includes("开始处理视频批次 1/1：共 72 帧，模型 Lama")
    ),
    "Wrapped backend start video batch log should be converted into user-facing copy."
  );

  const heartbeatInitial = await page.evaluate(() => {
    const bridge = window.__MOONSHINE_BACKEND_MANAGER_TEST__;
    bridge.clearTerminal();
    bridge.addTerminalLog(
      "slbr processing: 56%|█████▌ | 5/9 [00:26<00:19, 4.97s/it]",
      "info"
    );
    const line = bridge
      .getTerminalLines()
      .find((item) => item.message.includes("SLBR 正在处理"));
    return {
      heartbeatMs: bridge.getProgressHeartbeatMs(),
      message: line?.message || "",
      refreshId: line?.refreshId || 0,
      hasProgressInfo: Boolean(line?.hasProgressInfo),
    };
  });
  assert(heartbeatInitial.heartbeatMs === 1000, "Progress heartbeat should refresh once per second.");
  assert(
    heartbeatInitial.message.includes("5/9") &&
      heartbeatInitial.message.includes("56%") &&
      heartbeatInitial.message.includes("预计剩余"),
    "TQDM progress should be converted into user-facing progress copy."
  );
  assert(heartbeatInitial.hasProgressInfo, "TQDM progress line should keep live timing metadata.");

  await page.waitForTimeout(1150);
  const heartbeatAfter = await page.evaluate(() => {
    const line = window.__MOONSHINE_BACKEND_MANAGER_TEST__
      .getTerminalLines()
      .find((item) => item.message.includes("SLBR 正在处理"));
    return {
      message: line?.message || "",
      refreshId: line?.refreshId || 0,
    };
  });
  assert(
    heartbeatAfter.refreshId > heartbeatInitial.refreshId,
    "Active progress line should refresh even when the backend sends no new text."
  );
  assert(
    heartbeatAfter.message !== heartbeatInitial.message,
    "Active progress line should update elapsed/remaining time during a long iteration."
  );

  const heartbeatRepeatedRaw = await page.evaluate(() => {
    const bridge = window.__MOONSHINE_BACKEND_MANAGER_TEST__;
    bridge.addTerminalLog(
      "slbr processing: 56%|█████▌ | 5/9 [00:26<00:19, 4.97s/it]",
      "info"
    );
    const line = bridge
      .getTerminalLines()
      .find((item) => item.message.includes("SLBR 正在处理"));
    return {
      message: line?.message || "",
      refreshId: line?.refreshId || 0,
    };
  });
  assert(
    heartbeatRepeatedRaw.message.includes("已用 00:27") ||
      heartbeatRepeatedRaw.message.includes("已用 00:28"),
    "Repeated raw progress for the same item should keep local elapsed time instead of resetting."
  );
  assert(
    heartbeatRepeatedRaw.refreshId > heartbeatAfter.refreshId,
    "Repeated raw progress for the same item should refresh the existing live progress row."
  );

  const heartbeatStopped = await page.evaluate(() => {
    const bridge = window.__MOONSHINE_BACKEND_MANAGER_TEST__;
    bridge.addTerminalLog(
      "2026-05-12 19:57:04.528 | INFO | moonshine_server.api:api_video_batch_inpaint:1302 - [batch_0_90] finished video batch: model=lama, batch=1/1, total_frames=9, success=9, failed=0, elapsed=1.41s",
      "info"
    );
    const lines = bridge.getTerminalLines();
    const progressLine = lines.find((item) => item.message.includes("SLBR 处理完成"));
    const finishedLine = lines.find((item) => item.message.includes("视频批次 1/1 处理完成"));
    return {
      progressActive: Boolean(progressLine?.progressActive),
      hasProgressInfo: Boolean(progressLine?.hasProgressInfo),
      progressMessage: progressLine?.message || "",
      progressType: progressLine?.type || "",
      progressClassName: progressLine?.className || "",
      finishedType: finishedLine?.type || "",
      finishedClassName: finishedLine?.className || "",
    };
  });
  assert(
    !heartbeatStopped.progressActive && !heartbeatStopped.hasProgressInfo,
    "Finished backend batch log should stop the live progress heartbeat."
  );
  assert(
    heartbeatStopped.progressMessage.includes("9/9") &&
      heartbeatStopped.progressMessage.includes("100%"),
    "Finished backend batch log should promote the progress row to 100%."
  );
  assert(
    heartbeatStopped.progressType === "progress-complete" &&
      heartbeatStopped.progressClassName === "terminal-line--progress-complete",
    "Completed backend progress row should use the accent progress-complete style."
  );
  assert(
    heartbeatStopped.finishedType === "progress-complete" &&
      heartbeatStopped.finishedClassName === "terminal-line--progress-complete",
    "Finished backend batch summary should use the accent completion style."
  );

  const imageBatchProgress = await page.evaluate(() => {
    const bridge = window.__MOONSHINE_BACKEND_MANAGER_TEST__;
    bridge.clearTerminal();
    bridge.addTerminalLog(
      "Batch processing: 0%| | 0/5 [00:01<?, ?it/s]",
      "info"
    );
    bridge.addTerminalLog("检测到后端服务正在运行，跳过环境检测", "info");
    bridge.addTerminalLog(
      "Batch processing: 100%|██████████| 5/5 [00:02<00:00, 1.72it/s]",
      "info"
    );
    bridge.addTerminalLog("Batch processing completed in 2.00s for 5 images", "info");
    const lines = bridge.getTerminalLines();
    return {
      messages: lines.map((line) => line.message),
      activeProgressCount: lines.filter((line) => line.progressActive).length,
      batchProgressRows: lines.filter(
        (line) =>
          line.message.includes("批量图片 正在处理") ||
          line.message.includes("批量图片 处理完成")
      ),
      completionRows: lines.filter((line) => line.type === "progress-complete"),
    };
  });
  assert(
    imageBatchProgress.activeProgressCount === 0,
    "Completed image batch should not leave active progress rows."
  );
  assert(
    imageBatchProgress.batchProgressRows.length === 1 &&
      imageBatchProgress.batchProgressRows[0].message.includes("5/5") &&
      imageBatchProgress.batchProgressRows[0].message.includes("100%"),
    "Image batch progress should update one existing row to 100% instead of leaving duplicate progress rows."
  );
  assert(
    imageBatchProgress.completionRows.some((line) =>
      line.message.includes("批量图片处理完成：共 5 张，用时 2 秒")
    ),
    "Image batch finished log should be converted into an accent completion summary."
  );
}

async function runWorkflowTest() {
  const executablePath = resolveChromiumExecutable();
  console.log(`Using browser executable: ${executablePath}`);

  const browser = await chromium.launch({
    headless: process.env.MOONSHINE_E2E_HEADLESS !== "0",
    executablePath,
    args: ["--disable-dev-shm-usage", "--no-default-browser-check"],
  });

  const context = await browser.newContext({
    viewport: {
      width: 1600,
      height: 960,
    },
  });
  await installElectronMock(context);

  const page = await context.newPage();
  await installApiMocks(page);

  const consoleProblems = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      const text = message.text();
      if (
        !/Failed to load model list/i.test(text) &&
        !/Video player initialization timed out/i.test(text)
      ) {
        consoleProblems.push(`${message.type()}: ${text}`);
      }
    }
  });
  page.on("pageerror", (error) => {
    consoleProblems.push(`pageerror: ${error.message}`);
  });

  try {
    await testImageWorkflow(page);
    await testVideoWorkflow(page);
    await testBackendTerminalRefresh(page);

    assert(
      consoleProblems.length === 0,
      `Unexpected console/page errors:\n${consoleProblems.join("\n")}`
    );
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  ensureBuildArtifacts();
  const server = await startStaticServer();

  try {
    await runWorkflowTest();
    console.log("E2E comprehensive workflow test passed.");
  } finally {
    await closeStaticServer(server);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
