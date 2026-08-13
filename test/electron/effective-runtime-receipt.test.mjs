import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  effectiveRuntimeReceiptPath,
  markEffectiveRuntimeReceiptStopped,
  writeEffectiveRuntimeReceipt,
} from "../../src-electron/runtime/effective-runtime-receipt.js";

test("effective runtime receipt records actual paths and can be marked stopped", async (t) => {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-effective-runtime-"));
  t.after(() => fs.rm(userData, { recursive: true, force: true }));
  const serviceProjectPath = path.join(userData, "resources", "backend", "server");
  const environmentRoot = path.join(userData, "environments", "win-x64", "cpu", "spec");
  const pythonExecutable = path.join(environmentRoot, "venv", "Scripts", "python.exe");

  const written = await writeEffectiveRuntimeReceipt({
    userData,
    appVersion: "1.3.1",
    appProcessId: 123,
    serviceProcessId: 456,
    serviceProjectPath,
    pythonExecutable,
    environmentRoot,
    environmentSource: "managed",
    accelerator: "cpu",
    specHash: "a".repeat(64),
    port: 8080,
    startedAt: "2026-08-11T00:00:00.000Z",
  });

  assert.equal(written.filePath, effectiveRuntimeReceiptPath(userData));
  assert.equal(written.receipt.status, "running");
  assert.equal(written.receipt.serviceProjectPath, path.resolve(serviceProjectPath));
  assert.equal(written.receipt.pythonExecutable, path.resolve(pythonExecutable));
  assert.equal(written.receipt.environmentSource, "managed");

  const stopped = await markEffectiveRuntimeReceiptStopped({
    userData,
    status: "failed",
    stoppedAt: "2026-08-11T00:01:00.000Z",
  });
  assert.equal(stopped.changed, true);
  assert.equal(stopped.receipt.status, "failed");
  assert.equal(stopped.receipt.stoppedAt, "2026-08-11T00:01:00.000Z");
  const persisted = JSON.parse(await fs.readFile(written.filePath, "utf8"));
  assert.equal(persisted.status, "failed");
});
