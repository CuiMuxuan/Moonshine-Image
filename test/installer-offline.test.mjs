import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installerScript = fs.readFileSync(
  path.join(repoRoot, "build-resources", "installer-offline.nsh"),
  "utf8"
);

test("offline uninstaller exposes opt-in cleanup flags and unchecked UI", () => {
  assert.match(installerScript, /--delete-config/);
  assert.match(installerScript, /--delete-managed-environment/);
  assert.match(installerScript, /\$\{NSD_SetState\} \$unDeleteConfigCheckbox \$\{BST_UNCHECKED\}/);
  assert.match(installerScript, /\$\{NSD_SetState\} \$unDeleteManagedEnvironmentCheckbox \$\{BST_UNCHECKED\}/);
  assert.match(installerScript, /UninstPage custom un\.CleanupOptionsCreate un\.CleanupOptionsLeave/);
});

test("offline uninstaller scopes optional cleanup to app-owned paths", () => {
  for (const expectedPath of [
    "$APPDATA\\Moonshine-Image\\config",
    "$APPDATA\\Moonshine-Image\\environments\\win-x64",
    "$APPDATA\\Moonshine-Image\\runtime",
    "$LOCALAPPDATA\\Moonshine-Image\\components\\runtimes",
    "$LOCALAPPDATA\\Moonshine-Image\\components\\downloads",
  ]) {
    assert.ok(installerScript.includes(expectedPath), `missing cleanup target: ${expectedPath}`);
  }

  assert.match(installerScript, /\$\{If\} \$\{isUpdated\}[\s\S]*Goto moonshine_cleanup_done/);
  assert.doesNotMatch(installerScript, /RMDir \/r \/REBOOTOK "\$APPDATA\\Moonshine-Image"/);
  assert.match(installerScript, /(?:Delete|RMDir) \/(?:r )?\/REBOOTOK/);
});
