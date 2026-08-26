import assert from "node:assert/strict";
import test from "node:test";

import {
  MCP_API_METHODS,
  MCP_EXTERNAL_API_METHODS,
  getElectronMcpCapability,
} from "../src/utils/electronMcpApi.js";

const createMcpApi = () => Object.fromEntries(
  MCP_API_METHODS.map((method) => [method, () => method]),
);
const createExternalMcpApi = () => Object.fromEntries(
  [...MCP_API_METHODS, ...MCP_EXTERNAL_API_METHODS].map((method) => [method, () => method]),
);

test("MCP capability resolves the packaged preload ipcRenderer shape", () => {
  const ipcRenderer = createMcpApi();
  const capability = getElectronMcpCapability({ electron: { ipcRenderer } });

  assert.equal(capability.environment, "electron");
  assert.equal(capability.available, true);
  assert.equal(capability.externalAvailable, false);
  assert.equal(capability.api, ipcRenderer);
});

test("MCP capability retains compatibility with a legacy root-level bridge", () => {
  const electron = createMcpApi();
  const capability = getElectronMcpCapability({ electron });

  assert.equal(capability.environment, "electron");
  assert.equal(capability.available, true);
  assert.equal(capability.externalAvailable, false);
  assert.equal(capability.api, electron);
});

test("MCP capability distinguishes a complete external stdio bridge", () => {
  const ipcRenderer = createExternalMcpApi();
  const capability = getElectronMcpCapability({ electron: { ipcRenderer } });

  assert.equal(capability.available, true);
  assert.equal(capability.externalAvailable, true);
  assert.equal(capability.api, ipcRenderer);
});

test("MCP capability distinguishes a browser from an incomplete Electron bridge", () => {
  assert.deepEqual(getElectronMcpCapability({}), {
    environment: "browser",
    available: false,
    externalAvailable: false,
    api: null,
  });
  assert.deepEqual(getElectronMcpCapability({ electron: { ipcRenderer: {} } }), {
    environment: "electron",
    available: false,
    externalAvailable: false,
    api: null,
  });
});
