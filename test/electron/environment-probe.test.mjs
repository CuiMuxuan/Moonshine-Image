import assert from "node:assert/strict";
import test from "node:test";

import { probeEnvironment } from "../../src-electron/runtime/environment-probe.js";

test("environment probe checks Python, torch, CUDA, backend, and FFmpeg through the injected runner", async () => {
  const calls = [];
  const result = await probeEnvironment({
    root: "C:/managed/env",
    platform: "win32",
    accelerator: "cu130",
    runner: async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "--version") return { code: 0, stdout: "Python 3.12.11\n" };
      if (args[1]?.includes("__version__")) {
        return { code: 0, stdout: '{"version":"2.11.0+cu130","cuda":true}\n' };
      }
      if (args[1]?.includes("device_count")) {
        return { code: 0, stdout: '{"available":true,"version":"13.0","deviceCount":1}\n' };
      }
      if (args[0] === "-version") return { code: 0, stdout: "ffmpeg version 8.0\n" };
      return { code: 0, stdout: "ok\n" };
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.python.version, "3.12.11");
  assert.equal(result.torch.version, "2.11.0+cu130");
  assert.equal(result.cuda.available, true);
  assert.equal(result.cuda.deviceCount, 1);
  assert.equal(result.backend.ok, true);
  assert.equal(result.ffmpeg.version, "8.0");
  assert.equal(calls.length, 5);
});

test("environment probe aggregates actionable failures instead of hiding them", async () => {
  const result = await probeEnvironment({
    root: "C:/managed/env",
    platform: "win32",
    runner: async (_command, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "Python 3.12.11" };
      return { code: 1, stderr: `failed ${args[0] === "-version" ? "ffmpeg" : "python module"}` };
    },
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.some((value) => value.startsWith("PyTorch:")));
  assert.ok(result.errors.some((value) => value.startsWith("CUDA:")));
  assert.ok(result.errors.some((value) => value.startsWith("Backend:")));
  assert.ok(result.errors.some((value) => value.startsWith("FFmpeg:")));
});

test("cu130 probe fails when the installed torch cannot see CUDA", async () => {
  const result = await probeEnvironment({
    root: "C:/managed/env",
    platform: "win32",
    accelerator: "cu130",
    runner: async (_command, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "Python 3.12.11" };
      if (args[1]?.includes("__version__")) return { code: 0, stdout: '{"version":"2.11.0+cu130"}' };
      if (args[1]?.includes("device_count")) return { code: 0, stdout: '{"available":false,"deviceCount":0}' };
      if (args[0] === "-version") return { code: 0, stdout: "ffmpeg version 8.0" };
      return { code: 0, stdout: "ok" };
    },
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.some((value) => value.includes("cu130 environment")));
});
