import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const source = await readFile(path.join(root, "scripts", "build-electron-installer-local.mjs"), "utf8");

test("local Windows installer wrapper uses one StdUtils source and preserves the regular build command", () => {
  assert.equal(packageJson.scripts["build:electron:installer:local"], "node scripts/build-electron-installer-local.mjs");
  assert.match(source, /ELECTRON_BUILDER_NSIS_DIR: legacyNsisDir/);
  assert.match(source, /ELECTRON_BUILDER_NSIS_RESOURCES_DIR: isolatedResources/);
  assert.match(source, /stdutils\.dll/);
  assert.match(source, /@quasar.*app-vite.*bin.*quasar\.js/);
  assert.match(source, /\[quasarCli, "build", "-m", "electron", "-b", "builder"/);
  assert.doesNotMatch(source, /rm\(|remove\(/);
});
