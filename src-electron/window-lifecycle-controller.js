const CLOSE_BEHAVIORS = new Set(["tray", "quit"]);
const MCP_ACTIVITY_ROUTE = "/activity/mcp";

function normalizeCloseBehavior(value) {
  return CLOSE_BEHAVIORS.has(value) ? value : "tray";
}

function normalizeTaskSummary(value) {
  const input = value && typeof value === "object" ? value : {};
  const tasks = Array.isArray(input.tasks)
    ? input.tasks
        .filter((item) => item && typeof item === "object")
        .slice(0, 20)
        .map((item) => ({
          taskId: String(item.taskId || ""),
          type: String(item.type || "task"),
          label: String(item.label || "处理中任务"),
          progress: Number.isFinite(item.progress)
            ? Math.max(0, Math.min(1, item.progress))
            : null,
        }))
    : [];
  const requestedCount = Number(input.count ?? input.totalCount);
  return {
    count: Number.isFinite(requestedCount) && requestedCount >= 0 ? requestedCount : tasks.length,
    tasks,
  };
}

export class WindowLifecycleController {
  constructor({
    getCloseBehavior = () => "tray",
    getTaskSummary = () => ({ count: 0, tasks: [] }),
    onState = () => {},
    onNavigationRequest = () => {},
    requestWindowClose = () => {},
  } = {}) {
    this.getCloseBehavior = getCloseBehavior;
    this.getTaskSummary = getTaskSummary;
    this.onState = onState;
    this.onNavigationRequest = onNavigationRequest;
    this.requestWindowClose = requestWindowClose;
    this.window = null;
    this.state = "visible";
    this.isQuitting = false;
    this.appQuitRequested = false;
    this.rendererReady = false;
    this.pendingNavigation = null;
  }

  attachWindow(windowInstance) {
    if (!windowInstance || typeof windowInstance.on !== "function") {
      throw new TypeError("A BrowserWindow-compatible instance is required.");
    }

    this.window = windowInstance;
    this.rendererReady = false;
    this.pendingNavigation = null;
    windowInstance.on("close", (event) => this.handleWindowClose(event));
    windowInstance.on("show", () => {
      if (!this.isQuitting) this._setState("visible");
    });
    windowInstance.on("hide", () => {
      if (!this.isQuitting) this._setState("hidden_tray");
    });
    windowInstance.on("closed", () => {
      if (this.window !== windowInstance) return;
      this.window = null;
      this.rendererReady = false;
      this.pendingNavigation = null;
      this._emit();
    });
    this._setState(this._windowIsVisible(windowInstance) ? "visible" : "hidden_tray");
  }

  markRendererReady() {
    if (!this._hasLiveWindow(this.window)) return false;
    this.rendererReady = true;
    return this._flushPendingNavigation();
  }

  markRendererNotReady() {
    this.rendererReady = false;
    return true;
  }

  handleWindowClose(event) {
    if (this.isQuitting) return false;
    if (this.closeBehavior !== "tray") {
      this.beginQuit();
      return false;
    }

    event?.preventDefault?.();
    this.hideWindow();
    return true;
  }

  hideWindow() {
    const windowInstance = this.window;
    if (!this._hasLiveWindow(windowInstance)) return false;
    windowInstance.hide();
    this._setState("hidden_tray");
    return true;
  }

  restoreWindow({ route = null } = {}) {
    const windowInstance = this.window;
    if (!this._hasLiveWindow(windowInstance)) return false;
    if (windowInstance.isMinimized?.()) windowInstance.restore();
    windowInstance.show();
    windowInstance.focus();
    this._setState("visible");
    if (route === MCP_ACTIVITY_ROUTE) {
      this.pendingNavigation = { route: MCP_ACTIVITY_ROUTE, source: "tray" };
      this._flushPendingNavigation();
    }
    return true;
  }

  beginQuit() {
    if (this.isQuitting) return false;
    this.isQuitting = true;
    this._setState("quitting");
    return true;
  }

  cancelQuit() {
    if (!this.isQuitting) return false;
    this.isQuitting = false;
    this.appQuitRequested = false;
    this._setState(this._windowIsVisible(this.window) ? "visible" : "hidden_tray");
    return true;
  }

  requestQuit() {
    if (!this.beginQuit()) return false;
    this.requestWindowClose();
    return true;
  }

  shouldRequestAppQuitAfterWindowClosed() {
    return this.isQuitting && !this.appQuitRequested;
  }

  markAppQuitRequested() {
    this.beginQuit();
    this.appQuitRequested = true;
  }

  refreshTaskSummary() {
    this._emit();
  }

  get closeBehavior() {
    return normalizeCloseBehavior(this.getCloseBehavior());
  }

  getState() {
    const summary = normalizeTaskSummary(this.getTaskSummary());
    return {
      schema_version: "window-lifecycle/v1",
      state: this.state,
      visible: this.state === "visible",
      close_behavior: this.closeBehavior,
      is_quitting: this.isQuitting,
      active_task_count: summary.count,
      active_tasks: summary.tasks,
    };
  }

  _setState(nextState) {
    this.state = nextState;
    this._emit();
  }

  _emit() {
    this.onState(this.getState());
  }

  _flushPendingNavigation() {
    if (!this.rendererReady || !this.pendingNavigation || !this._hasLiveWindow(this.window)) {
      return false;
    }

    const request = this.pendingNavigation;
    try {
      const delivered = this.onNavigationRequest(request);
      if (delivered === false) return false;
      this.pendingNavigation = null;
      return true;
    } catch {
      return false;
    }
  }

  _windowIsVisible(windowInstance) {
    return this._hasLiveWindow(windowInstance) && windowInstance.isVisible?.() !== false;
  }

  _hasLiveWindow(windowInstance) {
    return Boolean(windowInstance) && windowInstance.isDestroyed?.() !== true;
  }
}

export { MCP_ACTIVITY_ROUTE, normalizeCloseBehavior };
