import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow } from "electron";

import { WindowLifecycleController } from "../../../src-electron/window-lifecycle-controller.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const userDataDir = process.env.M2_LIFECYCLE_USER_DATA_DIR;
const mode = process.env.M2_LIFECYCLE_MODE || "primary";

if (!userDataDir) {
  throw new Error("M2_LIFECYCLE_USER_DATA_DIR is required for the isolated Electron fixture.");
}

app.setName("moonshine-m2-lifecycle-e2e");
app.setPath("userData", userDataDir);

function report(payload) {
  process.stdout.write(`M2_LIFE_RESULT ${JSON.stringify(payload)}\n`);
}

function unavailable(error) {
  report({
    status: "unavailable",
    reason: error instanceof Error ? error.message : String(error),
    platform: process.platform,
  });
  app.exit(0);
}

function fail(error) {
  report({
    status: "failed",
    reason: error instanceof Error ? error.stack || error.message : String(error),
  });
  app.exit(1);
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function instrumentWindow(windowInstance, calls) {
  for (const method of ["restore", "show", "focus"]) {
    const original = windowInstance[method].bind(windowInstance);
    Object.defineProperty(windowInstance, method, {
      configurable: true,
      value(...args) {
        calls[method] += 1;
        return original(...args);
      },
    });
  }
}

const hasLock = app.requestSingleInstanceLock();

if (!hasLock) {
  process.stdout.write("M2_LIFE_SECONDARY_FORWARDED\n");
  app.exit(0);
} else if (mode !== "primary") {
  fail(new Error(`Unexpected fixture mode with primary instance lock: ${mode}`));
} else {
  let windowInstance = null;
  let lifecycle = null;
  let secondInstanceEvents = 0;
  let completed = false;

  async function complete() {
    if (completed) return;
    completed = true;

    try {
      assert.equal(secondInstanceEvents, 1, "the real Electron primary received one second-instance event");
      assert.equal(windowInstance.isDestroyed(), false, "the BrowserWindow remains live after tray close");
      assert.equal(windowInstance.webContents.isDestroyed(), false, "the renderer remains live after tray close");
      assert.equal(lifecycle.getState().state, "visible");
      assert.equal(lifecycle.getState().active_task_count, 1);

      report({
        status: "pass",
        browser_window_destroyed: windowInstance.isDestroyed(),
        renderer_destroyed: windowInstance.webContents.isDestroyed(),
        renderer_id: windowInstance.webContents.id,
        second_instance_events: secondInstanceEvents,
        navigation: navigationRequests,
        restore_calls: methodCalls.restore,
        show_calls: methodCalls.show,
        focus_calls: methodCalls.focus,
        lifecycle_state: lifecycle.getState(),
      });
      lifecycle.beginQuit();
      app.quit();
    } catch (error) {
      fail(error);
    }
  }

  const methodCalls = { restore: 0, show: 0, focus: 0 };
  const navigationRequests = [];

  app.on("second-instance", () => {
    secondInstanceEvents += 1;
    try {
      assert.ok(windowInstance, "the second instance restores the existing BrowserWindow");
      assert.equal(windowInstance.isDestroyed(), false, "the original BrowserWindow is still live");
      assert.equal(lifecycle.restoreWindow(), true, "second-instance restores the existing window");
      assert.equal(windowInstance.isVisible(), true, "second-instance makes the existing window visible");
      assert.equal(navigationRequests.length, 0, "second-instance cannot supply a navigation route");

      // The tray policy owns the only allowed navigation route. Any other route is ignored.
      assert.equal(lifecycle.restoreWindow({ route: "/activity/not-allowed" }), true);
      assert.deepEqual(navigationRequests, []);
      assert.equal(lifecycle.restoreWindow({ route: "/activity/mcp" }), true);
      assert.deepEqual(navigationRequests, [{ route: "/activity/mcp", source: "tray" }]);

      void complete();
    } catch (error) {
      fail(error);
    }
  });

  app.whenReady().then(async () => {
    try {
      windowInstance = new BrowserWindow({
        width: 480,
        height: 320,
        show: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      await windowInstance.loadURL("data:text/html,<title>M2 lifecycle real Electron fixture</title>");
      instrumentWindow(windowInstance, methodCalls);

      lifecycle = new WindowLifecycleController({
        getCloseBehavior: () => "tray",
        getTaskSummary: () => ({
          count: 1,
          tasks: [{ taskId: "m2-live-task", type: "image", label: "图片处理", progress: 0.5 }],
        }),
        onNavigationRequest: (request) => navigationRequests.push(request),
      });
      lifecycle.attachWindow(windowInstance);
      lifecycle.markRendererReady();
      const rendererId = windowInstance.webContents.id;

      windowInstance.close();
      await waitFor(() => !windowInstance.isVisible(), "BrowserWindow.hide() after close-to-tray");
      assert.equal(windowInstance.isDestroyed(), false, "close-to-tray does not destroy BrowserWindow");
      assert.equal(windowInstance.webContents.isDestroyed(), false, "close-to-tray does not destroy renderer");
      assert.equal(windowInstance.webContents.id, rendererId, "close-to-tray keeps the same renderer process");
      assert.equal(lifecycle.getState().state, "hidden_tray");

      windowInstance.minimize();
      await waitFor(() => windowInstance.isMinimized(), "BrowserWindow minimization before restore");
      process.stdout.write("M2_LIFE_READY\n");
    } catch (error) {
      unavailable(error);
    }
  }).catch(unavailable);
}
