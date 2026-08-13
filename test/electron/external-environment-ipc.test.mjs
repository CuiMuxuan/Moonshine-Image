import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../..");
const mainSource = await readFile(
  path.join(repoRoot, "src-electron", "electron-main.js"),
  "utf8"
);
const preloadSource = await readFile(
  path.join(repoRoot, "src-electron", "electron-preload.js"),
  "utf8"
);

function extractSource(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Expected source to contain ${startMarker}.`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Expected ${endMarker} to follow ${startMarker}.`);
  return source.slice(start, end);
}

const selectDirectorySource = extractSource(
  mainSource,
  "async function selectExternalEnvironmentDirectory()",
  "async function probeExternalEnvironmentSelection("
);
const probeSource = extractSource(
  mainSource,
  "async function probeExternalEnvironmentSelection(",
  "async function activateExternalEnvironmentSelection("
);
const activateSource = extractSource(
  mainSource,
  "async function activateExternalEnvironmentSelection(",
  "async function forgetExternalEnvironmentSelection()"
);
const forgetSource = extractSource(
  mainSource,
  "async function forgetExternalEnvironmentSelection()",
  'ipcMain.handle("runtime-get-state"'
);
const safeErrorSource = extractSource(
  mainSource,
  "function toSafeExternalEnvironmentError(",
  "function deriveExternalEnvironmentRendererStatus("
);
const directoryCandidateSource = extractSource(
  mainSource,
  "function createExternalEnvironmentDirectorySelection(",
  "function toSafeExternalEnvironmentError("
);
const failureResponseSource = extractSource(
  mainSource,
  "function reportExternalEnvironmentIpcFailure(",
  "function getManagedReleaseSources("
);
const preloadExternalEnvironmentSource = extractSource(
  preloadSource,
  "selectExternalEnvironmentDirectory:",
  "getModelManifestState:"
);

test("external environment selection is directory-only and handles cancellation", () => {
  assert.match(
    selectDirectorySource,
    /dialog\.showOpenDialog\(mainWindow,\s*\{\s*properties:\s*\["openDirectory"\]/s
  );
  assert.match(selectDirectorySource, /selection\.canceled/);
  assert.match(selectDirectorySource, /canceled:\s*true/);
  assert.match(selectDirectorySource, /cancelled:\s*true/);
  assert.match(selectDirectorySource, /createExternalEnvironmentDirectorySelection\(selectedPath\)/);
  assert.doesNotMatch(selectDirectorySource, /probeExternalEnvironment|activateExternalEnvironment/);
});

test("probe, activate, and forget delegate through EnvironmentManager and rebroadcast state", () => {
  assert.match(
    probeSource,
    /getExternalEnvironmentDirectorySelection\(selectionId\)/
  );
  assert.match(
    probeSource,
    /rememberExternalEnvironmentDirectorySelection\(candidateId, selection\.selectedPath\)/
  );
  assert.match(probeSource, /candidateId:\s*selectionId/);
  assert.match(
    probeSource,
    /environmentManager\.probeExternalEnvironment\(\{\s*directoryPath:\s*selection\.selectedPath,?\s*\}\)/s
  );
  assert.doesNotMatch(probeSource, /payload\?*\.directoryPath/);
  assert.match(probeSource, /broadcastEnvironmentState\(result\.state, external\)/);

  assert.match(
    activateSource,
    /environmentManager\.activateExternalEnvironment\(\{\s*candidateToken\s*\}\)/
  );
  assert.doesNotMatch(activateSource, /directoryPath|child_process|\bexec\b|\bspawn\b/);
  assert.match(activateSource, /broadcastEnvironmentState\(result\.state, external\)/);
  assert.match(
    activateSource,
    /externalEnvironmentDirectorySelections\.delete\(candidateToken\)/
  );

  assert.match(forgetSource, /environmentManager\.forgetExternalEnvironment\(\)/);
  assert.doesNotMatch(forgetSource, /directoryPath|child_process|\bexec\b|\bspawn\b/);
  assert.match(forgetSource, /broadcastEnvironmentState\(result\.state, external\)/);
});

test("directory candidates remain reusable for revalidation until activation or expiry", () => {
  assert.match(
    directoryCandidateSource,
    /externalEnvironmentDirectorySelections\.set\(normalizedId,\s*\{/s
  );
  assert.match(
    directoryCandidateSource,
    /return externalEnvironmentDirectorySelections\.get\(normalizedId\) \|\| null/
  );
  assert.doesNotMatch(
    directoryCandidateSource,
    /function getExternalEnvironmentDirectorySelection[\s\S]*?\.delete\(normalizedId\)/
  );
});

test("main process registers the four fixed external-environment IPC channels", () => {
  const registrations = [
    ["environment-external-select-directory", "selectExternalEnvironmentDirectory"],
    ["environment-external-probe", "probeExternalEnvironmentSelection"],
    ["environment-external-activate", "activateExternalEnvironmentSelection"],
    ["environment-external-forget", "forgetExternalEnvironmentSelection"],
  ];

  for (const [channel, handler] of registrations) {
    assert.match(
      mainSource,
      new RegExp(`ipcMain\\.handle\\("${channel}",\\s*${handler}\\)`)
    );
  }
});

test("preload exposes named candidate-only methods for the external environment flow", () => {
  assert.match(
    preloadExternalEnvironmentSource,
    /selectExternalEnvironmentDirectory:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("environment-external-select-directory"\)/s
  );
  assert.match(
    preloadExternalEnvironmentSource,
    /probeExternalEnvironment:[\s\S]*?ipcRenderer\.invoke\("environment-external-probe",\s*\{\s*candidateId:\s*getExternalEnvironmentCandidateId\(candidate\),?\s*\}\)/
  );
  assert.match(
    preloadExternalEnvironmentSource,
    /activateExternalEnvironment:[\s\S]*?ipcRenderer\.invoke\("environment-external-activate",\s*\{\s*candidateId:\s*getExternalEnvironmentCandidateId\(candidate\),?\s*\}\)/
  );
  assert.match(
    preloadExternalEnvironmentSource,
    /forgetExternalEnvironment:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("environment-external-forget"\)/s
  );
  assert.doesNotMatch(
    preloadExternalEnvironmentSource,
    /directoryPath|filePath|command|child_process|\bexec\b|\bspawn\b/
  );
});

test("renderer failures use stable safe errors instead of raw exception data", () => {
  assert.match(safeErrorSource, /EXTERNAL_ENVIRONMENT_RENDERER_MESSAGES\[code\]/);
  assert.match(safeErrorSource, /Object\.prototype\.hasOwnProperty\.call\(/);
  assert.match(safeErrorSource, /code,\s*message:/s);
  assert.doesNotMatch(safeErrorSource, /details|stack/);

  const messages = {
    EXTERNAL_ENV_REQUEST_FAILED: "safe request failure",
    EXTERNAL_ENV_PROBE_FAILED: "safe probe failure",
  };
  const createSafeError = new Function(
    "EXTERNAL_ENVIRONMENT_RENDERER_MESSAGES",
    `${safeErrorSource}\nreturn toSafeExternalEnvironmentError;`
  );
  const toSafeError = createSafeError(messages);
  assert.deepEqual(
    toSafeError(
      {
        code: "ENOENT",
        message: "C:\\private\\runtime\\python.exe was not found",
        details: { stack: "private stack" },
      },
      "EXTERNAL_ENV_PROBE_FAILED"
    ),
    { code: "EXTERNAL_ENV_PROBE_FAILED", message: "safe probe failure" }
  );

  assert.match(failureResponseSource, /const failure = toSafeExternalEnvironmentError\(/);
  assert.match(failureResponseSource, /error:\s*failure/);
  assert.doesNotMatch(failureResponseSource, /error:\s*error|details:\s*error|stack:\s*error/);
  assert.match(failureResponseSource, /broadcastEnvironmentState\(/);
});

test("managed environment preparation exposes cancellation and path actions", () => {
  assert.match(
    mainSource,
    /ipcMain\.handle\("runtime-cancel", async \(\) => environmentManager\?\.cancelPreparation\?\.\(\)\)/
  );
  assert.match(
    mainSource,
    /ipcMain\.handle\("environment-cancel", async \(\) => environmentManager\?\.cancelPreparation\?\.\(\)\)/
  );
  assert.match(
    mainSource,
    /ipcMain\.handle\("environment-open-path", async \(\) => \{[\s\S]*environmentManager\?\.getState\?\.\(\)\.activePath[\s\S]*shell\.openPath\(environmentPath\)/
  );
  assert.match(preloadSource, /cancelRuntime:\s*\(\) => ipcRenderer\.invoke\("runtime-cancel"\)/);
  assert.match(
    preloadSource,
    /cancelEnvironmentPreparation:\s*\(\) => ipcRenderer\.invoke\("environment-cancel"\)/
  );
  assert.match(preloadSource, /openEnvironmentPath:\s*\(\) => ipcRenderer\.invoke\("environment-open-path"\)/);
});

test("window close and app quit settle active environment preparation", () => {
  assert.match(
    mainSource,
    /\["preparing", "cancelling"\]\.includes\(environmentState\.status\)/
  );
  assert.match(mainSource, /buttons:\s*\["继续准备", "取消准备并退出", "返回应用"\]/);
  assert.match(mainSource, /environmentManager\?\.cancelPreparation\?\.\(\)/);
  assert.match(mainSource, /await environmentManager\?\.waitForPreparation\?\.\(\)/);
  assert.match(
    mainSource,
    /environmentState\.canCancel \|\| environmentState\.status === "cancelling"/
  );
});
