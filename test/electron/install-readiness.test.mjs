import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateAppUpdateInstallReadiness,
  prepareAppUpdateInstall,
} from "../../src-electron/updater/install-readiness.js";

test("allows installation immediately when the app is idle", () => {
  assert.deepEqual(evaluateAppUpdateInstallReadiness(), {
    allowed: true,
    reason: "",
    activeProcessingTaskCount: 0,
    activeFfmpegTaskCount: 0,
    backendState: "stopped",
    requiresBackendStop: false,
  });
});

test("allows preparation when only a running backend must be stopped", () => {
  const result = evaluateAppUpdateInstallReadiness({
    backendStatus: { state: "running", processRunning: true },
  });

  assert.equal(result.allowed, true);
  assert.equal(result.requiresBackendStop, true);
  assert.equal(result.reason, "");
});

test("blocks active processing and FFmpeg tasks", () => {
  const result = evaluateAppUpdateInstallReadiness({
    activeProcessingTaskCount: 2,
    activeFfmpegTaskCount: 1,
    backendStatus: { state: "running", processRunning: true },
  });

  assert.equal(result.allowed, false);
  assert.equal(result.requiresBackendStop, false);
  assert.match(result.reason, /2 个图片或视频任务/);
  assert.match(result.reason, /1 个 FFmpeg 任务/);
});

test("blocks backend lifecycle transitions", () => {
  const starting = evaluateAppUpdateInstallReadiness({
    backendStatus: { state: "starting", processRunning: true },
  });
  const stopping = evaluateAppUpdateInstallReadiness({
    backendStatus: { state: "stopping", processRunning: true },
  });

  assert.equal(starting.allowed, false);
  assert.match(starting.reason, /正在启动/);
  assert.equal(stopping.allowed, false);
  assert.match(stopping.reason, /正在停止/);
});

test("blocks installation after application quit starts", () => {
  const result = evaluateAppUpdateInstallReadiness({
    applicationQuitRequested: true,
  });

  assert.equal(result.allowed, false);
  assert.match(result.reason, /正在退出/);
});

test("stops a running backend and rechecks before installation", async () => {
  let backendRunning = true;
  let stopCalls = 0;
  let readinessCalls = 0;
  const result = await prepareAppUpdateInstall({
    getReadiness: () => {
      readinessCalls += 1;
      return evaluateAppUpdateInstallReadiness({
        backendStatus: {
          state: backendRunning ? "running" : "stopped",
          processRunning: backendRunning,
        },
      });
    },
    stopBackend: async () => {
      stopCalls += 1;
      backendRunning = false;
      return { success: true };
    },
  });

  assert.equal(result.allowed, true);
  assert.equal(result.backendStopped, true);
  assert.equal(stopCalls, 1);
  assert.equal(readinessCalls, 2);
});

test("does not stop the backend while a hard blocker exists", async () => {
  let stopCalls = 0;
  const result = await prepareAppUpdateInstall({
    getReadiness: () =>
      evaluateAppUpdateInstallReadiness({
        activeProcessingTaskCount: 1,
        backendStatus: { state: "running", processRunning: true },
      }),
    stopBackend: async () => {
      stopCalls += 1;
      return { success: true };
    },
  });

  assert.equal(result.allowed, false);
  assert.equal(stopCalls, 0);
});

test("keeps installation blocked when backend stop fails or remains running", async () => {
  const readiness = () =>
    evaluateAppUpdateInstallReadiness({
      backendStatus: { state: "running", processRunning: true },
    });
  const failed = await prepareAppUpdateInstall({
    getReadiness: readiness,
    stopBackend: async () => ({ success: false, code: "BACKEND_STOP_FAILED" }),
  });
  const stillRunning = await prepareAppUpdateInstall({
    getReadiness: readiness,
    stopBackend: async () => ({ success: true }),
  });

  assert.equal(failed.allowed, false);
  assert.equal(failed.code, "APP_UPDATE_BACKEND_STOP_FAILED");
  assert.equal(failed.backendCode, "BACKEND_STOP_FAILED");
  assert.equal(stillRunning.allowed, false);
  assert.equal(stillRunning.code, "APP_UPDATE_BACKEND_STILL_RUNNING");
});
