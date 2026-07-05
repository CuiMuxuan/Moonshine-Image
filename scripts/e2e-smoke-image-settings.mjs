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
const port = Number(process.env.MOONSHINE_E2E_PORT || 9173);
const baseUrl = `http://${host}:${port}`;
const imageUrl = `${baseUrl}/#/image`;
const expectedBackendPort = String(process.env.MOONSHINE_E2E_BACKEND_PORT || "8091");
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

function ensureBuildArtifacts() {
  if (
    process.env.MOONSHINE_E2E_SKIP_BUILD === "1" &&
    fs.existsSync(indexHtmlPath)
  ) {
    return;
  }
  runCommand({
    label: "Build (E2E smoke)",
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

async function runSmokeTest() {
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
  await context.addInitScript(() => {
    window.__MOONSHINE_E2E__ = true;
  });

  const page = await context.newPage();

  try {
    await page.goto(imageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector('[data-testid="image-page"]', { timeout: 60000 });

    // 顶部导航入口可见
    await page.waitForSelector('[data-testid="nav-image-button"]', { timeout: 20000 });
    await page.waitForSelector('[data-testid="nav-video-button"]', { timeout: 20000 });

    // 全局设置：打开 -> 修改后端端口 -> 保存 -> 回读校验
    await page.click('[data-testid="open-global-settings-button"]');
    await page.waitForSelector('[data-testid="global-settings-card"]', {
      state: "visible",
      timeout: 20000,
    });

    const backendTab = page.getByRole("tab").nth(1);
    await backendTab.click();
    const backendPanel = page.locator('[data-testid="global-settings-backend-panel"]');
    await backendPanel.waitFor({ state: "visible", timeout: 20000 });

    const backendPortInput = backendPanel.locator('input[type="number"]').first();
    await backendPortInput.waitFor({ state: "visible", timeout: 20000 });
    await backendPortInput.click({ clickCount: 3 });
    await backendPortInput.fill(expectedBackendPort);

    await page.click('[data-testid="global-settings-save-button"]');
    await page.waitForSelector('[data-testid="global-settings-card"]', {
      state: "hidden",
      timeout: 20000,
    });

    await page.click('[data-testid="open-global-settings-button"]');
    await page.waitForSelector('[data-testid="global-settings-card"]', {
      state: "visible",
      timeout: 20000,
    });
    await backendTab.click();
    await backendPanel.waitFor({ state: "visible", timeout: 20000 });
    const persistedPort = await backendPortInput.inputValue();
    if (persistedPort !== expectedBackendPort) {
      throw new Error(
        `Backend port persistence mismatch: expected ${expectedBackendPort}, got ${persistedPort}`
      );
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  ensureBuildArtifacts();
  const server = await startStaticServer();

  try {
    await runSmokeTest();
    console.log("E2E smoke test passed.");
  } finally {
    await closeStaticServer(server);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
