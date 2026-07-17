import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKEND_RUNTIME_IMPORT_MODULES,
  IMPORT_PROBE_PREFIX,
  buildImportProbeScript,
  classifyPythonCandidateResult,
  createImportProbeArgs,
  createIsolatedPythonEnv,
  detectSupportedPython,
  getPythonEnvironmentPathEntries,
  getPythonVersionRank,
  isSupportedPythonVersion,
  parseImportProbeResult,
  parsePythonVersion,
} from "../../src-electron/python-runtime.js";

test("parses Python versions and ranks supported minors", () => {
  assert.deepEqual(parsePythonVersion("Python 3.12.11"), {
    major: 3,
    minor: 12,
    patch: 11,
    text: "3.12.11",
  });
  assert.deepEqual(parsePythonVersion("3.10"), {
    major: 3,
    minor: 10,
    patch: 0,
    text: "3.10.0",
  });
  assert.equal(parsePythonVersion("not Python"), null);
  assert.equal(isSupportedPythonVersion("3.9.20"), false);
  assert.equal(isSupportedPythonVersion("3.10.14"), true);
  assert.ok(getPythonVersionRank("3.12.0") > getPythonVersionRank("3.11.99"));
  assert.ok(getPythonVersionRank("3.11.0") > getPythonVersionRank("3.10.99"));
});

test("creates an isolated Windows Python environment without mutating inputs", () => {
  const baseEnv = {
    Path: "C:\\Windows\\System32;C:\\runtime\\env\\Scripts",
    PYTHONHOME: "C:\\old-python",
    pythonpath: "C:\\old-modules",
    CONDA_PREFIX: "C:\\old-conda",
    CONDA_DEFAULT_ENV: "base",
    CONDA_SHLVL: "2",
    KEEP_ME: "yes",
  };
  const original = { ...baseEnv };
  const isolated = createIsolatedPythonEnv({
    baseEnv,
    envRoot: "C:\\runtime\\env",
    platform: "win32",
    overrides: {
      VIRTUAL_ENV: "C:\\also-blocked",
      MOONSHINE_PACKAGED_RUNTIME: "1",
    },
  });

  assert.deepEqual(baseEnv, original);
  assert.equal(isolated.PYTHONHOME, undefined);
  assert.equal(isolated.pythonpath, undefined);
  assert.equal(isolated.CONDA_PREFIX, undefined);
  assert.equal(isolated.CONDA_DEFAULT_ENV, undefined);
  assert.equal(isolated.CONDA_SHLVL, undefined);
  assert.equal(isolated.VIRTUAL_ENV, undefined);
  assert.equal(isolated.KEEP_ME, "yes");
  assert.equal(isolated.MOONSHINE_PACKAGED_RUNTIME, "1");
  assert.deepEqual(isolated.PATH.split(";").slice(0, 3), [
    "C:\\runtime\\env",
    "C:\\runtime\\env\\Scripts",
    "C:\\runtime\\env\\Library\\bin",
  ]);
  assert.equal(
    isolated.PATH.split(";").filter(
      (entry) => entry.toLowerCase() === "c:\\runtime\\env\\scripts"
    ).length,
    1
  );
});

test("constructs platform-appropriate POSIX Python PATH entries", () => {
  assert.deepEqual(
    getPythonEnvironmentPathEntries("/opt/moonshine/env", { platform: "linux" }),
    ["/opt/moonshine/env/bin", "/opt/moonshine/env"]
  );

  const isolated = createIsolatedPythonEnv({
    baseEnv: {
      PATH: "/usr/local/bin:/usr/bin",
      PYTHONPATH: "/tmp/modules",
      VIRTUAL_ENV: "/tmp/old-env",
    },
    envRoot: "/opt/moonshine/env",
    platform: "linux",
  });
  assert.equal(
    isolated.PATH,
    "/opt/moonshine/env/bin:/opt/moonshine/env:/usr/local/bin:/usr/bin"
  );
  assert.equal(isolated.PYTHONPATH, undefined);
  assert.equal(isolated.VIRTUAL_ENV, undefined);
});

test("classifies candidate results without discarding diagnostics", () => {
  const candidate = { command: "python", args: [], label: "python" };
  assert.equal(
    classifyPythonCandidateResult(candidate, {
      success: true,
      version: "3.12.4",
    }).status,
    "supported"
  );
  assert.equal(
    classifyPythonCandidateResult(candidate, {
      success: true,
      version: "3.8.10",
    }).status,
    "unsupported"
  );

  const missing = classifyPythonCandidateResult(candidate, {
    success: false,
    error: Object.assign(new Error("not found"), { code: "ENOENT" }),
  });
  assert.equal(missing.status, "not-found");
  assert.equal(missing.osCode, "ENOENT");

  const launcherWithoutRuntime = classifyPythonCandidateResult(
    { command: "py", args: ["-3.12"] },
    {
      success: false,
      diagnostic: {
        stderrTail: "Requested Python version (3.12) not installed",
      },
    }
  );
  assert.equal(launcherWithoutRuntime.status, "not-found");

  const unusable = classifyPythonCandidateResult(candidate, {
    success: false,
    error: Object.assign(new Error("access denied"), { code: "EACCES" }),
    diagnostic: { id: "diag-1" },
  });
  assert.equal(unusable.status, "unusable");
  assert.equal(unusable.diagnostic.id, "diag-1");
});

test("inspects every candidate and chooses 3.12 even when 3.8 is first", async () => {
  const candidates = [
    { command: "python", args: [] },
    { command: "py", args: ["-3.10"] },
    { command: "py", args: ["-3.12"] },
    { command: "py", args: ["-3.11"] },
  ];
  const versions = new Map([
    ["python", "3.8.10"],
    ["py -3.10", "3.10.14"],
    ["py -3.12", "3.12.11"],
    ["py -3.11", "3.11.9"],
  ]);
  const inspected = [];

  const result = await detectSupportedPython({
    candidates,
    inspectCandidate: async (candidate) => {
      inspected.push(candidate.label);
      return { success: true, version: versions.get(candidate.label) };
    },
  });

  assert.deepEqual(inspected, ["python", "py -3.10", "py -3.12", "py -3.11"]);
  assert.equal(result.success, true);
  assert.equal(result.label, "py -3.12");
  assert.equal(result.version.text, "3.12.11");
  assert.equal(result.attempts.length, candidates.length);
});

test("returns unsupported, unusable, and not-found detection outcomes", async (t) => {
  await t.test("unsupported when only Python 3.8 is usable", async () => {
    const result = await detectSupportedPython({
      candidates: [{ command: "python" }, { command: "python3" }],
      inspectCandidate: async (candidate) =>
        candidate.command === "python"
          ? { success: true, version: "3.8.10" }
          : { success: false, osCode: "ENOENT", error: "not found" },
    });
    assert.equal(result.code, "SYSTEM_PYTHON_UNSUPPORTED");
    assert.equal(result.classification, "unsupported");
  });

  await t.test("unusable when an executable exists but cannot run", async () => {
    const result = await detectSupportedPython({
      candidates: [{ command: "python" }, { command: "python3" }],
      inspectCandidate: async (candidate) => {
        if (candidate.command === "python") {
          throw Object.assign(new Error("DLL load failed"), { code: "EACCES" });
        }
        return { success: false, osCode: "ENOENT", error: "not found" };
      },
    });
    assert.equal(result.code, "SYSTEM_PYTHON_UNUSABLE");
    assert.equal(result.attempts[0].reason, "DLL load failed");
  });

  await t.test("not found when every command is missing", async () => {
    const result = await detectSupportedPython({
      candidates: [{ command: "python" }, { command: "python3" }],
      inspectCandidate: async () => ({
        success: false,
        diagnostic: { osCode: "ENOENT", reason: "spawn ENOENT" },
      }),
    });
    assert.equal(result.code, "SYSTEM_PYTHON_NOT_FOUND");
    assert.equal(result.classification, "not-found");
  });
});

test("builds and parses structured per-module import probes", () => {
  const script = buildImportProbeScript(["fastapi", "PIL.Image"]);
  assert.match(script, /importlib\.import_module\(module_name\)/);
  assert.match(script, /"fastapi"/);
  assert.match(script, /"PIL\.Image"/);
  assert.deepEqual(createImportProbeArgs(["fastapi"]), [
    "-c",
    buildImportProbeScript(["fastapi"]),
  ]);
  assert.throws(() => buildImportProbeScript(["valid", "bad-name"]), TypeError);

  const usable = parseImportProbeResult({
    stdout: `warning before probe\n${IMPORT_PROBE_PREFIX}{"ok":true,"missing":[],"errors":{}}\n`,
    stderr: "an import warning",
    exitCode: 0,
  });
  assert.equal(usable.success, true);
  assert.equal(usable.dependenciesUsable, true);

  const missing = parseImportProbeResult({
    stdout: `${IMPORT_PROBE_PREFIX}{"ok":false,"missing":["torch"],"errors":{"torch":"ImportError: DLL load failed"}}`,
    exitCode: 1,
  });
  assert.equal(missing.success, false);
  assert.equal(missing.parsed, true);
  assert.equal(missing.code, "PYTHON_DEPENDENCIES_MISSING");
  assert.deepEqual(missing.missingModules, ["torch"]);
  assert.equal(missing.errors.torch, "ImportError: DLL load failed");

  const invalid = parseImportProbeResult({ stdout: "plain output", exitCode: 1 });
  assert.equal(invalid.parsed, false);
  assert.equal(invalid.code, "PYTHON_IMPORT_PROBE_INVALID_OUTPUT");
});

test("backend runtime probes every startup dependency and the API entrypoint", () => {
  assert.deepEqual(BACKEND_RUNTIME_IMPORT_MODULES, [
    "fastapi",
    "uvicorn",
    "numpy",
    "PIL",
    "torch",
    "transformers",
    "cv2",
    "socketio",
    "loguru",
    "tqdm",
    "moonshine_server.api",
  ]);

  const script = buildImportProbeScript();
  BACKEND_RUNTIME_IMPORT_MODULES.forEach((moduleName) => {
    assert.match(script, new RegExp(`"${moduleName.replaceAll(".", "\\.")}"`));
  });

  const entrypointFailure = parseImportProbeResult({
    stdout: `${IMPORT_PROBE_PREFIX}{"ok":false,"missing":["moonshine_server.api"],"errors":{"moonshine_server.api":"ImportError: DLL load failed"}}`,
    exitCode: 1,
  });
  assert.equal(entrypointFailure.success, false);
  assert.deepEqual(entrypointFailure.missingModules, ["moonshine_server.api"]);
});
