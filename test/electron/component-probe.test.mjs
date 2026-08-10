import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  probeManagedComponent,
  READY_FILE,
} from "../../src-electron/runtime/component-probe.js";

async function writeFile(root, relative, value) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
}

async function runtimeFixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-component-probe-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeFile(root, "env/python.exe", "python");
  await writeFile(root, "env/Scripts/conda-unpack.exe", "unpack");
  await writeFile(root, "runtime-manifest.json", JSON.stringify({
    schemaVersion: 4,
    runtimeFlavor: "cpu",
    modelBundle: "external-models",
    envDir: "env",
    pythonExecutable: "env/python.exe",
    condaUnpackExecutable: "env/Scripts/conda-unpack.exe",
    builtAt: "2026-08-08T00:00:00.000Z",
    samRuntime: {
      sam1: { modelWeightsBundled: false },
      sam2: { modelWeightsBundled: false },
      sam3: { modelWeightsBundled: false },
    },
    ...overrides,
  }));
  return root;
}

function component(overrides = {}) {
  return {
    id: "python-cpu",
    kind: "python-runtime",
    version: "1.3.0",
    sha256: "a".repeat(64),
    accelerator: "cpu",
    entrypoint: "env/python.exe",
    ...overrides,
  };
}

test("managed Python probe relocates once, executes Python, and returns a relative entrypoint", async (t) => {
  const root = await runtimeFixture(t);
  const calls = [];
  const runProcessImpl = async (command, args, options) => {
    calls.push({ command: path.basename(command), args, cwd: options.cwd, env: options.env });
    return { success: true, stdout: command.includes("python") ? "Python 3.12.11\n" : "" };
  };

  const first = await probeManagedComponent({ component: component(), root, runProcessImpl, platform: "win32", baseEnv: {} });
  assert.equal(first.success, true);
  assert.equal(first.entrypoint, "env/python.exe");
  assert.equal(first.relocated, true);
  assert.deepEqual(calls.map((call) => call.command), ["conda-unpack.exe", "python.exe"]);
  assert.equal(calls[1].env.MOONSHINE_MODEL_BUNDLE, "external-models");
  assert.equal(JSON.parse(await fs.readFile(path.join(root, READY_FILE), "utf8")).sha256, "a".repeat(64));

  calls.length = 0;
  const second = await probeManagedComponent({ component: component(), root, runProcessImpl, platform: "win32", baseEnv: {} });
  assert.equal(second.relocated, false);
  assert.deepEqual(calls.map((call) => call.command), ["python.exe"]);
});

test("managed Python probe rejects descriptor and model-policy mismatches before execution", async (t) => {
  const root = await runtimeFixture(t);
  let calls = 0;
  const runProcessImpl = async () => { calls += 1; return { success: true }; };
  await assert.rejects(
    probeManagedComponent({ component: component({ entrypoint: "python.exe" }), root, runProcessImpl }),
    /does not match runtime-manifest/
  );
  await writeFile(root, "runtime-manifest.json", JSON.stringify({
    schemaVersion: 4,
    runtimeFlavor: "cpu",
    modelBundle: "bundled-models",
    envDir: "env",
    pythonExecutable: "env/python.exe",
    condaUnpackExecutable: "env/Scripts/conda-unpack.exe",
    samRuntime: { sam1: { modelWeightsBundled: false } },
  }));
  await assert.rejects(
    probeManagedComponent({ component: component(), root, runProcessImpl }),
    /bundled model policy/
  );
  assert.equal(calls, 0);
});

test("managed FFmpeg probe executes the signed relative entrypoint", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-ffmpeg-probe-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeFile(root, "ffmpeg.exe", "ffmpeg");
  const calls = [];
  const result = await probeManagedComponent({
    component: { id: "ffmpeg", version: "1.3.0", sha256: "b".repeat(64), entrypoint: "ffmpeg.exe" },
    root,
    runProcessImpl: async (command, args) => {
      calls.push({ command, args });
      return { success: true, stdout: "ffmpeg version 8.0\n" };
    },
  });
  assert.equal(result.entrypoint, "ffmpeg.exe");
  assert.deepEqual(calls[0].args, ["-version"]);
});
