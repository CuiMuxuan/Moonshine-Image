import test from "node:test";
import assert from "node:assert/strict";

import {
  ApplicationBootstrapError,
  bootstrapApplication,
  createFatalStartupHandler,
} from "../../src-electron/app-bootstrap.js";

function createSteps(overrides = {}) {
  const calls = [];
  return {
    calls,
    options: {
      verifyIntegrity: async () => {
        calls.push("integrity");
        return { success: true };
      },
      registerProtocol: async () => calls.push("protocol"),
      loadConfig: async () => calls.push("config"),
      cleanupTemporaryFiles: async () => calls.push("cleanup"),
      createWindow: async () => calls.push("window"),
      ...overrides,
    },
  };
}

test("bootstrapApplication awaits startup steps in order", async () => {
  const { calls, options } = createSteps();
  assert.deepEqual(await bootstrapApplication(options), { success: true });
  assert.deepEqual(calls, ["integrity", "protocol", "config", "cleanup", "window"]);
});

test("bootstrapApplication preserves integrity exit code", async () => {
  const { options } = createSteps({
    verifyIntegrity: async () => ({ success: false, error: "manifest mismatch" }),
  });
  await assert.rejects(
    bootstrapApplication(options),
    (error) =>
      error instanceof ApplicationBootstrapError &&
      error.code === "APP_RESOURCE_INTEGRITY_FAILED" &&
      error.exitCode === 173
  );
});

test("bootstrapApplication wraps asynchronous window failures", async () => {
  const { options } = createSteps({
    createWindow: async () => {
      throw new Error("loadFile failed");
    },
  });
  await assert.rejects(
    bootstrapApplication(options),
    (error) =>
      error instanceof ApplicationBootstrapError &&
      error.phase === "window-creation" &&
      error.cause?.message === "loadFile failed"
  );
});

for (const [phase, overrideName] of [
  ["protocol-registration", "registerProtocol"],
  ["config-loading", "loadConfig"],
  ["temporary-cleanup", "cleanupTemporaryFiles"],
]) {
  test(`bootstrapApplication wraps ${phase} failures`, async () => {
    const { options } = createSteps({
      [overrideName]: async () => {
        throw new Error(`${phase} failed`);
      },
    });
    await assert.rejects(
      bootstrapApplication(options),
      (error) =>
        error instanceof ApplicationBootstrapError &&
        error.phase === phase &&
        error.exitCode === 174
    );
  });
}

test("bootstrapApplication preserves window diagnostics", async () => {
  const diagnostic = { id: "window-diagnostic", code: "APP_PRELOAD_FAILED" };
  const { options } = createSteps({
    createWindow: async () => {
      throw new ApplicationBootstrapError("preload failed", {
        code: "APP_PRELOAD_FAILED",
        phase: "preload",
        diagnostic,
      });
    },
  });
  await assert.rejects(
    bootstrapApplication(options),
    (error) => error.diagnostic === diagnostic && error.phase === "preload"
  );
});

test("fatal startup handling logs, displays, and exits only once", async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const handleFatal = createFatalStartupHandler(async (error) => {
    calls.push(["log", error.message]);
    await gate;
    calls.push(["dialog", error.message]);
    calls.push(["exit", 174]);
    return { code: "APP_BOOTSTRAP_FAILED", source: error.message };
  });

  const first = handleFatal(new Error("loadFile failed"));
  const second = handleFatal(new Error("preload failed"));
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(firstResult, secondResult);
  assert.deepEqual(calls, [
    ["log", "loadFile failed"],
    ["dialog", "loadFile failed"],
    ["exit", 174],
  ]);
});
