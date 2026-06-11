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
const port = Number(process.env.MOONSHINE_E2E_PORT || 9176);
const baseUrl = `http://${host}:${port}`;
const imageUrl = `${baseUrl}/#/image`;
const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const distDir = path.join(repoRoot, "dist", "spa");
const indexHtmlPath = path.join(distDir, "index.html");

const tinyPngBytes = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x03, 0x01, 0x01, 0x00, 0xc9, 0xfe, 0x92, 0xef, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const solidMaskPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4f5phFwAHHAKFhD+0FQAAAABJRU5ErkJggg==";

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
    label: "Build (SAM smart selection UI smoke)",
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
    masking: {
      defaultSamModel: "sam_vit_b",
      defaultSam1Model: "sam_vit_b",
      defaultSam2Model: "sam2_1_hiera_large",
      defaultSam3Model: "sam3_1_multiplex",
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
      defaultFrameRate: 30,
      maxKeyframes: 100,
      batchRetryCount: 3,
      failureRetentionCount: 3,
      proxyMaxSide: 1280,
      previewTrialSeconds: 3,
      supportedFormats: ["mp4", "mov", "avi", "mkv", "wmv", "webm"],
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
        case "get-resources-path":
          return "C:\\Moonshine-E2E\\resources";
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
        modelDir: "C:\\Moonshine-E2E\\models",
        cuda: { cuda_available: false },
        models: [
          {
            id: "lama",
            label: "Lama去除模型",
            type: "image",
            installed: true,
            available: true,
            requiresMask: true,
            runCapabilities: { scopes: ["selected", "folder"] },
          },
          {
            id: "sam_vit_b",
            family: "sam",
            category: "mask_generator",
            label: "SAM1 ViT-B 智能选区模型",
            type: "mask",
            installed: true,
            available: true,
            runCapabilities: {
              scopes: ["currentImage"],
              maskPrompts: ["point", "box"],
            },
          },
          {
            id: "sam2_1_hiera_large",
            family: "sam2",
            category: "mask_generator",
            label: "SAM2.1 Hiera Large",
            type: "mask",
            installed: true,
            available: true,
            runCapabilities: {
              scopes: ["currentImage", "videoFrames"],
              maskPrompts: ["point", "box", "mask"],
            },
          },
          {
            id: "sam3",
            family: "sam3",
            category: "text_smart_selection",
            label: "SAM3 文本智能选区模型",
            type: "mask",
            installed: true,
            available: true,
            runCapabilities: {
              scopes: ["currentImage", "selectedImages"],
              maskPrompts: ["text"],
            },
          },
          {
            id: "sam3_1_multiplex",
            family: "sam3",
            category: "text_smart_selection",
            label: "SAM3.1 Multiplex 文本智能选区模型",
            type: "mask",
            installed: true,
            available: true,
            runCapabilities: {
              scopes: ["currentImage", "selectedImages", "videoFrames"],
              maskPrompts: ["text"],
            },
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
        device: "cuda",
        pointBox: {
          enabled: true,
          defaultModelId: "sam_vit_b",
          promptTypes: ["point", "box"],
        },
        text: {
          enabled: true,
          defaultModelId: "sam3_1_multiplex",
          implementedModelIds: ["sam3", "sam3_1_multiplex"],
          pendingModels: [],
          promptTypes: ["text"],
        },
      }),
    });
  });
  await page.route("**/api/v1/moonshine/sam/text/predict", async (route) => {
    const body = route.request().postDataJSON?.() || {};
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        modelId: body.model_id || "sam3_1_multiplex",
        imageHash: "e2e-sam-text",
        width: 1,
        height: 1,
        prompt: {
          type: "text",
          text: body.text || "red rectangle",
          language: body.language || "auto",
          modelText: body.text || "red rectangle",
          modelLanguage: body.language || "auto",
          normalization: "original",
          attempts: [],
        },
        candidates: [
          {
            id: "e2e-text-candidate-0",
            index: 0,
            mask: `data:image/png;base64,${solidMaskPngBase64}`,
            score: 0.91,
            box: { x: 0, y: 0, width: 1, height: 1, x0: 0, y0: 0, x1: 1, y1: 1 },
            promptType: "text",
            prompt: {
              type: "text",
              text: body.text || "red rectangle",
              language: body.language || "auto",
              modelText: body.text || "red rectangle",
              modelLanguage: body.language || "auto",
              normalization: "original",
            },
          },
        ],
        performance: {
          device: "cuda",
          imageCacheHit: false,
          imageMegapixels: 0.01,
          totalMs: 12,
        },
      }),
    });
  });
}

async function waitForImageBridge(page) {
  await page.waitForFunction(() => Boolean(window.__MOONSHINE_IMAGE_TEST__), null, {
    timeout: 60000,
  });
}

async function collectSamPanelState(page) {
  return page.evaluate(() => {
    const panel = document.querySelector(".sam-toolbar");
    const textPanel = document.querySelector(".sam-text-panel");
    const prompt = textPanel?.querySelector(".sam-text-prompt");
    const input = prompt?.querySelector("input");
    const buttons = Array.from(textPanel?.querySelectorAll(".sam-text-actions .q-btn") || []);
    const panelStyle = panel ? window.getComputedStyle(panel) : null;
    const textPanelStyle = textPanel ? window.getComputedStyle(textPanel) : null;
    const promptStyle = prompt ? window.getComputedStyle(prompt) : null;
    return {
      bodyDark: document.body.classList.contains("body--dark"),
      maskerDark: Boolean(panel?.closest(".masker-dark")),
      panelVisible: Boolean(panel),
      panelText: panel?.textContent || "",
      textPanelVisible: Boolean(textPanel),
      textPanelText: textPanel?.textContent || "",
      promptVisible: Boolean(prompt),
      promptPlaceholder: input?.getAttribute("placeholder") || "",
      promptDisabled:
        Boolean(input?.disabled) ||
        Boolean(prompt?.classList.contains("q-field--disabled")),
      enabledButtonCount: buttons.filter(
        (button) =>
          !button.classList.contains("disabled") &&
          button.getAttribute("aria-disabled") !== "true" &&
          !button.hasAttribute("disabled")
      ).length,
      disabledButtonCount: buttons.filter(
        (button) =>
          button.classList.contains("disabled") ||
          button.getAttribute("aria-disabled") === "true" ||
          button.hasAttribute("disabled")
      ).length,
      buttonCount: buttons.length,
      panelColor: panelStyle?.color || "",
      panelBackground: panelStyle?.backgroundColor || "",
      textPanelColor: textPanelStyle?.color || "",
      promptColor: promptStyle?.color || "",
    };
  });
}

async function openSamTextMenu(page) {
  const prompt = page.locator(".sam-text-panel .sam-text-prompt");
  if (!(await prompt.isVisible().catch(() => false))) {
    await page.locator('[data-testid="sam-text-menu-button"]').click();
  }
  await page.waitForSelector(".sam-text-panel .sam-text-prompt", {
    state: "visible",
    timeout: 10000,
  });
}

async function runSamSmartSelectionUiTest(page) {
  await page.goto(imageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('[data-testid="image-page"]', { timeout: 60000 });
  await waitForImageBridge(page);

  const snapshotAfterUpload = await page.evaluate(async (bytes) => {
    const file = new File([new Uint8Array(bytes)], "Moonshine-SAM-E2E.png", {
      type: "image/png",
      lastModified: Date.now(),
    });
    await window.__MOONSHINE_IMAGE_TEST__.addFile(file);
    window.__MOONSHINE_IMAGE_TEST__.setCurrentModel("lama");
    const snapshot = window.__MOONSHINE_IMAGE_TEST__.getSnapshot();
    window.__MOONSHINE_IMAGE_TEST__.toggleSelectionById(snapshot.currentFileId);
    return window.__MOONSHINE_IMAGE_TEST__.getSnapshot();
  }, Array.from(tinyPngBytes));
  assert(snapshotAfterUpload.fileCount === 1, "Image upload should add one image.");
  assert(snapshotAfterUpload.selectedSamTextBatchCount === 1, "Uploaded image should be selected for SAM text batch search.");

  await page.waitForFunction(
    () => window.__MOONSHINE_IMAGE_TEST__?.getSnapshot().samModelOptions.length >= 2,
    null,
    { timeout: 20000 }
  );

  const smartSnapshot = await page.evaluate(() => {
    const bridge = window.__MOONSHINE_IMAGE_TEST__;
    const before = bridge.getSnapshot();
    const smart = bridge.setMaskMode("smart");
    return { before, smart };
  });
  assert(
    smartSnapshot.smart.samModelOptions.includes("sam_vit_b") &&
      smartSnapshot.smart.samModelOptions.includes("sam2_1_hiera_large"),
    "Smart selection should offer installed SAM1/SAM2 point and box models."
  );
  assert(
    !smartSnapshot.smart.samModelOptions.includes("sam3_1_multiplex"),
    "Smart selection point/box model selector must exclude SAM3 text models."
  );
  assert(
    !smartSnapshot.smart.samModelOptions.includes("sam3"),
    "Smart selection point/box model selector must exclude SAM3 base text models."
  );
  assert(
    smartSnapshot.smart.maskMode === "smart" && smartSnapshot.smart.smartSelectionMode === true,
    "Image bridge should put the page into smart selection mode."
  );
  assert(
    smartSnapshot.smart.samTextAvailable &&
      smartSnapshot.smart.defaultSamTextModelId === "sam3_1_multiplex",
    "SAM text smart selection should use SAM3.1 as the default text model when capabilities allow it."
  );

  await page.waitForSelector(".sam-toolbar", { state: "visible", timeout: 20000 });
  await openSamTextMenu(page);
  await page.fill(".sam-text-panel .sam-text-prompt input", "red rectangle");

  const themeButton = page.locator('[data-testid="toggle-theme-button"]');
  if (await page.evaluate(() => document.body.classList.contains("body--dark"))) {
    await themeButton.click();
    await page.waitForFunction(() => document.body.classList.contains("body--light"), null, {
      timeout: 5000,
    });
  }

  const lightState = await collectSamPanelState(page);
  assert(lightState.panelVisible, "SAM smart selection toolbar should be visible in light mode.");
  assert(lightState.textPanelVisible, "SAM text menu should be visible in light mode.");
  assert(lightState.promptVisible, "SAM text placeholder should be visible in light mode.");
  assert(lightState.panelText.includes("智能选区拖动区域"), "SAM toolbar should show the smart selection drag label.");
  assert(lightState.textPanelText.includes("自定义文本"), "SAM text menu should show the custom text label.");
  assert(
    lightState.promptPlaceholder.includes("输入短名词短语"),
    "SAM text prompt should show the current-image target placeholder."
  );
  assert(!lightState.promptDisabled, "SAM text prompt should be enabled when SAM3 is installed.");
  assert(
    lightState.buttonCount === 2 && lightState.enabledButtonCount === 2,
    "Current-image and selected-images text search should be enabled when SAM3 text is available and an image is selected."
  );

  await page.locator(".sam-text-actions .q-btn").nth(1).click();
  await page.waitForFunction(
    () => {
      const snapshot = window.__MOONSHINE_IMAGE_TEST__?.getSnapshot?.();
      return (
        snapshot?.currentHasMask &&
        snapshot?.samTextBatchState?.running === false &&
        snapshot?.samTextBatchState?.success === 1 &&
        snapshot?.samTextBatchState?.failed === 0
      );
    },
    null,
    { timeout: 10000 }
  );

  await themeButton.click();
  await page.waitForSelector(".masker-dark .sam-toolbar", { state: "visible", timeout: 5000 });
  await openSamTextMenu(page);

  const darkState = await collectSamPanelState(page);
  assert(
    darkState.bodyDark && darkState.maskerDark,
    "The smoke test should switch the page into Quasar dark mode."
  );
  assert(darkState.panelVisible, "SAM smart selection toolbar should remain visible in dark mode.");
  assert(darkState.textPanelVisible, "SAM text menu should remain visible in dark mode.");
  assert(darkState.promptVisible, "SAM text placeholder should remain visible in dark mode.");
  assert(!darkState.promptDisabled, "SAM text prompt should remain enabled in dark mode.");
  assert(
    darkState.textPanelColor !== lightState.textPanelColor,
    "SAM text menu should expose a distinct dark-mode style."
  );
}

async function main() {
  ensureBuildArtifacts();
  const server = await startStaticServer();
  const executablePath = resolveChromiumExecutable();
  const browser = await chromium.launch({
    headless: process.env.MOONSHINE_E2E_HEADLESS !== "0",
    executablePath,
    args: ["--disable-dev-shm-usage", "--no-default-browser-check"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await installElectronMock(context);
  const page = await context.newPage();
  await installApiMocks(page);

  const consoleProblems = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      const text = message.text();
      if (!/Failed to load resource: net::ERR_UNKNOWN_URL_SCHEME/i.test(text)) {
        consoleProblems.push(`${message.type()}: ${text}`);
      }
    }
  });
  page.on("pageerror", (error) => {
    consoleProblems.push(`pageerror: ${error.message}`);
  });

  try {
    await runSamSmartSelectionUiTest(page);
    assert(
      consoleProblems.length === 0,
      `Unexpected console/page errors:\n${consoleProblems.join("\n")}`
    );
    console.log("SAM smart selection UI smoke test passed.");
  } finally {
    await context.close();
    await browser.close();
    await closeStaticServer(server);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
