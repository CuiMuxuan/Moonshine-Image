import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");
const indexSource = read("src/pages/IndexPage.vue");
const editorSource = read("src/components/image/ImageEditor.vue");
const maskerSource = read("src/components/image/ImageMasker.vue");
const drawerSource = read("src/components/image/ImageSettingsDrawer.vue");
const explorerSource = read("src/components/common/FileExplorer.vue");
const listSource = read("src/components/common/FileList.vue");
const modelPanelSource = read("src/components/global/ModelManagementPanel.vue");
const modelRegistrySource = read("src/stores/modelRegistry.js");
const backendModelRegistrySource = read("server/moonshine_server/moonshine/model_registry.py");
const configSchemaSource = read("src/shared/appConfigSchema.js");
const configManagerSource = read("src/config/ConfigManager.js");

test("OCR entry lives in the image smart-selection toolbar", () => {
  assert.match(indexSource, /:ocr-available="ocrAvailable"/);
  assert.match(editorSource, /:ocr-available="ocrAvailable"/);
  assert.match(maskerSource, /data-testid="ocr-smart-selection-button"/);
  assert.match(maskerSource, /智能选区模型设置/);
  assert.doesNotMatch(drawerSource, /image-ocr-section|run-ocr|ocrModelId/);
  assert.doesNotMatch(explorerSource, /request-ocr-batch|ocr-available/);
  assert.doesNotMatch(listSource, /image-file-list-ocr-batch|批量 OCR|request-ocr-batch/);
});

test("OCR toolbar is capability-safe and reports unavailable state", () => {
  assert.match(indexSource, /const ocrCapabilities = ref\(\{/);
  assert.match(indexSource, /ocrCapabilities\.value\.status === "ready"/);
  assert.match(indexSource, /const requestOcr = async \(\) => \{/);
  assert.match(indexSource, /const samSelectionBusy = computed\(/);
  assert.match(indexSource, /if \(!ocrAvailable\.value \|\| ocrBusy\.value \|\| samSelectionBusy\.value\) return/);
  assert.match(maskerSource, /:disable="ocrBusy \|\| samProcessingState\.running \|\| !ocrAvailable \|\| !props\.samImage"/);
  assert.match(maskerSource, /ocrAvailable \? 'OCR 文本智能选区' : ocrStatusMessage/);
  assert.match(maskerSource, /v-if="ocrAvailable" class="sam-settings-hint">RapidOCR 已就绪/);
  assert.doesNotMatch(maskerSource, /ocrAvailable \? 'RapidOCR 已就绪' : ocrStatusMessage/);
});

test("OCR settings expose adjustable thresholds and optional SAM enhancement", () => {
  assert.match(maskerSource, /label="直接选中阈值"/);
  assert.match(maskerSource, /label="候选阈值"/);
  assert.match(maskerSource, /label="使用 SAM 增强文本蒙版"/);
  assert.match(maskerSource, /label="SAM 框选模型"/);
  assert.match(indexSource, /ocrConfidenceHigh/);
  assert.match(indexSource, /ocrConfidenceLow/);
  assert.match(indexSource, /persistOcrSettings/);
  assert.match(configSchemaSource, /ocrConfidenceHigh: 0\.9/);
  assert.match(configSchemaSource, /ocrConfidenceLow: 0\.8/);
  assert.match(configManagerSource, /ocrConfidenceLow > merged\.masking\.ocrConfidenceHigh/);
});

test("OCR recognition writes through the shared SAM candidate mask path", () => {
  assert.match(indexSource, /createOcrService\(api\)/);
  assert.match(indexSource, /buildOcrCandidates/);
  assert.match(indexSource, /appendExternalSamTextResult/);
  assert.match(indexSource, /loadingControl\?\.show/);
  assert.match(indexSource, /loadingControl\?\.hide/);
  assert.match(indexSource, /fileManagerStore\.updateFileMask\(file\.id, applied\.mask\)/);
  assert.match(maskerSource, /setSamCandidateEnabled/);
  assert.match(maskerSource, /removeSamCandidate/);
  assert.match(maskerSource, /candidate\.source \|\| "text"/);
  assert.match(maskerSource, /candidate\.label \|\| `智能选区候选/);
});

test("model management presents RapidOCR as one aggregated intelligent-selection model", () => {
  assert.match(modelRegistrySource, /ocrModels/);
  assert.match(modelRegistrySource, /installedOcrModels/);
  assert.match(backendModelRegistrySource, /ocr_rapid_onnx_mobile/);
  assert.match(modelPanelSource, /RapidOCR/);
  assert.match(modelPanelSource, /ocrModels/);
  assert.match(modelPanelSource, /v-if="model\.type !== 'ocr'"/);
});
