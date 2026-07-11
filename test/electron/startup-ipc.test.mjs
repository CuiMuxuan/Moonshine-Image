import assert from "node:assert/strict";
import test from "node:test";

import { runStartupIpcOperation } from "../../src-electron/startup-ipc.js";

test("returns successful asynchronous startup IPC results unchanged", async () => {
  const expected = { success: true, pythonPath: "runtime/python.exe" };
  const result = await runStartupIpcOperation(async () => expected, () => {
    throw new Error("failure normalizer should not run");
  });
  assert.equal(result, expected);
});

test("normalizes a rejected conda-unpack operation instead of exposing a remote rejection", async () => {
  const diagnostic = {
    id: "startup-test-1",
    code: "BUNDLED_RUNTIME_RELOCATION_FAILED",
    stage: "bundled-runtime-relocation",
    exitCode: 1,
    stderrTail: "conda-unpack failed",
  };
  const failure = Object.assign(new Error("conda-unpack failed"), { diagnostic });
  let normalizationCount = 0;

  const result = await runStartupIpcOperation(
    () => Promise.reject(failure),
    async (error) => {
      normalizationCount += 1;
      return {
        success: false,
        code: error.diagnostic.code,
        error: "Bundled Python runtime preparation failed.",
        recoveryHint: "Re-extract the application package and retry.",
        diagnostic: error.diagnostic,
      };
    }
  );

  assert.equal(normalizationCount, 1);
  assert.equal(result.success, false);
  assert.equal(result.code, "BUNDLED_RUNTIME_RELOCATION_FAILED");
  assert.equal(result.diagnostic, diagnostic);
});

test("normalizes synchronous startup failures through the same boundary", async () => {
  const expected = new Error("synchronous setup failure");
  const result = await runStartupIpcOperation(
    () => {
      throw expected;
    },
    (error) => ({ success: false, error: error.message })
  );
  assert.deepEqual(result, { success: false, error: expected.message });
});
