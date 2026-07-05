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
const port = Number(process.env.MOONSHINE_E2E_PORT || 9181);
const baseUrl = `http://${host}:${port}`;
const imageUrl = `${baseUrl}/#/image`;
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

function ensureBuildArtifacts() {
  if (process.env.MOONSHINE_E2E_SKIP_BUILD === "1" && fs.existsSync(indexHtmlPath)) {
    return;
  }

  runCommand({
    label: "Build (image toolbar responsive smoke)",
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

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
}

async function waitForToolbar(page) {
  await page.waitForSelector(".image-processing-toolbar", {
    state: "visible",
    timeout: 30000,
  });
}

async function collectToolbarMetrics(page) {
  return page.evaluate(() => {
    const toolbar = document.querySelector(".image-processing-toolbar");
    const row = document.querySelector(".image-processing-toolbar > .row");
    const fileArea = document.querySelector(".toolbar-file-area");
    const actionArea = document.querySelector(".toolbar-actions");
    const maskToggle = document.querySelector(".mask-mode-toggle");
    const maskButtons = Array.from(
      document.querySelectorAll(".mask-mode-button-target")
    ).map((target) => {
      const label = Array.from(target.querySelectorAll(".q-btn__content span"))
        .map((node) => node.textContent.trim())
        .filter(Boolean)
        .join(" ");
      const button = target.querySelector(".q-btn");
      const icon = target.querySelector(".q-icon");
      const text = target.querySelector(".q-btn__content span");
      const iconRect = icon?.getBoundingClientRect();
      const textRect = text?.getBoundingClientRect();
      return {
        testid: button?.getAttribute("data-testid") || "",
        label,
        active: target.classList.contains("mask-mode-button-target--active"),
        iconTextGap:
          iconRect && textRect ? Math.round((textRect.left - iconRect.right) * 100) / 100 : null,
      };
    });
    const labels = Array.from(
      document.querySelectorAll(".image-processing-toolbar .q-btn__content span")
    )
      .map((node) => node.textContent.trim())
      .filter(Boolean);

    const rectOf = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
      };
    };

    return {
      viewportWidth: window.innerWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      toolbarScrollWidth: toolbar?.scrollWidth || 0,
      toolbarClientWidth: toolbar?.clientWidth || 0,
      row: rectOf(row),
      fileArea: rectOf(fileArea),
      actionArea: rectOf(actionArea),
      maskToggle: rectOf(maskToggle),
      maskButtons,
      labels,
    };
  });
}

async function openImagePage(browser, viewport) {
  const page = await browser.newPage({ viewport });
  await page.goto(imageUrl, { waitUntil: "networkidle" });
  await waitForToolbar(page);
  return page;
}

function assertNoHorizontalOverflow(metrics, label = "Image toolbar") {
  assert(
    metrics.documentScrollWidth <= metrics.viewportWidth + 1,
    `${label} should not create horizontal page overflow.`
  );
  assert(
    metrics.toolbarScrollWidth <= metrics.toolbarClientWidth + 1,
    `${label} should not overflow its visible width.`
  );
}

async function assertDesktopMaskButtons(browser) {
  const page = await openImagePage(browser, { width: 1024, height: 720 });
  try {
    const metrics = await collectToolbarMetrics(page);
    console.log(JSON.stringify({ viewport: "desktop", ...metrics }, null, 2));

    assertNoHorizontalOverflow(metrics, "Desktop image toolbar");
    assert(
      Array.isArray(metrics.maskButtons) && metrics.maskButtons.length === 3,
      "Desktop mask mode group should render all three independent buttons."
    );
    const activeButtons = metrics.maskButtons.filter((button) => button.active);
    assert(activeButtons.length === 1, "Desktop mask mode group should have one active button.");
    assert(
      Boolean(activeButtons[0].label),
      "Desktop mask mode group should show text on the active button."
    );
    assert(
      activeButtons[0].iconTextGap !== null && activeButtons[0].iconTextGap <= 6,
      `Desktop active mask mode icon and text should be compact, got gap ${activeButtons[0].iconTextGap}.`
    );
    assert(
      metrics.maskButtons
        .filter((button) => !button.active)
        .every((button) => !button.label),
      "Desktop mask mode group should keep inactive buttons icon-only."
    );
  } finally {
    await page.close();
  }
}

async function assertNarrowToolbar(browser) {
  const page = await openImagePage(browser, { width: 360, height: 720 });
  try {
    const metrics = await collectToolbarMetrics(page);
    console.log(JSON.stringify({ viewport: "narrow", ...metrics }, null, 2));

    assertNoHorizontalOverflow(metrics, "Narrow image toolbar");
    assert(
      Array.isArray(metrics.labels) && metrics.labels.length === 0,
      "Image toolbar should hide bottom text labels at the narrow breakpoint."
    );
    assert(
      Array.isArray(metrics.maskButtons) && metrics.maskButtons.length === 1,
      "Narrow mask mode group should render only the current button."
    );
    assert(
      metrics.maskButtons.every((button) => !button.label),
      "Narrow mask mode button should stay icon-only even when selected."
    );
  } finally {
    await page.close();
  }
}

async function run() {
  ensureBuildArtifacts();
  const server = await startStaticServer();
  let browser = null;

  try {
    browser = await chromium.launch({
      executablePath: resolveChromiumExecutable(),
      headless: true,
    });
    await assertDesktopMaskButtons(browser);
    await assertNarrowToolbar(browser);
  } finally {
    if (browser) await browser.close();
    await closeServer(server);
  }

  console.log("Image toolbar responsive smoke test passed.");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
