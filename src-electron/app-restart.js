export function scheduleApplicationRestart({ app, schedule = setImmediate } = {}) {
  if (typeof app?.relaunch !== "function" || typeof app?.quit !== "function") {
    return {
      success: false,
      code: "APP_RESTART_UNAVAILABLE",
      reason: "当前环境不支持重启应用。",
    };
  }
  if (typeof schedule !== "function") {
    throw new TypeError("scheduleApplicationRestart requires a scheduler.");
  }

  schedule(() => {
    app.relaunch();
    app.quit();
  });
  return { success: true };
}
