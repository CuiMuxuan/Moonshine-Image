import path from "node:path";

export const SUPPORTED_PYTHON_MINORS = Object.freeze([12, 11, 10]);

export const PYTHON_ENV_KEYS_TO_REMOVE = Object.freeze([
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONEXECUTABLE",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "CONDA_DEFAULT_ENV",
  "CONDA_SHLVL",
]);

export const BACKEND_RUNTIME_IMPORT_MODULES = Object.freeze([
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

export const DEFAULT_IMPORT_PROBE_MODULES = BACKEND_RUNTIME_IMPORT_MODULES;
export const BACKEND_RUNTIME_IMPORT_TIMEOUT_MS = 60_000;

export const IMPORT_PROBE_PREFIX = "MOONSHINE_IMPORT_PROBE=";

const NOT_FOUND_ERROR_CODES = new Set([
  "ENOENT",
  "COMMAND_NOT_FOUND",
  "SYSTEM_PYTHON_NOT_FOUND",
]);

function getPathImplementation(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function getEnvironmentValue(environment, requestedKey, platform) {
  if (!environment || typeof environment !== "object") {
    return undefined;
  }

  if (platform !== "win32") {
    return environment[requestedKey];
  }

  const matchingKey = Object.keys(environment).find(
    (key) => key.toUpperCase() === requestedKey.toUpperCase()
  );
  return matchingKey ? environment[matchingKey] : undefined;
}

function isEnvironmentKey(key, requestedKey, platform) {
  return platform === "win32"
    ? key.toUpperCase() === requestedKey.toUpperCase()
    : key === requestedKey;
}

function uniquePathEntries(entries, platform) {
  const seen = new Set();
  return entries.filter((entry) => {
    if (typeof entry !== "string" || entry.length === 0) {
      return false;
    }

    const identity = platform === "win32" ? entry.toLowerCase() : entry;
    if (seen.has(identity)) {
      return false;
    }

    seen.add(identity);
    return true;
  });
}

export function getPythonEnvironmentPathEntries(
  envRoot,
  { platform = process.platform } = {}
) {
  if (typeof envRoot !== "string" || envRoot.trim() === "") {
    return [];
  }

  const pathImplementation = getPathImplementation(platform);
  const normalizedRoot = pathImplementation.resolve(envRoot);

  if (platform === "win32") {
    return [
      normalizedRoot,
      pathImplementation.join(normalizedRoot, "Scripts"),
      pathImplementation.join(normalizedRoot, "Library", "bin"),
    ];
  }

  return [pathImplementation.join(normalizedRoot, "bin"), normalizedRoot];
}

export function createIsolatedPythonEnv({
  baseEnv = process.env,
  envRoot,
  platform = process.platform,
  overrides = {},
  additionalPathEntries = [],
} = {}) {
  const blockedKeys = new Set(PYTHON_ENV_KEYS_TO_REMOVE);
  const mergedEnvironment = { ...baseEnv, ...overrides };
  const isolatedEnvironment = {};

  for (const [key, value] of Object.entries(mergedEnvironment)) {
    const comparableKey = platform === "win32" ? key.toUpperCase() : key;
    if (blockedKeys.has(comparableKey) || isEnvironmentKey(key, "PATH", platform)) {
      continue;
    }
    isolatedEnvironment[key] = value;
  }

  const inheritedPath =
    getEnvironmentValue(overrides, "PATH", platform) ??
    getEnvironmentValue(baseEnv, "PATH", platform) ??
    "";
  const delimiter = platform === "win32" ? ";" : ":";
  const pathEntries = uniquePathEntries(
    [
      ...getPythonEnvironmentPathEntries(envRoot, { platform }),
      ...additionalPathEntries,
      ...String(inheritedPath).split(delimiter),
    ],
    platform
  );

  if (pathEntries.length > 0 || inheritedPath !== "") {
    isolatedEnvironment.PATH = pathEntries.join(delimiter);
  }

  return isolatedEnvironment;
}

export function parsePythonVersion(input) {
  if (input && typeof input === "object") {
    const major = Number(input.major);
    const minor = Number(input.minor);
    const patch = Number(input.patch ?? 0);
    if ([major, minor, patch].every(Number.isInteger)) {
      return {
        major,
        minor,
        patch,
        text: `${major}.${minor}.${patch}`,
      };
    }
  }

  const match = String(input ?? "").match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) {
    return null;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] ?? 0);
  return {
    major,
    minor,
    patch,
    text: `${major}.${minor}.${patch}`,
  };
}

export function isSupportedPythonVersion(input) {
  const version = parsePythonVersion(input);
  return (
    version?.major === 3 && SUPPORTED_PYTHON_MINORS.includes(version.minor)
  );
}

export function getPythonVersionRank(input) {
  const version = parsePythonVersion(input);
  if (!isSupportedPythonVersion(version)) {
    return -1;
  }

  const minorRank = SUPPORTED_PYTHON_MINORS.length - SUPPORTED_PYTHON_MINORS.indexOf(
    version.minor
  );
  return minorRank * 1_000_000 + version.patch;
}

function getResultErrorCode(result) {
  return (
    result?.osCode ??
    result?.diagnostic?.osCode ??
    result?.error?.code ??
    (typeof result?.code === "string" ? result.code : undefined)
  );
}

function getResultReason(result) {
  if (typeof result?.error === "string") {
    return result.error;
  }
  if (result?.error?.message) {
    return result.error.message;
  }
  if (typeof result?.reason === "string") {
    return result.reason;
  }
  if (result?.diagnostic?.reason) {
    return result.diagnostic.reason;
  }
  return "Python candidate could not be executed.";
}

function normalizeCandidate(candidate = {}, index = 0) {
  const args = Array.isArray(candidate.args) ? [...candidate.args] : [];
  const command = String(candidate.command ?? "");
  return {
    ...candidate,
    command,
    args,
    label: candidate.label || [command, ...args].join(" ").trim() || `candidate-${index + 1}`,
  };
}

export function isMissingPythonRuntimeResult(result = {}) {
  const details = [
    result.error?.message || result.error,
    result.reason,
    result.diagnostic?.reason,
    result.diagnostic?.stdoutTail,
    result.diagnostic?.stderrTail,
  ]
    .filter(Boolean)
    .join("\n");
  return /requested python version.*not installed|no (?:installed|suitable) python|python (?:was|is) not found|unable to (?:locate|find).*python installation|can't find (?:a )?suitable python/i.test(
    details
  );
}

export function classifyPythonCandidateResult(candidate, result, index = 0) {
  const normalizedCandidate = normalizeCandidate(candidate, index);
  const version = parsePythonVersion(
    result?.version ?? result?.stdout ?? result?.output
  );

  if (result?.success === true && version) {
    return {
      ...normalizedCandidate,
      status: isSupportedPythonVersion(version) ? "supported" : "unsupported",
      version,
      reason: isSupportedPythonVersion(version)
        ? null
        : `Python ${version.text} is outside the supported range (3.10.x to 3.12.x).`,
      diagnostic: result.diagnostic ?? null,
      index,
    };
  }

  const osCode = getResultErrorCode(result);
  const status =
    result?.notFound === true ||
    NOT_FOUND_ERROR_CODES.has(String(osCode || "").toUpperCase()) ||
    isMissingPythonRuntimeResult(result)
      ? "not-found"
      : "unusable";

  return {
    ...normalizedCandidate,
    status,
    version,
    reason:
      result?.success === true && !version
        ? "Python responded, but its version could not be parsed."
        : getResultReason(result),
    osCode: osCode ?? null,
    diagnostic: result?.diagnostic ?? null,
    index,
  };
}

function createDetectionFailure(attempts) {
  const unsupportedAttempts = attempts.filter(
    (attempt) => attempt.status === "unsupported"
  );
  if (unsupportedAttempts.length > 0) {
    const versions = [
      ...new Set(unsupportedAttempts.map((attempt) => attempt.version.text)),
    ];
    return {
      success: false,
      code: "SYSTEM_PYTHON_UNSUPPORTED",
      classification: "unsupported",
      error: `Detected Python ${versions.join(", ")}, but supported versions are 3.10.x to 3.12.x.`,
      attempts,
    };
  }

  if (attempts.some((attempt) => attempt.status === "unusable")) {
    return {
      success: false,
      code: "SYSTEM_PYTHON_UNUSABLE",
      classification: "unusable",
      error: "Python executables were found, but none could be used.",
      attempts,
    };
  }

  return {
    success: false,
    code: "SYSTEM_PYTHON_NOT_FOUND",
    classification: "not-found",
    error: "No system Python executable was detected.",
    attempts,
  };
}

export async function detectSupportedPython({ candidates, inspectCandidate } = {}) {
  if (!Array.isArray(candidates)) {
    throw new TypeError("candidates must be an array.");
  }
  if (typeof inspectCandidate !== "function") {
    throw new TypeError("inspectCandidate must be a function.");
  }

  const attempts = [];
  for (const [index, candidate] of candidates.entries()) {
    let result;
    try {
      result = await inspectCandidate(normalizeCandidate(candidate, index));
    } catch (error) {
      result = { success: false, error };
    }
    attempts.push(classifyPythonCandidateResult(candidate, result, index));
  }

  const supportedAttempts = attempts
    .filter((attempt) => attempt.status === "supported")
    .sort((left, right) => {
      const rankDifference =
        getPythonVersionRank(right.version) - getPythonVersionRank(left.version);
      return rankDifference || left.index - right.index;
    });

  if (supportedAttempts.length === 0) {
    return createDetectionFailure(attempts);
  }

  const selected = supportedAttempts[0];
  return {
    success: true,
    command: selected.command,
    args: [...selected.args],
    label: selected.label,
    path: selected.path,
    version: selected.version,
    selected,
    attempts,
  };
}

function normalizeImportModules(modules) {
  const normalizedModules = [...new Set(modules)];
  for (const moduleName of normalizedModules) {
    if (
      typeof moduleName !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(moduleName)
    ) {
      throw new TypeError(`Invalid Python import module name: ${String(moduleName)}`);
    }
  }
  return normalizedModules;
}

export function buildImportProbeScript(modules = DEFAULT_IMPORT_PROBE_MODULES) {
  if (!Array.isArray(modules)) {
    throw new TypeError("modules must be an array.");
  }

  const normalizedModules = normalizeImportModules(modules);
  return [
    "import importlib",
    "import json",
    "import sys",
    `modules = ${JSON.stringify(normalizedModules)}`,
    "missing = []",
    "errors = {}",
    "for module_name in modules:",
    "    try:",
    "        importlib.import_module(module_name)",
    "    except Exception as exc:",
    "        missing.append(module_name)",
    '        errors[module_name] = f"{type(exc).__name__}: {exc}"',
    `print("${IMPORT_PROBE_PREFIX}" + json.dumps({"ok": not missing, "missing": missing, "errors": errors}, ensure_ascii=True))`,
    "sys.exit(1 if missing else 0)",
  ].join("\n");
}

export function createImportProbeArgs(modules = DEFAULT_IMPORT_PROBE_MODULES) {
  return ["-c", buildImportProbeScript(modules)];
}

export function parseImportProbeResult(result = {}) {
  const normalizedResult =
    typeof result === "string" ? { stdout: result, exitCode: 0 } : result;
  const stdout = String(normalizedResult?.stdout ?? "");
  const stderr = String(normalizedResult?.stderr ?? "");
  const exitCode = Number.isInteger(normalizedResult?.exitCode)
    ? normalizedResult.exitCode
    : null;
  const probeLine = [...stdout.split(/\r?\n/)]
    .reverse()
    .find((line) => line.includes(IMPORT_PROBE_PREFIX));

  if (!probeLine) {
    return {
      success: false,
      parsed: false,
      code: "PYTHON_IMPORT_PROBE_INVALID_OUTPUT",
      error: "Python dependency probe did not return structured output.",
      missingModules: [],
      errors: {},
      exitCode,
      stderr,
    };
  }

  let payload;
  try {
    payload = JSON.parse(
      probeLine.slice(probeLine.indexOf(IMPORT_PROBE_PREFIX) + IMPORT_PROBE_PREFIX.length)
    );
  } catch (error) {
    return {
      success: false,
      parsed: false,
      code: "PYTHON_IMPORT_PROBE_INVALID_OUTPUT",
      error: `Python dependency probe returned invalid JSON: ${error.message}`,
      missingModules: [],
      errors: {},
      exitCode,
      stderr,
    };
  }

  const missingModules = Array.isArray(payload?.missing)
    ? payload.missing.filter((moduleName) => typeof moduleName === "string")
    : [];
  const errors =
    payload?.errors && typeof payload.errors === "object" && !Array.isArray(payload.errors)
      ? payload.errors
      : {};
  const dependenciesUsable =
    payload?.ok === true && missingModules.length === 0 && (exitCode === null || exitCode === 0);

  if (dependenciesUsable) {
    return {
      success: true,
      parsed: true,
      dependenciesUsable: true,
      missingModules,
      errors,
      exitCode,
      stderr,
    };
  }

  return {
    success: false,
    parsed: true,
    dependenciesUsable: false,
    code:
      missingModules.length > 0
        ? "PYTHON_DEPENDENCIES_MISSING"
        : "PYTHON_IMPORT_PROBE_FAILED",
    error:
      missingModules.length > 0
        ? `Python dependencies are not usable: ${missingModules.join(", ")}.`
        : "Python dependency probe failed.",
    missingModules,
    errors,
    exitCode,
    stderr,
  };
}
