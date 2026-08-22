function taskLabel(task) {
  const progress = Number.isFinite(task.progress) ? ` ${Math.round(task.progress * 100)}%` : "";
  return `${task.label}${progress}`;
}

export class TrayManager {
  constructor({
    Tray,
    Menu,
    icon,
    tooltip = "Moonshine-Image",
    lifecycle,
  } = {}) {
    if (typeof Tray !== "function" || !Menu || typeof Menu.buildFromTemplate !== "function") {
      throw new TypeError("Electron Tray and Menu dependencies are required.");
    }
    if (!lifecycle) throw new TypeError("A window lifecycle controller is required.");

    this.Tray = Tray;
    this.Menu = Menu;
    this.icon = icon;
    this.tooltip = tooltip;
    this.lifecycle = lifecycle;
    this.tray = null;
    this.lastState = null;
  }

  create() {
    if (this.tray) return this.tray;
    this.tray = new this.Tray(this.icon);
    this.tray.on("click", () => this.lifecycle.restoreWindow());
    this.refresh();
    return this.tray;
  }

  refresh(state = this.lifecycle.getState()) {
    if (!this.tray) return;
    this.lastState = state;
    const taskCount = Number(state.active_task_count || 0);
    this.tray.setToolTip(`${this.tooltip}${taskCount > 0 ? ` - ${taskCount} 个任务` : ""}`);
    this.tray.setContextMenu(this.Menu.buildFromTemplate(this._buildMenuTemplate(state)));
  }

  dispose() {
    if (!this.tray) return;
    this.tray.destroy?.();
    this.tray = null;
  }

  _buildMenuTemplate(state) {
    const tasks = Array.isArray(state.active_tasks) ? state.active_tasks : [];
    const taskCount = Number(state.active_task_count || 0);
    const taskItems = tasks.length
      ? tasks.map((task) => ({ label: taskLabel(task), enabled: false }))
      : [{ label: "当前没有活动任务", enabled: false }];

    return [
      { label: "打开窗口", click: () => this.lifecycle.restoreWindow() },
      {
        label: "MCP 调用日志",
        click: () => {
          this.lifecycle.restoreWindow({ route: "/activity/mcp" });
        },
      },
      {
        label: `当前任务（${taskCount}）`,
        submenu: taskItems,
      },
      { type: "separator" },
      { label: "退出程序", click: () => this.lifecycle.requestQuit() },
    ];
  }
}
