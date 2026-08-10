import assert from "node:assert/strict";
import test from "node:test";

import { scheduleApplicationRestart } from "../../src-electron/app-restart.js";

test("application restart is scheduled after the IPC reply can complete", () => {
  const calls = [];
  let scheduled = null;
  const result = scheduleApplicationRestart({
    app: {
      relaunch: () => calls.push("relaunch"),
      quit: () => calls.push("quit"),
    },
    schedule: (callback) => {
      scheduled = callback;
    },
  });

  assert.deepEqual(result, { success: true });
  assert.deepEqual(calls, []);
  scheduled();
  assert.deepEqual(calls, ["relaunch", "quit"]);
});

test("application restart reports an unavailable Electron app", () => {
  assert.deepEqual(scheduleApplicationRestart({ app: null }), {
    success: false,
    code: "APP_RESTART_UNAVAILABLE",
    reason: "当前环境不支持重启应用。",
  });
});
