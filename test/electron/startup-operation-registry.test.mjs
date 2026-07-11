import assert from "node:assert/strict";
import test from "node:test";

import { StartupOperationRegistry } from "../../src-electron/startup-operation-registry.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("tracks a runner until it settles and removes it exactly once", async () => {
  const registry = new StartupOperationRegistry();
  const gate = deferred();
  const running = registry.run(() => gate.promise);

  await Promise.resolve();
  assert.equal(registry.size, 1);
  gate.resolve("done");
  assert.equal(await running, "done");
  assert.equal(registry.size, 0);
  assert.deepEqual(await registry.waitForSettled(10), { settled: true, pending: 0 });
});

test("relays an external AbortSignal without leaving a tracked runner", async () => {
  const registry = new StartupOperationRegistry();
  const external = new AbortController();
  const reason = new Error("cancel external setup");
  let observedSignal;

  const running = registry.run(async (signal) => {
    observedSignal = signal;
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    throw signal.reason;
  }, external.signal);
  await Promise.resolve();
  external.abort(reason);

  await assert.rejects(running, reason);
  assert.equal(observedSignal.aborted, true);
  assert.equal(observedSignal.reason, reason);
  assert.equal(registry.size, 0);
});

test("abort cancels every active runner and waitForSettled waits for cleanup", async () => {
  const registry = new StartupOperationRegistry();
  const reason = new Error("application quit");
  const observed = [];
  const runners = [1, 2].map(() =>
    registry.run(
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              observed.push(signal.reason);
              resolve();
            },
            { once: true }
          );
        })
    )
  );

  await Promise.resolve();
  assert.equal(registry.abort(reason), 2);
  assert.deepEqual(await registry.waitForSettled(100), { settled: true, pending: 0 });
  await Promise.all(runners);
  assert.deepEqual(observed, [reason, reason]);
});

test("waitForSettled reports a bounded timeout for an uncooperative runner", async () => {
  const registry = new StartupOperationRegistry();
  const gate = deferred();
  const running = registry.run(() => gate.promise);
  await Promise.resolve();

  assert.deepEqual(await registry.waitForSettled(5), { settled: false, pending: 1 });
  gate.resolve();
  await running;
  assert.deepEqual(await registry.waitForSettled(5), { settled: true, pending: 0 });
});

test("new runners receive the registry initial abort reason", async () => {
  const reason = new Error("application is quitting");
  const registry = new StartupOperationRegistry({ getInitialAbortReason: () => reason });

  const result = await registry.run((signal) => ({ aborted: signal.aborted, reason: signal.reason }));
  assert.equal(result.aborted, true);
  assert.equal(result.reason, reason);
  assert.equal(registry.size, 0);
});

test("synchronous operation errors reject and clean the registry", async () => {
  const registry = new StartupOperationRegistry();
  const expected = new Error("sync failure");

  await assert.rejects(
    registry.run(() => {
      throw expected;
    }),
    expected
  );
  assert.equal(registry.size, 0);
});
