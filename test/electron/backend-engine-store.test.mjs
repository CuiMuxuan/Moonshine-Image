import assert from "node:assert/strict";
import test from "node:test";

import { createPinia, setActivePinia } from "pinia";

import { useBackendEngineStore } from "../../src/stores/backendEngine.js";

const createStore = () => {
  setActivePinia(createPinia());
  return useBackendEngineStore();
};

test("backend state does not become usable before readiness", () => {
  const store = createStore();

  store.applyServiceEvent({
    state: "starting",
    processRunning: true,
    ready: false,
    port: 8123,
  });

  assert.equal(store.status, "preparing");
  assert.equal(store.processRunning, true);
  assert.equal(store.ready, false);
  assert.equal(store.isRunning, false);
  assert.equal(store.port, 8123);

  store.applyServiceEvent({
    state: "running",
    processRunning: true,
    ready: true,
    port: 8123,
  });

  assert.equal(store.status, "running");
  assert.equal(store.isRunning, true);
});

test("running event with ready false remains in verification", () => {
  const store = createStore();

  store.applyServiceEvent({
    state: "running",
    processRunning: true,
    ready: false,
    stage: "verifying",
  });

  assert.equal(store.status, "preparing");
  assert.equal(store.phase, "verifying");
  assert.equal(store.isRunning, false);
});

test("structured and legacy failures remain compatible", () => {
  const store = createStore();
  const diagnostic = {
    id: "startup-test",
    code: "BACKEND_EXITED_BEFORE_READY",
    stderrTail: "traceback",
  };

  store.setFailed({
    error: "后端提前退出",
    recoveryHint: "检查启动日志",
    diagnostic,
  });

  assert.equal(store.hasFailed, true);
  assert.equal(store.error, "后端提前退出");
  assert.equal(store.recoveryHint, "检查启动日志");
  assert.deepEqual(store.diagnostic, diagnostic);

  store.setFailed("旧式错误文本");
  assert.equal(store.error, "旧式错误文本");
});

test("stopped state clears readiness and session timestamps", () => {
  const store = createStore();

  store.setRunning({
    port: 9000,
    startedAt: 100,
    readyAt: 200,
  });
  store.setStopped({
    startedAt: 100,
    readyAt: 200,
    lastExit: { exitCode: 0 },
  });

  assert.equal(store.status, "stopped");
  assert.equal(store.processRunning, false);
  assert.equal(store.ready, false);
  assert.equal(store.startedAt, null);
  assert.equal(store.readyAt, null);
  assert.deepEqual(store.lastExit, { exitCode: 0 });
});

test("failed state clears session timestamps while preserving process truth", () => {
  const store = createStore();
  store.setRunning({ startedAt: 100, readyAt: 200 });
  store.applyServiceEvent({
    state: "failed",
    processRunning: true,
    startedAt: 100,
    readyAt: 200,
    error: "stop timeout",
  });

  assert.equal(store.status, "failed");
  assert.equal(store.processRunning, true);
  assert.equal(store.ready, false);
  assert.equal(store.startedAt, null);
  assert.equal(store.readyAt, null);
});

test("expected startup cancellation settles as stopped without failure", () => {
  const store = createStore();
  store.setPreparing("startingEngine", {
    processRunning: true,
    ready: false,
  });

  const handled = store.applyStopResult({
    success: false,
    code: "BACKEND_START_CANCELLED",
    cancelled: true,
    expected: true,
    processRunning: false,
    ready: false,
  });

  assert.equal(handled, true);
  assert.equal(store.status, "stopped");
  assert.equal(store.hasFailed, false);
  assert.equal(store.error, "");
  assert.equal(store.processRunning, false);
  assert.equal(store.ready, false);
});

test("unexpected stop failure remains available for failure handling", () => {
  const store = createStore();
  store.setStopping({ processRunning: true });

  const handled = store.applyStopResult({
    success: false,
    code: "BACKEND_STOP_FAILED",
    error: "stop failed",
  });

  assert.equal(handled, false);
  assert.equal(store.status, "stopping");
  assert.equal(store.hasFailed, false);
});
