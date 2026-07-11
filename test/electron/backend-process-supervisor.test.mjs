import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { BackendProcessSupervisor } from "../../src-electron/backend-process-supervisor.js";

class FakeStream extends EventEmitter {}

class FakeChild extends EventEmitter {
  constructor(pid = 1001, { autoClose = true } = {}) {
    super();
    this.pid = pid;
    this.stdout = new FakeStream();
    this.stderr = new FakeStream();
    this.killed = false;
    this.autoClose = autoClose;
  }

  kill(signal) {
    this.killed = true;
    if (this.autoClose) queueMicrotask(() => this.emit("close", 0, signal));
    return true;
  }
}

async function flushMicrotasks(count = 4) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

function createFakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer(callback, delay) {
      const timer = {
        callback,
        delay,
        cleared: false,
        fired: false,
        unref() {},
      };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
    runNext() {
      const timer = timers.find((candidate) => !candidate.cleared && !candidate.fired);
      assert.ok(timer, "expected an active timer");
      timer.fired = true;
      timer.callback();
      return timer;
    },
  };
}

test("spawn errors resolve as structured failures without throwing", async () => {
  const child = new FakeChild();
  const supervisor = new BackendProcessSupervisor({
    spawnImpl: () => {
      queueMicrotask(() => child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" })));
      return child;
    },
    probeReady: async () => false,
    sleep: async () => {},
  });

  const result = await supervisor.start({ command: "missing-python", port: 8080 });
  assert.equal(result.success, false);
  assert.equal(result.code, "BACKEND_PROCESS_SPAWN_FAILED");
  assert.equal(result.diagnostic.osCode, "ENOENT");
  assert.equal(supervisor.getStatus().state, "failed");
});

test("spawn error followed by close settles startup and failed state once", async () => {
  const child = new FakeChild();
  const states = [];
  const supervisor = new BackendProcessSupervisor({
    spawnImpl: () => {
      queueMicrotask(() => {
        child.emit("error", Object.assign(new Error("denied"), { code: "EACCES" }));
        child.emit("close", 13, null);
      });
      return child;
    },
    probeReady: async () => false,
    sleep: async () => {},
    onState: (event) => states.push(event),
  });

  const result = await supervisor.start({ command: "blocked-python", port: 8080 });
  assert.equal(result.code, "BACKEND_PROCESS_SPAWN_FAILED");
  assert.equal(result.diagnostic.osCode, "EACCES");
  assert.equal(states.filter((event) => event.state === "failed").length, 1);
});

test("early exits preserve stderr and exit code", async () => {
  const child = new FakeChild();
  const supervisor = new BackendProcessSupervisor({
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.from("Traceback: import failed"));
        child.emit("close", 7, null);
      });
      return child;
    },
    probeReady: async () => false,
    sleep: async () => {},
  });

  const result = await supervisor.start({ command: "python", args: ["main.py"], port: 8080 });
  assert.equal(result.code, "BACKEND_EXITED_BEFORE_READY");
  assert.equal(result.diagnostic.exitCode, 7);
  assert.match(result.diagnostic.stderrTail, /import failed/);
  const status = supervisor.getStatus();
  assert.equal(status.code, "BACKEND_EXITED_BEFORE_READY");
  assert.equal(status.error, result.error);
  assert.equal(status.diagnostic.id, result.diagnostic.id);
});

test("backend output tails are capped by UTF-8 bytes", async () => {
  const child = new FakeChild();
  const supervisor = new BackendProcessSupervisor({
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.from(`prefix-${"错".repeat(20000)}-tail`));
        child.emit("close", 9, null);
      });
      return child;
    },
    probeReady: async () => false,
    sleep: async () => {},
  });

  const result = await supervisor.start({ command: "python", port: 8080 });
  assert.ok(Buffer.byteLength(result.diagnostic.stderrTail, "utf8") <= 32 * 1024);
  assert.match(result.diagnostic.stderrTail, /-tail$/);
});

test("backend output is decoded and classified by complete lines across chunks", async () => {
  const child = new FakeChild(7001, { autoClose: false });
  const output = [];
  const supervisor = new BackendProcessSupervisor({
    spawnImpl: () => child,
    probeReady: async () => true,
    onOutput: (event) => output.push(event),
  });

  const result = await supervisor.start({ command: "python", port: 8134 });
  assert.equal(result.success, true);

  const utf8Line = Buffer.from("启动完成\n", "utf8");
  child.stdout.emit("data", utf8Line.subarray(0, 1));
  child.stdout.emit("data", utf8Line.subarray(1));
  child.stderr.emit("data", Buffer.from("Trace"));
  child.stderr.emit("data", Buffer.from("back (most recent call last):\nWARN"));
  child.stderr.emit("data", Buffer.from("ING: low memory\nER"));
  child.stderr.emit("data", Buffer.from("ROR: final crash"));

  const beforeClose = output.filter((event) => event.stream !== "lifecycle");
  assert.deepEqual(
    beforeClose.map(({ message, type, stream }) => ({ message, type, stream })),
    [
      { message: "启动完成", type: "info", stream: "stdout" },
      {
        message: "Traceback (most recent call last):",
        type: "error",
        stream: "stderr",
      },
      { message: "WARNING: low memory", type: "warning", stream: "stderr" },
    ],
  );
  for (const event of beforeClose) {
    assert.equal(event.stage, "backend-run");
    assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(Object.hasOwn(event, "diagnosticId"));
  }

  child.emit("close", 9, null);
  const flushedError = output.find((event) => event.message === "ERROR: final crash");
  assert.equal(flushedError?.type, "error");
  assert.equal(flushedError?.stream, "stderr");
  assert.match(supervisor.getStatus().lastError.stderrTail, /ERROR: final crash$/);
});

test("the total startup timeout wins even when a readiness probe hangs", async () => {
  const child = new FakeChild();
  const fakeTimers = createFakeTimers();
  const neverReady = new Promise(() => {});
  const supervisor = new BackendProcessSupervisor({
    spawnImpl: () => child,
    probeReady: async () => await neverReady,
    terminateProcess: async (target) => target.kill("SIGTERM"),
    readinessTimeoutMs: 120000,
    setTimeoutImpl: (callback, delay) => fakeTimers.setTimer(callback, delay),
    clearTimeoutImpl: (timer) => fakeTimers.clearTimer(timer),
  });

  const starting = supervisor.start({ command: "python", port: 8081 });
  await flushMicrotasks();
  assert.equal(fakeTimers.runNext().delay, 120000);
  const result = await starting;

  assert.equal(result.success, false);
  assert.equal(result.code, "BACKEND_START_TIMEOUT");
  assert.equal(result.diagnostic.timedOut, true);
  assert.equal(child.killed, true);
  assert.equal(supervisor.getStatus().state, "failed");
});

test("unexpected close fails running state and emits the stderr tail", async () => {
  const child = new FakeChild();
  let probes = 0;
  const output = [];
  const supervisor = new BackendProcessSupervisor({
    spawnImpl: () => child,
    probeReady: async () => ++probes >= 2,
    sleep: async () => {},
    onOutput: (event) => output.push(event),
  });

  const result = await supervisor.start({ command: "python", port: 8123 });
  assert.equal(result.success, true);
  assert.equal(result.ready, true);
  assert.equal(supervisor.getStatus().running, true);

  child.stderr.emit("data", Buffer.from("FATAL: backend runtime crashed"));
  child.emit("close", 1, null);
  assert.equal(supervisor.getStatus().state, "failed");
  assert.equal(supervisor.getStatus().running, false);
  const lifecycleError = output.find((event) => event.stream === "lifecycle");
  assert.match(lifecycleError.message, /backend runtime crashed/);
  assert.match(lifecycleError.stderrTail, /backend runtime crashed/);
});

test("concurrent starts share one spawn and stop waits for close", async () => {
  const child = new FakeChild();
  let spawnCount = 0;
  let releaseProbe;
  const probeGate = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  const supervisor = new BackendProcessSupervisor({
    spawnImpl: () => {
      spawnCount += 1;
      return child;
    },
    probeReady: async () => {
      await probeGate;
      return true;
    },
    terminateProcess: async (target) => target.kill("SIGTERM"),
  });

  const first = supervisor.start({ command: "python", port: 8124 });
  const second = supervisor.start({ command: "python", port: 8124 });
  releaseProbe();
  assert.equal((await first).success, true);
  assert.equal((await second).success, true);
  assert.equal(spawnCount, 1);

  const stopped = await supervisor.stop();
  assert.equal(stopped.success, true);
  assert.equal(supervisor.getStatus().state, "stopped");
});

test("stop during startup cancels the start without ending in failed state", async () => {
  const child = new FakeChild();
  const states = [];
  const neverReady = new Promise(() => {});
  const supervisor = new BackendProcessSupervisor({
    spawnImpl: () => child,
    probeReady: async () => await neverReady,
    terminateProcess: async (target) => target.kill("SIGTERM"),
    onState: (event) => states.push(event),
  });

  const starting = supervisor.start({ command: "python", port: 8125 });
  await flushMicrotasks();
  const stopping = supervisor.stop();
  const [startResult, stopResult] = await Promise.all([starting, stopping]);

  assert.equal(startResult.success, false);
  assert.equal(startResult.code, "BACKEND_START_CANCELLED");
  assert.equal(startResult.cancelled, true);
  assert.equal(stopResult.success, true);
  assert.equal(supervisor.getStatus().state, "stopped");
  assert.equal(states.some((event) => event.state === "failed"), false);
});

test("start requested while stopping waits and launches the new spec", async () => {
  const oldChild = new FakeChild(2001, { autoClose: false });
  const newChild = new FakeChild(2002);
  const spawns = [];
  const supervisor = new BackendProcessSupervisor({
    spawnImpl: (command, args) => {
      spawns.push({ command, args });
      return spawns.length === 1 ? oldChild : newChild;
    },
    probeReady: async () => true,
    terminateProcess: async () => {},
  });

  await supervisor.start({ command: "old-python", args: ["old.py"], port: 8126 });
  const stopping = supervisor.stop();
  await flushMicrotasks();
  const startingNew = supervisor.start({
    command: "new-python",
    args: ["new.py"],
    port: 8127,
  });
  await flushMicrotasks();
  assert.equal(spawns.length, 1);

  oldChild.emit("close", 0, "SIGTERM");
  assert.equal((await stopping).success, true);
  const startResult = await startingNew;
  assert.equal(startResult.success, true);
  assert.equal(startResult.port, 8127);
  assert.deepEqual(spawns, [
    { command: "old-python", args: ["old.py"] },
    { command: "new-python", args: ["new.py"] },
  ]);
  assert.equal(supervisor.getStatus().pid, 2002);
});

test("late close from an old spawn failure cannot clear a newer process", async () => {
  const oldChild = new FakeChild(3001, { autoClose: false });
  const newChild = new FakeChild(3002);
  let spawnCount = 0;
  const supervisor = new BackendProcessSupervisor({
    spawnImpl: () => {
      spawnCount += 1;
      if (spawnCount === 1) {
        queueMicrotask(() => oldChild.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" })));
        return oldChild;
      }
      return newChild;
    },
    probeReady: async () => spawnCount > 1,
    sleep: async () => {},
  });

  assert.equal((await supervisor.start({ command: "missing", port: 8128 })).success, false);
  assert.equal((await supervisor.start({ command: "python", port: 8129 })).success, true);
  assert.equal(supervisor.getStatus().lastExit, null);

  oldChild.emit("close", 127, null);
  assert.equal(supervisor.getStatus().state, "running");
  assert.equal(supervisor.getStatus().pid, 3002);
  assert.equal(supervisor.getStatus().lastExit, null);
});

test("late error from a stopped child cannot fail a newer process", async () => {
  const oldChild = new FakeChild(4001, { autoClose: false });
  const newChild = new FakeChild(4002);
  let spawnCount = 0;
  const supervisor = new BackendProcessSupervisor({
    spawnImpl: () => {
      spawnCount += 1;
      return spawnCount === 1 ? oldChild : newChild;
    },
    probeReady: async () => true,
    terminateProcess: async (target) => queueMicrotask(() => target.emit("close", 0, "SIGTERM")),
  });

  await supervisor.start({ command: "python", port: 8130 });
  await supervisor.stop();
  await supervisor.start({ command: "python", port: 8131 });
  oldChild.emit("error", Object.assign(new Error("late error"), { code: "EPIPE" }));

  assert.equal(supervisor.getStatus().state, "running");
  assert.equal(supervisor.getStatus().pid, 4002);
  assert.equal(supervisor.getStatus().lastError, null);
});

test("stop uses two five-second phases and succeeds only after a real close", async () => {
  const child = new FakeChild(5001, { autoClose: false });
  const fakeTimers = createFakeTimers();
  const terminationModes = [];
  const supervisor = new BackendProcessSupervisor({
    spawnImpl: () => child,
    probeReady: async () => true,
    terminateProcess: async (_target, { force }) => {
      terminationModes.push(force);
    },
    setTimeoutImpl: (callback, delay) => fakeTimers.setTimer(callback, delay),
    clearTimeoutImpl: (timer) => fakeTimers.clearTimer(timer),
  });

  await supervisor.start({ command: "python", port: 8132 });
  let stopSettled = false;
  const stopping = supervisor.stop().then((result) => {
    stopSettled = true;
    return result;
  });
  await flushMicrotasks();
  assert.deepEqual(terminationModes, [false]);
  assert.equal(stopSettled, false);

  assert.equal(fakeTimers.runNext().delay, 5000);
  await flushMicrotasks();
  assert.deepEqual(terminationModes, [false, true]);
  assert.equal(stopSettled, false);
  const forcedTimer = fakeTimers.timers.find(
    (timer) => !timer.cleared && !timer.fired,
  );
  assert.equal(forcedTimer.delay, 5000);

  child.emit("close", 0, "SIGKILL");
  const stopResult = await stopping;
  assert.equal(stopResult.success, true);
  assert.equal(supervisor.getStatus().state, "stopped");
});

test("stop reports failure after ten seconds when force never produces close", async () => {
  const child = new FakeChild(6001, { autoClose: false });
  const fakeTimers = createFakeTimers();
  const supervisor = new BackendProcessSupervisor({
    spawnImpl: () => child,
    probeReady: async () => true,
    terminateProcess: async () => {},
    setTimeoutImpl: (callback, delay) => fakeTimers.setTimer(callback, delay),
    clearTimeoutImpl: (timer) => fakeTimers.clearTimer(timer),
  });

  await supervisor.start({ command: "python", port: 8133 });
  const stopping = supervisor.stop();
  await flushMicrotasks();
  fakeTimers.runNext();
  await flushMicrotasks();
  fakeTimers.runNext();
  const stopResult = await stopping;

  assert.equal(stopResult.success, false);
  assert.equal(stopResult.code, "BACKEND_STOP_FAILED");
  assert.equal(stopResult.diagnostic.timedOut, true);
  assert.equal(supervisor.getStatus().state, "failed");
  assert.equal(supervisor.getStatus().processRunning, true);
});

test("stop waits for each termination attempt and preserves its final diagnostics", async () => {
  const child = new FakeChild(7002, { autoClose: false });
  const fakeTimers = createFakeTimers();
  const terminationModes = [];
  let activeTerminations = 0;
  let maxActiveTerminations = 0;
  const supervisor = new BackendProcessSupervisor({
    spawnImpl: () => child,
    probeReady: async () => true,
    terminateProcess: async (_target, { force, signal }) => {
      terminationModes.push(force);
      activeTerminations += 1;
      maxActiveTerminations = Math.max(maxActiveTerminations, activeTerminations);
      await new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            queueMicrotask(() => {
              activeTerminations -= 1;
              const phase = force ? "forced" : "graceful";
              const error = Object.assign(new Error(`${phase} taskkill failed`), {
                code: "ETASKKILL",
                diagnostic: {
                  stage: force ? "backend-force-stop" : "backend-stop",
                  reason: "non-zero-exit",
                  commandLine: `taskkill /pid ${child.pid} /t${force ? " /f" : ""}`,
                  cwd: "C:\\app",
                  osCode: "ETASKKILL",
                  exitCode: force ? 19 : 5,
                  signal: null,
                  stdoutTail: "",
                  stderrTail: `${phase} taskkill stderr`,
                  attempts: [],
                },
              });
              reject(error);
            });
          },
          { once: true },
        );
      });
    },
    setTimeoutImpl: (callback, delay) => fakeTimers.setTimer(callback, delay),
    clearTimeoutImpl: (timer) => fakeTimers.clearTimer(timer),
  });

  await supervisor.start({ command: "python", port: 8135 });
  const stopping = supervisor.stop();
  await flushMicrotasks();
  assert.deepEqual(terminationModes, [false]);

  assert.equal(fakeTimers.runNext().delay, 5000);
  await flushMicrotasks(8);
  assert.deepEqual(terminationModes, [false, true]);
  assert.equal(maxActiveTerminations, 1);

  assert.equal(fakeTimers.runNext().delay, 5000);
  const stopResult = await stopping;

  assert.equal(stopResult.code, "BACKEND_STOP_FAILED");
  assert.equal(stopResult.diagnostic.exitCode, 19);
  assert.equal(stopResult.diagnostic.osCode, "ETASKKILL");
  assert.match(stopResult.diagnostic.stderrTail, /graceful taskkill stderr/);
  assert.match(stopResult.diagnostic.stderrTail, /forced taskkill stderr/);
  assert.equal(stopResult.diagnostic.attempts.length, 2);
  assert.deepEqual(
    stopResult.diagnostic.attempts.map(({ stage, exitCode }) => ({ stage, exitCode })),
    [
      { stage: "backend-stop", exitCode: 5 },
      { stage: "backend-force-stop", exitCode: 19 },
    ],
  );
  assert.equal(activeTerminations, 0);
  assert.equal(maxActiveTerminations, 1);
});
