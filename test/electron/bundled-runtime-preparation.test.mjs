import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createDiagnostic,
  StartupProcessError,
  toStartupFailure,
} from "../../src-electron/startup-diagnostics.js";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../..");
const electronMainSource = await readFile(
  path.join(repoRoot, "src-electron", "electron-main.js"),
  "utf8"
);

function extractFunctionSource(name, nextName) {
  const startMarkers = [`async function ${name}(`, `function ${name}(`];
  const start = startMarkers.reduce((found, marker) => {
    if (found >= 0) return found;
    return electronMainSource.indexOf(marker);
  }, -1);
  assert.notEqual(start, -1, `Expected electron-main.js to define ${name}.`);

  const nextMarkers = [`\nasync function ${nextName}(`, `\nfunction ${nextName}(`];
  const end = nextMarkers.reduce((found, marker) => {
    const index = electronMainSource.indexOf(marker, start + 1);
    if (index < 0) return found;
    return found < 0 ? index : Math.min(found, index);
  }, -1);
  assert.notEqual(end, -1, `Expected ${nextName} to follow ${name}.`);
  return electronMainSource.slice(start, end).trim();
}

const runtimePreparationSource = [
  extractFunctionSource("runBundledCondaUnpack", "getBundledRuntimeState"),
  extractFunctionSource("ensureBundledRuntimeReady", "getVenvPythonPathByVenvPath"),
].join("\n\n");
const packagedBackendIntegritySource = extractFunctionSource(
  "ensurePackagedBackendIntegrity",
  "isBackendProjectStructureComplete"
);

test("packaged backend copies extensionless files without creating file-named directories", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-packaged-backend-"));
  const resourcesRoot = path.join(tempRoot, "resources");
  const runtimeProjectPath = path.join(tempRoot, "runtime", "server");
  const sourcePath = path.join(resourcesRoot, "backend", "server", "LICENSE");
  const manifestPath = path.join(resourcesRoot, "integrity", "manifest.json");
  const contents = "packaged backend license\n";
  const entry = {
    path: "backend/server/LICENSE",
    size: Buffer.byteLength(contents),
    sha256: (await import("node:crypto"))
      .createHash("sha256")
      .update(contents)
      .digest("hex"),
  };

  try {
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(sourcePath, contents);
    fs.writeFileSync(manifestPath, JSON.stringify({ entries: [entry] }));

    const dependencies = {
      path,
      fs,
      crypto: await import("node:crypto"),
      PACKAGED_BACKEND_RESOURCE_DIR: "backend",
      PACKAGED_BACKEND_PROJECT_DIR: "server",
      usesPackagedBackendProject: () => true,
      verifyPackagedResourcesIntegrity: async () => ({ success: true }),
      getIntegrityArtifactPaths: () => ({ manifestPath }),
      getPackagedBackendRuntimeProjectPath: () => runtimeProjectPath,
      getResourcesRootPath: () => resourcesRoot,
      getFileSize: (filePath) => fs.statSync(filePath).size,
      ensureDiskSpace(targetPath) {
        const normalizedPath = path.resolve(path.normalize(targetPath));
        const directory = path.extname(normalizedPath)
          ? path.dirname(normalizedPath)
          : normalizedPath;
        fs.mkdirSync(directory, { recursive: true });
      },
    };
    const dependencyNames = Object.keys(dependencies);
    const factory = new Function(
      ...dependencyNames,
      `${packagedBackendIntegritySource}\nreturn ensurePackagedBackendIntegrity;`
    );
    const ensurePackagedBackendIntegrity = factory(...Object.values(dependencies));

    const result = await ensurePackagedBackendIntegrity(runtimeProjectPath);
    const targetPath = path.join(runtimeProjectPath, "LICENSE");

    assert.equal(result.success, true);
    assert.equal(fs.statSync(targetPath).isFile(), true);
    assert.equal(fs.readFileSync(targetPath, "utf8"), contents);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function createRuntimeHarness(options = {}) {
  const runtimeEnvPath = "C:\\Moonshine-Test\\runtime";
  const backendPath = "C:\\Moonshine-Test\\backend";
  const metadataPath = "C:\\Moonshine-Test\\runtime-metadata.json";
  const logPath = "C:\\Moonshine-Test\\logs\\startup.log";
  const bundledPython = path.join(runtimeEnvPath, "python.exe");
  const relocationStderr =
    options.relocationStderr ||
    "Traceback (most recent call last):\n  File \"conda-unpack-script.py\", line 7\nRuntimeError: prefix replacement failed";
  const verifierResults = [...(options.verifierResults || [])];
  const sentLogs = [];
  const startupLogEntries = [];
  const stateWrites = [];
  let verifierCallCount = 0;
  let relocationCallCount = 0;
  let clearedStateCount = 0;

  const startupLogger = {
    warning(message, details = {}) {
      startupLogEntries.push({ level: "warning", message, details });
      return Promise.resolve();
    },
    error(message, details = {}) {
      startupLogEntries.push({ level: "error", message, details });
      return Promise.resolve();
    },
  };

  const dependencies = {
    path,
    fs: {
      existsSync() {
        return true;
      },
    },
    STARTUP_LOG_PATH: logPath,
    startupLogger,
    StartupProcessError,
    createDiagnostic,
    toStartupFailure,
    async ensurePackagedBackendIntegrity() {
      return { success: true };
    },
    getPackagedBackendRuntimeProjectPath() {
      return backendPath;
    },
    getPackagedRuntimeEnvPath() {
      return runtimeEnvPath;
    },
    getPackagedRuntimeMetadataPath() {
      return metadataPath;
    },
    readJsonFile() {
      return { builtAt: "2026-07-16T00:00:00.000Z" };
    },
    async withBundledRuntimeLock(task) {
      return await task();
    },
    getBundledRuntimeState() {
      return options.runtimeState ?? null;
    },
    hasBundledRuntimeStateChanged() {
      return options.stateChanged !== false;
    },
    async verifyBundledPythonRuntime() {
      const result = verifierResults[verifierCallCount];
      verifierCallCount += 1;
      assert.ok(
        result,
        `Unexpected bundled runtime verifier call #${verifierCallCount}.`
      );
      return result;
    },
    writeBundledRuntimeState(metadata, pythonPath) {
      stateWrites.push({ metadata, pythonPath });
    },
    clearBundledRuntimeState() {
      clearedStateCount += 1;
    },
    getBundledRuntimeEnvPath() {
      return runtimeEnvPath;
    },
    getBundledPythonPath() {
      return bundledPython;
    },
    getPackagedModelsPath() {
      return "C:\\Moonshine-Test\\models";
    },
    augmentStartupFailure(result, defaults) {
      return { ...defaults, ...result };
    },
    async runProcess(command, args, processOptions) {
      relocationCallCount += 1;
      processOptions.onStderr?.(relocationStderr);
      if (options.relocationOutcome === "failure") {
        throw new StartupProcessError("Failed to relocate the bundled Python runtime.", {
          diagnostic: {
            id: "relocation-diagnostic",
            code: "BUNDLED_RUNTIME_RELOCATION_FAILED",
            stage: "bundled-runtime-relocation",
            commandLine: `${command} ${args.join(" ")}`.trim(),
            exitCode: 1,
            stderrTail: relocationStderr,
            logPath,
          },
          recoveryHint: processOptions.recoveryHint,
        });
      }
      return { success: true };
    },
  };

  const dependencyNames = Object.keys(dependencies);
  const factory = new Function(
    ...dependencyNames,
    `${runtimePreparationSource}\nreturn { runBundledCondaUnpack, ensureBundledRuntimeReady };`
  );
  const functions = factory(...Object.values(dependencies));
  const sendLog = (message, type = "info", details = {}) => {
    sentLogs.push({ message, type, details });
  };

  return {
    ...functions,
    sendLog,
    sentLogs,
    startupLogEntries,
    stateWrites,
    get verifierCallCount() {
      return verifierCallCount;
    },
    get relocationCallCount() {
      return relocationCallCount;
    },
    get clearedStateCount() {
      return clearedStateCount;
    },
  };
}

const unusableBeforeRelocation = {
  success: false,
  code: "BUNDLED_DEPENDENCIES_UNUSABLE",
  error: "The bundled runtime still points at its previous prefix.",
};
const usableRuntime = {
  success: true,
  pythonPath: "C:\\Moonshine-Test\\runtime\\python.exe",
  pythonVersion: "3.11.9",
};

test("successful relocation reuses the verified result after the runtime lock", async () => {
  const harness = createRuntimeHarness({
    verifierResults: [unusableBeforeRelocation, usableRuntime],
    relocationOutcome: "success",
  });

  const result = await harness.ensureBundledRuntimeReady(harness.sendLog);

  assert.equal(result.success, true);
  assert.equal(result.pythonPath, usableRuntime.pythonPath);
  assert.equal(harness.relocationCallCount, 1);
  assert.equal(
    harness.verifierCallCount,
    2,
    "The verifier result produced after relocation must not be recomputed after releasing the lock."
  );
  assert.equal(harness.stateWrites.length, 1);
});

test("an already usable runtime is not verified again after releasing the lock", async () => {
  const harness = createRuntimeHarness({ verifierResults: [usableRuntime] });

  const result = await harness.ensureBundledRuntimeReady(harness.sendLog);

  assert.equal(result.success, true);
  assert.equal(harness.verifierCallCount, 1);
  assert.equal(harness.relocationCallCount, 0);
  assert.equal(harness.stateWrites.length, 1);
});

test("a moved app emits one renderer warning when relocation fails but recheck succeeds", async () => {
  const relocationStderr =
    "Traceback (most recent call last):\n  File \"conda-unpack-script.py\", line 19\nValueError: executable prefix is longer than the placeholder";
  const harness = createRuntimeHarness({
    verifierResults: [unusableBeforeRelocation, usableRuntime],
    relocationOutcome: "failure",
    relocationStderr,
    runtimeState: { runtimeEnvPath: "C:\\Moonshine-Old\\runtime" },
  });

  const result = await harness.ensureBundledRuntimeReady(harness.sendLog);
  const rendererWarnings = harness.sentLogs.filter((entry) => entry.type === "warning");

  assert.equal(result.success, true);
  assert.equal(harness.verifierCallCount, 2);
  assert.equal(rendererWarnings.length, 1);
  assert.match(rendererWarnings[0].message, /诊断编号：relocation-diagnostic/u);
  assert.equal(rendererWarnings[0].details.diagnosticId, "relocation-diagnostic");
  assert.equal(rendererWarnings[0].details.logPath, "C:\\Moonshine-Test\\logs\\startup.log");
  assert.equal(rendererWarnings[0].details.diagnostic, undefined);
  assert.ok(
    !JSON.stringify(harness.sentLogs).includes("Traceback") &&
      !JSON.stringify(harness.sentLogs).includes(relocationStderr),
    "Raw relocation stderr must never be present in renderer messages or metadata."
  );
  assert.ok(
    harness.startupLogEntries.some(
      (entry) => entry.level === "warning" && entry.message === relocationStderr
    ),
    "Raw multiline relocation stderr must remain available in the startup log."
  );
});

test("relocation and recheck failure still block a moved app startup", async () => {
  const recheckStderr =
    "Traceback (most recent call last):\nModuleNotFoundError: No module named 'torch'";
  const failedRecheck = {
    success: false,
    code: "BUNDLED_DEPENDENCIES_UNUSABLE",
    error: "Bundled dependencies could not be imported.",
    stderr: recheckStderr,
    diagnostic: {
      id: "recheck-diagnostic",
      code: "BUNDLED_DEPENDENCIES_UNUSABLE",
      stage: "python-dependency-probe",
      stderrTail: recheckStderr,
    },
  };
  const harness = createRuntimeHarness({
    verifierResults: [unusableBeforeRelocation, failedRecheck],
    relocationOutcome: "failure",
    runtimeState: { runtimeEnvPath: "C:\\Moonshine-Old\\runtime" },
  });

  await assert.rejects(
    () => harness.ensureBundledRuntimeReady(harness.sendLog),
    (error) => {
      assert.equal(error.code, "BUNDLED_RUNTIME_RELOCATION_FAILED");
      assert.match(error.message, /app appears to have been moved/i);
      assert.equal(error.diagnostic.attempts.length, 2);
      assert.equal(
        error.diagnostic.attempts[1].code,
        "BUNDLED_DEPENDENCIES_UNUSABLE"
      );
      assert.equal(error.diagnostic.attempts[1].stderrTail, recheckStderr);
      return true;
    }
  );
  assert.equal(harness.verifierCallCount, 2);
  assert.equal(harness.clearedStateCount, 1);
  assert.equal(
    harness.sentLogs.filter((entry) => entry.type === "warning").length,
    0,
    "A failed recheck must not be presented as a recoverable relocation warning."
  );
});

test("successful conda-unpack still blocks when moonshine_server.api cannot import", async () => {
  const importStderr =
    "Traceback (most recent call last):\n  File \"<string>\", line 1\nModuleNotFoundError: No module named 'moonshine_server.api'";
  const importFailure = {
    success: false,
    code: "BACKEND_ENTRYPOINT_IMPORT_FAILED",
    error: "Failed to import moonshine_server.api.",
    missingModules: ["moonshine_server.api"],
    dependencyErrors: {
      "moonshine_server.api": "ModuleNotFoundError",
    },
    stderr: importStderr,
    diagnostic: {
      id: "entrypoint-import-diagnostic",
      code: "BACKEND_ENTRYPOINT_IMPORT_FAILED",
      stage: "python-dependency-probe",
      stderrTail: importStderr,
      attempts: [{ code: "BACKEND_ENTRYPOINT_IMPORT_FAILED" }],
    },
  };
  const harness = createRuntimeHarness({
    verifierResults: [unusableBeforeRelocation, importFailure],
    relocationOutcome: "success",
  });

  await assert.rejects(
    () => harness.ensureBundledRuntimeReady(harness.sendLog),
    (error) => {
      assert.equal(error.name, "StartupProcessError");
      assert.equal(error.code, "BACKEND_ENTRYPOINT_IMPORT_FAILED");
      assert.equal(error.diagnostic.stage, "bundled-runtime-verification");
      assert.equal(error.diagnostic.stderrTail, importStderr);
      assert.deepEqual(error.diagnostic.attempts, importFailure.diagnostic.attempts);
      return true;
    }
  );
  assert.equal(harness.relocationCallCount, 1);
  assert.equal(harness.verifierCallCount, 2);
  assert.equal(harness.stateWrites.length, 0);
  assert.ok(
    harness.sentLogs.every((entry) => !entry.message.includes("Traceback")),
    "The import traceback must not be rendered as terminal output."
  );
  assert.ok(
    harness.startupLogEntries.some(
      (entry) =>
        entry.level === "error" &&
        entry.details.diagnostic?.stderrTail === importStderr &&
        entry.details.missingModules?.includes("moonshine_server.api")
    ),
    "The import traceback and missing entrypoint must be written to startup diagnostics."
  );
});
