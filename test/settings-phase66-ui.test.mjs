import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("phase66 path cards expose complete-path tooltips and one folder action", async () => {
  const source = await readSource("src/components/global/GlobalSettings.vue");
  const backendPanel = source.slice(
    source.indexOf('name="backend"', source.indexOf("<q-tab-panel")),
    source.indexOf('name="models"', source.indexOf('<q-tab-panel name="models"'))
  );
  const filesPanel = source.slice(
    source.indexOf('<q-tab-panel name="files"'),
    source.indexOf('<q-tab-panel name="appearance"')
  );

  assert.equal((backendPanel.match(/<q-tooltip v-if=/g) || []).length, 3);
  assert.equal((backendPanel.match(/icon="folder_open"/g) || []).length, 3);
  assert.equal((filesPanel.match(/<q-tooltip v-if=/g) || []).length, 2);
  assert.equal((filesPanel.match(/icon="folder_open"/g) || []).length, 2);
  assert.match(source, /class="settings-copy-button"[\s\S]{0,180}aria-label="复制/);
  assert.match(source, /class="settings-copy-button"[\s\S]{0,240}:disable="!localConfig\.fileManagement\.downloadPath"/);
});

test("phase66 image processing settings use a responsive two-column core grid", async () => {
  const source = await readSource("src/components/global/GlobalSettings.vue");
  const start = source.indexOf('settings-panel-grid--image-core');
  const end = source.indexOf('</div>', source.indexOf('imageSmartSelectionModel', start));
  const core = source.slice(start, end);

  assert.ok(start >= 0, "image core grid should exist");
  assert.equal((core.match(/<SettingsPanel\b/g) || []).length, 8);
  assert.match(source, /\.settings-panel-grid--image-core \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(source, /\.settings-panel-grid--image-core \{ grid-template-columns: minmax\(0, 1fr\); \}/);
});

test("phase66 app update panel exposes release metadata and environment switching shell", async () => {
  const source = await readSource("src/components/global/GlobalSettings.vue");

  assert.match(source, /data-testid="global-settings-update-summary"/);
  assert.match(source, /currentVersionUpdatedAtText/);
  assert.match(source, /当前版本更新时间/);
  assert.match(source, /data-testid="global-settings-environment-update"/);
  assert.match(source, /checkEnvironmentUpdate/);
  assert.match(source, /getEnvironmentSwitchPlan/);
  assert.match(source, /switchEnvironmentAccelerator/);
  assert.match(source, /canSwitchToCpu/);
  assert.match(source, /canSwitchToCu130/);
  assert.match(source, /当前无可用运行环境/);
  assert.match(source, /v-if="runtimeEnvironmentIsReady"[\s\S]{0,260}label="重新检测"/);
});

test("phase66 CUDA status is an accessible diagnostic card rather than raw paragraphs", async () => {
  const source = await readSource("src/components/common/CudaStatus.vue");

  assert.match(source, /data-testid="cuda-status"/);
  assert.match(source, /aria-label="查看 CUDA 运行环境诊断"/);
  assert.match(source, /cuda-status__metric-grid/);
  assert.match(source, /cuda-status__summary/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /CPU 运行包/);
  assert.match(source, /NVIDIA 驱动/);
  assert.match(source, /body\.body--dark/);
});
