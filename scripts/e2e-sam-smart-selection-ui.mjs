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
let lastSamPredictRequest = null;

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

function resolveSpawnCommand(command, args = []) {
  if (isWindows && /\.cmd$/i.test(command)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }
  return { command, args };
}

function runCommand({ label, command, args = [] }) {
  console.log(`\n=== ${label} ===`);
  const spawnRequest = resolveSpawnCommand(command, args);
  const result = spawnSync(spawnRequest.command, spawnRequest.args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
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

function waitForCondition(predicate, timeoutMs, description) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for ${description}`));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
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
      launchMode: "cuda",
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
      imageSmartSelectionDefaultModel: "sam3",
      videoSmartSelectionDefaultModel: "sam2_1_hiera_large",
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
      body: JSON.stringify({ cuda_available: true, torch_cuda_available: true, cuda_device_count: 1, device: "cuda" }),
    });
  });
  await page.route("**/api/v1/moonshine/models**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        currentModel: "lama",
        modelDir: "C:\\Moonshine-E2E\\models",
        cuda: { cuda_available: true, torch_cuda_available: true, cuda_device_count: 1 },
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
            enabledCapabilities: {
              imagePoint: true,
              imageBox: true,
              imageText: false,
              videoPoint: false,
              videoBox: false,
              videoText: false,
              videoPropagate: false,
            },
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
            enabledCapabilities: {
              imagePoint: true,
              imageBox: true,
              imageText: false,
              videoPoint: true,
              videoBox: true,
              videoText: false,
              videoPropagate: true,
            },
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
            enabledCapabilities: {
              imagePoint: true,
              imageBox: true,
              imageText: true,
              videoPoint: false,
              videoBox: true,
              videoText: true,
              videoPropagate: true,
            },
            runCapabilities: {
              scopes: ["currentImage", "selectedImages", "videoFrames"],
              maskPrompts: ["point", "box", "text"],
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
            enabledCapabilities: {
              imagePoint: false,
              imageBox: false,
              imageText: true,
              videoPoint: false,
              videoBox: true,
              videoText: true,
              videoPropagate: true,
            },
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
  await page.route("**/api/v1/moonshine/sam/predict", async (route) => {
    const body = route.request().postDataJSON?.() || {};
    lastSamPredictRequest = body;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        modelId: body.model_id || "sam3_1_multiplex",
        imageHash: "e2e-sam-pointbox",
        width: 1,
        height: 1,
        prompt: {
          type: body.box ? "box" : "point",
          points: body.points || [],
          box: body.box || null,
        },
        candidates: [
          {
            id: "e2e-pointbox-candidate-0",
            index: 0,
            mask: `data:image/png;base64,${solidMaskPngBase64}`,
            score: 0.93,
            box: { x: 0, y: 0, width: 1, height: 1, x0: 0, y0: 0, x1: 1, y1: 1 },
            promptType: body.box ? "box" : "point",
            prompt: {
              type: body.box ? "box" : "point",
              points: body.points || [],
              box: body.box || null,
            },
          },
          {
            id: "e2e-pointbox-candidate-1",
            index: 1,
            mask: `data:image/png;base64,${solidMaskPngBase64}`,
            score: 0.82,
            box: { x: 0, y: 0, width: 1, height: 1, x0: 0, y0: 0, x1: 1, y1: 1 },
            promptType: body.box ? "box" : "point",
          },
          {
            id: "e2e-pointbox-candidate-2",
            index: 2,
            mask: `data:image/png;base64,${solidMaskPngBase64}`,
            score: 0.71,
            box: { x: 0, y: 0, width: 1, height: 1, x0: 0, y0: 0, x1: 1, y1: 1 },
            promptType: body.box ? "box" : "point",
          },
        ],
        performance: {
          device: "cuda",
          imageCacheHit: false,
          imageMegapixels: 0.01,
          totalMs: 10,
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
    const textPanel = document.querySelector('[data-testid="sam-text-settings-section"]');
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
      promptValue: input?.value || "",
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
  const isPromptVisible = async () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="sam-text-settings-section"] .sam-text-prompt'))
        .some((item) => item.getClientRects().length > 0)
    );
  const clickVisibleSettingsButton = async () => {
    const rect = await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll('[data-testid="sam-settings-button"]'))
        .find((item) => item.getClientRects().length > 0);
      if (!button) return null;
      const { left, top, width, height } = button.getBoundingClientRect();
      return {
        x: left + width / 2,
        y: top + height / 2,
        width,
        height,
      };
    });
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    await page.mouse.click(rect.x, rect.y);
    return true;
  };
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await isPromptVisible()) return;
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll('[data-testid="sam-settings-button"]'))
            .some((button) => button.getClientRects().length > 0),
        null,
        { timeout: 10000 }
      );
      await clickVisibleSettingsButton();
      try {
        await page.waitForFunction(
          () =>
            Array.from(document.querySelectorAll('[data-testid="sam-text-settings-section"] .sam-text-prompt'))
              .some((item) => item.getClientRects().length > 0),
          null,
          { timeout: 1500 }
        );
        return;
      } catch (error) {
        await page.waitForTimeout(150);
      }
    }
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('[data-testid="sam-text-settings-section"] .sam-text-prompt'))
          .some((item) => item.getClientRects().length > 0),
      null,
      { timeout: 10000 }
    );
  } catch (error) {
    const debugState = await page.evaluate(() => ({
      snapshot: window.__MOONSHINE_IMAGE_TEST__?.getSnapshot?.(),
      settingsButtonCount: document.querySelectorAll('[data-testid="sam-settings-button"]').length,
      visibleSettingsButtonCount: Array.from(document.querySelectorAll('[data-testid="sam-settings-button"]'))
        .filter((button) => button.getClientRects().length > 0).length,
      promptCount: document.querySelectorAll('[data-testid="sam-text-settings-section"] .sam-text-prompt').length,
      visiblePromptCount: Array.from(
        document.querySelectorAll('[data-testid="sam-text-settings-section"] .sam-text-prompt')
      ).filter((item) => item.getClientRects().length > 0).length,
      panelText: document.querySelector(".sam-toolbar")?.textContent || "",
    }));
    throw new Error(`Failed to open SAM text menu: ${JSON.stringify(debugState)}`);
  }
}

async function fillSamTextPrompt(page, value) {
  try {
    await page.waitForFunction(
      () =>
        Array.from(
          document.querySelectorAll('[data-testid="sam-text-settings-section"] .sam-text-prompt input')
        ).some((input) => input.getClientRects().length > 0 && !input.disabled),
      null,
      { timeout: 10000 }
    );
  } catch (error) {
    const debugState = await page.evaluate(() => ({
      snapshot: window.__MOONSHINE_IMAGE_TEST__?.getSnapshot?.(),
      inputCount: document.querySelectorAll('[data-testid="sam-text-settings-section"] .sam-text-prompt input').length,
      visibleInputCount: Array.from(
        document.querySelectorAll('[data-testid="sam-text-settings-section"] .sam-text-prompt input')
      ).filter((input) => input.getClientRects().length > 0 && !input.disabled).length,
    }));
    throw new Error(`Failed to fill SAM text prompt: ${JSON.stringify(debugState)}`);
  }
  await page.evaluate((nextValue) => {
    const input = Array.from(
      document.querySelectorAll('[data-testid="sam-text-settings-section"] .sam-text-prompt input')
    ).find((item) => item.getClientRects().length > 0 && !item.disabled);
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(input, nextValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function drawManualMaskStrokeOnCanvas(page) {
  const maskCanvas = page.locator('[data-testid="image-mask-canvas"]');
  await maskCanvas.waitFor({ state: "visible", timeout: 10000 });
  const canvasBox = await maskCanvas.boundingBox();
  assert(
    canvasBox && canvasBox.width > 0 && canvasBox.height > 0,
    "Image mask canvas should be visible before drawing a regression mask."
  );
  const x = canvasBox.x + canvasBox.width / 2;
  const y = canvasBox.y + canvasBox.height / 2;
  const dx = Math.max(1, Math.min(12, canvasBox.width / 4));
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 2 });
  await page.mouse.up();
}

async function clickSamTextBatchButton(page) {
  try {
    await page.waitForFunction(
      () => {
        const button = Array.from(document.querySelectorAll('[data-testid="sam-text-batch-button"]'))
          .find((item) => item.getClientRects().length > 0);
        return (
          button &&
          !button.classList.contains("disabled") &&
          button.getAttribute("aria-disabled") !== "true" &&
          !button.hasAttribute("disabled")
        );
      },
      null,
      { timeout: 10000 }
    );
  } catch (error) {
    const debugState = await page.evaluate(() => ({
      snapshot: window.__MOONSHINE_IMAGE_TEST__?.getSnapshot?.(),
      buttonCount: document.querySelectorAll('[data-testid="sam-text-batch-button"]').length,
      visibleButtonCount: Array.from(document.querySelectorAll('[data-testid="sam-text-batch-button"]'))
        .filter((button) => button.getClientRects().length > 0).length,
      buttonStates: Array.from(document.querySelectorAll('[data-testid="sam-text-batch-button"]'))
        .map((button) => ({
          text: button.textContent || "",
          visible: button.getClientRects().length > 0,
          disabled:
            Boolean(button.classList.contains("disabled")) ||
            button.getAttribute("aria-disabled") === "true" ||
            Boolean(button.hasAttribute("disabled")),
        })),
    }));
    throw new Error(`Failed to click SAM text batch button: ${JSON.stringify(debugState)}`);
  }
  await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('[data-testid="sam-text-batch-button"]'))
      .find((item) => item.getClientRects().length > 0);
    button?.click();
  });
}

async function runBatchMixedMaskCleanupRegression(page) {
  const setup = await page.evaluate(async ({ bytes, maskDataUrl }) => {
    const bridge = window.__MOONSHINE_IMAGE_TEST__;
    bridge.clearSelection();
    const ids = [];
    for (const name of ["A", "B", "3", "4"]) {
      const file = new File([new Uint8Array(bytes)], `Moonshine-SAM-Batch-${name}.png`, {
        type: "image/png",
        lastModified: Date.now(),
      });
      const fileData = await bridge.addFile(file);
      ids.push(fileData.id);
    }
    bridge.setCurrentModel("lama");
    bridge.setCurrentFile(ids[0]);
    bridge.setMask(ids[0], maskDataUrl);
    bridge.setMask(ids[1], maskDataUrl);
    ids.forEach((fileId) => bridge.toggleSelectionById(fileId));
    bridge.setMaskMode("smart");
    return {
      ids,
      snapshot: bridge.getSnapshot(),
    };
  }, {
    bytes: Array.from(tinyPngBytes),
    maskDataUrl: `data:image/png;base64,${solidMaskPngBase64}`,
  });

  assert(setup.ids.length === 4, "Batch cleanup regression should create four images.");
  assert(
    setup.snapshot.selectedSamTextBatchCount === 4,
    "Batch cleanup regression should select only the four new images."
  );
  assert(
    setup.snapshot.maskStates.filter((state) => setup.ids.includes(state.id) && state.hasMask)
      .length === 2,
    "Batch cleanup regression should start with two manual masks."
  );

  await page.evaluate(() =>
    window.__MOONSHINE_IMAGE_TEST__?.runSamTextBatchPrediction?.({
      text: "red rectangle",
      language: "auto",
      modelId: "sam3",
      promptSource: "manual",
    })
  );
  try {
    await page.waitForFunction(
      () => {
        const snapshot = window.__MOONSHINE_IMAGE_TEST__?.getSnapshot?.();
        return (
          snapshot?.samTextBatchState?.running === false &&
          snapshot?.samTextBatchState?.total === 4 &&
          snapshot?.samTextBatchState?.success === 4 &&
          snapshot?.samTextBatchState?.failed === 0
        );
      },
      null,
      { timeout: 15000 }
    );
  } catch (error) {
    const debugState = await page.evaluate((ids) => {
      const snapshot = window.__MOONSHINE_IMAGE_TEST__?.getSnapshot?.();
      const button = document.querySelector('[data-testid="sam-text-batch-button"]');
      return {
        ids,
        snapshot,
        buttonText: button?.textContent || "",
        buttonDisabled:
          Boolean(button?.classList.contains("disabled")) ||
          button?.getAttribute("aria-disabled") === "true" ||
          Boolean(button?.hasAttribute("disabled")),
      };
    }, setup.ids);
    throw new Error(`Four-image SAM batch did not finish as expected: ${JSON.stringify(debugState)}`);
  }

  const afterSamBatch = await page.evaluate((ids) => {
    const snapshot = window.__MOONSHINE_IMAGE_TEST__?.getSnapshot?.();
    return {
      maskStates: snapshot.maskStates.filter((state) => ids.includes(state.id)),
      selectedSamTextBatchCount: snapshot.selectedSamTextBatchCount,
    };
  }, setup.ids);
  assert(
    afterSamBatch.maskStates.every((state) => state.hasMask),
    "SAM selected-images text search should write a mask for every regression image."
  );

  const afterFinalize = await page.evaluate(async (ids) => {
    const bridge = window.__MOONSHINE_IMAGE_TEST__;
    await bridge.finalizeSuccessfulMaskRun(ids);
    return bridge.getSnapshot().maskStates.filter((state) => ids.includes(state.id));
  }, setup.ids);
  assert(
    afterFinalize.every((state) => !state.hasMask),
    "Successful batch processing should clear stored masks for every regression image."
  );

  for (const fileId of setup.ids) {
    const currentState = await page.evaluate(async (id) => {
      const bridge = window.__MOONSHINE_IMAGE_TEST__;
      bridge.setCurrentFile(id);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise((resolve) => setTimeout(resolve, 80));
      return bridge.getSnapshot();
    }, fileId);
    assert(
      !currentState.currentHasMask,
      `Processed image ${fileId} should not restore a manual or SAM mask after switching back.`
    );
  }
}

async function runUnselectedSamFallbackPreservationRegression(page) {
  const setup = await page.evaluate(async ({ bytes, maskDataUrl }) => {
    const bridge = window.__MOONSHINE_IMAGE_TEST__;
    bridge.clearSelection();
    const ids = [];
    for (const name of ["Selected-A", "Selected-B", "Unselected-3", "Unselected-4"]) {
      const file = new File([new Uint8Array(bytes)], `Moonshine-SAM-Preserve-${name}.png`, {
        type: "image/png",
        lastModified: Date.now(),
      });
      const fileData = await bridge.addFile(file);
      ids.push(fileData.id);
    }
    bridge.setCurrentModel("lama");
    ids.forEach((fileId) => bridge.setMask(fileId, maskDataUrl));
    bridge.toggleSelectionById(ids[0]);
    bridge.toggleSelectionById(ids[1]);

    const fallbackContextId = bridge
      .getSamContextIdsForFile(ids[2])
      .find((contextId) => contextId.startsWith("base64:") || contextId.startsWith("path:"));
    bridge.setSamSession(fallbackContextId, {
      candidates: [
        {
          localId: "unselected-shared-fallback-candidate",
          enabled: true,
          mask: maskDataUrl,
          source: "text",
          score: 0.91,
          createdAt: new Date().toISOString(),
        },
      ],
      baseSnapshotDataUrl: maskDataUrl,
      width: 1,
      height: 1,
      operationIndex: 1,
    });

    return {
      ids,
      fallbackContextId,
      beforeHasFallbackSession: bridge.hasSamSession(fallbackContextId),
      snapshot: bridge.getSnapshot(),
    };
  }, {
    bytes: Array.from(tinyPngBytes),
    maskDataUrl: `data:image/png;base64,${solidMaskPngBase64}`,
  });

  assert(
    setup.beforeHasFallbackSession,
    "Regression setup should seed a shared fallback SAM session for unselected images."
  );
  assert(
    setup.snapshot.selectedFileIds.length === 2 &&
      setup.snapshot.selectedFileIds.includes(setup.ids[0]) &&
      setup.snapshot.selectedFileIds.includes(setup.ids[1]),
    "Regression setup should select only A and B."
  );

  const afterFinalize = await page.evaluate(async ({ ids, fallbackContextId }) => {
    const bridge = window.__MOONSHINE_IMAGE_TEST__;
    await bridge.finalizeSuccessfulMaskRun(ids.slice(0, 2));
    return {
      hasFallbackSession: bridge.hasSamSession(fallbackContextId),
      snapshot: bridge.getSnapshot(),
    };
  }, setup);

  assert(
    afterFinalize.hasFallbackSession,
    "Processing selected images must not delete SAM fallback sessions still referenced by unselected images."
  );
  const states = new Map(afterFinalize.snapshot.maskStates.map((state) => [state.id, state.hasMask]));
  assert(!states.get(setup.ids[0]) && !states.get(setup.ids[1]), "Selected A/B masks should be cleared.");
  assert(states.get(setup.ids[2]) && states.get(setup.ids[3]), "Unselected 3/4 masks should be preserved.");
}

async function runMaskLifecycleMatrixRegression(page) {
  const setup = await page.evaluate(async ({ bytes, maskDataUrl }) => {
    const bridge = window.__MOONSHINE_IMAGE_TEST__;
    bridge.clearSelection();
    bridge.setCurrentModel("lama");
    const files = {};
    const createFile = async ({ key, label, selected, manual, sam }) => {
      const file = new File([new Uint8Array(bytes)], `Moonshine-SAM-Matrix-${label}.png`, {
        type: "image/png",
        lastModified: Date.now(),
      });
      const fileData = await bridge.addFile(file);
      if (manual || sam) {
        bridge.setMask(fileData.id, maskDataUrl);
      }
      if (sam) {
        bridge.setSamSession(fileData.id, {
          candidates: [
            {
              localId: `${key}-candidate`,
              enabled: true,
              mask: maskDataUrl,
              source: "text",
              score: 0.91,
              createdAt: new Date().toISOString(),
            },
          ],
          baseSnapshotDataUrl: manual ? maskDataUrl : "",
          width: 1,
          height: 1,
          operationIndex: 1,
        });
      }
      if (selected) {
        bridge.toggleSelectionById(fileData.id);
      }
      files[key] = {
        id: fileData.id,
        selected,
        manual,
        sam,
      };
    };

    await createFile({
      key: "selectedManualOnly",
      label: "Selected-Manual-Only",
      selected: true,
      manual: true,
      sam: false,
    });
    await createFile({
      key: "selectedSamOnly",
      label: "Selected-SAM-Only",
      selected: true,
      manual: false,
      sam: true,
    });
    await createFile({
      key: "selectedMixed",
      label: "Selected-Mixed",
      selected: true,
      manual: true,
      sam: true,
    });
    await createFile({
      key: "unselectedManualOnly",
      label: "Unselected-Manual-Only",
      selected: false,
      manual: true,
      sam: false,
    });
    await createFile({
      key: "unselectedSamOnly",
      label: "Unselected-SAM-Only",
      selected: false,
      manual: false,
      sam: true,
    });
    await createFile({
      key: "unselectedMixed",
      label: "Unselected-Mixed",
      selected: false,
      manual: true,
      sam: true,
    });

    return {
      files,
      snapshot: bridge.getSnapshot(),
    };
  }, {
    bytes: Array.from(tinyPngBytes),
    maskDataUrl: `data:image/png;base64,${solidMaskPngBase64}`,
  });

  const selectedIds = Object.values(setup.files)
    .filter((file) => file.selected)
    .map((file) => file.id);
  assert(selectedIds.length === 3, "Matrix setup should select three processed images.");
  assert(
    setup.snapshot.selectedFileIds.length === 3 &&
      selectedIds.every((fileId) => setup.snapshot.selectedFileIds.includes(fileId)),
    "Matrix setup should select only the three processed images."
  );

  const afterFinalize = await page.evaluate(async ({ files, selectedIds }) => {
    const bridge = window.__MOONSHINE_IMAGE_TEST__;
    await bridge.finalizeSuccessfulMaskRun(selectedIds);
    const snapshot = bridge.getSnapshot();
    const maskStates = new Map(snapshot.maskStates.map((state) => [state.id, state.hasMask]));
    return Object.fromEntries(
      Object.entries(files).map(([key, file]) => [
        key,
        {
          hasMask: Boolean(maskStates.get(file.id)),
          session: bridge.getSamSessionSummary(file.id),
        },
      ])
    );
  }, {
    files: setup.files,
    selectedIds,
  });

  for (const key of ["selectedManualOnly", "selectedSamOnly", "selectedMixed"]) {
    assert(!afterFinalize[key].hasMask, `${key} mask should be cleared after successful processing.`);
    assert(!afterFinalize[key].session.exists, `${key} SAM session should be cleared after successful processing.`);
  }

  assert(afterFinalize.unselectedManualOnly.hasMask, "Unselected manual-only mask should be preserved.");
  assert(
    !afterFinalize.unselectedManualOnly.session.exists,
    "Unselected manual-only image should not gain a SAM session."
  );
  assert(afterFinalize.unselectedSamOnly.hasMask, "Unselected SAM-only composite mask should be preserved.");
  assert(afterFinalize.unselectedSamOnly.session.exists, "Unselected SAM-only session should be preserved.");
  assert(
    afterFinalize.unselectedSamOnly.session.enabledCandidateCount === 1 &&
      !afterFinalize.unselectedSamOnly.session.hasBaseSnapshotDataUrl,
    "Unselected SAM-only session should keep candidates without inventing a manual base layer."
  );
  assert(afterFinalize.unselectedMixed.hasMask, "Unselected mixed mask should be preserved.");
  assert(afterFinalize.unselectedMixed.session.exists, "Unselected mixed SAM session should be preserved.");
  assert(
    afterFinalize.unselectedMixed.session.enabledCandidateCount === 1 &&
      afterFinalize.unselectedMixed.session.hasBaseSnapshotDataUrl,
    "Unselected mixed session should keep both SAM candidates and the manual base layer."
  );

  const afterSwitchingUnselected = await page.evaluate(async ({ files }) => {
    const bridge = window.__MOONSHINE_IMAGE_TEST__;
    const keys = ["unselectedManualOnly", "unselectedSamOnly", "unselectedMixed"];
    const waitForCanvasMask = async (timeoutMs = 1200) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (bridge.getCurrentCanvasMaskDataUrl()) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return Boolean(bridge.getCurrentCanvasMaskDataUrl());
    };
    const result = {};
    for (const key of keys) {
      bridge.setCurrentFile(files[key].id);
      const canvasHasMask = await waitForCanvasMask();
      const snapshot = bridge.getSnapshot();
      result[key] = {
        currentHasMask: snapshot.currentHasMask,
        canvasHasMask,
        session: bridge.getSamSessionSummary(files[key].id),
      };
    }
    return result;
  }, {
    files: setup.files,
  });

  assert(
    afterSwitchingUnselected.unselectedManualOnly.currentHasMask &&
      afterSwitchingUnselected.unselectedManualOnly.canvasHasMask,
    "Switching back to unselected manual-only image should keep its mask visible on canvas."
  );
  assert(
    afterSwitchingUnselected.unselectedSamOnly.currentHasMask &&
      afterSwitchingUnselected.unselectedSamOnly.canvasHasMask &&
      afterSwitchingUnselected.unselectedSamOnly.session.enabledCandidateCount === 1,
    "Switching back to unselected SAM-only image should keep its smart candidate visible on canvas."
  );
  assert(
    afterSwitchingUnselected.unselectedMixed.currentHasMask &&
      afterSwitchingUnselected.unselectedMixed.canvasHasMask &&
      afterSwitchingUnselected.unselectedMixed.session.enabledCandidateCount === 1 &&
      afterSwitchingUnselected.unselectedMixed.session.hasBaseSnapshotDataUrl,
    "Switching back to unselected mixed image should keep both manual base and smart candidate state visible."
  );

  await page.evaluate((fileId) => {
    const bridge = window.__MOONSHINE_IMAGE_TEST__;
    bridge.setCurrentFile(fileId);
    bridge.setMaskMode("manual");
  }, setup.files.unselectedSamOnly.id);
  await drawManualMaskStrokeOnCanvas(page);
  await page.waitForFunction(
    (fileId) => {
      const bridge = window.__MOONSHINE_IMAGE_TEST__;
      return Boolean(bridge?.getSamSessionSummary?.(fileId)?.hasBaseSnapshotDataUrl);
    },
    setup.files.unselectedSamOnly.id,
    { timeout: 5000 }
  );

  const afterPostFinalizeManualEdit = await page.evaluate(async ({ editedId, switchAwayId }) => {
    const bridge = window.__MOONSHINE_IMAGE_TEST__;
    const waitForCanvasMask = async (timeoutMs = 1200) => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (bridge.getCurrentCanvasMaskDataUrl()) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return Boolean(bridge.getCurrentCanvasMaskDataUrl());
    };
    const beforeSwitchSession = bridge.getSamSessionSummary(editedId);
    bridge.setCurrentFile(switchAwayId);
    await waitForCanvasMask();
    bridge.setCurrentFile(editedId);
    const canvasHasMask = await waitForCanvasMask();
    return {
      beforeSwitchSession,
      afterSwitchSession: bridge.getSamSessionSummary(editedId),
      canvasHasMask,
      snapshot: bridge.getSnapshot(),
    };
  }, {
    editedId: setup.files.unselectedSamOnly.id,
    switchAwayId: setup.files.unselectedManualOnly.id,
  });
  assert(
    afterPostFinalizeManualEdit.beforeSwitchSession.hasBaseSnapshotDataUrl &&
      afterPostFinalizeManualEdit.afterSwitchSession.hasBaseSnapshotDataUrl,
    "Manual edits made after processing on an unselected SAM-only image should be stored as its SAM base layer."
  );
  assert(
    afterPostFinalizeManualEdit.snapshot.currentHasMask &&
      afterPostFinalizeManualEdit.canvasHasMask,
    "Manual edits made after processing on an unselected SAM-only image should remain visible after switching away and back."
  );
}

async function runSamSmartSelectionUiTest(page) {
  await page.goto(imageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('[data-testid="image-page"]', { timeout: 60000 });
  await waitForImageBridge(page);

  const snapshotAfterUpload = await page.evaluate(async ({ bytes, maskDataUrl }) => {
    const file = new File([new Uint8Array(bytes)], "Moonshine-SAM-E2E.png", {
      type: "image/png",
      lastModified: Date.now(),
    });
    await window.__MOONSHINE_IMAGE_TEST__.addFile(file);
    window.__MOONSHINE_IMAGE_TEST__.setCurrentModel("lama");
    const snapshot = window.__MOONSHINE_IMAGE_TEST__.getSnapshot();
    window.__MOONSHINE_IMAGE_TEST__.setMask(snapshot.currentFileId, maskDataUrl);
    window.__MOONSHINE_IMAGE_TEST__.toggleSelectionById(snapshot.currentFileId);
    return window.__MOONSHINE_IMAGE_TEST__.getSnapshot();
  }, {
    bytes: Array.from(tinyPngBytes),
    maskDataUrl: `data:image/png;base64,${solidMaskPngBase64}`,
  });
  assert(snapshotAfterUpload.fileCount === 1, "Image upload should add one image.");
  assert(snapshotAfterUpload.currentHasMask, "SAM smoke image should start with a manual mask.");
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
    "Smart selection should offer installed SAM1/SAM2.1 point and box models."
  );
  assert(
    smartSnapshot.smart.samModelOptions.includes("sam3_1_multiplex"),
    "Smart selection model selector should include the configured SAM3.1 text model."
  );
  assert(
    smartSnapshot.smart.samModelOptions.includes("sam3"),
    "Smart selection model selector should include installed SAM3 alongside SAM3.1."
  );
  assert(
    smartSnapshot.smart.maskMode === "smart" && smartSnapshot.smart.smartSelectionMode === true,
    "Image bridge should put the page into smart selection mode."
  );
  assert(
    smartSnapshot.smart.samTextAvailable &&
      smartSnapshot.smart.defaultSamTextModelId === "sam3",
    "SAM text smart selection should follow the configured image smart-selection default model."
  );

  await page.waitForSelector(".sam-toolbar", { state: "visible", timeout: 20000 });
  lastSamPredictRequest = null;
  const maskCanvas = page.locator('[data-testid="image-mask-canvas"]');
  await maskCanvas.waitFor({ state: "visible", timeout: 10000 });
  const canvasBox = await maskCanvas.boundingBox();
  assert(
    canvasBox && canvasBox.width > 0 && canvasBox.height > 0,
    "Image mask canvas should be visible before testing SAM3 point selection."
  );
  await maskCanvas.click();
  await waitForCondition(
    () =>
      lastSamPredictRequest?.model_id === "sam3" &&
      Array.isArray(lastSamPredictRequest?.points) &&
      lastSamPredictRequest.points.length === 1,
    10000,
    "SAM3 point selection request"
  );
  assert(
    lastSamPredictRequest.model_id === "sam3",
    "Selecting SAM3 in image smart selection should use SAM3 for point/box requests."
  );

  await openSamTextMenu(page);
  await fillSamTextPrompt(page, "red rectangle");

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

  await clickSamTextBatchButton(page);
  try {
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
  } catch (error) {
    const snapshot = await page.evaluate(() => window.__MOONSHINE_IMAGE_TEST__?.getSnapshot?.());
    const domState = await page.evaluate(() => {
      const batchButton = document.querySelector('[data-testid="sam-text-batch-button"]');
      const promptInput = document.querySelector(
        '[data-testid="sam-text-settings-section"] .sam-text-prompt input'
      );
      return {
        promptValue: promptInput?.value || "",
        batchButtonText: batchButton?.textContent || "",
        batchButtonDisabled:
          Boolean(batchButton?.classList.contains("disabled")) ||
          batchButton?.getAttribute("aria-disabled") === "true" ||
          Boolean(batchButton?.hasAttribute("disabled")),
        cpuRiskDialogVisible: Boolean(document.querySelector(".sam-cpu-risk-dialog")),
      };
    });
    throw new Error(
      `SAM selected-images text search did not finish as expected: ${JSON.stringify({
        snapshot,
        domState,
      })}`
    );
  }

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

  const afterMixedMaskFinalize = await page.evaluate(async () => {
    const bridge = window.__MOONSHINE_IMAGE_TEST__;
    const snapshot = bridge.getSnapshot();
    return bridge.finalizeSuccessfulMaskRun([snapshot.currentFileId]);
  });
  assert(
    !afterMixedMaskFinalize.currentHasMask,
    "Successful mask-required processing should clear mixed manual and SAM smart-selection masks."
  );

  await runBatchMixedMaskCleanupRegression(page);
  await runUnselectedSamFallbackPreservationRegression(page);
  await runMaskLifecycleMatrixRegression(page);
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
