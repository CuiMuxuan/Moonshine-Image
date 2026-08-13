import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../..");

const [mainSource, preloadSource, storeSource] = await Promise.all([
  readFile(path.join(repoRoot, "src-electron", "electron-main.js"), "utf8"),
  readFile(path.join(repoRoot, "src-electron", "electron-preload.js"), "utf8"),
  readFile(path.join(repoRoot, "src", "stores", "updateManager.js"), "utf8"),
]);

test("environment update IPC uses stable status, plan, and confirmed switch channels", () => {
  assert.match(mainSource, /ipcMain\.handle\("environment-update-status", async \(_event, options = \{\}\) =>/);
  assert.match(mainSource, /ipcMain\.handle\("environment-update-plan", async \(_event, options = \{\}\) =>/);
  assert.match(mainSource, /ipcMain\.handle\("environment-update-switch", async \(event, options = \{\}\) =>/);
  assert.match(mainSource, /environmentManager\?\.getUpdateStatus\?\.\(options\)/);
  assert.match(mainSource, /environmentManager\?\.getUpdatePlan\?\.\(options\)/);
  assert.match(mainSource, /environmentManager\?\.switchEnvironment\?\.\(\{/);

  assert.match(preloadSource, /getEnvironmentUpdateStatus:[\s\S]*?ipcRenderer\.invoke\("environment-update-status", options\)/);
  assert.match(preloadSource, /getEnvironmentUpdatePlan:[\s\S]*?ipcRenderer\.invoke\("environment-update-plan", options\)/);
  assert.match(preloadSource, /switchEnvironment:[\s\S]*?ipcRenderer\.invoke\("environment-update-switch", options\)/);
  assert.doesNotMatch(preloadSource, /environment-get-update-(?:status|plan)/);
});

test("update manager stores environment update diagnostics and invokes the dedicated IPC methods", () => {
  for (const field of [
    "nvidiaDeviceName",
    "nvidiaDriverVersion",
    "canSwitchToCu130",
    "canSwitchToCpu",
    "acceleratorChangeReason",
  ]) {
    assert.match(storeSource, new RegExp(`\\b${field}\\b`));
  }
  assert.match(storeSource, /environmentUpdate:\s*\{ \.\.\.DEFAULT_ENVIRONMENT_UPDATE_STATE \}/);
  assert.match(storeSource, /const checkEnvironmentUpdate = \(\) =>[\s\S]*?"getEnvironmentUpdateStatus"[\s\S]*?"environment-update-status"/);
  assert.match(storeSource, /const getEnvironmentSwitchPlan = \(target\) =>[\s\S]*?"getEnvironmentUpdatePlan"[\s\S]*?"environment-update-plan"/);
  assert.match(storeSource, /const switchEnvironmentAccelerator = \(\{ target, confirmed = false \} = \{\}\) =>[\s\S]*?"switchEnvironment"[\s\S]*?"environment-update-switch"/);
});
