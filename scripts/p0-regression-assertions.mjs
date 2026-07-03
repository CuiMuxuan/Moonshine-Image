import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function readText(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  return fs.readFileSync(absolutePath, "utf8");
}

function findPatternIndex(content, pattern, fromIndex = 0) {
  if (typeof pattern === "string") {
    return content.indexOf(pattern, fromIndex);
  }

  if (!(pattern instanceof RegExp)) {
    throw new Error(`Unsupported pattern type: ${String(pattern)}`);
  }

  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  regex.lastIndex = fromIndex;
  const match = regex.exec(content);
  return match ? match.index : -1;
}

function assertPattern({ file, description, pattern }) {
  const content = readText(file);
  const ok = pattern instanceof RegExp ? pattern.test(content) : content.includes(pattern);
  if (!ok) {
    throw new Error(`Assertion failed: ${description}\nFile: ${file}`);
  }
  console.log(`PASS  ${description}`);
}

function assertAbsentPattern({ file, description, pattern }) {
  const content = readText(file);
  const ok = pattern instanceof RegExp ? !pattern.test(content) : !content.includes(pattern);
  if (!ok) {
    throw new Error(`Assertion failed: ${description}\nFile: ${file}`);
  }
  console.log(`PASS  ${description}`);
}

function assertPatternOrder({ file, description, patterns }) {
  const content = readText(file);
  let cursor = 0;
  for (const pattern of patterns) {
    const index = findPatternIndex(content, pattern, cursor);
    if (index < 0) {
      throw new Error(`Assertion failed: ${description}\nFile: ${file}`);
    }
    cursor = index + 1;
  }
  console.log(`PASS  ${description}`);
}

function logSection(title) {
  console.log(`\n[${title}]`);
}

function runAssertions() {
  console.log("Running P0 regression assertions...");

  logSection("Video Workflow");

  assertPattern({
    file: "src/components/video/ResourceManage.vue",
    description: "Video resource tab keeps runtime tab alias mapping",
    pattern: /if\s*\(value\s*===\s*"masks"\)\s*return\s*"runtime";/,
  });
  assertPattern({
    file: "src/components/video/ResourceManage.vue",
    description: "Video resource panel supports SLBR processing ranges list",
    pattern: /videoStore\.processingRanges/,
  });
  assertPattern({
    file: "src/stores/videoManager.js",
    description: "Video store keeps independent processingRanges state",
    pattern: /const processingRanges = ref\(\[\]\);/,
  });
  assertPattern({
    file: "src/stores/videoManager.js",
    description: "Video snapshot captures processingRanges",
    pattern: /processingRanges:\s*processingRanges\.value\.map\(cloneProcessingRange\),/,
  });
  assertPattern({
    file: "src/stores/videoManager.js",
    description: "Video snapshot restore applies processingRanges",
    pattern: /processingRanges\.value = \(snapshot\.processingRanges \|\| \[\]\)\.map\(/,
  });
  assertPattern({
    file: "src/stores/videoManager.js",
    description: "Video snapshot restore applies currentTime",
    pattern: /currentTime\.value = clamp\(Number\(snapshot\.currentTime \|\| 0\), 0, duration\);/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video page includes SLBR frame filtering function",
    pattern: /const shouldProcessFrameWithSlbr = \(\{[\s\S]*ranges[\s\S]*\}\) =>/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video page passes model_id to backend request",
    pattern: /model_id:\s*requestedModelId/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video page uses processing ranges only for SLBR",
    pattern: /requestedModelId\s*===\s*"slbr"\s*\?\s*getEnabledProcessingRanges\(\)\s*:\s*\[\]/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video page restores model from shared/ui state",
    pattern: /const restoredModel = String\(sharedModel \|\| uiState\.currentModel \|\| ""\)\.trim\(\);/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video page syncs timeline cursor from restored playback time",
    pattern: /timelineRef\.value\.setTime\(videoStore\.currentTime \|\| 0\);/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video SLBR pipeline skips backend frames outside selected ranges",
    pattern: /if \(modelId === "slbr" && !shouldProcessFrame\)/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video page persists UI state with shared capture helper",
    pattern: /const persistVideoUiStateToAppState = \(\) => \{\s*appStateStore\.saveUIState\("video", captureVideoUiState\(\)\);\s*\};/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video page supports configurable FFmpeg fallback when WebAV export fails",
    pattern: /getConfiguredVideoProcessingEngine[\s\S]*runWithVideoProcessingEngine[\s\S]*WebAV 失败，正在切换 FFmpeg 兜底[\s\S]*exportProcessedBatchSegmentWithFfmpeg[\s\S]*finalizeProcessedVideoWithFfmpeg/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron exposes a shared disk-space guard before large local writes",
    pattern: /(?=[\s\S]*DEFAULT_DISK_SPACE_SAFETY_BYTES)(?=[\s\S]*function ensureDiskSpace\(targetPath, payload = \{\}\))(?=[\s\S]*ipcMain\.handle\("ensure-disk-space")(?=[\s\S]*ipcMain\.handle\("check-disk-space")(?=[\s\S]*saveFileHandler[\s\S]*ensureDiskSpace)(?=[\s\S]*open-file-write-stream[\s\S]*ensureDiskSpace)(?=[\s\S]*save-temp-video[\s\S]*ensureDiskSpace)[\s\S]*/,
  });
  assertPattern({
    file: "src-electron/electron-preload.js",
    description: "Preload direct file writes preflight disk space through the main process",
    pattern: /(?=[\s\S]*const getByteLength = \(value\) =>)(?=[\s\S]*writeFile: async \(filePath, data, options = \{\}\) =>)(?=[\s\S]*ipcRenderer\.invoke\("ensure-disk-space")(?=[\s\S]*writeFileBase64: async \(filePath, base64Content, options = \{\}\) =>)[\s\S]*/,
  });
  assertPattern({
    file: "src/services/ErrorClassifier.js",
    description: "Frontend classifies disk-space failures as user-facing disk-space errors",
    pattern: /(?=[\s\S]*status === 507)(?=[\s\S]*磁盘空间不足)(?=[\s\S]*insufficient-disk-space)[\s\S]*/,
  });
  assertPattern({
    file: "server/moonshine_server/disk_space.py",
    description: "Backend exposes a shared disk-space guard for large writes",
    pattern: /(?=[\s\S]*DEFAULT_DISK_SPACE_SAFETY_BYTES)(?=[\s\S]*class DiskSpaceError)(?=[\s\S]*def ensure_disk_space\()(?=[\s\S]*shutil\.disk_usage)(?=[\s\S]*磁盘空间不足)[\s\S]*/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/model_registry.py",
    description: "Model downloads preflight disk space before and during large model writes",
    pattern: /(?=[\s\S]*from moonshine_server\.disk_space import DEFAULT_DISK_SPACE_SAFETY_BYTES, ensure_disk_space)(?=[\s\S]*estimated_size = int\(file_spec\.get\("size"\) or 0\))(?=[\s\S]*operation="下载模型文件")(?=[\s\S]*part_path\.open\("wb"\))(?=[\s\S]*output\.write\(chunk\))[\s\S]*/,
  });
  assertPattern({
    file: "src/stores/videoManager.js",
    description: "Video store has a dedicated SAM video mask track type",
    pattern: /SAM_VIDEO:\s*"samVideo"[\s\S]*createSamVideoMaskTrack[\s\S]*setSamVideoObjectEnabled[\s\S]*removeSamVideoObject/,
  });
  assertPattern({
    file: "src/stores/videoManager.js",
    description: "SAM video tracks are locked from manual range and keyframe edits",
    pattern: /(?=[\s\S]*sam-video-track-locked)(?=[\s\S]*时间范围由 SAM2\.1 传播结果决定)(?=[\s\S]*SAM 视频轨道不支持手动关键帧编辑)/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "SAM2 propagation polls real-progress jobs and writes bidirectional results back into the selected SAM video track",
    pattern: /(?=[\s\S]*runSamVideoSelectionFromMaskList[\s\S]*createEmptySamVideoMaskTrack)(?=[\s\S]*const targetMaskId = videoStore\.selectedMaskId)(?=[\s\S]*runSamVideoPropagationJob[\s\S]*reverse: false)(?=[\s\S]*runSamVideoPropagationJob[\s\S]*reverse: true)(?=[\s\S]*getSamVideoPropagationJobResult)(?=[\s\S]*updateSamVideoMaskTrackResult\(targetMaskId, result\))(?=[\s\S]*SAM2\.1 已更新)/,
  });
  assertPattern({
    file: "src/components/video/ResourceManage.vue",
    description: "Video resource list keeps SAM video tracks at track-level controls only",
    pattern: /(?=[\s\S]*mask\.type === 'samVideo'[\s\S]*SAM)(?=[\s\S]*emit\('remove-mask', mask\.id\))[\s\S]*/,
  });
  assertAbsentPattern({
    file: "src/components/video/ResourceManage.vue",
    description: "Video resource list does not expose SAM object checkbox or object delete controls",
    pattern: /setSamVideoObjectEnabled|remove-sam-video-object|sam-object-list/,
  });

  logSection("Image Workflow");

  assertPatternOrder({
    file: "src/pages/IndexPage.vue",
    description: "Image page validates backend paths before model dispatch",
    patterns: [
      /const backendPathValidation = await validateBackendPathsForConfig\(/,
      /switch\s*\(currentModel\.value\)\s*\{/,
    ],
  });
  assertPattern({
    file: "src/shared/samLexiconDefaults.js",
    description: "SAM3 lexicon defaults use separate color and noun dictionaries",
    pattern: /DEFAULT_SAM3_COLOR_TERMS[\s\S]*DEFAULT_SAM3_NOUN_TERMS[\s\S]*createDefaultSam3Lexicon/,
  });
  assertPattern({
    file: "src/services/SamLexiconService.js",
    description: "SAM3 lexicon prompt builder supports manual, color-only, noun-only, and composed prompts",
    pattern: /(?=[\s\S]*buildSam3LexiconPrompt)(?=[\s\S]*source: "manual")(?=[\s\S]*lexicon-color)(?=[\s\S]*lexicon-noun)(?=[\s\S]*lexicon-composed)/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image smart selection has SAM3 color and noun selectors",
    pattern: /samTextColor[\s\S]*samTextNoun[\s\S]*samGeneratedPromptText/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "SAM3 batch text search forwards lexicon source metadata",
    pattern: /promptSource = "manual"[\s\S]*promptColor = null[\s\S]*promptNoun = null[\s\S]*predictSamText\(\{[\s\S]*promptSource[\s\S]*promptColor[\s\S]*promptNoun/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page keeps Lama, MAT and SLBR model dispatch branches",
    pattern: /switch\s*\(currentModel\.value\)\s*\{[\s\S]*case\s*"lama":[\s\S]*case\s*"mat":[\s\S]*runRemoveModel\(\);[\s\S]*case\s*"slbr":[\s\S]*runSlbrModel\(\);/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image SLBR single-run request carries model_id",
    pattern: /requestData\.model_id = "slbr";/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image SLBR single-run request carries model options",
    pattern: /requestData\.options = getCurrentModelOptions\(\);/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image SLBR folder-run request carries model_id and options",
    pattern: /const folderData = \{[\s\S]*model_id:\s*"slbr",[\s\S]*options:\s*getCurrentModelOptions\(\),/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page subscribes to global model switch event",
    pattern: /window\.addEventListener\("moonshine-switch-model", handleGlobalModelSwitch\);/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page unsubscribes from global model switch event",
    pattern: /window\.removeEventListener\("moonshine-switch-model", handleGlobalModelSwitch\);/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page reads and writes shared current model",
    pattern: /getSharedCurrentModel[\s\S]*setSharedCurrentModel/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page preserves mask toolbar preference across non-mask model switches",
    pattern: /const maskToolsPreferredVisible = ref\(true\);[\s\S]*const rememberMaskToolsPreference = \(\) => \{[\s\S]*maskToolsPreferredVisible\.value = Boolean\(showMaskTools\.value\);[\s\S]*showMaskTools\.value = maskToolsPreferredVisible\.value;/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page hides unsupported mask tools without overwriting drawing preference",
    pattern: /if \(!modelSupportsMaskTools\(metadata\)\) \{[\s\S]*showMaskTools\.value = false;[\s\S]*setMaskDrawingMode\(false, \{ persist: false \}\);/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page captures preferred drawing mode instead of temporary disabled state",
    pattern: /const captureMaskUiState = \(\) => \(\{[\s\S]*showMaskTools: maskToolsPreferredVisible\.value,[\s\S]*drawingMode: runtimeUiStore\.imageMaskDrawingEnabled,/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page syncs managed output path before the settings drawer first renders",
    pattern: /onMounted\(async \(\) => \{[\s\S]*await configStore\.loadConfig\(\);[\s\S]*if \(configStore\.config\.fileManagement\) \{[\s\S]*syncManagedImageOutputPath\(configStore\.config\.fileManagement\);[\s\S]*runtimeUiStore\.ensureImageMaskToolState/,
  });
  assertPattern({
    file: "src/services/ImageProcessingService.js",
    description: "Moonshine image request validator enforces model_id",
    pattern: /if \(!requestData\.model_id\) \{\s*throw new Error\('.*model_id.*'\);\s*\}/,
  });
  assertPatternOrder({
    file: "src/services/ImageProcessingService.js",
    description: "Moonshine image API call validates request payload before POST",
    patterns: [
      /validateMoonshineImageRequestData\(requestData\);/,
      /api\.post\('\/api\/v1\/moonshine\/image\/process', requestData/,
    ],
  });

  logSection("Global Config & Backend Management");

  assertPatternOrder({
    file: "src/components/global/GlobalSettings.vue",
    description: "Global settings validates model directory before assignment",
    patterns: [
      /const selectModelPath = async \(\) => \{/,
      /const validation = await validateBackendPaths\(\{/,
      /localConfig\.value\.general\.modelDir = value;/,
    ],
  });
  assertPatternOrder({
    file: "src/components/global/GlobalSettings.vue",
    description: "Global settings validates backend project path before project check",
    patterns: [
      /const selectBackendProjectPath = async \(\) => \{/,
      /const validation = await validateBackendPaths\(\{/,
      /const checkResult = await window\.electron\.ipcRenderer\.invoke\("check-project", value\);/,
    ],
  });
  assertPatternOrder({
    file: "src/components/global/GlobalSettings.vue",
    description: "Global settings validates backend-related paths before persisting config",
    patterns: [
      /const backendPathValidation = await validateBackendPaths\(\{/,
      /const storeResult = await configStore\.persistConfig\(serializableConfig\);/,
    ],
  });
  assertPattern({
    file: "src/components/global/BackendManager.vue",
    description: "Backend manager has a centralized backend path guard",
    pattern: /const ensureBackendPathsValid = async \(\{[\s\S]*const validation = await validateBackendPaths\(\{/,
  });
  assertPatternOrder({
    file: "src/components/global/BackendManager.vue",
    description: "Backend manager checks backend paths before environment diagnosis",
    patterns: [
      /const checkEnvironment = async \(\) => \{/,
      /const pathsValid = await ensureBackendPathsValid\(\{\}\);/,
      /if \(!pathsValid\) \{/,
    ],
  });
  assertPatternOrder({
    file: "src/components/global/BackendManager.vue",
    description: "Backend manager checks backend paths before starting service",
    patterns: [
      /const startService = async \(\) => \{/,
      /const pathsValid = await ensureBackendPathsValid\(\{/,
      /if \(!pathsValid\) \{/,
      /window\.electron\.ipcRenderer\.invoke\(\s*"start-backend-service",/,
    ],
  });
  assertPatternOrder({
    file: "src/layouts/MainLayout.vue",
    description: "Main layout validates backend paths before silent auto-start checks",
    patterns: [
      /const backendPathValidation = await validateBackendPathsForConfig\(/,
      /if \(!backendPathValidation\.valid\) \{/,
      /const processStatus = await invoke\("check-backend-status"\);/,
    ],
  });
  assertPattern({
    file: "src/layouts/MainLayout.vue",
    description: "Main layout defers backend-path blocked dialog when startup overlay is active",
    pattern: /const queueBackendPathBlockedDialog = \(validationResult = null\) => \{[\s\S]*if \(showStartupOverlay\.value\) \{[\s\S]*pendingBackendPathDialog\.value = validationResult \|\| \{\};/,
  });
  assertPattern({
    file: "src/layouts/MainLayout.vue",
    description: "Main layout flushes deferred backend-path dialog after startup overlay",
    pattern: /const handleStartupOverlayFinished = \(\) => \{\s*flushPendingBackendPathDialog\(\);\s*\};/,
  });

  logSection("Config & Shared State Contracts");

  assertPattern({
    file: "src/shared/appConfigSchema.js",
    description: "Shared config schema defaults keep backendProjectPath + modelDir",
    pattern: /general:\s*\{[\s\S]*modelDir:\s*""[\s\S]*backendProjectPath:\s*""/,
  });
  assertPattern({
    file: "src/shared/appConfigSchema.js",
    description: "Config default brush color stays at #8a71d4",
    pattern: /export const DEFAULT_IMAGE_BRUSH = Object\.freeze\(\{[\s\S]*color:\s*"#8a71d4",/,
  });
  assertPattern({
    file: "src/shared/appConfigSchema.js",
    description: "Video default brush color inherits image brush color",
    pattern: /export const DEFAULT_VIDEO_BRUSH = Object\.freeze\(\{[\s\S]*color:\s*DEFAULT_IMAGE_BRUSH\.color,/,
  });
  assertPattern({
    file: "src/shared/appConfigSchema.js",
    description: "Shared config schema owns versioned migration and removes unknown legacy fields",
    pattern: /export const CONFIG_SCHEMA_VERSION[\s\S]*alignConfigWithDefaultSchema[\s\S]*migrateLegacyConfigShape[\s\S]*needsConfigMigration/,
  });
  assertPattern({
    file: "src/shared/appConfigSchema.js",
    description: "Shared config schema owns video processing engine defaults",
    pattern: /VIDEO_PROCESSING_ENGINE_OPTIONS = Object\.freeze\(\["auto", "webav", "ffmpeg"\]\)[\s\S]*videoProcessingEngine:\s*"auto"/,
  });
  assertPattern({
    file: "src/shared/appConfigSchema.js",
    description: "Shared config schema owns SAM render cache defaults",
    pattern: /CONFIG_SCHEMA_VERSION = 8[\s\S]*DEFAULT_MASKING_CONFIG[\s\S]*samRenderCacheEnabled:\s*true[\s\S]*samRenderCacheMaxContexts:\s*12[\s\S]*samRenderCacheMaxMemoryMb:\s*192[\s\S]*samRenderCacheLargeImageLongSide:\s*4096[\s\S]*samLazyRenderDisabledCandidates:\s*true[\s\S]*samRenderCachePreloadVisibleList:\s*true[\s\S]*samRenderCacheNeighborPreloadCount:\s*4/,
  });
  assertPattern({
    file: "src/config/ConfigManager.js",
    description: "Frontend config manager uses shared default config instead of a local default tree",
    pattern: /from "src\/shared\/appConfigSchema"[\s\S]*static defaultConfig = DEFAULT_APP_CONFIG;/,
  });
  assertPattern({
    file: "src/config/ConfigManager.js",
    description: "Frontend config manager validates and normalizes video processing engine",
    pattern: /VIDEO_PROCESSING_ENGINE_OPTIONS[\s\S]*视频处理引擎必须是 auto、webav 或 ffmpeg[\s\S]*videoProcessingEngine:\s*VIDEO_PROCESSING_ENGINE_OPTIONS\.includes/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron config uses shared schema and migrates older config files on load",
    pattern: /from "\.\.\/src\/shared\/appConfigSchema\.js"[\s\S]*needsConfigMigration\(configData\)[\s\S]*fs\.writeFileSync\(configPath, JSON\.stringify\(sanitizedConfig, null, 2\)\)/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron config validates and sanitizes video processing engine",
    pattern: /VIDEO_PROCESSING_ENGINE_OPTIONS[\s\S]*merged\.advanced\.videoProcessingEngine = VIDEO_PROCESSING_ENGINE_OPTIONS\.includes[\s\S]*!VIDEO_PROCESSING_ENGINE_OPTIONS\.includes\(config\.advanced\.videoProcessingEngine\)/,
  });
  assertPattern({
    file: "src/shared/appConfigSchema.js",
    description: "Removed advanced config fields are absent from the shared schema",
    pattern: /^((?!maxConcurrentTasks|enableDebugMode|logLevel).)*$/s,
  });
  assertPattern({
    file: "src/config/ConfigManager.js",
    description: "Config merge keeps modelDir normalization logic",
    pattern: /modelDir:\s*normalizeModelDir\(merged\.general\?\.modelDir\)\s*\|\|\s*this\.defaultConfig\.general\.modelDir/,
  });
  assertPattern({
    file: "src/config/ConfigManager.js",
    description: "Config manager validates and normalizes SAM render cache settings",
    pattern: /SAM 渲染缓存图片数量[\s\S]*SAM 渲染缓存内存上限[\s\S]*SAM 渲染缓存大图长边阈值[\s\S]*SAM 相邻图片预热数量[\s\S]*samRenderCacheEnabled:\s*normalizeBoolean[\s\S]*samRenderCacheMaxContexts:\s*normalizeInteger[\s\S]*samRenderCacheNeighborPreloadCount:\s*normalizeInteger/,
  });
  assertPattern({
    file: "src/components/global/GlobalSettings.vue",
    description: "Global settings exposes SAM smart selection render cache controls in image processing settings",
    pattern: /智能选区渲染缓存[\s\S]*global-settings-sam-render-cache-enabled[\s\S]*global-settings-sam-lazy-render-disabled-candidates[\s\S]*global-settings-sam-preload-visible-list[\s\S]*global-settings-sam-render-cache-max-contexts[\s\S]*global-settings-sam-neighbor-preload-count/,
  });
  assertPattern({
    file: "src/stores/appState.js",
    description: "App state includes shared current model normalization",
    pattern: /const SHARED_MODEL_IDS = \["lama", "mat", "slbr"\];/,
  });
  assertPattern({
    file: "src/stores/appState.js",
    description: "App state exposes shared current model getters/setters",
    pattern: /setSharedCurrentModel[\s\S]*getSharedCurrentModel/,
  });

  logSection("Backend Path Validation Guards");

  assertPattern({
    file: "src/utils/backendPathValidation.js",
    description: "Frontend path validation helper is present",
    pattern: /export const validateBackendPathsForConfig/,
  });
  assertPattern({
    file: "src/utils/backendPathValidation.js",
    description: "Frontend path selection blocked message includes current and selected paths",
    pattern: /currentBackendProjectPath[\s\S]*selectedBackendProjectPath[\s\S]*selectedModelDir/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron main keeps CJK path detection pattern",
    pattern: /const CJK_PATH_PATTERN = \/\[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\]\/u;/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron main validates backend project/model paths for CJK",
    pattern: /if \(normalized\.backendProjectPath && containsCjkCharacter\(normalized\.backendProjectPath\)\)[\s\S]*if \(normalized\.modelDir && containsCjkCharacter\(normalized\.modelDir\)\)/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron main exposes validate-backend-paths IPC",
    pattern: /ipcMain\.handle\("validate-backend-paths", async \(event, input = \{\}\) => \{\s*return buildBackendPathValidationResult\(input \|\| \{\}\);\s*\}\);/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron main checks backend paths before project verification",
    pattern: /ipcMain\.handle\("check-project"[\s\S]*buildBackendPathValidationResult\(\{[\s\S]*backendProjectPath: selectPath \|\| global\.projectPath \|\| "",/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron main checks backend paths before project path switch",
    pattern: /ipcMain\.handle\("set-project-path"[\s\S]*buildBackendPathValidationResult\(\{[\s\S]*backendProjectPath: normalizedPath,/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron main checks backend paths before service startup",
    pattern: /ipcMain\.handle\("start-backend-service"[\s\S]*buildBackendPathValidationResult\(\{[\s\S]*backendProjectPath: global\.projectPath,/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Packaged backend startup honors the configured model directory before falling back to bundled models",
    pattern: /function resolveEffectiveModelDir\(input = \{\}\)[\s\S]*const configuredModelDir = String\(modelDir \|\| ""\)\.trim\(\);[\s\S]*return configuredModelDir \|\| getEffectiveBundledModelDir\(\);[\s\S]*if \(isBundledBackendMode\(global\.projectPath\)\)[\s\S]*const effectiveModelDir = resolveEffectiveModelDir\(\{[\s\S]*modelDir: config\?\.modelDir \|\| "",[\s\S]*args\.push\(`--model-dir=\$\{effectiveModelDir\}`\)/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Bundled runtime preparation skips relocation only after Python and backend dependencies are usable",
    pattern: /async function verifyBundledPythonRuntime\(options = \{\}\)[\s\S]*const checkDependencies = options\.checkDependencies === true;[\s\S]*import fastapi,uvicorn,numpy,PIL,torch,transformers[\s\S]*const existingRuntime = await verifyBundledPythonRuntime\(\{[\s\S]*checkDependencies: true,[\s\S]*Bundled Python runtime is already usable\. Refreshing runtime state/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Bundled runtime relocation warnings are downgraded only when the verified runtime is still usable",
    pattern: /catch \(error\) \{[\s\S]*const fallbackRuntime = await verifyBundledPythonRuntime\(\{[\s\S]*checkDependencies: true,[\s\S]*Bundled runtime relocation reported a warning, but Python is usable/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron main probes backend port availability before service startup",
    pattern: /function isBackendPortAvailable\(port[\s\S]*nodeNet\.createServer\(\)[\s\S]*probe\.listen\(port, host\);/,
  });
  assertPatternOrder({
    file: "src-electron/electron-main.js",
    description: "Electron main resolves an available backend port before spawning backend",
    patterns: [
      /const portResolution = await resolveAvailableBackendPort\(config\?\.port\);/,
      /`--port=\$\{portResolution\.port\}`/,
      /backendProcess = spawn\(backendPython, args,/,
      /backendServicePort = portResolution\.port;/,
    ],
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Backend startup returns the actual runtime port",
    pattern: /return \{[\s\S]*success: true,[\s\S]*port: portResolution\.port,[\s\S]*requestedPort: portResolution\.requestedPort,[\s\S]*portChanged: portResolution\.portChanged,/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Backend status reports the current runtime port",
    pattern: /ipcMain\.handle\("check-backend-status"[\s\S]*port: backendServicePort,/,
  });
  assertPatternOrder({
    file: "src/layouts/MainLayout.vue",
    description: "Silent backend auto-start syncs actual backend port before health checks",
    patterns: [
      /const startResult = await invoke\("start-backend-service",/,
      /await syncBackendRuntimePort\(startResult\.port \|\| generalConfig\.backendPort \|\| 8080\);/,
      /backendEngineStore\.setPhase\("verifying"\);/,
      /reachable = await checkBackendStatus\(\{ notifyOnFailure: false \}\);/,
    ],
  });
  assertPatternOrder({
    file: "src/components/global/BackendManager.vue",
    description: "Backend manager syncs and displays the actual runtime port after manual start",
    patterns: [
      /const result = await window\.electron\.ipcRenderer\.invoke\(/,
      /const actualPort = Number\(result\.port \|\| backendConfig\.port\);/,
      /await syncRuntimeBackendPort\(actualPort\);/,
      /后端服务启动成功，端口: \$\{actualPort\}/,
      /已更新前端 API 端口配置为: \$\{actualPort\}/,
    ],
  });
  assertPattern({
    file: "server/moonshine_server/api.py",
    description: "CUDA health API reports PyTorch CUDA, NVIDIA driver, nvcc, and user notification diagnostics",
    pattern: /(?=[\s\S]*def _get_nvidia_driver_info\(self\))(?=[\s\S]*nvidia-smi)(?=[\s\S]*def _get_nvcc_info\(self\))(?=[\s\S]*nvcc)(?=[\s\S]*torch_package)(?=[\s\S]*torch_cuda_version)(?=[\s\S]*torch_cuda_available)(?=[\s\S]*diagnostic_code)(?=[\s\S]*notification_links)(?=[\s\S]*https:\/\/pytorch\.org\/get-started\/locally\/)(?=[\s\S]*https:\/\/www\.nvidia\.com\/en-us\/drivers\/)[\s\S]*/,
  });
  assertPattern({
    file: "src/layouts/MainLayout.vue",
    description: "Frontend shows CUDA diagnostic notifications once per backend startup and keeps CPU package silent",
    pattern: /(?=[\s\S]*cudaDiagnosticNotificationKey)(?=[\s\S]*backendSessionStartedAt)(?=[\s\S]*useRuntimeDiagnosticsStore)(?=[\s\S]*getBackendSessionKey)(?=[\s\S]*refreshCudaDiagnostics)(?=[\s\S]*getCudaStatusMatchesSession\(sessionKey\))(?=[\s\S]*runtimeDiagnosticsStore\.setCudaStatus\(cudaInfo, sessionKey\))(?=[\s\S]*maybeNotifyCudaDiagnostic)(?=[\s\S]*torch_package === "cpu")(?=[\s\S]*notification_links)(?=[\s\S]*openExternalUrl)(?=[\s\S]*maybeNotifyCudaDiagnostic\(cudaInfo\))[\s\S]*/,
  });
  assertPattern({
    file: "src/components/common/CudaStatus.vue",
    description: "CUDA status menu displays runtime package, PyTorch CUDA, NVIDIA driver, and nvcc details",
    pattern: /(?=[\s\S]*useRuntimeDiagnosticsStore)(?=[\s\S]*inject\("runtimeDiagnostics")(?=[\s\S]*refreshCudaStatus)(?=[\s\S]*runtimeDiagnostics\.refreshCudaDiagnostics\(\{ force: true, notify: true \}\))(?=[\s\S]*CPU 运行包)(?=[\s\S]*statusBadgeColor)(?=[\s\S]*grey-7)(?=[\s\S]*PyTorch CUDA)(?=[\s\S]*NVIDIA 驱动)(?=[\s\S]*CUDA Toolkit)(?=[\s\S]*torch_cuda_available)(?=[\s\S]*nvidia_driver_available)(?=[\s\S]*nvcc_available)[\s\S]*/,
  });
  assertPattern({
    file: "src/stores/runtimeDiagnostics.js",
    description: "Runtime diagnostics cache CUDA by backend session key instead of a short TTL",
    pattern: /(?=[\s\S]*sessionKey)(?=[\s\S]*getCudaStatusMatchesSession)(?![\s\S]*CUDA_STATUS_TTL_MS)(?![\s\S]*cudaStatusFresh)[\s\S]*/,
  });

  logSection("Backend API Contracts");

  assertPattern({
    file: "server/moonshine_server/schema.py",
    description: "Video batch frame item keeps optional mask_path",
    pattern: /mask_path:\s*Optional\[str\]\s*=\s*None/,
  });
  assertPattern({
    file: "server/moonshine_server/schema.py",
    description: "Mask-inpaint video requests require mask_path for LaMa and MAT",
    pattern: /if values\.model_id in \{"lama", "mat"\}:[\s\S]*mask_path is required when model_id is lama or mat[\s\S]*values\.model_id not in \{"lama", "mat", "slbr"\}/,
  });
  assertPattern({
    file: "server/moonshine_server/schema.py",
    description: "Schema exposes SLBR tile options for model options",
    pattern: /tile_size:\s*int\s*=\s*Field\(384,\s*ge=1\)[\s\S]*tile_batch:\s*int\s*=\s*Field\(4,\s*ge=1,\s*le=32\)/,
  });
  assertPattern({
    file: "server/moonshine_server/api.py",
    description: "Backend video batch API has slbr branch",
    pattern: /if model_id == "slbr":[\s\S]*infer_bgr\(/,
  });
  assertPattern({
    file: "server/moonshine_server/api.py",
    description: "Backend API normalizes tile options before SLBR inference",
    pattern: /slbr_options = self\._normalize_moonshine_options\(req\.options\.model_options\)/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/model_registry.py",
    description: "Model registry normalizes capability scores on a 10-point decimal scale",
    pattern: /round\(max\(0\.0,\s*min\(10\.0,\s*value\)\),\s*1\)/,
  });

  logSection("Fullscreen Drawing Guards");

  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Fullscreen toolbar toggle can be disabled by model capability",
    pattern: /fullscreenDrawingToolbarToggleDisabled/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Fullscreen toolbar default placement function exists",
    pattern: /const placeFullscreenDrawingToolbarToDefault = async \(\) =>/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video page reads shared current model during restore/load",
    pattern: /getSharedCurrentModel/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page syncs shared current model",
    pattern: /setSharedCurrentModel/,
  });

  logSection("E2E Hooks");

  assertPattern({
    file: "src/layouts/MainLayout.vue",
    description: "Main layout exposes global settings trigger test id",
    pattern: /data-testid="open-global-settings-button"/,
  });
  assertPattern({
    file: "src/components/global/MainToolbar.vue",
    description: "Main toolbar exposes image/video route and theme toggle test ids",
    pattern: /data-testid="nav-image-button"[\s\S]*data-testid="nav-video-button"[\s\S]*data-testid="toggle-theme-button"/,
  });
  assertPattern({
    file: "src/components/global/GlobalSettings.vue",
    description: "Global settings exposes backend tab, backend port and save button test ids",
    pattern: /data-testid="global-settings-tab-backend"[\s\S]*data-testid="global-settings-backend-port"[\s\S]*data-testid="global-settings-save-button"/,
  });
  assertPattern({
    file: "src/components/global/GlobalSettings.vue",
    description: "Global settings exposes temp cleanup controls and video failure retention in file management",
    pattern: /data-testid="global-settings-tab-files"[\s\S]*data-testid="global-settings-cleanup-temp-files-button"[\s\S]*data-testid="global-settings-temp-cleanup-enabled"[\s\S]*data-testid="global-settings-temp-cleanup-max-age-days"[\s\S]*data-testid="global-settings-video-failure-retention-count"/,
  });
  assertPattern({
    file: "src/components/global/GlobalSettings.vue",
    description: "Global settings exposes video processing engine selector",
    pattern: /v-model="localConfig\.advanced\.videoProcessingEngine"[\s\S]*data-testid="global-settings-video-processing-engine"[\s\S]*videoProcessingEngineOptions/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron exposes FFmpeg runtime and video export IPC",
    pattern: /ipcMain\.handle\("check-ffmpeg-runtime"[\s\S]*ipcMain\.handle\("ffprobe-media"[\s\S]*ipcMain\.handle\("ffmpeg-encode-frame-sequence"[\s\S]*ipcMain\.handle\("ffmpeg-concat-segments"[\s\S]*ipcMain\.handle\("ffmpeg-mux-audio"[\s\S]*ipcMain\.handle\("cancel-ffmpeg-task"/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron confirms window close while image or video tasks are processing",
    pattern: /const activeProcessingTasks = new Map\(\)[\s\S]*ipcMain\.on\("set-active-processing-task"[\s\S]*mainWindow\.on\("close"[\s\S]*showMessageBoxSync[\s\S]*任务仍在处理中/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image processing marks the app busy during close-sensitive work",
    pattern: /setActiveProcessingTask[\s\S]*IMAGE_PROCESSING_TASK_ID[\s\S]*setImageProcessingGuard\(true[\s\S]*setImageProcessingGuard\(false/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video processing marks the app busy during close-sensitive work",
    pattern: /VIDEO_PROCESSING_TASK_ID[\s\S]*watch\(isProcessing[\s\S]*setActiveProcessingTask[\s\S]*clearActiveProcessingTask/,
  });
  assertPattern({
    file: "server/moonshine_server/model_manager.py",
    description: "Backend can start without installed models and loads models lazily",
    pattern: /self\.model = None[\s\S]*Default model .* is not installed[\s\S]*Model .* is not installed\. Please install the model before processing/,
  });
  assertPattern({
    file: "scripts/prepare-electron-resources.mjs",
    description: "Electron resource preparation bundles FFmpeg from a local runtime root",
    pattern: /PACKAGED_FFMPEG_RESOURCE_DIR[\s\S]*resolveFfmpegSourceRoot[\s\S]*MOONSHINE_FFMPEG_ROOT[\s\S]*copyPackagedFfmpegRuntime/,
  });
  assertPattern({
    file: "quasar.config.js",
    description: "Electron packaging includes FFmpeg extra resources",
    pattern: /extraResource:\s*\[[\s\S]*build-resources\/ffmpeg[\s\S]*extraResources:\s*\[[\s\S]*from:\s*"build-resources\/ffmpeg"[\s\S]*to:\s*"ffmpeg"/,
  });
  assertPattern({
    file: "src/components/common/ModelCapabilityRadar.vue",
    description: "Model capability radar renders 10-point decimal capability values",
    pattern: /formatCapabilityValue\(getCapabilityValue\(axis\.key\)\)[\s\S]*\/10[\s\S]*const CAPABILITY_MAX = 10;/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page exposes guarded E2E workflow bridge",
    pattern: /window\.__MOONSHINE_E2E__ !== true[\s\S]*window\.__MOONSHINE_IMAGE_TEST__/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video page exposes guarded E2E workflow bridge",
    pattern: /window\.__MOONSHINE_E2E__ !== true[\s\S]*window\.__MOONSHINE_VIDEO_TEST__/,
  });
  assertPattern({
    file: "src/components/global/BackendManager.vue",
    description: "Backend manager terminal progress refresh stays within 500-1000 ms",
    pattern: /const TERMINAL_PROGRESS_SYNC_MIN_MS = 500;[\s\S]*const TERMINAL_PROGRESS_SYNC_MAX_MS = 1000;/,
  });
  assertPattern({
    file: "src/components/global/BackendManager.vue",
    description: "Backend manager exposes close button for E2E modal isolation",
    pattern: /data-testid="backend-manager-close-button"/,
  });
  assertPattern({
    file: "src/components/global/BackendManager.vue",
    description: "Backend manager refreshes identical progress-line text",
    pattern: /lineType === "progress"[\s\S]*line\.refreshId = \+\+terminalLineRefreshId;/,
  });
  assertPattern({
    file: "src/components/global/BackendManager.vue",
    description: "Backend manager treats parsed tqdm lines as live progress after copy normalization",
    pattern: /let progressInfo = parseTqdmProgressLine\(stripBackendLogEnvelope\(rawText\)\);[\s\S]*progressInfo \|\| isProgressLine\(cleanText\) \|\| type === "progress"/,
  });
  assertPattern({
    file: "src/components/global/BackendManager.vue",
    description: "Backend manager throttles raw tqdm info logs as progress before rendering",
    pattern: /const getQueuedTerminalLogType = \(item = \{\}\) => \{[\s\S]*parseTqdmProgressLine\(stripBackendLogEnvelope\(rawText\)\)[\s\S]*progressInfo \|\| isProgressLine\(message\) \|\| item\.type === "progress"/,
  });
  assertPattern({
    file: "src/components/global/BackendManager.vue",
    description: "Backend manager gives normalized progress lines a stable heartbeat key",
    pattern: /const getProgressLineKeyFromInfo = \(progressInfo = \{\}\) =>[\s\S]*progress:\$\{progressInfo\.label \|\| "backend"\}[\s\S]*getProgressLineKeyFromInfo\(progressInfo\)/,
  });
  assertPattern({
    file: "src/components/global/BackendManager.vue",
    description: "Backend manager preserves local elapsed time when the same tqdm step repeats",
    pattern: /const mergeLiveProgressInfo = \(currentInfo, incomingInfo, now = Date\.now\(\)\) => \{[\s\S]*isSameProgressStep\(currentInfo, incomingInfo\)[\s\S]*baseElapsedSeconds: currentElapsed/,
  });
  assertPattern({
    file: "src/components/global/BackendManager.vue",
    description: "Backend manager heartbeat refreshes active progress lines without new backend text",
    pattern: /const TERMINAL_PROGRESS_HEARTBEAT_MS = 1000;[\s\S]*window\.setInterval\(\s*refreshLiveProgressLines,\s*TERMINAL_PROGRESS_HEARTBEAT_MS/,
  });
  assertPattern({
    file: "src/components/global/BackendManager.vue",
    description: "Backend manager stops live progress heartbeat when final logs arrive",
    pattern: /const deactivateTerminalProgressLines = \(\) => \{[\s\S]*line\.progressActive = false;[\s\S]*completeActiveProgressLine\(logInfo\)/,
  });
  assertPattern({
    file: "src/components/global/BackendManager.vue",
    description: "Backend manager promotes completed progress rows to 100 percent accent style",
    pattern: /const completeActiveProgressLine = \(completionInfo = \{\}\) => \{[\s\S]*percent: 100[\s\S]*line\.type = "progress-complete"[\s\S]*terminal-line--progress-complete/,
  });
  assertPattern({
    file: "src/components/global/BackendManager.vue",
    description: "Backend manager freezes raw 100 percent progress rows without live heartbeat metadata",
    pattern: /const isParsedProgressComplete =[\s\S]*isCompleteProgressInfo\(progressInfo\)[\s\S]*isCompletionLog \|\| isParsedProgressComplete[\s\S]*line\.progressInfo = line\.progressActive \? progressInfo : null/,
  });
  assertPattern({
    file: "src/components/global/BackendManager.vue",
    description: "Backend manager converts raw video batch logs into user-facing copy",
    pattern: /const parseVideoBatchStartLog[\s\S]*start\\s\+video\\s\+batch[\s\S]*const parseVideoBatchFinishLog[\s\S]*finished\\s\+video\\s\+batch[\s\S]*开始处理视频批次[\s\S]*视频批次/,
  });
  assertPattern({
    file: "src/components/global/BackendManager.vue",
    description: "Backend manager uses singular completion copy for one processed image",
    pattern: /imageFinishLog\.totalFrames === 1[\s\S]*单张图片处理完成，用时 \$\{imageFinishLog\.elapsedSeconds\} 秒/,
  });
  assertPattern({
    file: "server/moonshine_server/api.py",
    description: "Backend video batch completion log avoids dumping all output paths",
    pattern: /finished video batch:[\s\S]*failed=\{len\(failed_items\)\}, elapsed=\{batch_time:\.2f\}s"[\s\S]*\)[\s\S]*return JSONResponse/,
  });
  assertPattern({
    file: "server/moonshine_server/api.py",
    description: "Backend video batch logs do not include raw outputs payloads",
    pattern: /^((?!outputs=\{\[item\.get\('output_path'\)).)*$/s,
  });
  assertPattern({
    file: "scripts/e2e-comprehensive-workflow.mjs",
    description: "Comprehensive E2E workflow covers image, video, mask and backend terminal flows",
    pattern: /testImageWorkflow[\s\S]*testVideoWorkflow[\s\S]*testBackendTerminalRefresh[\s\S]*testGlobalSettingsTempCleanup/,
  });

  console.log("\nAll P0 regression assertions passed.");
}

try {
  runAssertions();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
