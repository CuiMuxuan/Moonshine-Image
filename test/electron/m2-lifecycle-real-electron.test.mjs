import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const fixturePath = path.join(__dirname, "fixtures", "m2-lifecycle-real-electron-main.mjs");
const require = createRequire(import.meta.url);
const electronExecutable = require("electron");
const electronMainPath = path.join(repoRoot, "src-electron", "electron-main.js");

function fixtureEnvironment(userDataDir, mode) {
  return {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    M2_LIFECYCLE_MODE: mode,
    M2_LIFECYCLE_USER_DATA_DIR: userDataDir,
  };
}

function startFixture(userDataDir, mode) {
  const child = spawn(electronExecutable, [fixturePath, `--user-data-dir=${userDataDir}`], {
    cwd: repoRoot,
    env: fixtureEnvironment(userDataDir, mode),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let exitResult = null;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      exitResult = { code, signal };
      resolve(exitResult);
    });
  });
  return {
    child,
    exited,
    output: () => ({ stdout, stderr, exitResult }),
  };
}

async function waitFor(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function parseResult(stdout) {
  const line = stdout.split(/\r?\n/).find((item) => item.startsWith("M2_LIFE_RESULT "));
  return line ? JSON.parse(line.slice("M2_LIFE_RESULT ".length)) : null;
}

function displayUnavailable(output) {
  return /M2_LIFE_RESULT \{"status":"unavailable"|cannot open display|missing x server|failed to initialize|failed to create browserwindow/i.test(
    `${output.stdout}\n${output.stderr}`,
  );
}

test("real Electron close-to-tray and second-instance restore retain the same renderer", async (t) => {
  if (typeof electronExecutable !== "string" || !(await fs.stat(electronExecutable).catch(() => null))) {
    t.skip("Electron executable is not installed in this worktree.");
    return;
  }

  const electronMain = await fs.readFile(electronMainPath, "utf8");
  assert.match(
    electronMain,
    /app\.on\("second-instance", \(\) => \{\s*void restoreMainWindow\(\)\.catch\(handleFatalStartupError\);\s*\}\);/,
    "production second-instance handling restores without caller-provided navigation",
  );

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-m2-life-"));
  const userDataDir = path.join(tempRoot, "user-data");
  const primary = startFixture(userDataDir, "primary");

  try {
    await waitFor(
      () => primary.output().stdout.includes("M2_LIFE_READY") || primary.output().exitResult,
      "isolated Electron primary readiness",
    );
    const primaryBeforeSecondary = primary.output();
    const primaryResult = parseResult(primaryBeforeSecondary.stdout);
    if (primaryResult?.status === "unavailable" || displayUnavailable(primaryBeforeSecondary)) {
      t.skip(`Real Electron window unavailable in this environment: ${primaryResult?.reason || primaryBeforeSecondary.stderr}`);
      return;
    }
    assert.match(primaryBeforeSecondary.stdout, /M2_LIFE_READY/, primaryBeforeSecondary.stderr);

    const secondary = startFixture(userDataDir, "secondary");
    const secondaryExit = await secondary.exited;
    assert.equal(secondaryExit.code, 0, `${JSON.stringify(secondary.output())}`);
    assert.match(secondary.output().stdout, /M2_LIFE_SECONDARY_FORWARDED/);

    const primaryExit = await primary.exited;
    const output = primary.output();
    const result = parseResult(output.stdout);
    assert.equal(primaryExit.code, 0, `${output.stderr}\n${output.stdout}`);
    assert.deepEqual(result?.status, "pass", `${output.stderr}\n${output.stdout}`);
    assert.equal(result.browser_window_destroyed, false);
    assert.equal(result.renderer_destroyed, false);
    assert.equal(result.second_instance_events, 1);
    assert.equal(result.restore_calls >= 1, true);
    assert.equal(result.show_calls >= 1, true);
    assert.equal(result.focus_calls >= 1, true);
    assert.deepEqual(result.navigation, [{ route: "/activity/mcp", source: "tray" }]);
    assert.equal(result.lifecycle_state.active_task_count, 1);
  } finally {
    primary.child.kill();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
