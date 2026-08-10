import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyWindowsExecutableResources } from "../../scripts/after-pack-windows.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("Windows resource hook uses the project icon and an npm-bundled editor", () => {
  const hookSource = fs.readFileSync(path.join(repoRoot, "scripts", "after-pack-windows.mjs"), "utf8");
  assert.match(hookSource, /import \{ rcedit \} from "rcedit"/);
  assert.match(hookSource, /src-electron", "icons", "icon\.ico"/);
  assert.equal(fs.existsSync(path.join(repoRoot, "node_modules", "rcedit", "bin", "rcedit-x64.exe")), true);
  assert.equal(typeof applyWindowsExecutableResources, "function");
});
