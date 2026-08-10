import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildComponentBundles,
  runSevenZip,
  validateComponentSource,
} from "../../scripts/release/component-bundle-lib.mjs";

async function writeFile(root, relative, value) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
}

async function makeFixture(t, { bundledModels = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moonshine-component-bundle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cpu = path.join(root, "cpu");
  const cu130 = path.join(root, "cu130");
  const ffmpeg = path.join(root, "ffmpeg");
  for (const [directory, flavor] of [[cpu, "cpu"], [cu130, "cu130"]]) {
    await writeFile(directory, "env/python.exe", "python");
    await writeFile(directory, "env/Scripts/conda-unpack.exe", "unpack");
    await writeFile(directory, "runtime-manifest.json", JSON.stringify({
      schemaVersion: 4,
      runtimeFlavor: flavor,
      modelBundle: bundledModels ? "bundled-models" : "external-models",
      envDir: "env",
      pythonExecutable: "env/python.exe",
      condaUnpackExecutable: "env/Scripts/conda-unpack.exe",
      samRuntime: {
        sam1: { modelWeightsBundled: false },
        sam2: { modelWeightsBundled: false },
        sam3: { modelWeightsBundled: false },
      },
    }));
  }
  await writeFile(ffmpeg, "ffmpeg.exe", "ffmpeg");
  await writeFile(ffmpeg, "ffprobe.exe", "ffprobe");
  await writeFile(ffmpeg, "LICENSE.txt", "license");
  return { root, cpu, cu130, ffmpeg };
}

test("component bundle builder validates online runtime boundaries and writes a release descriptor", async (t) => {
  const fixture = await makeFixture(t);
  const outputDir = path.join(fixture.root, "output");
  const result = await buildComponentBundles({
    version: "1.3.0",
    outputDir,
    runtimeCpuRoot: fixture.cpu,
    runtimeCu130Root: fixture.cu130,
    ffmpegRoot: fixture.ffmpeg,
  });

  assert.equal(result.descriptor.components.length, 3);
  const cpu = result.descriptor.components.find((component) => component.id === "python-cpu");
  assert.equal(cpu.entrypoint, "env/python.exe");
  assert.equal(cpu.artifactPath, "components/win-x64/releases/1.3.0/python-cpu.zip");
  assert.ok(result.report.components.every((component) => component.archiveBytes > 0));
  assert.ok((await fs.stat(path.join(outputDir, "components.json"))).isFile());
  assert.ok((await fs.stat(path.join(outputDir, "python-cpu.zip"))).isFile());
});

test("component bundle builder rejects bundled model runtimes before producing output", async (t) => {
  const fixture = await makeFixture(t, { bundledModels: true });
  const outputDir = path.join(fixture.root, "output");
  await assert.rejects(
    buildComponentBundles({
      version: "1.3.0",
      outputDir,
      runtimeCpuRoot: fixture.cpu,
      runtimeCu130Root: fixture.cu130,
      ffmpegRoot: fixture.ffmpeg,
    }),
    /modelBundle=external-models/
  );
  assert.equal(await fs.stat(outputDir).catch((error) => error.code), "ENOENT");
});

test("component bundle builder refuses overwrite and unsafe model files", async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(fixture.ffmpeg, "weights/sam3.pt", Buffer.alloc(1));
  await assert.rejects(
    validateComponentSource({ id: "ffmpeg", root: fixture.ffmpeg }),
    /Model weight is not allowed/
  );
});

test("7-Zip runner streams output beyond the former spawnSync buffer limit", async () => {
  const outputBytes = 12 * 1024 * 1024;
  const result = await runSevenZip(
    process.execPath,
    ["-e", `process.stdout.write("x".repeat(${outputBytes}))`],
    process.cwd()
  );

  assert.equal(Buffer.byteLength(result.stdout), 64 * 1024);
  assert.equal(result.stderr, "");
});
