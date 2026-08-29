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
const mainLayoutSource = read("src/layouts/MainLayout.vue");
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

test("smart-selection model picker treats RapidOCR as a selectable model", () => {
  assert.match(indexSource, /const ocrModelOptions = computed\(\(\) =>/);
  assert.match(indexSource, /type: "ocr"/);
  assert.match(indexSource, /installedOcrModels/);
  assert.doesNotMatch(indexSource, /installedOcrModels[\s\S]*model\.ready !== false/);
  assert.match(maskerSource, /label="智能选区模型"/);
  assert.match(maskerSource, /selectedSmartModelIsOcr/);
  assert.match(maskerSource, /前往安装模型/);
  assert.match(editorSource, /update:smart-selection-model/);
});

test("smart-selection text actions survive model switching with explicit capability feedback", () => {
  assert.match(maskerSource, /v-if="!selectedSmartModelIsOcr"/);
  assert.match(maskerSource, /const samTextModelOption = computed\(\(\) =>/);
  assert.match(maskerSource, /const samTextSelectionAvailable = computed\(\(\) => Boolean\(samTextModelOption\.value\)\)/);
  assert.doesNotMatch(maskerSource, /未安装支持文本智选的 SAM 模型，以下检索按钮暂不可用/);
  assert.doesNotMatch(maskerSource, /当前模型不支持文本智选，检索时将使用 \{\{ samTextModelLabel \}\}/);
  assert.match(maskerSource, /samTextSelectionAvailable\.value &&/);
  assert.match(maskerSource, /return samTextModelOption\.value\?\.value \|\| props\.samTextModelId/);
  assert.match(maskerSource, /v-if="selectedSmartModelIsOcr \|\| selectedSamModelSupportsText"/);
  assert.match(maskerSource, /:disable="samPredicting \|\| samTextBatchRunning \|\| !props\.samImage \|\| !samTextSelectionAvailable"/);
});

test("RapidOCR exposes Apache-2.0 metadata", () => {
  assert.match(backendModelRegistrySource, /RAPIDOCR_LICENSE/);
  assert.match(backendModelRegistrySource, /https:\/\/github\.com\/RapidAI\/RapidOCR\/blob\/main\/LICENSE/);
  assert.match(backendModelRegistrySource, /"license": RAPIDOCR_LICENSE/);
  assert.match(read("server/moonshine_server/ocr_adapter.py"), /"license_id": "Apache-2\.0"/);
});

test("image preview and file toolbar preserve responsive cursor and controls", () => {
  assert.doesNotMatch(editorSource, /'cursor-none': isManualDrawingMode/);
  assert.match(maskerSource, /'cursor-none':/);
  assert.match(listSource, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(listSource, /@container file-list-toolbar \(max-width: 320px\)/);
  assert.match(listSource, /file-list-toolbar-button/);
});

test("image settings use consistent path copy across scopes", () => {
  assert.match(drawerSource, /<span>路径设置<\/span>/);
  assert.match(drawerSource, /label="输入路径"/);
  assert.match(drawerSource, /label="蒙版路径"/);
  assert.match(drawerSource, /输出路径/);
  assert.match(drawerSource, /打开输出路径/);
  assert.doesNotMatch(drawerSource, /文件夹设置|输入文件夹|蒙版文件夹|输出文件夹/);
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

test("OCR SAM enhancement uses one ordered batch request with stable prompt ids", () => {
  assert.match(indexSource, /predictSamMasksBatch/);
  assert.match(indexSource, /const samPrompts = \[\]/);
  assert.match(indexSource, /id: promptId, box, points: \[\]/);
  assert.match(indexSource, /candidateByPromptId = new Map/);
  assert.match(indexSource, /batchResult\?\.results/);
  assert.match(indexSource, /expectedPromptIds = new Set/);
  assert.match(indexSource, /new Set\(responsePromptIds\)\.size/);
  assert.match(indexSource, /expectedPromptIds\.has/);
  assert.match(indexSource, /批量增强失败，回退逐框处理/);
  assert.match(indexSource, /predictSamMask\(/);
});

test("SAM batch service keeps a separate endpoint and batch-wide multimask setting", () => {
  const serviceSource = read("src/services/SamPredictionService.js");
  assert.ok(serviceSource.includes('SAM_PREDICT_BATCH_PATH = "/api/v1/moonshine/sam/predict-batch"'));
  assert.match(serviceSource, /export const predictSamMasksBatch = async/);
  assert.match(serviceSource, /prompts = request\.prompts\.map/);
  assert.match(serviceSource, /multimask_output: request\.multimask_output/);
  assert.match(serviceSource, /api\.post\(SAM_PREDICT_BATCH_PATH/);
});

test("OCR and SAM batch commits are guarded against cancellation races", () => {
  assert.match(indexSource, /let smartSelectionBatchGeneration = 0/);
  assert.match(indexSource, /const isSmartSelectionBatchCurrent = \(generation\) =>/);
  assert.match(indexSource, /smartSelectionBatchGeneration \+= 1/);
  assert.match(indexSource, /commitGuard: \(\) =>[\s\S]{0,160}isSmartSelectionBatchCurrent\(batchGeneration\)/);
  assert.match(indexSource, /isSmartSelectionBatchCurrent\(batchGeneration\) && !samTextBatchCancelRequested\.value/);
  assert.match(indexSource, /applied\?\.cancelled \|\| !isSmartSelectionBatchCurrent\(batchGeneration\)/);
  assert.match(maskerSource, /commitGuard/);
  assert.match(maskerSource, /!canCommit\(\)/);
  assert.match(maskerSource, /samSessionByContext\.delete\(sessionKey\)/);
});

test("smart-selection batch targets and cleanup are image-only and failure-safe", () => {
  assert.match(indexSource, /const selectedSmartSelectionBatchFiles = computed\(\(\) =>[\s\S]*?const current = fileManagerStore\.currentFile[\s\S]*?return \[\.\.\.selected, current\]/);
  assert.match(indexSource, /const selectedSmartSelectionImageFiles = computed\(\(\) =>[\s\S]*?filter\(isImageFile\)/);
  assert.match(indexSource, /const selectedSamTextBatchFiles = computed\(\(\) =>[\s\S]*?selectedSmartSelectionImageFiles\.value/);
  assert.match(indexSource, /return selectedSmartSelectionBatchFiles\.value;/);
  assert.match(indexSource, /const imageFilesToProcess = filesToProcess\.filter\(\(file\) => isImageFile\(file\)\)/);
  assert.match(indexSource, /if \(imageFilesToProcess\.length > 0\) \{/);
  assert.match(indexSource, /status: cancelled \? "cancelled" : "failed"/);
  assert.match(indexSource, /message: cancelled \? "未开始处理" : message/);
  assert.match(indexSource, /const unprocessed = filesToProcess\.filter\(\(file\) => !processedFiles\.has\(file\)\);[\s\S]{0,500}completed \+= unprocessed\.length;/);
  assert.match(indexSource, /const unprocessed = filesToProcess\.filter\(\(item\) => !processedFiles\.has\(item\)\);[\s\S]{0,500}completed \+= unprocessed\.length;/);
  assert.ok((indexSource.match(/try \{\s*await cleanupPageProcessingInputs\(context\.chainInputPath\);\s*\} finally \{/g) || []).length >= 2);
  assert.ok((indexSource.match(/loadingControl\?\.hide\?\.\(\);[\s\S]{0,100}isPageDisabled\.value = false;/g) || []).length >= 2);
});

test("SAM and OCR candidates snapshot and independently edit the active brush style", () => {
  assert.match(maskerSource, /displayColor: normalizeSamDisplayColor\(candidate\?\.displayColor, getEffectiveMaskDisplayColor\(\)\)/);
  assert.match(maskerSource, /displayAlpha: normalizeSamDisplayAlpha\(candidate\?\.displayAlpha, getEffectiveMaskDisplayAlpha\(\)\)/);
  assert.ok((maskerSource.match(/displayColor: getEffectiveMaskDisplayColor\(\)/g) || []).length >= 3);
  assert.ok((maskerSource.match(/displayAlpha: getEffectiveMaskDisplayAlpha\(\)/g) || []).length >= 3);
  assert.match(maskerSource, /const getEffectiveMaskDisplayColor = \(\) =>[\s\S]*brushColor\.value/);
  assert.match(maskerSource, /const getEffectiveMaskDisplayAlpha = \(\) =>[\s\S]*brushAlpha\.value/);
  assert.match(maskerSource, /const setSamCandidateDisplayStyle = async/);
  assert.match(maskerSource, /@input="setSamCandidateDisplayStyle\(candidate\.localId, \{ color: \$event\.target\.value \}, \{ render: false \}\)"/);
  assert.match(maskerSource, /@update:model-value="setSamCandidateDisplayStyle\(candidate\.localId, \{ alpha: \$event \}, \{ render: false \}\)"/);
  assert.match(maskerSource, /@change="commitSamCandidateDisplayStyle\(candidate\.localId\)"/);
  assert.match(maskerSource, /class="sam-candidate-color-swatch"/);
  assert.match(maskerSource, /蒙版透明度/);
  assert.match(maskerSource, /normalizeSamCandidateMaskStyle[\s\S]*targetRed[\s\S]*targetGreen[\s\S]*targetBlue[\s\S]*targetAlpha/);
  assert.match(maskerSource, /renderMeta = \{[\s\S]*displayColor,[\s\S]*displayAlpha/);
});

test("OCR current and selected actions use the shared modelType/scope dispatcher", () => {
  assert.match(maskerSource, /smart-selection-request/);
  assert.match(maskerSource, /requestSmartSelectionAction\('ocr', 'current'\)/);
  assert.match(maskerSource, /selectedSmartModelIsOcr \? 'ocr' : 'sam'/);
  assert.match(maskerSource, /data-testid="sam-text-current-button"/);
  assert.match(maskerSource, /data-testid="sam-text-batch-button"/);
  assert.match(editorSource, /@smart-selection-request/);
  assert.match(editorSource, /"smart-selection-request"/);
  assert.match(indexSource, /const runSmartSelectionRequest = async/);
  assert.match(indexSource, /const runOcrBatchPrediction = async/);
  assert.match(indexSource, /modelType === "ocr"/);
  assert.match(indexSource, /scope === "selected"/);
  assert.match(indexSource, /recognizeOcrFile\(file, options\)/);
  assert.match(indexSource, /appendSmartSelectionBatchItem/);
  assert.match(indexSource, /status: "skipped"/);
  assert.match(indexSource, /status: "failed"/);
  assert.match(indexSource, /未发现文本区域/);
  assert.match(indexSource, /actionLabel:[\s\S]*取消/);
  assert.match(indexSource, /loadingControl\?\.hide/);
  assert.match(maskerSource, /const getOcrModelId = \(\) =>/);
  assert.match(maskerSource, /modelId: normalizedModelType === "sam" \? getTextModelId\(\) : getOcrModelId\(\)/);
});

test("OCR-only candidates bypass LaMa expansion while SAM candidates retain it", () => {
  assert.match(
    maskerSource,
    /const SAM_EXPANDABLE_CANDIDATE_SOURCES = new Set\(\["point", "box", "text", "ocr-sam"\]\)/
  );
  assert.match(maskerSource, /shouldAutoExpandSamCandidate\(candidate\)/);
  assert.match(maskerSource, /if \(!isSamCandidateExpansionEligible\(candidate\)\) \{[\s\S]*?autoExpandPx: 0,[\s\S]*?expandPx: 0,/);
  assert.match(maskerSource, /const autoExpand = shouldAutoExpandSamCandidate\(candidate\)/);
  assert.match(maskerSource, /v-if="shouldAutoExpandSamCandidate\(candidate\)"/);
});

test("smart-selection batch results use a bounded virtual scroll list", () => {
  assert.match(maskerSource, /<q-virtual-scroll[\s\S]*:items="samTextBatchItems"/);
  assert.match(maskerSource, /class="sam-batch-results"/);
  assert.match(maskerSource, /virtual-scroll-item-size="24"/);
  assert.match(maskerSource, /\.sam-batch-results[\s\S]*height:\s*120px/);
});

test("candidate delete and manual erase share the non-destructive erase layer", () => {
  assert.match(maskerSource, /icon="delete"/);
  assert.match(maskerSource, /color="negative"/);
  assert.match(maskerSource, /candidate\.eraseMask/);
  assert.match(maskerSource, /applySamEraseOperationToEnabledCandidates/);
  assert.match(maskerSource, /const hasSamCandidateLayer = \(\) =>[\s\S]*candidate\?\.enabled !== false/);
});

test("candidate and base-mask state is captured and restored with canvas history", () => {
  assert.match(maskerSource, /const captureSamHistoryState = \(\) => \(/);
  assert.match(maskerSource, /historySamStates\.value = \[\]/);
  assert.match(maskerSource, /historySamStates\.value\.push\(captureSamHistoryState\(\)\)/);
  assert.match(maskerSource, /const restoreSamHistoryState = \(state = null\) =>/);
  assert.match(maskerSource, /restoreSamHistoryState\(historySamStates\.value\[targetIndex\]\)/);
  assert.match(maskerSource, /baseSnapshotDataUrl: samBaseSnapshotDataUrl\.value/);
  assert.match(maskerSource, /candidates: cloneSamCandidates\(samCandidates\.value\)/);
  assert.match(maskerSource, /const redo = \(\) =>/);
  assert.match(maskerSource, /getNextMaskHistoryIndex/);
  assert.match(maskerSource, /:can-redo="canRedo"/);
  assert.doesNotMatch(maskerSource, /operationStartIndices\.value = operationStartIndices\.value\.filter\(\(index\) => index <= targetIndex\)/);
});

test("model management presents RapidOCR as one aggregated intelligent-selection model", () => {
  assert.match(modelRegistrySource, /ocrModels/);
  assert.match(modelRegistrySource, /installedOcrModels/);
  assert.match(backendModelRegistrySource, /ocr_rapid_onnx_mobile/);
  assert.match(modelPanelSource, /RapidOCR/);
  assert.match(modelPanelSource, /ocrModels/);
  assert.doesNotMatch(modelPanelSource, /v-if="model\.type !== 'ocr'"/);
  assert.match(modelPanelSource, /icon="verified"[\s\S]*label="校验"/);
  assert.match(modelPanelSource, /label="手动安装说明"/);
  assert.match(modelPanelSource, /outline[\s\S]*label="手动安装说明"/);
  assert.match(modelPanelSource, /icon="help_outline"/);
  assert.match(modelPanelSource, /aria-label="查看安装说明"/);
  assert.match(modelPanelSource, /<q-tooltip>安装说明<\/q-tooltip>/);
  assert.match(backendModelRegistrySource, /RAPIDOCR_MODEL_BASE_URL[\s\S]*huggingface\.co\/CuiMuxuan\/moonshine-models\/resolve\/main\/ocr\/rapidocr/);
  assert.match(backendModelRegistrySource, /"manualSources": \[[\s\S]*MANUAL_MODEL_SOURCE_URL/);
});

test("model verification distinguishes a missing model from a successful check", () => {
  assert.match(modelPanelSource, /未在模型路径检测到此模型/);
  assert.match(modelPanelSource, /const allFilesMissing = files\.length === 0 \|\| files\.every/);
  assert.match(modelPanelSource, /const modelMissing =\s*[\s\S]*allFilesMissing/);
  assert.match(modelPanelSource, /message: "校验成功"/);
});

test("global loading uses a visible breathing pulse with a reduced-motion variant", () => {
  assert.match(mainLayoutSource, /data-testid="global-loading-overlay"/);
  assert.match(mainLayoutSource, /data-testid="global-loading-pulse"/);
  assert.match(mainLayoutSource, /animation: global-loading-breathe/);
  assert.match(mainLayoutSource, /@keyframes global-loading-breathe/);
  assert.match(mainLayoutSource, /@keyframes global-loading-reduced-pulse/);
  assert.match(mainLayoutSource, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(
    mainLayoutSource,
    /@keyframes global-loading-breathe[\s\S]*?transform: scale\(0\.9\);[\s\S]*?50%[\s\S]*?transform: scale\(1\.1\);/
  );
  assert.match(
    mainLayoutSource,
    /animation: global-loading-breathe 2\.2s cubic-bezier\(0\.77, 0, 0\.175, 1\) infinite/
  );
  assert.match(
    mainLayoutSource,
    /\.global-loading-logo[\s\S]*?will-change: transform, opacity, filter/
  );
  assert.doesNotMatch(mainLayoutSource, /@keyframes global-loading-pulse/);
  assert.match(mainLayoutSource, /filter: drop-shadow\(0 6px 14px/);
});
