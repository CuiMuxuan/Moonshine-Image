import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";

function runCommand({ label, command, args = [] }) {
  console.log(`\n=== ${label} ===`);
  const shouldUseShell = isWindows && /\.cmd$/i.test(command);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: shouldUseShell,
  });

  if (result.error) {
    throw new Error(
      `Command failed (${label}): ${command} ${args.join(" ")}\n${result.error.message}`
    );
  }

  if (result.status !== 0) {
    throw new Error(`Command failed (${label}): ${command} ${args.join(" ")}`);
  }
}

function tryProbePython(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "pipe",
    shell: false,
    encoding: "utf8",
  });
  return result.status === 0;
}

function resolvePythonInvoker() {
  const envPython = String(process.env.PYTHON || "").trim();
  const candidates = [];

  if (envPython) {
    candidates.push({
      command: envPython,
      probeArgs: ["-c", "import sys;print(sys.version)"],
      runArgsPrefix: [],
    });
  }

  candidates.push(
    {
      command: "python",
      probeArgs: ["-c", "import sys;print(sys.version)"],
      runArgsPrefix: [],
    },
    {
      command: "py",
      probeArgs: ["-3", "-c", "import sys;print(sys.version)"],
      runArgsPrefix: ["-3"],
    }
  );

  for (const candidate of candidates) {
    if (tryProbePython(candidate.command, candidate.probeArgs)) {
      return candidate;
    }
  }

  throw new Error(
    "Python executable not found. Set PYTHON or install python/py launcher to run P0 gate."
  );
}

function runP0Gate() {
  const npmCommand = isWindows ? "npm.cmd" : "npm";
  const shouldRunE2E = String(process.env.MOONSHINE_P0_RUN_E2E || "").trim() === "1";

  runCommand({
    label: "Lint",
    command: npmCommand,
    args: ["run", "lint"],
  });

  runCommand({
    label: "Build",
    command: npmCommand,
    args: ["run", "build"],
  });

  runCommand({
    label: "P0 Static Assertions",
    command: "node",
    args: ["scripts/p0-regression-assertions.mjs"],
  });

  const python = resolvePythonInvoker();
  const pyCompileTargets = [
    "server/moonshine_server/schema.py",
    "server/moonshine_server/api.py",
    "server/moonshine_server/batch_processing.py",
    "server/moonshine_server/image_output.py",
    "server/moonshine_server/moonshine/model_registry.py",
    "server/moonshine_server/moonshine/slbr_runner.py",
  ];

  runCommand({
    label: "Backend Python Syntax Check",
    command: python.command,
    args: [...python.runArgsPrefix, "-m", "py_compile", ...pyCompileTargets],
  });

  if (shouldRunE2E) {
    runCommand({
      label: "E2E Smoke",
      command: "node",
      args: ["scripts/e2e-smoke-image-settings.mjs"],
    });
  }

  console.log("\nP0 regression gate passed.");
}

try {
  runP0Gate();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
