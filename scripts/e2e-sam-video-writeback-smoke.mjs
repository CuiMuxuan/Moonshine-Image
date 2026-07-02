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
const port = Number(process.env.MOONSHINE_E2E_PORT || 9178);
const baseUrl = `http://${host}:${port}`;
const videoUrl = `${baseUrl}/#/video`;
const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const distDir = path.join(repoRoot, "dist", "spa");
const indexHtmlPath = path.join(distDir, "index.html");
const testVideoPath =
  process.env.MOONSHINE_E2E_SAM_VIDEO_PATH ||
  "C:\\Users\\cjh02\\Downloads\\生成看板娘呼吸动画视频 (5).mp4";

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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

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
  if (process.env.MOONSHINE_E2E_SKIP_BUILD === "1" && fs.existsSync(indexHtmlPath)) {
    return;
  }

  runCommand({
    label: "Build (SAM video writeback smoke)",
    command: npmCommand,
    args: ["run", "build"],
  });
}

function safeResolveAssetPath(requestPath) {
  const normalized = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const resolved = path.join(distDir, normalized);
  return resolved.startsWith(distDir) ? resolved : "";
}

function createStaticServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url || "/", baseUrl);
    const pathname = decodeURIComponent(url.pathname || "/");
    const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = safeResolveAssetPath(requested);
    const targetPath =
      filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()
        ? filePath
        : indexHtmlPath;

    const ext = path.extname(targetPath).toLowerCase();
    res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
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

  const fromPathList = findExecutableFromPathList(
    browserExecutableCandidatesByPlatform[process.platform] || []
  );
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

function createMockConfig() {
  return {
    schemaVersion: 5,
    general: {
      backendPort: 8091,
      launchMode: "cpu",
      modelDir: "",
      backendProjectPath: "C:\\Moonshine-E2E",
      defaultModel: "lama",
      autoStart: false,
      language: "zh-CN",
    },
    advanced: {
      imageProcessingMethod: "auto",
      imageOutputFormat: "auto",
      imageOutputQuality: 95,
      imageOutputNamingMode: "original",
      imageOutputFixedPrefix: "moonshine",
      imageHistoryLimit: 10,
      imageWarningSize: 50,
      stateSaveLimit: 100,
      imageBrushDefault: { size: 20, color: "#8a71d4", alpha: 0.75 },
      videoBrushDefault: { size: 24, color: "#8a71d4", alpha: 0.75 },
    },
    fileManagement: {
      downloadPath: "",
      tempPath: "C:\\Moonshine-E2E\\temp",
      imageFolderName: "images",
      videoFolderName: "videos",
      tempCleanup: {
        enabled: false,
        onStartup: false,
        maxAgeDays: 7,
        includeImages: true,
        includeVideos: true,
        keepRecentFailures: true,
      },
    },
    video: {
      frameExtractionFormat: "jpg",
      batchFrameCount: 120,
      historyLimit: 5,
      defaultFrameRate: 24,
      maxKeyframes: 100,
      batchRetryCount: 3,
      failureRetentionCount: 3,
      proxyMaxSide: 1280,
      previewTrialSeconds: 3,
      supportedFormats: ["mp4", "mov", "avi", "mkv", "wmv", "webm"],
    },
    masking: {
      defaultSamModel: "sam_vit_b",
      defaultSam1Model: "sam_vit_b",
      defaultSam2Model: "sam2_1_hiera_large",
      defaultSam3Model: "sam3_1_multiplex",
      imageSmartSelectionDefaultModel: "sam_vit_b",
      videoSmartSelectionDefaultModel: "sam2_1_hiera_large",
    },
    ui: {
      theme: "light",
      buttonSize: "sm",
      brandColors: {
        primary: "#8a71d4",
        secondary: "#c1bee6",
        accent: "#e6cfad",
        positive: "#189e7a",
        negative: "#cc455d",
        info: "#7a8dbe",
        warning: "#e6ac00",
      },
      showStartupAnimation: false,
      showWelcomeDialog: true,
      confirmBeforeExit: true,
      autoSaveInterval: 30000,
    },
    shortcuts: {},
  };
}

async function installElectronMock(context) {
  await context.addInitScript((initialConfig) => {
    window.__MOONSHINE_E2E__ = true;

    const savedConfig = { ...initialConfig };
    const listeners = new Map();
    const tinyPngBuffer = [
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
      0x00, 0x03, 0x01, 0x01, 0x00, 0xc9, 0xfe, 0x92, 0xef, 0x00, 0x00, 0x00,
      0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];
    const savedFiles = new Map();

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
      size: savedFiles.get(normalizePath(filePath))?.buffer?.length || 1024,
      type: extensionToMime(filePath),
      mtimeMs: Date.now(),
      lastModified: Date.now(),
      data: {
        path: String(filePath || ""),
        name: basename(filePath),
        size: savedFiles.get(normalizePath(filePath))?.buffer?.length || 1024,
        type: extensionToMime(filePath),
        buffer: savedFiles.get(normalizePath(filePath))?.buffer || tinyPngBuffer,
      },
    });
    const readMockFile = (filePath) => {
      const normalizedPath = normalizePath(filePath);
      const saved = savedFiles.get(normalizedPath);
      return {
        success: true,
        data: {
          path: String(filePath || ""),
          name: basename(filePath) || "Moonshine-E2E.PNG",
          type: extensionToMime(filePath) || "image/png",
          size: saved?.buffer?.length || tinyPngBuffer.length,
          lastModified: Date.now(),
          buffer: saved?.buffer || tinyPngBuffer,
        },
      };
    };

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
        case "check-backend-status":
          return { success: true, running: false };
        case "validate-backend-paths":
          return { valid: true, invalidPaths: [] };
        case "get-resources-path":
          return "C:\\Moonshine-E2E\\resources";
        case "get-file-stats":
          return buildStats(payload);
        case "read-file":
        case "read-file-with-progress":
          return readMockFile(payload);
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
        async writeFile(filePath, data) {
          const bytes = Array.from(data instanceof Uint8Array ? data : new Uint8Array(data || []));
          savedFiles.set(normalizePath(filePath), {
            buffer: bytes.length ? bytes : tinyPngBuffer,
            type: extensionToMime(filePath),
          });
        },
        joinPath(...parts) {
          return parts.filter(Boolean).join("\\");
        },
        getPathForFile(file) {
          return file?.path || "";
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
          },
        ],
      }),
    });
  });
  await page.route("**/api/v1/moonshine/sam/capabilities**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        device: "cpu",
        pointBox: {
          enabled: true,
          defaultModelId: "sam_vit_b",
          promptTypes: ["point", "box"],
          models: [
            {
              id: "sam_vit_b",
              family: "sam",
              installed: true,
              available: true,
              supportsPointBox: true,
            },
          ],
        },
        video: {
          enabled: true,
          defaultModelId: "sam2_1_hiera_large",
          models: [
            {
              id: "sam2_1_hiera_large",
              family: "sam2",
              installed: true,
              available: true,
              supportsVideo: true,
            },
          ],
        },
        text: { enabled: false, defaultModelId: "", models: [] },
      }),
    });
  });
}

async function waitForPageBridge(page, bridgeName) {
  await page.waitForFunction(
    (name) => Boolean(window[name]),
    bridgeName,
    { timeout: 60000 }
  );
}

function buildPathBackedSamResult({ frameCount = 241, fps = 24 } = {}) {
  return {
    modelId: "sam2_1_hiera_large",
    width: 720,
    height: 960,
    frameCount,
    objectCount: 1,
    input: {
      type: "videoPath",
      videoPath: testVideoPath,
      frameIndex: 120,
      fps,
      responseType: "path",
      propagation: "bidirectional",
    },
    objects: [
      {
        objectId: 1,
        enabled: true,
        pointCount: 1,
        hasBox: false,
      },
    ],
    promptObjects: [
      {
        objectId: 1,
        frameIndex: 120,
        points: [{ x: 360, y: 480, label: 1 }],
      },
    ],
    frames: Array.from({ length: frameCount }, (_, frameIndex) => ({
      frameIndex,
      masks: [
        {
          objectId: 1,
          maskPath: `C:\\Moonshine-E2E\\temp\\moonshine-sam-video-masks\\track\\run\\mask_f${String(frameIndex).padStart(6, "0")}_o001.jpg`,
          maskAssetId: `e2e:${frameIndex}:1`,
          maskSignature: `sig-${frameIndex}`,
          maskSize: 128,
        },
      ],
    })),
  };
}

async function runSmoke(page) {
  await installApiMocks(page);
  await page.goto(videoUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('[data-testid="video-page"]', { timeout: 60000 });
  await waitForPageBridge(page, "__MOONSHINE_VIDEO_TEST__");

  const afterUpload = await page.evaluate(async (filePath) => {
    const file = new File(["moonshine-e2e-video"], "生成看板娘呼吸动画视频 (5).mp4", {
      type: "video/mp4",
      lastModified: Date.now(),
    });
    file.path = filePath;
    return window.__MOONSHINE_VIDEO_TEST__.loadVideoFile(file, {
      width: 720,
      height: 960,
      duration: 10.041667,
      fps: 24,
    });
  }, testVideoPath);
  assert(afterUpload.hasVideoFile, "Video page should load the user-scale MP4 fixture.");
  assert(afterUpload.videoWidth === 720 && afterUpload.videoHeight === 960, "Video metadata should match the user video.");

  const writeback = await page.evaluate((result) => {
    const bridge = window.__MOONSHINE_VIDEO_TEST__;
    const emptyTrack = bridge.createEmptySamVideoTrack({
      name: "E2E SAM 241 帧智能轨道",
    });
    const update = bridge.updateSelectedSamVideoResult(result);
    return { emptyTrack, update };
  }, buildPathBackedSamResult());

  assert(writeback.emptyTrack.maskId, "SAM video smoke should create an empty smart-selection track.");
  assert(writeback.update.success, writeback.update.error || "SAM video 241-frame result should write back.");
  assert(writeback.update.snapshot.selectedMaskType === "samVideo", "The selected track should remain a SAM video track.");
  assert(writeback.update.snapshot.selectedSamFrameCount === 241, "The selected SAM track should keep all 241 propagated frames.");
  assert(writeback.update.snapshot.selectedSamObjectCount === 1, "The selected SAM track should expose one candidate object.");
  assert(writeback.update.snapshot.selectedSamFirstFrameMaskCount === 1, "The first propagated frame should expose one object mask.");
  assert(writeback.update.snapshot.selectedSamHasPreviewMask, "SAM video frames should keep path-backed preview masks.");
  assert(
    !("selectedSamInlineMaskCount" in writeback.update.snapshot),
    "SAM video E2E snapshot should not expose inline mask compatibility counters."
  );
  assert(writeback.update.snapshot.samVideo.resultFrameCount === 241, "SAM video state should keep only the writeback summary.");

  await page.waitForTimeout(500);
  const pageStillVisible = await page.locator('[data-testid="video-page"]').isVisible();
  assert(pageStillVisible, "Video page should stay visible after writing back 241 SAM frames.");

  const afterIdleSnapshot = await page.evaluate(() => window.__MOONSHINE_VIDEO_TEST__.getSnapshot());
  assert(afterIdleSnapshot.selectedMaskId, "The smoke should keep a selected SAM video mask.");
  assert(
    !("selectedSamInlineMaskCount" in afterIdleSnapshot),
    "SAM video state should remain path-backed without inline mask counters after the preview settles."
  );
}

async function main() {
  ensureBuildArtifacts();
  const server = await startStaticServer();
  const browser = await chromium.launch({
    headless: true,
    executablePath: resolveChromiumExecutable(),
  });
  const pageErrors = [];

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      deviceScaleFactor: 1,
    });
    await installElectronMock(context);
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message || String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") {
        const text = message.text();
        if (!text.includes("ERR_UNKNOWN_URL_SCHEME")) {
          pageErrors.push(text);
        }
      }
    });

    await runSmoke(page);
    assert(pageErrors.length === 0, `Page should not emit errors:\n${pageErrors.join("\n")}`);
    await context.close();
  } finally {
    await browser.close();
    await closeStaticServer(server);
  }

  console.log("SAM video 241-frame writeback smoke passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
