import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

import { createAppUpdateMetadata } from "../../scripts/release/create-app-update-metadata.mjs";

test("app update metadata is derived from the immutable test installer", async () => {
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), "moonshine-app-metadata-"));
  const installerName = "Moonshine-Image-Test-Setup-1.3.3-test.1.exe";
  const installerPath = path.join(artifactDir, installerName);
  const contents = Buffer.from("moonshine-test-installer");
  await writeFile(installerPath, contents);
  await writeFile(`${installerPath}.blockmap`, "blockmap");

  const result = await createAppUpdateMetadata({
    artifactDir,
    version: "1.3.3-test.1",
    releaseDate: "2026-08-13T00:00:00.000Z",
  });
  const latest = YAML.parse(await readFile(result.outputPath, "utf8"));

  assert.equal(result.edition, "test");
  assert.equal(result.channel, "test");
  assert.equal(latest.version, "1.3.3-test.1");
  assert.equal(latest.path, installerName);
  assert.equal(latest.files[0].url, installerName);
  assert.equal(latest.files[0].size, contents.length);
  assert.equal(latest.files[0].sha512, createHash("sha512").update(contents).digest("base64"));
  assert.equal(latest.releaseDate, "2026-08-13T00:00:00.000Z");
});

test("app update metadata refuses a cross-edition artifact name", async () => {
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), "moonshine-app-metadata-"));
  await writeFile(path.join(artifactDir, "Moonshine-Image-Setup-1.3.3-test.1.exe"), "wrong edition");
  await assert.rejects(
    () => createAppUpdateMetadata({ artifactDir, version: "1.3.3-test.1" }),
    /ENOENT|no such file/i,
  );
});
