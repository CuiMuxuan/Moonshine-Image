import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPinia, setActivePinia } from "pinia";

import { useUpdateManagerStore } from "../src/stores/updateManager.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const settingsSource = fs.readFileSync(
  path.join(repoRoot, "src/components/global/GlobalSettings.vue"),
  "utf8"
);
const layoutSource = fs.readFileSync(
  path.join(repoRoot, "src/layouts/MainLayout.vue"),
  "utf8"
);
const backendManagerSource = fs.readFileSync(
  path.join(repoRoot, "src/components/global/BackendManager.vue"),
  "utf8"
);
const electronMainSource = fs.readFileSync(
  path.join(repoRoot, "src-electron/electron-main.js"),
  "utf8"
);

test("update actions only retry the phase reported by the main process", () => {
  setActivePinia(createPinia());
  const updateManager = useUpdateManagerStore();

  updateManager.applyState({ enabled: true, status: "error", retryAction: "check" });
  assert.equal(updateManager.canCheck, true);
  assert.equal(updateManager.canDownload, false);
  assert.equal(updateManager.canInstall, false);

  updateManager.applyState({ status: "error", retryAction: "download" });
  assert.equal(updateManager.canCheck, false);
  assert.equal(updateManager.canDownload, true);
  assert.equal(updateManager.canInstall, false);

  updateManager.applyState({ status: "error", retryAction: "install" });
  assert.equal(updateManager.canCheck, false);
  assert.equal(updateManager.canDownload, false);
  assert.equal(updateManager.canInstall, true);
});

test("the update store owns one named preload subscription and disposes it safely", async () => {
  const originalWindow = globalThis.window;
  let stateListener = null;
  let unsubscribeCalls = 0;
  globalThis.window = {
    electron: {
      ipcRenderer: {
        getAppUpdateState: async () => ({
          enabled: true,
          status: "available",
          currentVersion: "1.2.0",
          availableVersion: "1.3.0",
        }),
        onAppUpdateState: (listener) => {
          stateListener = listener;
          return () => {
            unsubscribeCalls += 1;
          };
        },
      },
    },
  };

  try {
    setActivePinia(createPinia());
    const updateManager = useUpdateManagerStore();
    await updateManager.initialize();

    assert.equal(updateManager.state.status, "available");
    assert.equal(updateManager.state.availableVersion, "1.3.0");
    stateListener?.({ status: "downloaded", progress: 100 });
    assert.equal(updateManager.state.status, "downloaded");
    assert.equal(updateManager.state.progress, 100);

    updateManager.dispose();
    updateManager.dispose();
    assert.equal(unsubscribeCalls, 1);
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }
});

test("the main layout owns the updater subscription and update attention entry", () => {
  assert.match(layoutSource, /const updateInitialization = updateManager\.initialize\(\)/);
  assert.match(layoutSource, /await updateInitialization/);
  assert.match(layoutSource, /updateManager\.dispose\(\)/);
  assert.match(layoutSource, /data-testid="app-update-settings-badge"/);
  assert.match(layoutSource, /openGlobalSettings\(\{ tab: "updates" \}\)/);

  assert.doesNotMatch(settingsSource, /updateManager\.initialize\(\)/);
  assert.doesNotMatch(settingsSource, /updateManager\.dispose\(\)/);
});

test("runtime onboarding waits for startup and never blocks a ready environment", () => {
  const dialogStart = layoutSource.indexOf("<q-dialog\n    :model-value=\"runtimePreparationVisible\"");
  const dialogEnd = layoutSource.indexOf("<startup-overlay", dialogStart);
  const dialogSource = layoutSource.slice(dialogStart, dialogEnd);

  assert.ok(dialogStart >= 0 && dialogEnd > dialogStart);
  assert.doesNotMatch(dialogSource, /\bpersistent\b|no-esc-dismiss|no-backdrop-dismiss/);
  assert.match(dialogSource, /runtime-preparation-close/);
  assert.match(dialogSource, /runtime-preparation-defer/);
  assert.match(dialogSource, /runtime-preparation-guide/);
  assert.match(dialogSource, /label="暂不配置"/);
  assert.match(dialogSource, /label="引导配置"/);
  assert.match(layoutSource, /startupExperienceFinished\.value &&/);
  assert.match(layoutSource, /runtimeEnvironmentNeedsAttention\.value/);
  assert.match(layoutSource, /\["needs-create", "needs-repair", "needs-download", "failed"\]/);
  assert.doesNotMatch(dialogSource, /preparing|creating|repairing|downloading|verifying/);
  assert.match(layoutSource, /openGlobalSettings\(\{ tab: "updates" \}\)/);
  assert.match(layoutSource, /startupExperienceFinished\.value = true/);
  assert.match(layoutSource, /updateManager\.runtimeState\.status !== "ready"/);
  assert.match(electronMainSource, /state\?\.status !== "ready"/);
  assert.match(electronMainSource, /return await environmentManager\.check\(\)/);
  assert.match(
    electronMainSource,
    /ipcMain\.handle\("runtime-get-state", async \(\) => \{[\s\S]*await environmentManagerInitialization/
  );
});

test("the settings update panel is progressive and confirms installation", () => {
  assert.match(settingsSource, /v-if="showCheckUpdateAction"/);
  assert.match(settingsSource, /v-if="showDownloadUpdateAction"/);
  assert.match(settingsSource, /v-if="showInstallUpdateAction"/);
  assert.match(settingsSource, /title: "重启并安装更新"/);
  assert.match(settingsSource, /\.onOk\(\(\) => \{/);
  assert.match(settingsSource, /updateTransferSummary/);
  assert.match(settingsSource, /formatUpdateBytes\(updateState\.bytesPerSecond\)/);
  assert.match(settingsSource, /formatUpdateDateTime\(updateManager\.state\.checkedAt\)/);
  assert.match(settingsSource, /formatUpdateDateTime\(updateManager\.state\.releaseDate\)/);
  assert.match(settingsSource, /\{\{ updateManager\.state\.releaseNotes \}\}/);
  assert.doesNotMatch(settingsSource, /v-html[^\n]*releaseNotes/);
  assert.match(settingsSource, /global-settings-update-channel/);
  assert.match(settingsSource, /label: "测试"/);
  assert.match(settingsSource, /handleUpdateChannel/);
});

test("the update store switches the selected release channel through the preload API", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = {
    electron: {
      ipcRenderer: {
        setAppUpdateChannel: async (channel) => ({
          success: true,
          channel,
          state: { enabled: true, channel, status: "idle" },
        }),
      },
    },
  };
  try {
    setActivePinia(createPinia());
    const updateManager = useUpdateManagerStore();
    const result = await updateManager.setAppUpdateChannel("test");
    assert.equal(result.success, true);
    assert.equal(updateManager.state.channel, "test");
    assert.equal(updateManager.state.status, "idle");
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("runtime state is local environment state with a normalized accelerator", () => {
  setActivePinia(createPinia());
  const updateManager = useUpdateManagerStore();

  updateManager.applyRuntimeState({
    enabled: true,
    status: "ready",
    channel: "beta",
    accelerator: "cu130",
    specHash: "sha256:environment-spec",
    pythonVersion: "3.12.10",
  });

  assert.equal(updateManager.runtimeState.selectedAccelerator, "cu130");
  assert.equal(updateManager.runtimeState.specHash, "sha256:environment-spec");
  assert.equal(updateManager.runtimeState.pythonVersion, "3.12.10");
  assert.equal("channel" in updateManager.runtimeState, false);
  assert.equal(updateManager.runtimeStatusLabel, "环境就绪");
  assert.equal(updateManager.runtimeState.restartRequired, false);
});

test("settings summarizes environment state while backend manager owns environment actions", () => {
  assert.match(settingsSource, /运行环境/);
  assert.doesNotMatch(settingsSource, /运行时组件/);
  assert.doesNotMatch(settingsSource, /runtimeChannelOptions|global-settings-runtime-channel|发布通道（应用与组件）/);
  assert.match(settingsSource, /global-settings-open-backend-manager/);
  assert.doesNotMatch(settingsSource, /global-settings-runtime-ensure/);
  assert.match(backendManagerSource, /label: "自动（推荐）"/);
  assert.match(backendManagerSource, /label: "CPU"/);
  assert.match(backendManagerSource, /label: "NVIDIA cu130"/);
  assert.match(backendManagerSource, /backend-managed-environment-check/);
  assert.match(backendManagerSource, /backend-managed-environment-ensure/);
  assert.match(backendManagerSource, /backend-managed-environment-restart-required/);
  assert.match(backendManagerSource, /label: "立即重启"/);
  assert.match(backendManagerSource, /label: "稍后重启"/);
  assert.match(settingsSource, /global-settings-runtime-restart-required/);
  assert.match(settingsSource, /updateManager\.restartApplication\(\)/);
  assert.match(settingsSource, /global-settings-runtime-diagnostics/);
  assert.match(settingsSource, /specHash/);
  assert.doesNotMatch(layoutSource, /运行时组件/);
  assert.match(layoutSource, /运行环境尚未创建/);
});

test("the update store routes external environment actions through IPC fallbacks", async () => {
  const originalWindow = globalThis.window;
  const calls = [];
  globalThis.window = {
    electron: {
      ipcRenderer: {
        invoke: async (channel, payload) => {
          calls.push([channel, payload]);
          if (channel === "environment-external-select-directory") {
            return {
              success: true,
              candidateId: "candidate-1",
              selectedPath: "C:\\runtime",
              external: {
                status: "stale",
                candidateId: "candidate-1",
                selectedPath: "C:\\runtime",
              },
            };
          }
          if (channel === "environment-external-probe") {
            return {
              success: true,
              candidateId: "candidate-1",
              valid: true,
              canActivate: true,
              diagnostics: { python: { success: true, version: "3.12.10" } },
              external: {
                status: "valid",
                candidateId: "candidate-1",
                selectedPath: "C:\\runtime",
                layout: "conda",
                canActivate: true,
              },
              state: {
                source: "managed",
                externalCandidateToken: "core-token-must-not-reach-store",
                external: {
                  status: "valid",
                  candidateId: "candidate-1",
                  selectedPath: "C:\\runtime",
                  layout: "conda",
                  canActivate: true,
                },
              },
            };
          }
          if (channel === "environment-external-activate") {
            return {
              success: true,
              diagnostics: { python: { success: true, version: "3.12.10" } },
              external: {
                status: "active",
                candidateId: null,
                selectedPath: "C:\\runtime",
                layout: "conda",
                canActivate: false,
              },
              state: {
                source: "external",
                status: "ready",
                externalConfigured: true,
                externalPath: "C:\\runtime",
                externalLayout: "conda",
                selectedAccelerator: "cpu",
              },
            };
          }
          if (channel === "environment-external-forget") {
            return { success: true, state: { source: "managed" } };
          }
          return { success: false, code: "UNEXPECTED_CHANNEL" };
        },
      },
    },
  };

  try {
    setActivePinia(createPinia());
    const updateManager = useUpdateManagerStore();

    await updateManager.selectExternalEnvironmentDirectory();
    assert.equal(updateManager.runtimeState.external.selectedPath, "C:\\runtime");

    await updateManager.probeExternalEnvironment();
    assert.equal(updateManager.runtimeState.external.status, "valid");
    assert.equal(updateManager.runtimeState.external.candidateId, "candidate-1");
    assert.equal(updateManager.runtimeState.external.canActivate, true);
    assert.equal(updateManager.runtimeState.external.diagnostics.python.version, "3.12.10");
    assert.equal("externalCandidateToken" in updateManager.runtimeState, false);

    await updateManager.activateExternalEnvironment();
    assert.equal(updateManager.runtimeState.source, "external");
    assert.equal(updateManager.runtimeState.external.status, "active");

    await updateManager.returnToManagedEnvironment();
    assert.equal(updateManager.runtimeState.source, "managed");
    assert.equal(updateManager.runtimeState.external.status, "unselected");

    assert.deepEqual(calls.map(([channel]) => channel), [
      "environment-external-select-directory",
      "environment-external-probe",
      "environment-external-activate",
      "environment-external-forget",
    ]);
    assert.equal(calls[1][1].candidateId, "candidate-1");
    assert.equal(calls[2][1].candidateId, "candidate-1");
    assert.deepEqual(Object.keys(calls[1][1]), ["candidateId"]);
    assert.deepEqual(Object.keys(calls[2][1]), ["candidateId"]);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("backend manager offers a read-only external Python environment workflow", () => {
  assert.match(backendManagerSource, /Python 环境来源/);
  assert.match(backendManagerSource, /label: "自动管理"/);
  assert.match(backendManagerSource, /label: "已有环境"/);
  assert.match(backendManagerSource, /<q-stepper[\s\S]*?header-nav/);
  assert.match(backendManagerSource, /readonly/);
  assert.match(backendManagerSource, /icon="folder_open"/);
  assert.match(backendManagerSource, /backend-external-environment-help/);
  assert.match(backendManagerSource, /externalEnvironmentHelpColor/);
  assert.match(backendManagerSource, /不要选择 python\.exe 或其他 EXE 文件/);
  assert.match(backendManagerSource, /runtime-manifest\.json/);
  assert.match(backendManagerSource, /Scripts\/python\.exe/);
  assert.match(backendManagerSource, /未选择/);
  assert.match(backendManagerSource, /校验中/);
  assert.match(backendManagerSource, /可使用/);
  assert.match(backendManagerSource, /使用中/);
  assert.match(backendManagerSource, /需要重新校验/);
  assert.match(backendManagerSource, /不可用/);
  ["Python", "PyTorch", "加速类型", "CUDA", "后端模块", "应用内置 FFmpeg"].forEach((label) => {
    assert.match(backendManagerSource, new RegExp(label));
  });
  assert.match(backendManagerSource, /label="重新校验"/);
  assert.match(backendManagerSource, /label="使用此环境"/);
  assert.match(backendManagerSource, /label="忘记此目录"/);
  assert.match(backendManagerSource, /label="停止使用"/);
  assert.match(backendManagerSource, /外部目录未被修改/);
  assert.match(backendManagerSource, /未检测到运行时/);
  assert.match(backendManagerSource, /正在自动安装/);
  assert.match(backendManagerSource, /请重试，或手动创建可用环境/);
  assert.doesNotMatch(backendManagerSource, /离线|offline/i);
  assert.doesNotMatch(backendManagerSource, /if \(!candidateId\) pythonEnvironmentSource\.value = "managed"/);
  assert.match(backendManagerSource, /const checkedProjectPath = resolveCheckedProjectPath\(projectResult\)/);
  assert.match(backendManagerSource, /PROJECT_PATH_MISSING/);
  assert.doesNotMatch(backendManagerSource, /后端项目检测成功：\$\{projectResult\.path\}/);
  assert.doesNotMatch(backendManagerSource, /environment-external-[^"']+[\s\S]*execute-command/);
});
