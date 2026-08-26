import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONFIG_SCHEMA_VERSION,
  createDefaultAppConfig,
  normalizeConfigToCurrentSchema,
} from "../src/shared/appConfigSchema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const settingsSource = fs.readFileSync(
  path.join(repoRoot, "src/components/global/GlobalSettings.vue"),
  "utf8"
);

test("new configurations default to tray close behavior with explicit confirmation", () => {
  const config = createDefaultAppConfig();

  assert.equal(CONFIG_SCHEMA_VERSION, 16);
  assert.equal(config.general.closeBehavior, "tray");
  assert.equal(config.general.confirmBeforeQuit, true);
});

test("legacy configurations keep their quit behavior and confirmation preference", () => {
  const migrated = normalizeConfigToCurrentSchema({
    schemaVersion: 14,
    general: { backendPort: 8080 },
    ui: { confirmBeforeExit: false },
  });

  assert.equal(migrated.general.closeBehavior, "quit");
  assert.equal(migrated.general.confirmBeforeQuit, false);
});

test("a legacy confirmation preference without a schema version remains an explicit quit preference", () => {
  const migrated = normalizeConfigToCurrentSchema({
    general: { backendPort: 8080 },
    ui: { confirmBeforeExit: true },
  });

  assert.equal(migrated.general.closeBehavior, "quit");
  assert.equal(migrated.general.confirmBeforeQuit, true);
});

test("an explicit modern close behavior is not overwritten by compatibility migration", () => {
  const migrated = normalizeConfigToCurrentSchema({
    schemaVersion: 14,
    general: { closeBehavior: "tray", confirmBeforeQuit: true },
    ui: { confirmBeforeExit: false },
  });

  assert.equal(migrated.general.closeBehavior, "tray");
  assert.equal(migrated.general.confirmBeforeQuit, true);
});

test("the existing general settings tab owns close behavior controls", () => {
  const generalStart = settingsSource.indexOf('<q-tab-panel name="general"');
  const generalEnd = settingsSource.indexOf('<q-tab-panel', generalStart + 1);
  const generalPanel = settingsSource.slice(generalStart, generalEnd);

  assert.match(generalPanel, /data-testid="global-settings-close-behavior"/);
  assert.match(generalPanel, /<SettingsPanel v-bind="settingsHelp\.closeBehavior"/);
  assert.match(generalPanel, /v-model="localConfig\.general\.closeBehavior"/);
  assert.match(generalPanel, /<SettingsPanel v-bind="settingsHelp\.confirmBeforeQuit"/);
  assert.match(generalPanel, /v-model="localConfig\.general\.confirmBeforeQuit"/);
  assert.match(settingsSource, /label: "最小化到托盘（推荐）", value: "tray"/);
  assert.match(settingsSource, /label: "退出程序", value: "quit"/);
});
