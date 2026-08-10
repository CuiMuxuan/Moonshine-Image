import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_UPDATE_ACTION,
  APP_UPDATE_STATUS,
  AppUpdaterService,
} from "../../src-electron/updater/app-updater.js";

const repoRoot = path.resolve(dirname(fileURLToPath(import.meta.url)), "../..");

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.checkCalls = 0;
    this.downloadCalls = 0;
    this.installCalls = [];
  }

  async checkForUpdates() {
    this.checkCalls += 1;
    this.emit("checking-for-update");
    this.emit("update-available", {
      version: "1.3.0",
      releaseName: "Moonshine 1.3.0",
      releaseNotes: "Fixes and improvements",
    });
    return { isUpdateAvailable: true, updateInfo: { version: "1.3.0" } };
  }

  async downloadUpdate() {
    this.downloadCalls += 1;
    this.emit("download-progress", {
      percent: 42,
      bytesPerSecond: 1024,
      transferred: 42,
      total: 100,
    });
    this.emit("update-downloaded", { version: "1.3.0" });
    return ["Moonshine-Image-Setup-1.3.0.exe"];
  }

  quitAndInstall(...args) {
    this.installCalls.push(args);
  }
}

function createService(updater, overrides = {}) {
  const states = [];
  const service = new AppUpdaterService({
    updater,
    isPackaged: true,
    currentVersion: "1.2.0",
    now: () => 1_700_000_000_000,
    send: (state) => states.push(state),
    ...overrides,
  });
  return { service, states };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("app updater maps check and download events to a stable state", async () => {
  const updater = new FakeUpdater();
  const { service, states } = createService(updater);

  assert.equal(service.getState().status, APP_UPDATE_STATUS.IDLE);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);

  const checkResult = await service.checkForUpdates();
  assert.equal(checkResult.success, true);
  assert.equal(service.getState().status, APP_UPDATE_STATUS.AVAILABLE);
  assert.equal(service.getState().availableVersion, "1.3.0");
  assert.equal(service.getState().releaseNotes, "Fixes and improvements");

  const downloadResult = await service.downloadUpdate();
  assert.equal(downloadResult.success, true);
  assert.equal(service.getState().status, APP_UPDATE_STATUS.DOWNLOADED);
  assert.equal(service.getState().progress, 100);
  assert.equal(updater.checkCalls, 1);
  assert.equal(updater.downloadCalls, 1);
  assert.ok(states.some((state) => state.status === APP_UPDATE_STATUS.DOWNLOADING));
});

test("app update channel changes clear stale availability but preserve a downloaded update", async () => {
  const updater = new FakeUpdater();
  const { service } = createService(updater);
  await service.checkForUpdates();

  const changed = service.setChannel("beta");
  assert.equal(changed.success, true);
  assert.equal(changed.changed, true);
  assert.equal(changed.state.channel, "beta");
  assert.equal(changed.state.status, APP_UPDATE_STATUS.IDLE);
  assert.equal(changed.state.availableVersion, null);

  await service.checkForUpdates();
  await service.downloadUpdate();
  const locked = service.setChannel("stable");
  assert.equal(locked.success, false);
  assert.equal(locked.code, "APP_UPDATE_CHANNEL_LOCKED");
  assert.equal(locked.state.channel, "beta");
  assert.equal(locked.state.status, APP_UPDATE_STATUS.DOWNLOADED);
});

test("install is blocked while the host reports active work", async () => {
  const updater = new FakeUpdater();
  const { service } = createService(updater);
  await service.checkForUpdates();
  await service.downloadUpdate();

  const blocked = await service.installUpdate(() => ({
    allowed: false,
    reason: "后端服务仍在运行。",
  }));
  assert.equal(blocked.success, false);
  assert.equal(blocked.code, "APP_UPDATE_INSTALL_BLOCKED");
  assert.equal(service.getState().status, APP_UPDATE_STATUS.DOWNLOADED);
  assert.equal(service.getState().installBlockedReason, "后端服务仍在运行。");
  assert.equal(updater.installCalls.length, 0);

  const installed = await service.installUpdate(() => ({ allowed: true }));
  assert.equal(installed.success, true);
  assert.equal(service.getState().status, APP_UPDATE_STATUS.INSTALLING);
  assert.deepEqual(updater.installCalls[0], [false, true]);
});

test("disabled updater never calls the provider", async () => {
  const updater = new FakeUpdater();
  const service = new AppUpdaterService({ updater, isPackaged: false });

  assert.equal(service.getState().status, APP_UPDATE_STATUS.DISABLED);
  const result = await service.checkForUpdates();
  assert.equal(result.success, false);
  assert.equal(result.code, "APP_UPDATE_DISABLED");
  assert.equal(updater.checkCalls, 0);
});

test("initial check is delayed and can be disposed", async () => {
  const updater = new FakeUpdater();
  let scheduledCallback = null;
  let cleared = false;
  const { service } = createService(updater, {
    setTimeoutImpl: (callback) => {
      scheduledCallback = callback;
      return { unref() {} };
    },
    clearTimeoutImpl: () => {
      cleared = true;
    },
  });

  assert.equal(service.scheduleInitialCheck(15_000), true);
  assert.equal(updater.checkCalls, 0);
  assert.equal(updater.listenerCount("error"), 1);
  scheduledCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updater.checkCalls, 1);

  service.scheduleInitialCheck();
  const stateBeforeDispose = service.getState();
  service.dispose();
  assert.equal(cleared, true);
  assert.equal(updater.listenerCount("error"), 0);
  updater.emit("update-not-available", { version: "1.2.0" });
  assert.deepEqual(service.getState(), stateBeforeDispose);
  assert.equal(service.scheduleInitialCheck(), false);
});

test("provider errors are exposed without throwing through IPC callers", async () => {
  const updater = new FakeUpdater();
  const successfulCheck = updater.checkForUpdates.bind(updater);
  updater.checkForUpdates = async () => {
    throw Object.assign(new Error("feed unavailable"), { code: "ERR_UPDATER_CHANNEL" });
  };
  const { service } = createService(updater);

  const result = await service.checkForUpdates();
  assert.equal(result.success, false);
  assert.equal(result.code, "APP_UPDATE_CHECK_FAILED");
  assert.equal(service.getState().status, APP_UPDATE_STATUS.ERROR);
  assert.deepEqual(service.getState().error, {
    message: "feed unavailable",
    code: "ERR_UPDATER_CHANNEL",
    phase: APP_UPDATE_ACTION.CHECK,
    retryAction: APP_UPDATE_ACTION.CHECK,
  });
  assert.equal(service.getState().retryAction, APP_UPDATE_ACTION.CHECK);

  const wrongRetry = await service.downloadUpdate();
  assert.equal(wrongRetry.success, false);
  assert.equal(wrongRetry.code, "APP_UPDATE_RETRY_ACTION_MISMATCH");
  assert.equal(wrongRetry.requiredAction, APP_UPDATE_ACTION.CHECK);
  assert.equal(updater.downloadCalls, 0);

  updater.checkForUpdates = successfulCheck;
  const retry = await service.checkForUpdates();
  assert.equal(retry.success, true);
  assert.equal(service.getState().status, APP_UPDATE_STATUS.AVAILABLE);
  assert.equal(service.getState().retryAction, null);
});

test("download failures can only retry the download phase", async () => {
  const updater = new FakeUpdater();
  const successfulDownload = updater.downloadUpdate.bind(updater);
  const { service } = createService(updater);
  await service.checkForUpdates();

  updater.downloadUpdate = async () => {
    updater.downloadCalls += 1;
    throw Object.assign(new Error("download interrupted"), { code: "ERR_NETWORK" });
  };

  const failed = await service.downloadUpdate();
  assert.equal(failed.success, false);
  assert.equal(failed.code, "APP_UPDATE_DOWNLOAD_FAILED");
  assert.equal(service.getState().status, APP_UPDATE_STATUS.ERROR);
  assert.equal(service.getState().error.phase, APP_UPDATE_ACTION.DOWNLOAD);
  assert.equal(service.getState().retryAction, APP_UPDATE_ACTION.DOWNLOAD);

  const wrongRetry = await service.checkForUpdates();
  assert.equal(wrongRetry.code, "APP_UPDATE_RETRY_ACTION_MISMATCH");
  assert.equal(wrongRetry.requiredAction, APP_UPDATE_ACTION.DOWNLOAD);
  assert.equal(updater.checkCalls, 1);

  updater.downloadUpdate = successfulDownload;
  const retried = await service.downloadUpdate();
  assert.equal(retried.success, true);
  assert.equal(service.getState().status, APP_UPDATE_STATUS.DOWNLOADED);
  assert.equal(updater.downloadCalls, 2);
});

test("install failures retain the downloaded artifact and only retry installation", async () => {
  const updater = new FakeUpdater();
  const { service } = createService(updater);
  await service.checkForUpdates();
  await service.downloadUpdate();

  updater.quitAndInstall = () => {
    updater.installCalls.push([false, true]);
    throw Object.assign(new Error("installer launch failed"), { code: "ERR_INSTALLER" });
  };

  const failed = await service.installUpdate();
  assert.equal(failed.success, false);
  assert.equal(failed.code, "APP_UPDATE_INSTALL_FAILED");
  assert.equal(service.getState().status, APP_UPDATE_STATUS.ERROR);
  assert.equal(service.getState().error.phase, APP_UPDATE_ACTION.INSTALL);
  assert.equal(service.getState().retryAction, APP_UPDATE_ACTION.INSTALL);
  assert.ok(service.getState().downloadedAt);

  assert.equal((await service.checkForUpdates()).requiredAction, APP_UPDATE_ACTION.INSTALL);
  assert.equal((await service.downloadUpdate()).requiredAction, APP_UPDATE_ACTION.INSTALL);

  updater.quitAndInstall = (...args) => updater.installCalls.push(args);
  const retried = await service.installUpdate();
  assert.equal(retried.success, true);
  assert.equal(service.getState().status, APP_UPDATE_STATUS.INSTALLING);
  assert.equal(updater.installCalls.length, 2);
});

test("operations are mutually exclusive and duplicate provider calls are rejected", async () => {
  const updater = new FakeUpdater();
  const checkDeferred = deferred();
  updater.checkForUpdates = () => {
    updater.checkCalls += 1;
    return checkDeferred.promise;
  };
  const { service } = createService(updater);

  const checking = service.checkForUpdates();
  const duplicateCheck = await service.checkForUpdates();
  const downloadDuringCheck = await service.downloadUpdate();
  assert.equal(duplicateCheck.code, "APP_UPDATE_BUSY");
  assert.equal(downloadDuringCheck.code, "APP_UPDATE_BUSY");
  assert.equal(updater.checkCalls, 1);

  checkDeferred.resolve({ isUpdateAvailable: true, updateInfo: { version: "1.3.0" } });
  assert.equal((await checking).success, true);
  assert.equal(service.getState().status, APP_UPDATE_STATUS.AVAILABLE);

  const downloadDeferred = deferred();
  updater.downloadUpdate = () => {
    updater.downloadCalls += 1;
    return downloadDeferred.promise;
  };
  const downloading = service.downloadUpdate();
  const duplicateDownload = await service.downloadUpdate();
  const checkDuringDownload = await service.checkForUpdates();
  assert.equal(duplicateDownload.code, "APP_UPDATE_BUSY");
  assert.equal(checkDuringDownload.code, "APP_UPDATE_BUSY");
  assert.equal(updater.downloadCalls, 1);

  updater.emit("download-progress", {
    transferred: 25,
    total: 50,
    bytesPerSecond: -1,
  });
  assert.equal(service.getState().progress, 50);
  assert.equal(service.getState().bytesPerSecond, 0);

  downloadDeferred.resolve(["Moonshine-Image-Setup-1.3.0.exe"]);
  assert.equal((await downloading).success, true);
  assert.equal(service.getState().status, APP_UPDATE_STATUS.DOWNLOADED);

  const readinessDeferred = deferred();
  let readinessCalls = 0;
  const installing = service.installUpdate(() => {
    readinessCalls += 1;
    return readinessDeferred.promise;
  });
  const duplicateInstall = await service.installUpdate();
  assert.equal(duplicateInstall.code, "APP_UPDATE_BUSY");
  assert.equal(readinessCalls, 1);
  readinessDeferred.resolve({ allowed: true });
  assert.equal((await installing).success, true);
  assert.equal(updater.installCalls.length, 1);
});

test("downloaded state is preserved against manual checks and stale provider events", async () => {
  const updater = new FakeUpdater();
  const { service } = createService(updater);
  await service.checkForUpdates();
  await service.downloadUpdate();
  const downloadedState = service.getState();

  const checkResult = await service.checkForUpdates();
  assert.equal(checkResult.success, false);
  assert.equal(checkResult.code, "APP_UPDATE_ALREADY_DOWNLOADED");
  assert.equal(updater.checkCalls, 1);

  updater.emit("checking-for-update");
  updater.emit("update-not-available", { version: "1.2.0" });
  updater.emit("update-available", { version: "9.9.9" });
  updater.emit("download-progress", { percent: 1 });
  updater.emit("error", new Error("late provider error"));

  assert.deepEqual(service.getState(), downloadedState);
});

test("provider results and state remain serializable", async () => {
  const updater = new FakeUpdater();
  updater.checkForUpdates = async () => ({
    isUpdateAvailable: true,
    updateInfo: {
      version: "1.3.0",
      releaseName: Symbol("release"),
      releaseNotes: [{ note: 123n }],
    },
    providerInternals: 123n,
  });
  const { service } = createService(updater);

  const result = await service.checkForUpdates();
  assert.equal(result.success, true);
  assert.equal("result" in result, false);
  assert.doesNotThrow(() => structuredClone(result));
  assert.doesNotThrow(() => JSON.stringify(service.getState()));
});

test("release configuration keeps packager compatibility and exposes an installer path", () => {
  const config = fs.readFileSync(path.join(repoRoot, "quasar.config.js"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const mainSource = fs.readFileSync(path.join(repoRoot, "src-electron/electron-main.js"), "utf8");

  assert.match(config, /bundler:\s*["']packager["']/);
  assert.match(config, /provider:\s*["']generic["']/);
  assert.match(
    config,
    /https:\/\/download\.moonshine\.email\/app\/win-x64\/stable\//,
  );
  assert.doesNotMatch(config, /provider:\s*["']github["']/);
  assert.match(config, /publish:\s*electronPublishConfig/);
  assert.match(config, /electronDist:\s*["']node_modules\/electron\/dist["']/);
  assert.match(config, /afterPack:\s*["']scripts\/after-pack-windows\.mjs["']/);
  assert.match(config, /signAndEditExecutable:\s*false/);
  assert.match(config, /publisherName:\s*null/);
  assert.doesNotMatch(config, /forceCodeSigning:\s*true/);
  assert.match(config, /App-only NSIS resources/);
  assert.match(config, /includeBundledComponents:\s*includeLegacyPackagedComponents/);
  assert.match(config, /MOONSHINE_PACKAGE_LEGACY_RUNTIME/);
  const packagerResourceBlock = config.match(/packager:\s*\{[\s\S]*?extraResource:\s*\[([\s\S]*?)\n\s*\],\n\s*\},\n\s*builder:/);
  assert.ok(packagerResourceBlock, "packager extraResource block should be explicit");
  assert.match(packagerResourceBlock[1], /includeLegacyPackagedComponents/);
  assert.doesNotMatch(
    packagerResourceBlock[1],
    /^\s*["']build-resources\/(runtime|models)["'],?\s*$/m,
  );
  const builderResourceBlock = config.match(/builder:\s*\{[\s\S]*?extraResources:\s*\[([\s\S]*?)\n\s*\],\n\s*\/\/ Installer artifact naming/);
  assert.ok(builderResourceBlock, "builder extraResources block should be explicit");
  assert.doesNotMatch(builderResourceBlock[1], /build-resources\/(runtime|models)/);
  assert.match(builderResourceBlock[1], /build-resources\/ffmpeg/);
  assert.doesNotMatch(config, /files:\s*\[\s*["']dist\/electron/);
  assert.doesNotMatch(config, /!node_modules\/\*\*/);
  assert.doesNotMatch(config, /appVersion:\s*["']1\.1\.0["']/);
  assert.match(packageJson.scripts["build:electron:installer"], /-b builder/);
  assert.match(packageJson.scripts["build:electron:installer"], /-T win/);
  assert.equal(packageJson.dependencies["electron-updater"], "^6.8.9");
  assert.match(mainSource, /ipcMain\.handle\("app-update-check"/);
  assert.match(mainSource, /getAppUpdateInstallReadiness/);
  assert.match(mainSource, /prepareAppUpdateInstallation/);
  assert.match(mainSource, /stopBackendServiceAndPendingLaunch/);
  assert.match(mainSource, /synchronizeAppUpdateChannel/);
  assert.match(mainSource, /setFeedURL/);
});
