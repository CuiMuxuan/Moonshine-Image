import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { TrayManager } from "../../src-electron/tray-manager.js";

class FakeTray extends EventEmitter {
  static instances = [];

  constructor(icon) {
    super();
    this.icon = icon;
    this.tooltip = "";
    this.menu = null;
    this.destroyed = false;
    FakeTray.instances.push(this);
  }

  setToolTip(value) {
    this.tooltip = value;
  }

  setContextMenu(menu) {
    this.menu = menu;
  }

  destroy() {
    this.destroyed = true;
  }
}

test("TrayManager keeps one Electron Tray and projects task status into its menu", () => {
  FakeTray.instances = [];
  const calls = [];
  const lifecycle = {
    getState: () => ({
      active_task_count: 2,
      active_tasks: [
        { label: "图片处理", progress: 0.25 },
        { label: "视频处理", progress: null },
      ],
    }),
    restoreWindow: (options) => calls.push(["restore", options]),
    requestQuit: () => calls.push(["quit"]),
  };
  const Menu = { buildFromTemplate: (template) => ({ template }) };
  const manager = new TrayManager({
    Tray: FakeTray,
    Menu,
    icon: "moonshine.png",
    lifecycle,
  });

  const tray = manager.create();
  assert.equal(manager.create(), tray);
  assert.equal(FakeTray.instances.length, 1);
  assert.equal(tray.tooltip, "Moonshine-Image - 2 个任务");

  const template = tray.menu.template;
  assert.equal(template[2].label, "当前任务（2）");
  assert.deepEqual(
    template[2].submenu.map((item) => item.label),
    ["图片处理 25%", "视频处理"]
  );

  template[1].click();
  template[4].click();
  assert.deepEqual(calls, [
    ["restore", { route: "/activity/mcp" }],
    ["quit"],
  ]);

  manager.dispose();
  assert.equal(tray.destroyed, true);
});
