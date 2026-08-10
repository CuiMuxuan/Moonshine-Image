import assert from "node:assert/strict";
import test from "node:test";

import { AppUpdaterService, APP_UPDATE_STATUS } from "../../src-electron/updater/app-updater.js";

function createUpdater() {
  const listeners = new Map();
  return {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on(event, handler) { listeners.set(event, handler); },
    removeListener(event) { listeners.delete(event); },
    async checkForUpdates() {
      listeners.get("update-available")?.({ version: "1.3.1" });
      return { updateInfo: { version: "1.3.1" }, isUpdateAvailable: true };
    },
    async downloadUpdate() {},
    async quitAndInstall() {},
  };
}

test("AppUpdaterService blocks electron-updater when signed app manifest preflight fails", async () => {
  const updater = createUpdater();
  let providerCalled = false;
  const service = new AppUpdaterService({
    updater,
    isPackaged: true,
    preflight: async () => { throw Object.assign(new Error("signature invalid"), { code: "MANIFEST_SIGNATURE_INVALID" }); },
  });
  updater.checkForUpdates = async () => {
    providerCalled = true;
    return { updateInfo: { version: "1.3.1" }, isUpdateAvailable: true };
  };
  const result = await service.checkForUpdates();
  assert.equal(result.success, false);
  assert.equal(providerCalled, false);
  assert.equal(result.state.status, APP_UPDATE_STATUS.ERROR);
  assert.equal(result.state.error.code, "MANIFEST_SIGNATURE_INVALID");
  service.dispose();
});

test("AppUpdaterService validates signed app metadata after provider check", async () => {
  const updater = createUpdater();
  const service = new AppUpdaterService({
    updater,
    isPackaged: true,
    preflight: async () => ({ verified: true }),
    validateUpdateInfo: () => { throw Object.assign(new Error("version mismatch"), { code: "APP_MANIFEST_VERSION_MISMATCH" }); },
  });
  const result = await service.checkForUpdates();
  assert.equal(result.success, false);
  assert.equal(result.state.error.code, "APP_MANIFEST_VERSION_MISMATCH");
  service.dispose();
});

