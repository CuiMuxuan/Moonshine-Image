import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../..");
const apiSource = await readFile(
  path.join(repoRoot, "server", "moonshine_server", "api.py"),
  "utf8",
);
const electronSource = await readFile(
  path.join(repoRoot, "src-electron", "electron-main.js"),
  "utf8",
);

function extractFunction(source, marker, nextMarker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `Expected source to define ${marker}.`);
  const end = source.indexOf(nextMarker, start + marker.length);
  assert.notEqual(end, -1, `Expected ${nextMarker} after ${marker}.`);
  return source.slice(start, end);
}

test("M1 backend wiring keeps persistent jobs behind the Electron userData switch", () => {
  const jobStoreBuilder = extractFunction(
    apiSource,
    "    def _build_job_store()",
    "    def api_job(",
  );
  assert.match(jobStoreBuilder, /MOONSHINE_USER_DATA_DIR/);
  assert.match(jobStoreBuilder, /MOONSHINE_PERSISTENT_JOBS_ENABLED/);
  assert.match(jobStoreBuilder, /["']jobs["']/);
  assert.match(jobStoreBuilder, /jobs\.sqlite3/);
  assert.match(jobStoreBuilder, /return None/);
  assert.doesNotMatch(jobStoreBuilder, /tempfile\.gettempdir/);
});

test("M1 Electron backend launch injects persistent storage and OCR model paths", () => {
  const launchBackend = extractFunction(
    electronSource,
    "async function launchBackendService(",
    "\n\nipcMain.handle(\"start-backend-service\"",
  );
  assert.match(
    launchBackend,
    /modelDir:\s*launchConfig\.modelDir\s*\|\|\s*globalConfig\.general\?\.modelDir\s*\|\|\s*""/,
  );
  assert.match(
    launchBackend,
    /MOONSHINE_OCR_MODEL_ROOT:\s*path\.join\(effectiveModelDir,\s*"ocr"\)/,
  );
  assert.match(launchBackend, /MOONSHINE_USER_DATA_DIR:\s*app\.getPath\("userData"\)/);
  assert.match(launchBackend, /MOONSHINE_PERSISTENT_JOBS_ENABLED:\s*"1"/);
  assert.doesNotMatch(launchBackend, /ipcRenderer|webContents\.send/);
});
