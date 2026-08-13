import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("model management exposes the model directory and preparation states", async () => {
  const source = await readSource("src/components/global/ModelManagementPanel.vue");

  assert.match(source, /aria-label="打开模型路径"/);
  assert.match(
    source,
    /若无法自动下载模型，请从下方下载源手动下载模型并将其存放于模型路径下。/
  );
  for (const stage of ["checking", "downloading", "verifying", "loading", "ready", "failed"]) {
    assert.match(source, new RegExp(`${stage}:`));
  }
});

test("service management keeps lower lifecycle controls and model guidance in the compact panel", async () => {
  const source = await readSource("src/components/global/BackendManager.vue");

  assert.match(source, /data-testid="backend-service-controls"/);
  assert.match(source, /class="service-info-grid"/);
  assert.match(source, /请打开模型管理页下载所需模型/);
  assert.match(source, /globalSettings\?\.open\?\.\(\{ tab: "models"/);
});

test("file management path cards put copy in the heading and keep one folder suffix", async () => {
  const source = await readSource("src/components/global/GlobalSettings.vue");
  const filePanel = source.slice(
    source.indexOf('<q-tab-panel name="files"'),
    source.indexOf('<q-tab-panel name="appearance"')
  );

  assert.equal((filePanel.match(/<template #actions>/g) || []).length, 2);
  assert.equal((filePanel.match(/icon="content_copy"/g) || []).length, 2);
  assert.equal((filePanel.match(/icon="folder_open"/g) || []).length, 2);
  assert.match(filePanel, /:disable="!localConfig\.fileManagement\.downloadPath"/);
  assert.match(filePanel, /:disable="!localConfig\.fileManagement\.tempPath"/);
});

test("file and service path cards use heading copy actions and the file grid is two columns", async () => {
  const source = await readSource("src/components/global/GlobalSettings.vue");
  const backendPanel = source.slice(
    source.indexOf('name="backend"', source.indexOf('<q-tab-panel')),
    source.indexOf('name="models"', source.indexOf('<q-tab-panel name="models"'))
  );
  const filePanel = source.slice(
    source.indexOf('<q-tab-panel name="files"'),
    source.indexOf('<q-tab-panel name="appearance"')
  );

  assert.match(filePanel, /settings-panel-grid--file-management/);
  assert.match(source, /\.settings-panel-grid--file-management \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.equal((backendPanel.match(/class="settings-copy-button"/g) || []).length, 3);
  assert.equal((backendPanel.match(/icon="content_copy"/g) || []).length, 3);
  assert.equal((backendPanel.match(/icon="folder(?:_open)?"/g) || []).length, 3);
  assert.equal((filePanel.match(/class="settings-copy-button"/g) || []).length, 2);
  assert.match(source, /\.settings-copy-button \{[\s\S]*width: 32px;/);
});

test("settings grids collapse to one column at narrow width", async () => {
  const source = await readFile("src/components/global/GlobalSettings.vue", "utf8");
  assert.match(
    source,
    /@media \(max-width: 900px\)[\s\S]*\.grid,[\s\S]*\.settings-panel-grid,[\s\S]*\.settings-toggle-grid[\s\S]*grid-template-columns: minmax\(0, 1fr\)/
  );
});
