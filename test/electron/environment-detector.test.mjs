import assert from "node:assert/strict";
import test from "node:test";

import {
  detectAccelerator,
  evaluateNvidiaResult,
  isCu130Compatible,
} from "../../src-electron/runtime/environment-detector.js";

test("auto selects cu130 when nvidia-smi reports a compatible driver", async () => {
  const calls = [];
  const result = await detectAccelerator({
    preference: "auto",
    runner: async (command, args) => {
      calls.push({ command, args });
      return { code: 0, stdout: "NVIDIA GeForce RTX 4090, 576.52\n", stderr: "" };
    },
    minimumDriverMajor: 570,
  });

  assert.equal(result.selectedAccelerator, "cu130");
  assert.equal(result.reason, "auto-nvidia-compatible");
  assert.equal(result.nvidia.driverMajor, 576);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("--query-gpu=name,driver_version"));
  assert.equal(isCu130Compatible({ code: 0, stdout: "driver 576.52" }, { minimumDriverMajor: 570 }), true);
});

test("auto falls back to CPU with an explicit reason when NVIDIA is unavailable", async () => {
  const result = await detectAccelerator({
    preference: "auto",
    runner: async () => ({ code: 1, stdout: "", stderr: "nvidia-smi not found" }),
  });

  assert.equal(result.selectedAccelerator, "cpu");
  assert.match(result.reason, /nvidia-smi/);
  assert.equal(result.nvidia.available, false);
});

test("manual CPU skips probing and manual cu130 never silently falls back", async () => {
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return { code: 1, stderr: "no GPU" };
  };
  const cpu = await detectAccelerator({ preference: "cpu", runner });
  assert.equal(cpu.selectedAccelerator, "cpu");
  assert.equal(cpu.nvidia.skipped, true);
  assert.equal(calls, 0);

  await assert.rejects(
    detectAccelerator({ preference: "cu130", runner }),
    (error) => error.code === "ENVIRONMENT_CU130_UNAVAILABLE",
  );
});

test("RTX 4060 Ti driver 560.94 emits explicit terminal data when auto falls back to CPU", async () => {
  const emitted = [];
  const result = await detectAccelerator({
    preference: "auto",
    runner: async () => ({
      code: 0,
      stdout: "NVIDIA GeForce RTX 4060 Ti, 560.94\n",
      stderr: "",
    }),
    minimumDriverMajor: 570,
    onEvent: (event) => emitted.push(event),
  });

  assert.equal(result.selectedAccelerator, "cpu");
  assert.equal(result.nvidia.gpuName, "NVIDIA GeForce RTX 4060 Ti");
  assert.equal(result.nvidia.driverVersion, "560.94");
  assert.equal(result.nvidia.compatible, false);
  assert.equal(result.event.type, "cu130-fallback-cpu");
  assert.equal(result.event.logOnly, true);
  assert.equal(result.event.status, "warning");
  assert.equal(result.event.terminal, true);
  assert.equal(result.event.terminalType, "warning");
  assert.equal(result.event.minimumDriverMajor, 570);
  assert.match(result.event.message, /RTX 4060 Ti.*560\.94.*570.*CPU/u);
  assert.deepEqual(emitted, result.events);
});

test("NVIDIA evaluation keeps GPU model and driver as separate diagnostics", () => {
  const result = evaluateNvidiaResult({
    code: 0,
    stdout: "NVIDIA GeForce RTX 4060 Ti, 560.94\n",
  }, 570);

  assert.equal(result.available, true);
  assert.equal(result.gpuName, "NVIDIA GeForce RTX 4060 Ti");
  assert.equal(result.driverVersion, "560.94");
  assert.equal(result.driverMajor, 560);
  assert.match(result.reason, /below the cu130 minimum \(570\)/u);
});
