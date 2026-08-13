import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainLayoutSource = fs.readFileSync(
  path.join(root, "src", "layouts", "MainLayout.vue"),
  "utf8"
);
const backendManagerSource = fs.readFileSync(
  path.join(root, "src", "components", "global", "BackendManager.vue"),
  "utf8"
);

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, `missing ${startMarker}`);
  assert.ok(end > start, `missing ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}

test("runtime-selected ports use the durable configuration path", () => {
  const mainLayoutSync = between(
    mainLayoutSource,
    "const syncBackendRuntimePort = async (port) =>",
    "const normalizeBackendFailure"
  );
  const backendManagerSync = between(
    backendManagerSource,
    "const syncRuntimeBackendPort = async (port) =>",
    "const syncBackendMode"
  );

  assert.match(mainLayoutSync, /await configStore\.persistConfig\(/);
  assert.doesNotMatch(mainLayoutSync, /await configStore\.saveConfig\(/);
  assert.match(backendManagerSync, /await persistConfig\(/);
  assert.doesNotMatch(backendManagerSync, /await configStore\.saveConfig\(/);
});

test("automatic service startup forwards the saved SAM release preference", () => {
  const automaticStart = between(
    mainLayoutSource,
    "const prepareBackendEngine = async () =>",
    "const handleStartupOverlayFinished"
  );

  assert.match(
    automaticStart,
    /samReleaseBeforeProcessing:\s*configStore\.config\.masking\?\.samReleaseBeforeProcessing !== false/
  );
});
