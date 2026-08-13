import assert from "node:assert/strict";
import test from "node:test";

import { createPinia, setActivePinia } from "pinia";

import { useUpdateManagerStore } from "../../src/stores/updateManager.js";

const compatibleCpuStatus = {
  success: true,
  available: true,
  source: "managed",
  status: "ready",
  checkedAt: "2026-08-13T12:00:00.000Z",
  currentAccelerator: "cpu",
  python: { version: "3.12.11" },
  torch: { version: "2.11.0+cpu", cudaVersion: null, cudaAvailable: false },
  nvidiaDeviceName: "NVIDIA GeForce RTX 4060 Ti",
  nvidiaDriverVersion: "576.88",
  canSwitchToCu130: true,
  canSwitchToCpu: false,
  acceleratorChangeReason: null,
};

test("environment update store maps status and sends dedicated plan/switch calls", async () => {
  const originalWindow = globalThis.window;
  const calls = [];
  globalThis.window = {
    electron: {
      ipcRenderer: {
        getEnvironmentUpdateStatus: async () => {
          calls.push(["status"]);
          return compatibleCpuStatus;
        },
        getEnvironmentUpdatePlan: async (payload) => {
          calls.push(["plan", payload]);
          return {
            success: true,
            allowed: true,
            requiresConfirmation: true,
            targetAccelerator: payload.target,
            status: compatibleCpuStatus,
          };
        },
        switchEnvironment: async (payload) => {
          calls.push(["switch", payload]);
          return {
            success: true,
            needsPrepare: false,
            updateStatus: {
              ...compatibleCpuStatus,
              currentAccelerator: "cu130",
              torch: { version: "2.11.0+cu130", cudaVersion: "13.0", cudaAvailable: true },
              canSwitchToCu130: false,
              canSwitchToCpu: true,
            },
            state: { status: "ready", selectedAccelerator: "cu130" },
          };
        },
      },
    },
  };
  try {
    setActivePinia(createPinia());
    const store = useUpdateManagerStore();

    const status = await store.checkEnvironmentUpdate();
    assert.equal(status.success, true);
    assert.equal(store.runtimeState.environmentUpdate.usable, true);
    assert.equal(store.runtimeState.environmentUpdate.pythonVersion, "3.12.11");
    assert.equal(store.runtimeState.environmentUpdate.torchVersion, "2.11.0+cpu");
    assert.equal(store.runtimeState.environmentUpdate.gpuName, "NVIDIA GeForce RTX 4060 Ti");
    assert.equal(store.runtimeState.environmentUpdate.nvidiaDriverVersion, "576.88");
    assert.equal(store.runtimeState.environmentUpdate.canSwitchToCu130, true);

    const plan = await store.getEnvironmentSwitchPlan("cu130");
    assert.equal(plan.allowed, true);
    const switched = await store.switchEnvironmentAccelerator({ target: "cu130", confirmed: true });
    assert.equal(switched.success, true);
    assert.equal(store.runtimeState.environmentUpdate.currentAccelerator, "cu130");
    assert.equal(store.runtimeState.environmentUpdate.torchPackage, "cuda");
    assert.equal(store.runtimeState.environmentUpdate.canSwitchToCpu, true);
    assert.deepEqual(calls, [
      ["status"],
      ["plan", { target: "cu130" }],
      ["switch", { target: "cu130", confirmed: true }],
    ]);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
