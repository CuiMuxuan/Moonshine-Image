import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { WindowLifecycleController } from "../../src-electron/window-lifecycle-controller.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const mainSource = fs.readFileSync(path.join(repoRoot, "src-electron/electron-main.js"), "utf8");
const preloadSource = fs.readFileSync(path.join(repoRoot, "src-electron/electron-preload.js"), "utf8");

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.visible = true;
    this.minimized = false;
    this.destroyed = false;
    this.hideCalls = 0;
    this.showCalls = 0;
    this.restoreCalls = 0;
    this.focusCalls = 0;
  }

  isDestroyed() {
    return this.destroyed;
  }

  isVisible() {
    return this.visible;
  }

  isMinimized() {
    return this.minimized;
  }

  hide() {
    this.hideCalls += 1;
    this.visible = false;
    this.emit("hide");
  }

  show() {
    this.showCalls += 1;
    this.visible = true;
    this.emit("show");
  }

  restore() {
    this.restoreCalls += 1;
    this.minimized = false;
  }

  focus() {
    this.focusCalls += 1;
  }

  close() {
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    this.emit("close", event);
    return event;
  }
}

test("tray close hides the window without discarding the task summary", () => {
  const windowInstance = new FakeWindow();
  const lifecycle = new WindowLifecycleController({
    getCloseBehavior: () => "tray",
    getTaskSummary: () => ({
      count: 1,
      tasks: [{ taskId: "task-1", type: "image", label: "图片处理", progress: 0.5 }],
    }),
  });
  lifecycle.attachWindow(windowInstance);

  const closeEvent = windowInstance.close();

  assert.equal(closeEvent.defaultPrevented, true);
  assert.equal(windowInstance.hideCalls, 1);
  assert.equal(lifecycle.getState().state, "hidden_tray");
  assert.equal(lifecycle.getState().active_task_count, 1);
  assert.equal(lifecycle.getState().active_tasks[0].progress, 0.5);
});

test("restoring a hidden window restores, focuses, and sends only the approved MCP route", () => {
  const windowInstance = new FakeWindow();
  const navigation = [];
  const lifecycle = new WindowLifecycleController({
    onNavigationRequest: (request) => navigation.push(request),
  });
  lifecycle.attachWindow(windowInstance);
  lifecycle.hideWindow();
  windowInstance.minimized = true;

  assert.equal(lifecycle.restoreWindow({ route: "/activity/mcp" }), true);

  assert.equal(windowInstance.restoreCalls, 1);
  assert.equal(windowInstance.showCalls, 1);
  assert.equal(windowInstance.focusCalls, 1);
  assert.deepEqual(navigation, [{ route: "/activity/mcp", source: "tray" }]);
  assert.equal(lifecycle.getState().state, "visible");
});

test("quit mode enters a reversible quit intent until the existing confirmation flow accepts it", () => {
  const windowInstance = new FakeWindow();
  const lifecycle = new WindowLifecycleController({ getCloseBehavior: () => "quit" });
  lifecycle.attachWindow(windowInstance);

  const closeEvent = windowInstance.close();

  assert.equal(closeEvent.defaultPrevented, false);
  assert.equal(lifecycle.getState().is_quitting, true);
  assert.equal(lifecycle.shouldRequestAppQuitAfterWindowClosed(), true);
  assert.equal(lifecycle.cancelQuit(), true);
  assert.equal(lifecycle.getState().is_quitting, false);
});

test("explicit quit is single-shot and asks the window to close before shutdown", () => {
  let closeRequests = 0;
  const lifecycle = new WindowLifecycleController({
    requestWindowClose: () => {
      closeRequests += 1;
    },
  });

  assert.equal(lifecycle.requestQuit(), true);
  assert.equal(lifecycle.requestQuit(), false);
  assert.equal(closeRequests, 1);
  assert.equal(lifecycle.shouldRequestAppQuitAfterWindowClosed(), true);
});

test("Electron main wires lifecycle ownership, single-instance recovery, and named tray IPC", () => {
  assert.match(mainSource, /app\.requestSingleInstanceLock\(\)/);
  assert.match(mainSource, /app\.on\("second-instance", \(\) =>/);
  assert.match(mainSource, /getWindowLifecycleController\(\)\.attachWindow\(windowInstance\)/);
  assert.match(mainSource, /ensureTrayManager\(\)/);
  assert.match(mainSource, /ipcMain\.handle\("tray-get-state"/);
  ["tray-show-window", "tray-hide-window", "tray-quit"].forEach((channel) => {
    assert.doesNotMatch(mainSource, new RegExp(`ipcMain\\.handle\\("${channel}"`));
  });
  assert.doesNotMatch(mainSource, /activeProcessingTasks\.clear\(\);/);
  ["getTrayState", "onTrayNavigation"].forEach((name) => {
    assert.match(preloadSource, new RegExp(`${name}:`));
  });
  ["showTrayWindow", "hideTrayWindow", "quitFromTray"].forEach((name) => {
    assert.doesNotMatch(preloadSource, new RegExp(`${name}:`));
  });
});
