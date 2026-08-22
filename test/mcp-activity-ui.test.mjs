import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");
const settingsSource = read("src/components/global/GlobalSettings.vue");
const storeSource = read("src/stores/mcpActivity.js");
const activityPanelSource = read("src/components/global/McpActivityPanel.vue");
const settingsPanelSource = read("src/components/global/McpSettingsPanel.vue");
const routesSource = read("src/router/routes.js");
const toolbarSource = read("src/components/global/MainToolbar.vue");

test("MCP UI stays in global settings and auxiliary activity route", () => {
  assert.match(settingsSource, /q-tab name="mcp"/);
  assert.match(settingsSource, /McpSettingsPanel/);
  assert.match(settingsSource, /validTabs = \[[^\]]*"mcp"/);
  assert.match(routesSource, /path: "activity\/mcp"/);
  assert.match(routesSource, /pages\/McpActivityPage\.vue/);
  assert.doesNotMatch(toolbarSource, /nav-mcp|MCP 活动/);
});

test("MCP renderer store uses named preload wrappers and bounded projections", () => {
  assert.match(storeSource, /getMcpState/);
  assert.match(storeSource, /getMcpActivity\(0\)/);
  assert.match(storeSource, /stopMcp/);
  assert.match(storeSource, /REQUEST_ID_PATTERN/);
  assert.match(storeSource, /TOOL_NAMES\.includes/);
  assert.match(storeSource, /moonshine\.image\.process_batch/);
  assert.match(storeSource, /moonshine\.jobs\.cancel/);
  assert.match(storeSource, /OUTCOMES\.has/);
  assert.match(storeSource, /CONFIRMATION_LIMIT_REACHED/);
  assert.match(storeSource, /CONFIRMATION_REQUIRED/);
  assert.match(storeSource, /INVALID_JOB_ID/);
  assert.match(storeSource, /PATH_NOT_ALLOWED/);
  assert.match(storeSource, /TOOL_NOT_ALLOWED/);
  assert.doesNotMatch(storeSource, /cause\?\.message/);
  assert.doesNotMatch(storeSource, /ipcRenderer|invoke\(/);
  assert.match(activityPanelSource, /mcp-activity-panel/);
  assert.match(settingsPanelSource, /openActivity/);
});
