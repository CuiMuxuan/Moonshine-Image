import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
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
  const found = pattern instanceof RegExp ? pattern.test(content) : content.includes(pattern);
  if (found) {
    throw new Error(`Assertion failed: ${description}\nFile: ${file}`);
  }
  console.log(`PASS  ${description}`);
}

function assertFileMissing({ file, description }) {
  const target = path.join(repoRoot, file);
  if (fs.existsSync(target)) {
    throw new Error(`Assertion failed: ${description}\nFile: ${file}`);
  }
  console.log(`PASS  ${description}`);
}

function logSection(title) {
  console.log(`\n[${title}]`);
}

function runAssertions() {
  console.log("Running P1 image regression assertions...");

  logSection("Output Config");
  assertPattern({
    file: "src/shared/appConfigSchema.js",
    description: "Shared config defaults include image output format and quality",
    pattern: /imageOutputFormat:\s*"auto"[\s\S]*imageOutputQuality:\s*DEFAULT_IMAGE_OUTPUT_QUALITY/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron config sanitizes image output format and quality",
    pattern: /merged\.advanced\.imageOutputFormat[\s\S]*merged\.advanced\.imageOutputQuality = normalizeInteger/,
  });
  assertPattern({
    file: "src/components/global/GlobalSettings.vue",
    description: "Global settings exposes image output format and quality controls",
    pattern: /v-model="localConfig\.advanced\.imageOutputFormat"[\s\S]*v-model\.number="localConfig\.advanced\.imageOutputQuality"/,
  });
  assertPattern({
    file: "src/stores/config.js",
    description: "Config store validates raw image quality before normalization",
    pattern: /ConfigManager\.validateConfig\(\s*ConfigManager\.mergeForStrictValidation\(newConfig\)\s*\)[\s\S]*ConfigManager\.mergeWithDefault\(newConfig\)/,
  });
  assertPattern({
    file: "src/shared/appConfigSchema.js",
    description: "Image processing method supports automatic transport selection by default",
    pattern: /IMAGE_PROCESSING_METHOD_OPTIONS[\s\S]*"auto"[\s\S]*imageProcessingMethod:\s*"auto"/,
  });
  assertPattern({
    file: "src/components/global/GlobalSettings.vue",
    description: "Global settings exposes automatic image processing transport",
    pattern: /label:\s*"自动（推荐）"[\s\S]*value:\s*"auto"[\s\S]*100MB/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron save-app-config validates raw payload before sanitizing",
    pattern: /validateConfig\(mergeConfigForStrictValidation\(newConfig\)\)[\s\S]*const sanitizedConfig = sanitizeAppConfig\(newConfig\)/,
  });
  assertPattern({
    file: "src/config/ConfigManager.js",
    description: "Frontend config allows MAT as a default model only when CUDA launch mode is active",
    pattern: /DEFAULT_MODEL_IDS = Object\.freeze\(\["lama", "mat"\]\)[\s\S]*normalizeDefaultModel[\s\S]*model === "mat" && launchMode !== "cuda" \? "lama" : model[\s\S]*默认模型必须是 lama 或 mat[\s\S]*defaultModel: normalizeDefaultModel/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron config sanitization falls back from default MAT to LaMa outside CUDA mode",
    pattern: /DEFAULT_BACKEND_MODEL_IDS = Object\.freeze\(\["lama", "mat"\]\)[\s\S]*normalizeDefaultBackendModel[\s\S]*model === "mat" && launchMode !== "cuda" \? "lama" : model[\s\S]*merged\.general\.defaultModel = normalizeDefaultBackendModel/,
  });
  assertPattern({
    file: "src/shared/appConfigSchema.js",
    description: "Shared config schema includes versioned temp cleanup defaults",
    pattern: /CONFIG_SCHEMA_VERSION[\s\S]*DEFAULT_TEMP_CLEANUP[\s\S]*tempCleanup:\s*\{ \.\.\.DEFAULT_TEMP_CLEANUP \}/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron startup cleanup uses the global temp cleanup policy",
    pattern: /function runStartupTempCleanup\(\)[\s\S]*cleanupOptions\.enabled[\s\S]*cleanupOptions\.onStartup[\s\S]*cleanupAppTempFiles\(cleanupOptions\)/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Temp cleanup keeps recent video processing tasks within the retention window",
    pattern: /isVideoProcessingTaskNewerThanCutoff[\s\S]*cleanupVideoProcessingTempWithPolicy\(cleanupOptions = \{\}, cutoffMs[\s\S]*cleanupVideoProcessingTempEntries\(\{ preserveTaskIds, cutoffMs \}\)/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Legacy video temp cleanup keeps compatibility by not pruning missing resume records",
    pattern: /cleanup-video-processing-temp[\s\S]*cleanupVideoProcessingTempEntries\(\{[\s\S]*preserveTaskIds,[\s\S]*pruneMissingTasks: false/,
  });
  assertPattern({
    file: "src/components/global/GlobalSettings.vue",
    description: "File management exposes configurable temp cleanup controls",
    pattern: /临时文件清理[\s\S]*允许自动清理[\s\S]*v-model="localConfig\.fileManagement\.tempCleanup\.enabled"[\s\S]*应用启动时执行[\s\S]*v-model="localConfig\.fileManagement\.tempCleanup\.onStartup"[\s\S]*v-model\.number="localConfig\.fileManagement\.tempCleanup\.maxAgeDays"[\s\S]*cleanup-app-temp-files/,
  });
  assertPattern({
    file: "src/components/global/GlobalSettings.vue",
    description: "Video failure scene retention setting is shown in file management",
    pattern: /data-testid="global-settings-tab-files"[\s\S]*v-model\.number="localConfig\.video\.failureRetentionCount"[\s\S]*data-testid="global-settings-video-failure-retention-count"[\s\S]*<q-tab-panel name="appearance"/,
  });
  assertPattern({
    file: "src/shared/appConfigSchema.js",
    description: "Shared config schema keeps version and page-level default SAM model settings",
    pattern: /CONFIG_SCHEMA_VERSION = 8[\s\S]*DEFAULT_MASKING_CONFIG[\s\S]*defaultSamModel:\s*"sam_vit_b"[\s\S]*defaultSam2Model:\s*"sam2_1_hiera_large"[\s\S]*defaultSam3Model:\s*"sam3_1_multiplex"[\s\S]*imageSmartSelectionDefaultModel:\s*"sam_vit_b"[\s\S]*videoSmartSelectionDefaultModel:\s*"sam2_1_hiera_large"[\s\S]*samRenderCacheEnabled:\s*true[\s\S]*samRenderCacheMaxContexts:\s*12[\s\S]*samRenderCacheMaxMemoryMb:\s*192[\s\S]*samRenderCacheLargeImageLongSide:\s*4096[\s\S]*samLazyRenderDisabledCandidates:\s*true[\s\S]*samRenderCachePreloadVisibleList:\s*true[\s\S]*samRenderCacheNeighborPreloadCount:\s*4[\s\S]*masking:\s*\{[\s\S]*DEFAULT_MASKING_CONFIG/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron config persists version and page-level default SAM model settings",
    pattern: /DEFAULT_MASKING_CONFIG[\s\S]*nextConfig\.masking\.defaultSamModel = DEFAULT_MASKING_CONFIG\.defaultSamModel[\s\S]*nextConfig\.masking\.defaultSam2Model = DEFAULT_MASKING_CONFIG\.defaultSam2Model[\s\S]*nextConfig\.masking\.imageSmartSelectionDefaultModel[\s\S]*nextConfig\.masking\.videoSmartSelectionDefaultModel[\s\S]*merged\.masking\.defaultSam3Model[\s\S]*merged\.masking\.imageSmartSelectionDefaultModel[\s\S]*merged\.masking\.videoSmartSelectionDefaultModel/,
  });

  logSection("Backend Protocol");
  assertPattern({
    file: "server/moonshine_server/schema.py",
    description: "Image requests expose output_format and output_quality",
    pattern: /class BatchInpaintRequest[\s\S]*output_format:\s*ImageOutputFormat[\s\S]*output_quality:\s*int = Field\(95,\s*ge=1,\s*le=100\)[\s\S]*class MoonshineImageProcessRequest[\s\S]*output_format:\s*ImageOutputFormat[\s\S]*output_quality:\s*int = Field\(95,\s*ge=1,\s*le=100\)/,
  });
  assertPattern({
    file: "server/moonshine_server/schema.py",
    description: "Backend output format accepts mixed-case values before enum validation",
    pattern: /field_validator,\s*model_validator[\s\S]*def normalize_image_output_format_value[\s\S]*str\(value\)\.strip\(\)\.lower\(\)[\s\S]*field_validator\(\s*"output_format", mode="before"\s*\)/,
  });
  assertPattern({
    file: "server/moonshine_server/image_output.py",
    description: "Backend output helper flattens explicit JPG alpha to white",
    pattern: /Image\.new\("RGB",\s*rgba\.size,\s*\(255,\s*255,\s*255\)\)[\s\S]*background\.paste\(rgba,\s*mask=rgba\.getchannel\("A"\)\)/,
  });
  assertPattern({
    file: "server/moonshine_server/api.py",
    description: "Backend batch APIs resolve output spec and return format metadata",
    pattern: /_resolve_result_spec[\s\S]*_build_result_meta\(output_spec\)/,
  });
  assertAbsentPattern({
    file: "server/moonshine_server/api.py",
    description: "Image processing APIs no longer return the old image result alias",
    pattern: /"image": result_data|Backward compatibility for older frontend response parsing/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/model_registry.py",
    description: "Model registry includes downloadable SAM1, SAM2.1, SAM3, and SAM3.1 mask models from the project model repo",
    pattern: /HF_MODEL_REPO_BASE_URL = "https:\/\/huggingface\.co\/CuiMuxuan\/moonshine-models\/resolve\/main"[\s\S]*"id": "sam_vit_b"[\s\S]*"family": "sam"[\s\S]*"modelVersion": "SAM1"[\s\S]*"downloadable": True[\s\S]*"url": f"\{HF_MODEL_REPO_BASE_URL\}\/sam\/sam_vit_b_01ec64\.pth"[\s\S]*"id": "sam2_1_hiera_large"[\s\S]*"family": "sam2"[\s\S]*"modelVersion": "SAM2\.1"[\s\S]*"url": f"\{HF_MODEL_REPO_BASE_URL\}\/sam2\/sam2\.1_hiera_large\.pt"[\s\S]*"id": "sam3"[\s\S]*"url": f"\{HF_MODEL_REPO_BASE_URL\}\/sam3\/sam3\.pt"[\s\S]*"id": "sam3_1_multiplex"[\s\S]*"category": "text_smart_selection"[\s\S]*"url": f"\{HF_MODEL_REPO_BASE_URL\}\/sam3\/sam3\.1_multiplex\.pt"/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/model_registry.py",
    description: "Model registry includes MAT as a CUDA-only mask image/video processing model with project download sources",
    pattern: /(?=[\s\S]*MAT_LICENSE = \{[\s\S]*"name": "CC BY-NC 4\.0"[\s\S]*仅限非商业用途)(?=[\s\S]*"id": "mat"[\s\S]*"family": "mat"[\s\S]*"modelVersion": "MAT")(?=[\s\S]*"requiresMask": True)(?=[\s\S]*"url": f"\{HF_MODEL_REPO_BASE_URL\}\/mat\/Places_512_FullData_G\.pth")(?=[\s\S]*"url": MANUAL_MODEL_SOURCE_URL)(?=[\s\S]*"path": "mat\/Places_512_FullData_G\.pth")(?=[\s\S]*"size": 250619359)(?=[\s\S]*"sha256": "0512e37ebba3986b0355130b2e2c1f95736d0778ac82e91b1212b4b21c231312")(?=[\s\S]*"license": MAT_LICENSE)(?=[\s\S]*"recommendedDevice": "cuda")(?=[\s\S]*"minimumVram": 6144)(?=[\s\S]*"recommendedVram": 8192)(?=[\s\S]*"scopes": \["selected", "batch", "folder", "video"\])[\s\S]*/,
  });
  assertPattern({
    file: "server/moonshine_server/model/mat.py",
    description: "MAT runtime loads only the project model file and rejects non-CUDA execution",
    pattern: /(?=[\s\S]*MAT_MODEL_FILE = "mat\/Places_512_FullData_G\.pth")(?=[\s\S]*def _resolve_mat_model_path\(\) -> str:[\s\S]*root_path = _root_model_path\(MAT_MODEL_FILE\)[\s\S]*if root_path\.is_file\(\):[\s\S]*return str\(root_path\)[\s\S]*raise FileNotFoundError)(?=[\s\S]*def init_model\(self, device, \*\*kwargs\):[\s\S]*"cuda" not in str\(device\)\.lower\(\) or not torch\.cuda\.is_available\(\)[\s\S]*MAT requires CUDA)(?=[\s\S]*load_model\(G, _resolve_mat_model_path\(\), device, None\))(?=[\s\S]*def is_downloaded\(\) -> bool:[\s\S]*return _root_model_path\(MAT_MODEL_FILE\)\.is_file\(\))[\s\S]*/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/model_registry.py",
    description: "Model registry tracks SAM2.1 variants under the sam2 folder and no longer exposes old SAM2 checkpoints",
    pattern: /(?=[\s\S]*"id": "sam2_1_hiera_tiny"[\s\S]*"modelVersion": "SAM2\.1"[\s\S]*"path": "sam2\/sam2\.1_hiera_tiny\.pt")(?=[\s\S]*"id": "sam2_1_hiera_small"[\s\S]*"path": "sam2\/sam2\.1_hiera_small\.pt")(?=[\s\S]*"id": "sam2_1_hiera_base_plus"[\s\S]*"path": "sam2\/sam2\.1_hiera_base_plus\.pt")(?=[\s\S]*"id": "sam2_1_hiera_large"[\s\S]*"path": "sam2\/sam2\.1_hiera_large\.pt")(?![\s\S]*"id": "sam2_hiera_)[\s\S]*/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/model_registry.py",
    description: "SAM3 text models require the sam3 subfolder and do not accept root checkpoint legacy paths",
    pattern: /"id": "sam3"[\s\S]*"path": "sam3\/sam3\.pt"[\s\S]*"legacyPaths": \[\][\s\S]*"id": "sam3_1_multiplex"[\s\S]*"path": "sam3\/sam3\.1_multiplex\.pt"[\s\S]*"legacyPaths": \[\]/,
  });
  assertAbsentPattern({
    file: "server/moonshine_server/moonshine/model_registry.py",
    description: "SAM1/SAM2.1 no longer accept root checkpoint legacy paths",
    pattern: /"legacyPaths": \["sam(?:_vit|2|2\.1)/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/model_registry.py",
    description: "Model registry exposes license metadata and generic legacy migration status",
    pattern: /(?=[\s\S]*MAT_LICENSE)(?=[\s\S]*SAM1_LICENSE)(?=[\s\S]*SAM2_LICENSE)(?=[\s\S]*SAM3_LICENSE)(?=[\s\S]*def _model_license_metadata)(?=[\s\S]*"license": manifest_item\.get\("license"\) or _model_license_metadata\(manifest_item\))(?=[\s\S]*"legacyDetected")(?=[\s\S]*"migrationTarget")[\s\S]*/,
  });
  assertPattern({
    file: "server/moonshine_server/api.py",
    description: "Model registry API returns release runtime profile for package diagnostics",
    pattern: /def _get_release_runtime_profile[\s\S]*MOONSHINE_RUNTIME_FLAVOR[\s\S]*MOONSHINE_MODEL_BUNDLE[\s\S]*sam3TextSupportedByPackage[\s\S]*"runtime": self\._get_release_runtime_profile\(cuda_info\)/,
  });
  assertPattern({
    file: "server/moonshine_server/schema.py",
    description: "SAM prediction request supports base64/path images, point prompts, and box prompts",
    pattern: /class SamPromptPoint[\s\S]*x:\s*float[\s\S]*label:\s*int[\s\S]*class SamPromptBox[\s\S]*width:\s*float[\s\S]*class MoonshineSamPredictRequest[\s\S]*image_type:\s*Literal\["base64",\s*"path"\][\s\S]*multimask_output:\s*bool/,
  });
  assertPattern({
    file: "server/moonshine_server/api.py",
    description: "Backend exposes standalone Moonshine SAM predict API",
    pattern: /MoonshineSamPredictRequest[\s\S]*SamService[\s\S]*"\/api\/v1\/moonshine\/sam\/predict"[\s\S]*def api_moonshine_sam_predict[\s\S]*_get_sam_service\(\)\.predict/,
  });
  assertPattern({
    file: "server/moonshine_server/api.py",
    description: "Backend exposes standalone Moonshine SAM capability API",
    pattern: /"\/api\/v1\/moonshine\/sam\/capabilities"[\s\S]*def api_moonshine_sam_capabilities[\s\S]*_get_sam_service\(\)\.capabilities\(\)/,
  });
  assertPattern({
    file: "server/moonshine_server/api.py",
    description: "Backend exposes project SAM2 video and SAM3 text routes",
    pattern: /"\/api\/v1\/moonshine\/sam\/video\/propagate"[\s\S]*api_moonshine_sam_video_propagate[\s\S]*"\/api\/v1\/moonshine\/sam\/text\/predict"[\s\S]*api_moonshine_sam_text_predict/,
  });
  assertPattern({
    file: "server/moonshine_server/api.py",
    description: "SAM predict API releases temporary torch memory on success and service errors",
    pattern: /def api_moonshine_sam_predict[\s\S]*try:[\s\S]*_get_sam_service\(\)\.predict[\s\S]*except SamServiceError as error:[\s\S]*raise HTTPException[\s\S]*finally:[\s\S]*torch_gc\(\)/,
  });
  assertPattern({
    file: "server/moonshine_server/api.py",
    description: "Legacy plugin mask route remains for RemoveBG and AnimeSeg compatibility",
    pattern: /"\/api\/v1\/run_plugin_gen_mask"[\s\S]*def api_run_plugin_gen_mask[\s\S]*support_gen_mask[\s\S]*gen_mask/,
  });
  assertFileMissing({
    file: "server/moonshine_server/plugins/interactive_seg.py",
    description: "Legacy InteractiveSeg plugin file has been removed",
  });
  assertAbsentPattern({
    file: "server/moonshine_server/plugins/__init__.py",
    description: "Plugin registry no longer imports or initializes InteractiveSeg",
    pattern: /InteractiveSeg|interactive_seg|enable_interactive_seg|interactive_seg_model|interactive_seg_device/,
  });
  assertAbsentPattern({
    file: "server/moonshine_server/schema.py",
    description: "Backend schema no longer exposes InteractiveSeg config fields",
    pattern: /InteractiveSegModel|enable_interactive_seg|interactive_seg_model|interactive_seg_device|interactiveSegModel|interactiveSegModels/,
  });
  assertAbsentPattern({
    file: "server/moonshine_server/cli.py",
    description: "Server CLI no longer exposes InteractiveSeg startup options",
    pattern: /InteractiveSegModel|enable_interactive_seg|interactive_seg_model|interactive_seg_device|INTERACTIVE_SEG/,
  });
  assertAbsentPattern({
    file: "server/moonshine_server/api.py",
    description: "Backend API no longer contains InteractiveSeg-specific model switching or config response fields",
    pattern: /InteractiveSeg|interactive_seg_model|interactiveSegModel|interactiveSegModels/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/sam_service.py",
    description: "SAM service loads SAM1 and SAM2.1 from the model registry without plugin download",
    pattern: /SAM1_MODEL_TYPES[\s\S]*SAM2_MODEL_TYPES = \{(?![\s\S]*"sam2_hiera_)[\s\S]*"sam2_1_hiera_large": "sam2_1_large"[\s\S]*build_model_status\(self\.model_dir[\s\S]*build_sam2\(model_type,\s*ckpt_path=str\(checkpoint_path\),\s*device=self\.device\)[\s\S]*sam_model_registry\[model_type\]\(checkpoint=str\(checkpoint_path\)\)[\s\S]*predictor\.predict\(/,
  });
  assertPattern({
    file: "server/moonshine_server/api.py",
    description: "Backend normalizes Device enum values before constructing the SAM service",
    pattern: /(?=[\s\S]*def _normalize_device_value\(device\) -> str:)(?=[\s\S]*raw_value = getattr\(device, "value", device\))(?=[\s\S]*normalized\.startswith\("device\."\))(?=[\s\S]*return normalized if normalized in \{"cpu", "cuda", "mps"\} else "cpu")(?=[\s\S]*def _get_sam_service\(self, device: Optional\[str\] = None\) -> SamService:[\s\S]*sam_device = self\._normalize_device_value\(device or self\.config\.device\)[\s\S]*SamService\(self\._model_dir\(\), sam_device\))[\s\S]*/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/sam_service.py",
    description: "SAM service serializes predictor state while setting images and running predictions",
    pattern: /from threading import RLock[\s\S]*self\._lock = RLock\(\)[\s\S]*with self\._lock:[\s\S]*predictor\.set_image\(rgb_np_img\)[\s\S]*predictor\.predict\(/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/sam_service.py",
    description: "SAM service keeps per-model image embedding cache state and reports performance metadata",
    pattern: /self\._image_cache = \{\}[\s\S]*model_cache_key = \(model_id, self\.device\)[\s\S]*cached_image_hash = self\._image_cache\.get\(model_cache_key\)[\s\S]*imageCacheHit[\s\S]*imageMegapixels[\s\S]*totalMs/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/sam_service.py",
    description: "SAM service translates common CUDA resource failures into user-facing guidance",
    pattern: /def _format_runtime_error[\s\S]*out of memory[\s\S]*SAM 推理显存不足[\s\S]*no available kernel[\s\S]*SAM2\.1 CUDA attention kernel 不可用/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/sam_service.py",
    description: "SAM point and box prediction rejects SAM3 text models until the text route is implemented",
    pattern: /POINT_BOX_FAMILIES = \{"sam", "sam2"\}[\s\S]*model\.get\("family"\) not in POINT_BOX_FAMILIES[\s\S]*Only SAM1\/SAM2\.1 point\/box prediction is enabled now/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/sam_service.py",
    description: "SAM capability API reports point/box readiness and gates real SAM3 text capability",
    pattern: /SAM3_REQUIRED_MODULES = \{[\s\S]*"sam3": "sam3"[\s\S]*"pycocotools": "pycocotools"[\s\S]*"psutil": "psutil"[\s\S]*"triton": "triton"[\s\S]*SAM3_TEXT_MODEL_IDS = \{"sam3", "sam3_1_multiplex"\}[\s\S]*SAM3_TEXT_DEFAULT_MODEL_ID = "sam3_1_multiplex"[\s\S]*SAM3_1_MISSING_KEYS_WARNING[\s\S]*def _sam3_runtime_status[\s\S]*"runtimeReady"[\s\S]*"deviceReady"[\s\S]*def capabilities\(self\)[\s\S]*point_box_models[\s\S]*"pointBox"[\s\S]*"enabled": bool\(point_box_models\)[\s\S]*"video"[\s\S]*"inputTypes": \["jpegFrameDirectory", "videoPath"\][\s\S]*"supportsMultipleObjects": True[\s\S]*"text"[\s\S]*"enabled": bool\(runnable_text_models\)[\s\S]*if item\.get\("id"\) == SAM3_TEXT_DEFAULT_MODEL_ID[\s\S]*"implementedModelIds": sorted\(SAM3_TEXT_MODEL_IDS\)[\s\S]*"pendingModels": pending_text_models[\s\S]*"warnings": text_warnings/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/sam_service.py",
    description: "SAM2 video propagation uses the bundled video predictor and JPEG frame directories",
    pattern: /build_sam2_video_predictor[\s\S]*self\._video_predictors = \{\}[\s\S]*def _get_video_predictor[\s\S]*def propagate_video[\s\S]*SAM2\.1 video input must be a JPEG frame directory[\s\S]*predictor\.add_new_points_or_box[\s\S]*predictor\.propagate_in_video/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/sam_service.py",
    description: "SAM3 text route performs real local-checkpoint text prediction with CUDA bf16 autocast",
    pattern: /(?=[\s\S]*def _get_text_model_status)(?=[\s\S]*if model_id not in SAM3_TEXT_MODEL_IDS)(?=[\s\S]*def _get_text_predictor)(?=[\s\S]*build_sam3_image_model\()(?=[\s\S]*checkpoint_path=str\(checkpoint_path\))(?=[\s\S]*load_from_HF=False)(?=[\s\S]*Sam3Processor)(?=[\s\S]*def _normalize_text_prompts)(?=[\s\S]*SAM3_ZH_PROMPT_TERMS)(?=[\s\S]*def predict_text)(?=[\s\S]*prompt_source)(?=[\s\S]*is_lexicon_prompt)(?=[\s\S]*torch\.autocast\(device_type="cuda", dtype=torch\.bfloat16\))(?=[\s\S]*predictor\.set_text_prompt)(?=[\s\S]*_sam3_mask_to_numpy)(?=[\s\S]*"promptType": "text")(?=[\s\S]*"modelText": used_prompt\["text"\])(?=[\s\S]*"color": prompt_color)(?=[\s\S]*"noun": prompt_noun)(?=[\s\S]*"promptColor": prompt_color)(?=[\s\S]*"promptNoun": prompt_noun)(?=[\s\S]*"diagnostics")(?=[\s\S]*"promptAttempts")(?=[\s\S]*"emptyResultReason")(?=[\s\S]*"autocast": "cuda\.bfloat16")/,
  });
  assertPattern({
    file: "scripts/verify_sam_text_quality.py",
    description: "SAM3 text quality smoke covers English, basic Chinese normalization, and absent-target diagnostics",
    pattern: /english_short_phrase[\s\S]*red rectangle[\s\S]*basic_chinese_lexicon[\s\S]*红色矩形[\s\S]*unknown_absent_target[\s\S]*green bicycle[\s\S]*diagnostics/,
  });
  assertPattern({
    file: "server/moonshine_server/api.py",
    description: "SAM3 reserved text API passes prompt language and lexicon metadata through the service boundary",
    pattern: /def api_moonshine_sam_text_predict[\s\S]*predict_text\([\s\S]*text=req\.text,[\s\S]*language=req\.language,[\s\S]*prompt_source=req\.prompt_source,[\s\S]*prompt_color=req\.prompt_color,[\s\S]*prompt_noun=req\.prompt_noun/,
  });
  assertPattern({
    file: "server/moonshine_server/plugins/segment_anything2/build_sam.py",
    description: "Bundled SAM2 builder can create the official video predictor class",
    pattern: /from \.sam2_video_predictor import SAM2VideoPredictor[\s\S]*sam2_video_model_registry[\s\S]*def build_sam2_video_predictor/,
  });
  assertPattern({
    file: "server/moonshine_server/plugins/segment_anything2/build_sam.py",
    description: "SAM2 video builder enables memory RoPE repeat for cross-frame propagation",
    pattern: /def build_memory_attention\(rope_k_repeat=False\)[\s\S]*cross_attention=RoPEAttention[\s\S]*rope_k_repeat=rope_k_repeat[\s\S]*def build_sam2_1_video_large\(\)[\s\S]*memory_attention=build_memory_attention\(rope_k_repeat=True\)/,
  });
  assertPattern({
    file: "server/moonshine_server/plugins/segment_anything2/sam2_video_predictor.py",
    description: "Bundled SAM2 video predictor uses local package imports",
    pattern: /from \.modeling\.sam2_base import NO_OBJ_SCORE, SAM2Base[\s\S]*from \.utils\.misc import concat_points, fill_holes_in_mask_scores, load_video_frames[\s\S]*def propagate_in_video/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/sam_service.py",
    description: "SAM2 CUDA prediction forces a stable math SDP fallback when Flash SDP is unavailable",
    pattern: /sam2_transformer[\s\S]*_configure_sam2_attention_compatibility[\s\S]*USE_FLASH_ATTN = False[\s\S]*MATH_KERNEL_ON = True/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/sam_service.py",
    description: "SAM service returns frontend-compatible translucent RGBA mask candidates",
    pattern: /rgba_mask = np\.zeros\(\(mask\.shape\[0\], mask\.shape\[1\], 4\)[\s\S]*rgba_mask\[mask > 128\] = \[255,\s*203,\s*0,\s*int\(255 \* 0\.73\)\]/,
  });
  assertPattern({
    file: "server/moonshine_server/batch_processing.py",
    description: "Lama folder processing writes selected output extension",
    pattern: /output_format:\s*str = "auto"[\s\S]*save_p = output \/ f"\{stem\}\{output_spec\['extension'\]\}"/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/slbr_runner.py",
    description: "SLBR folder processing writes selected output extension and metadata",
    pattern: /output_format:\s*str = "auto"[\s\S]*output_path_for\([\s\S]*output_spec\["extension"\][\s\S]*"mime_type": output_spec\["mime_type"\]/,
  });

  logSection("Frontend Requests & Results");
  assertPattern({
    file: "src/utils/imageOutputOptions.js",
    description: "Frontend image output request helper rejects invalid format and non-integer/out-of-range quality",
    pattern: /validateImageOutputFormat[\s\S]*throw new Error\("图片输出格式无效。"\)[\s\S]*validateImageOutputQuality[\s\S]*!Number\.isInteger\(quality\)[\s\S]*quality < MIN_IMAGE_OUTPUT_QUALITY[\s\S]*quality > MAX_IMAGE_OUTPUT_QUALITY[\s\S]*buildImageOutputRequestOptions/,
  });
  assertPattern({
    file: "src/stores/fileManager.js",
    description: "Image request builders use shared output option validation",
    pattern: /buildImageOutputRequestOptions[\s\S]*\.\.\.buildImageOutputRequestOptions\(configStore\.config\)/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Folder request builders use shared output option validation",
    pattern: /import \{ buildImageOutputRequestOptions \}[\s\S]*const getImageOutputRequestOptions = \(\) => buildImageOutputRequestOptions\(configStore\.config\);/,
  });
  assertPattern({
    file: "src/services/ImageProcessingService.js",
    description: "Processing results preserve backend format metadata",
    pattern: /addProcessingResult\(resultId,\s*resultPayload,\s*\{[\s\S]*mimeType:\s*result\.mime_type[\s\S]*extension:\s*result\.extension/,
  });
  assertAbsentPattern({
    file: "src/services/ImageProcessingService.js",
    description: "Image processing service no longer falls back to old result.image payloads",
    pattern: /result\.result \|\| result\.image|result\.image/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Download filenames use latest result extension",
    pattern: /const outputExtension = latestImage\?\.extension \|\| extension \|\| "\.png";/,
  });
  assertPattern({
    file: "src/stores/fileManager.js",
    description: "Auto transport uses Base64 only for non-folder batches up to 100 files and 100MB total",
    pattern: /AUTO_BASE64_MAX_FILE_COUNT = 100[\s\S]*AUTO_BASE64_MAX_TOTAL_BYTES = 100 \* 1024 \* 1024[\s\S]*resolveProcessingTransport[\s\S]*options\.folderMode[\s\S]*return "base64"/,
  });
  assertPattern({
    file: "src/stores/fileManager.js",
    description: "Latest image input resolver converts between path and Base64 with size validation",
    pattern: /assertCanConvertPathToBase64[\s\S]*resolveLatestImageInput[\s\S]*materializeBase64ImageToTempPath[\s\S]*fileToBase64/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Mask-required successful runs clear masks only for successfully processed image ids",
    pattern: /const clearMasksForProcessedFileIds = \(processedFileIds = \[\]\) => \{[\s\S]*updateFileMask\(fileId,\s*null\)[\s\S]*finalizeSuccessfulMaskRun\(maskUiState,\s*\{[\s\S]*processedFileIds/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Successful mask-required runs clear SAM sessions and render cache for processed image ids",
    pattern: /(?=[\s\S]*import \{ deleteSamImageSessions, getSamImageSessionStore \} from "src\/services\/SamImageSessionStore")(?=[\s\S]*const currentFileId = fileManagerStore\.currentFile\?\.id \|\| "")(?=[\s\S]*editorRef\.value\?\.clearSamContextSession\?\.\(currentFileId\))(?=[\s\S]*const backgroundIds = currentProcessed[\s\S]*uniqueIds\.filter\(\(fileId\) => fileId !== currentFileId\))(?=[\s\S]*clearSamRenderCacheContext\(fileId,\s*getSamImageSessionStore\(\)\))(?=[\s\S]*deleteSamImageSessions\(backgroundIds\))[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Folder mode can stage loaded latest image results and append output paths back to history",
    pattern: /buildStagedFolderInputs[\s\S]*resolveLatestImageInput\(loadedFile,\s*"path"[\s\S]*appendFolderResultsToLoadedFiles[\s\S]*addProcessingResult/,
  });
  assertPattern({
    file: "src/stores/modelRegistry.js",
    description: "Model registry store keeps SAM mask models separate from image processing models",
    pattern: /const imageModels = computed\(\(\) => models\.value\.filter\(\(model\) => model\.type === "image"\)\)[\s\S]*const maskModels = computed\(\(\) => models\.value\.filter\(\(model\) => model\.type === "mask"\)\)/,
  });
  assertPattern({
    file: "src/components/global/ModelManagementPanel.vue",
    description: "Model management panel can set default SAM family models without changing image model selection",
    pattern: /getSamDefaultConfigKey[\s\S]*defaultSam2Model[\s\S]*defaultSam3Model[\s\S]*getSamVersionVariantLabel[\s\S]*modelVersion[\s\S]*variant[\s\S]*setDefaultSamModel[\s\S]*mergedConfig\.masking\[key\] = model\.id/,
  });
  assertPattern({
    file: "src/components/global/ModelManagementPanel.vue",
    description: "Model management panel provides a Quasar model tree with SAM grouping, runtime, license, and legacy feedback",
    pattern: /(?=[\s\S]*<q-tree)(?=[\s\S]*modelTreeNodes)(?=[\s\S]*图片处理模型)(?=[\s\S]*智能选区模型)(?=[\s\S]*SAM1)(?=[\s\S]*SAM2)(?=[\s\S]*SAM3)(?=[\s\S]*handleModelTreeSelected)(?=[\s\S]*runtimeNotice)(?=[\s\S]*发布与许可证)(?=[\s\S]*getModelWarning)(?=[\s\S]*legacyDetected)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/global/ModelManagementPanel.vue",
    description: "Model management tree exposes MAT as its own image-processing group",
    pattern: /(?=[\s\S]*id: "image-mat")(?=[\s\S]*label: "MAT")(?=[\s\S]*models: imageModels\.filter\(\(model\) => model\.id === "mat" \|\| model\.family === "mat"\))(?=[\s\S]*!\["lama", "mat", "slbr"\]\.includes\(model\.id\))[\s\S]*/,
  });
  assertPattern({
    file: "src/components/global/ModelManagementPanel.vue",
    description: "Model management tree uses separate group/model node ids so SAM3 leaves render and select reliably",
    pattern: /(?=[\s\S]*:selected="selectedModelTreeNodeId")(?=[\s\S]*selectedModelTreeNodeId = computed\(\(\) =>[\s\S]*`model-\$\{selectedModelId\.value\}`)(?=[\s\S]*id: `model-\$\{model\.id\}`)(?=[\s\S]*modelId: model\.id)(?=[\s\S]*id: `group-\$\{id\}`)(?=[\s\S]*id: "group-smart-selection-models")(?=[\s\S]*id: "sam3"[\s\S]*label: "SAM3"[\s\S]*models: sam3Models)(?=[\s\S]*handleModelTreeSelected[\s\S]*node\?\.modelId[\s\S]*selectedModelId\.value = node\.modelId)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/global/ModelManagementPanel.vue",
    description: "Model management panel shows recommended VRAM as guidance without changing installed status",
    pattern: /(?=[\s\S]*目标相对路径：)(?=[\s\S]*正式检测路径：)(?=[\s\S]*当前检测到：)(?=[\s\S]*推荐显存)(?=[\s\S]*model\.recommendedVramWarning\.message)(?=[\s\S]*if \(model\.installed\) return "已安装")(?![\s\S]*已安装·设备不适配)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/global/ModelManagementPanel.vue",
    description: "Model management panel exposes the SAM3 color/noun lexicon CRUD dialog",
    pattern: /中文词表[\s\S]*sam3LexiconDialog[\s\S]*sam3LexiconEntries[\s\S]*addSam3LexiconEntry[\s\S]*removeSam3LexiconEntry[\s\S]*saveSam3LexiconDialog/,
  });
  assertPattern({
    file: "src/components/global/ModelManagementPanel.vue",
    description: "Model management panel only renders the capability radar for image processing models",
    pattern: /(?=[\s\S]*v-if="shouldShowModelCapabilityRadar\(model\)"[\s\S]*<model-capability-radar)(?=[\s\S]*shouldShowModelCapabilityRadar = \(model\) =>[\s\S]*model\?\.type === "image"[\s\S]*Object\.keys\(model\?\.capabilities \|\| \{\}\)\.length > 0)[\s\S]*/,
  });
  assertPattern({
    file: "src/services/ModelRegistryService.js",
    description: "Frontend model registry preserves SAM model version, license, legacy, and runtime metadata",
    pattern: /familyLabel: String\(model\.familyLabel[\s\S]*modelVersion: String\(model\.modelVersion[\s\S]*variant: String\(model\.variant[\s\S]*license: model\.license[\s\S]*legacyDetected[\s\S]*recommendedVram[\s\S]*recommendedVramWarning[\s\S]*runtime: response\?\.runtime/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/model_registry.py",
    description: "SAM registry uses recommended VRAM guidance without making installed SAM models unavailable",
    pattern: /(?=[\s\S]*"id": "sam_vit_b"[\s\S]*"recommendedVram": 4096)(?=[\s\S]*"id": "sam2_1_hiera_large"[\s\S]*"recommendedVram": 12288)(?=[\s\S]*"id": "sam3_1_multiplex"[\s\S]*"recommendedVram": 16384)(?=[\s\S]*def _recommended_vram_warning)(?=[\s\S]*"可能较慢或失败。")(?=[\s\S]*"recommendedVramWarning": recommended_vram_warning)[\s\S]*/,
  });
  assertPattern({
    file: "src/services/ModelRegistryService.js",
    description: "Frontend model registry sends the configured model directory to load, refresh, verify, and download calls",
    pattern: /buildModelDirectoryPayload[\s\S]*model_dir[\s\S]*api\.get\(\s*"\/api\/v1\/moonshine\/models",[\s\S]*directoryPayload\.model_dir \? \{ model_dir: directoryPayload\.model_dir \} : \{\}[\s\S]*api\.post\(\s*"\/api\/v1\/moonshine\/models\/refresh",[\s\S]*buildModelDirectoryPayload\(options\)[\s\S]*verify[\s\S]*buildModelDirectoryPayload\(options\)[\s\S]*download[\s\S]*buildModelDirectoryPayload\(options\)/,
  });
  assertPattern({
    file: "src/components/global/ModelManagementPanel.vue",
    description: "Model management panel reloads backend model status with the current global model directory",
    pattern: /currentConfiguredModelDir = computed[\s\S]*generalConfig\.modelDir[\s\S]*modelRegistryRequestOptions = computed[\s\S]*modelDir: currentConfiguredModelDir\.value[\s\S]*modelRegistry\.refreshModels\(modelRegistryRequestOptions\.value\)[\s\S]*modelRegistry\.verifyModel\(modelId, modelRegistryRequestOptions\.value\)[\s\S]*modelRegistry\.startDownload\(model\.id, modelRegistryRequestOptions\.value\)[\s\S]*watch\(\s*currentConfiguredModelDir,[\s\S]*modelRegistry\.loadModels\(modelRegistryRequestOptions\.value\)/,
  });
  assertPattern({
    file: "server/moonshine_server/api.py",
    description: "Backend model registry can switch the running model directory from model management requests",
    pattern: /(?=[\s\S]*MoonshineModelRegistryRequest)(?=[\s\S]*Body)(?=[\s\S]*Query)(?=[\s\S]*def api_moonshine_models\([\s\S]*req: Optional\[MoonshineModelRegistryRequest\] = Body\(default=None\),[\s\S]*model_dir: Optional\[str\] = Query\(default=None\),[\s\S]*self\._sync_model_dir\(model_dir or \(req\.model_dir if req else ""\)\))(?=[\s\S]*def _sync_model_dir\(self, model_dir: Optional\[str\]\):[\s\S]*os\.environ\["XDG_CACHE_HOME"\][\s\S]*self\._moonshine_runners\.clear\(\)[\s\S]*self\._sam_services\.clear\(\))[\s\S]*/,
  });
  assertPattern({
    file: "src/stores/modelRegistry.js",
    description: "Model registry store keeps runtime package diagnostics from the backend",
    pattern: /const runtime = ref\(\{\}\)[\s\S]*runtime\.value = payload\.runtime \|\| \{\}[\s\S]*runtime,/,
  });
  assertPattern({
    file: "src/stores/modelRegistry.js",
    description: "Model registry store defaults every model status request to the configured model directory",
    pattern: /useConfigStore[\s\S]*const configStore = useConfigStore\(\)[\s\S]*withConfiguredModelDir = \(options = \{\}\) =>[\s\S]*generalConfig\.modelDir[\s\S]*ModelRegistryService\.getModels\(withConfiguredModelDir\(options\)\)[\s\S]*ModelRegistryService\.refreshModels\(withConfiguredModelDir\(options\)\)[\s\S]*ModelRegistryService\.verifyModel\([\s\S]*withConfiguredModelDir\(options\)[\s\S]*ModelRegistryService\.startModelDownload\([\s\S]*withConfiguredModelDir\(options\)/,
  });
  assertPattern({
    file: "src/components/global/GlobalSettings.vue",
    description: "Global settings exposes MAT as a default backend model but disables and falls back outside CUDA mode",
    pattern: /defaultBackendModelOptions = computed\(\(\) => \[[\s\S]*\{ label: "LaMa", value: "lama" \}[\s\S]*label: "MAT"[\s\S]*value: "mat"[\s\S]*disable: localConfig\.value\.general\?\.launchMode !== "cuda"[\s\S]*fallbackMatDefaultModelIfNeeded[\s\S]*localConfig\.value\.general\.defaultModel = "lama"[\s\S]*MAT_CUDA_FALLBACK_MESSAGE/,
  });
  assertPattern({
    file: "src/components/global/BackendManager.vue",
    description: "Backend manager exposes MAT startup model only for CUDA and falls back to LaMa with a visible warning",
    pattern: /backendModelOptions = \[[\s\S]*\{ label: "LaMa", value: "lama" \}[\s\S]*\{ label: "MAT", value: "mat" \}[\s\S]*disable: option\.value === "mat" && backendConfig\.device !== "cuda"[\s\S]*fallbackMatDefaultModelIfNeeded[\s\S]*backendConfig\.model = "lama"[\s\S]*addTerminalLog\(MAT_CUDA_FALLBACK_MESSAGE, "warning"\)/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page switches backend mask-inpaint models and falls MAT back to LaMa with user-readable progress copy",
    pattern: /MASK_INPAINT_MODEL_IDS = \["lama", "mat"\][\s\S]*ensureBackendInpaintModel[\s\S]*modelRegistryStore\.switchModel\(requestedModel\)[\s\S]*handleModelChange\("lama", \{ notify: false \}\)[\s\S]*MAT_CUDA_FALLBACK_MESSAGE[\s\S]*正在使用 \$\{modelLabel\} 处理图片 0\/\$\{filesToProcess\.length\}/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/sam_service.py",
    description: "SAM capability diagnostics gate SAM3 text availability by release runtime profile",
    pattern: /def _release_runtime_profile[\s\S]*MOONSHINE_RUNTIME_FLAVOR[\s\S]*sam3TextSupportedByPackage[\s\S]*and release_runtime\["sam3TextSupportedByPackage"\][\s\S]*"releaseRuntime": release_runtime/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Packaged backend propagates runtime flavor and model bundle metadata",
    pattern: /function getPackagedRuntimeMetadata\(\)[\s\S]*getPackagedRuntimeMetadataPath\(\)[\s\S]*MOONSHINE_PACKAGED_RUNTIME[\s\S]*MOONSHINE_RUNTIME_FLAVOR[\s\S]*MOONSHINE_MODEL_BUNDLE/,
  });
  assertPattern({
    file: "scripts/build-runtime-win.mjs",
    description: "Windows runtime manifest records Python 3.12 package flavor and model bundle",
    pattern: /(?=[\s\S]*const runtimeFlavor = normalizeRuntimeFlavor)(?=[\s\S]*const modelBundle = normalizeModelBundle)(?=[\s\S]*pythonVersion: targetPythonVersion)(?=[\s\S]*runtimeFlavor,)(?=[\s\S]*modelBundle,)[\s\S]*/,
  });
  assertPattern({
    file: "scripts/package-win-matrix.mjs",
    description: "Windows release matrix writes all runtime/model-bundle combinations and SAM3 package policy",
    pattern: /const runtimeFlavors = \["cpu", "cu126", "cu130"\][\s\S]*const modelBundles = \["external-models", "bundled-models"\][\s\S]*writeReleaseMatrixManifest[\s\S]*sam3Policy[\s\S]*release-matrix\.json/,
  });
  assertPattern({
    file: "scripts/prepare-electron-resources.mjs",
    description: "Bundled model packages include only LaMa/SLBR and keep SAM weights external by default",
    pattern: /const bundledModelFileNames = new Set\(\["big-lama\.pt", "slbr\.pth\.tar"\]\)[\s\S]*normalizeModelBundle[\s\S]*external-models[\s\S]*bundled-models/,
  });
  assertPattern({
    file: "src/services/SamPredictionService.js",
    description: "Frontend SAM service calls the standalone prediction API",
    pattern: /predictSamMask[\s\S]*normalizePoints[\s\S]*normalizeBox[\s\S]*api\.post\("\/api\/v1\/moonshine\/sam\/predict"/,
  });
  assertPattern({
    file: "src/services/SamPredictionService.js",
    description: "Frontend SAM service can query standalone capability state",
    pattern: /getSamCapabilities[\s\S]*api\.get\("\/api\/v1\/moonshine\/sam\/capabilities"\)[\s\S]*读取 SAM 能力失败[\s\S]*getSamCapabilities[\s\S]*predictSamMask/,
  });
  assertPattern({
    file: "src/services/SamPredictionService.js",
    description: "Frontend SAM service exposes SAM2 video sync/job APIs and real SAM3 text calls",
    pattern: /propagateSamVideo[\s\S]*api\.post\("\/api\/v1\/moonshine\/sam\/video\/propagate"[\s\S]*createSamVideoPropagationJob[\s\S]*getSamVideoPropagationJob[\s\S]*getSamVideoPropagationJobResult[\s\S]*predictSamText[\s\S]*model_id: request\.model_id \|\| request\.modelId \|\| "sam3"[\s\S]*prompt_source[\s\S]*prompt_color[\s\S]*prompt_noun[\s\S]*api\.post\("\/api\/v1\/moonshine\/sam\/text\/predict"[\s\S]*SAM3 文本智能选区失败/,
  });
  assertPattern({
    file: "src/components/image/ImageProcessingToolbar.vue",
    description: "Image footer exposes three independently-tooltipped Quasar mask mode buttons",
    pattern: /v-for="button in visibleMaskModeButtons"[\s\S]*<q-btn[\s\S]*:data-testid="`image-mask-mode-\$\{button\.value\}`"[\s\S]*@click\.stop="handleMaskModeButtonClick\(button\)"[\s\S]*<q-tooltip>\{\{ maskModeButtonTooltip\(button\) \}\}<\/q-tooltip>[\s\S]*value:\s*"off"[\s\S]*value:\s*"manual"[\s\S]*value:\s*"smart"/,
  });
  assertPattern({
    file: "src/components/image/ImageProcessingToolbar.vue",
    description: "Image footer keeps smart selection visible but disables it until backend and SAM are ready",
    pattern: /backendReady[\s\S]*smartSelectionDisabledReason = computed[\s\S]*if \(!props\.backendReady\) return "后端服务启动成功后可用"[\s\S]*if \(!props\.smartSelectionAvailable\)[\s\S]*maskModeButtonDisabledReason[\s\S]*button\.value === "smart"[\s\S]*smartSelectionDisabledReason\.value/,
  });
  assertPattern({
    file: "src/components/image/ImageProcessingToolbar.vue",
    description: "Image footer compresses mask mode text and hides toolbar text at the same breakpoint as run/download",
    pattern: /(?=[\s\S]*:label="toolbarTextVisible \? '选择文件' : ''")(?=[\s\S]*:label="runButtonLabel")(?=[\s\S]*:label="\$q\.screen\.gt\.sm \? '下载' : ''")(?=[\s\S]*const toolbarTextVisible = computed\(\(\) => \$q\.screen\.gt\.sm\);)(?=[\s\S]*visibleMaskModeButtons = computed\(\(\) =>[\s\S]*\$q\.screen\.gt\.xs \? maskModeButtons\.value : \[currentMaskModeButton\.value\])(?=[\s\S]*const maskModeButtonLabel = \(button\) =>[\s\S]*toolbarTextVisible\.value && props\.maskMode === button\.value \? button\.label : "")(?=[\s\S]*const runButtonLabel = computed\(\(\) => \{[\s\S]*\$q\.screen\.gt\.sm \? "运行" : "")[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageProcessingToolbar.vue",
    description: "Image footer run button shows a loading startup state while the backend engine is preparing",
    pattern: /(?=[\s\S]*enginePreparing:\s*\{[\s\S]*type:\s*Boolean)(?=[\s\S]*enginePreparingLabel:\s*\{[\s\S]*type:\s*String)(?=[\s\S]*:icon="runButtonIcon")(?=[\s\S]*:loading="enginePreparing")(?=[\s\S]*<q-spinner size="20px" class="on-left" \/>)(?=[\s\S]*runButtonPreparingText = computed)(?=[\s\S]*props\.enginePreparing \? "sync" : "play_arrow")(?=[\s\S]*if \(props\.enginePreparing\)[\s\S]*"启动中")(?=[\s\S]*if \(props\.enginePreparing\) return true)(?=[\s\S]*if \(props\.enginePreparing\)[\s\S]*return runButtonPreparingText\.value)[\s\S]*/,
  });
  assertPattern({
    file: "src/shared/appConfigSchema.js",
    description: "Shared config migrates legacy general.modelPath into general.modelDir once and removes the old field",
    pattern: /if \(isPlainObject\(migrated\.general\)\) \{[\s\S]*const legacyModelPath = String\(migrated\.general\.modelPath \|\| ""\)\.trim\(\);[\s\S]*const modelDir = String\(migrated\.general\.modelDir \|\| ""\)\.trim\(\);[\s\S]*if \(!modelDir && legacyModelPath\) \{[\s\S]*migrated\.general\.modelDir = legacyModelPath;[\s\S]*\}[\s\S]*delete migrated\.general\.modelPath;[\s\S]*\}/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page passes SAM smart selection state and image payload into the editor",
    pattern: /:smart-selection-mode="isSmartSelectionMode"[\s\S]*:current-model="currentModel"[\s\S]*:sam-model-id="defaultSamModelId"[\s\S]*:sam-available="samPointBoxAvailable"[\s\S]*:sam-text-supported="samTextSupported"[\s\S]*:sam-text-available="samTextAvailable"[\s\S]*:sam-image="samImagePayload\.image"[\s\S]*:sam-image-type="samImagePayload\.imageType"[\s\S]*setMaskMode[\s\S]*"update:mask-mode"/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page offers SAM1/SAM2.1 point-box models plus available SAM3 text models in one selector",
    pattern: /(?=[\s\S]*:sam-model-options="samModelOptions")(?=[\s\S]*samPointBoxModelOptions = computed)(?=[\s\S]*installedMaskModels)(?=[\s\S]*\["sam", "sam2"\]\.includes\(model\.family\))(?=[\s\S]*configuredImageSamModelId = computed)(?=[\s\S]*imageSmartSelectionDefaultModel)(?=[\s\S]*samTextModelOptions = computed)(?=[\s\S]*model\.family === "sam3")(?=[\s\S]*defaultSamTextModelId\.value)(?=[\s\S]*samModelOptions = computed\(\(\) =>[\s\S]*samPointBoxModelOptions\.value[\s\S]*samTextModelOptions\.value)[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page can enter smart selection when SAM1/SAM2.1 point-box or SAM3 text is available",
    pattern: /(?=[\s\S]*samPointBoxAvailable = computed\(\(\) => samPointBoxModelOptions\.value\.length > 0\))(?=[\s\S]*samTextSupportedModelIds = \["sam3_1_multiplex", "sam3"\])(?=[\s\S]*samTextSupported = computed)(?=[\s\S]*samTextAvailable = computed\(\(\) =>[\s\S]*samTextSupported\.value[\s\S]*samCapabilities\.value\?\.text\?\.enabled)(?=[\s\S]*defaultSamTextModelId = computed[\s\S]*sam3_1_multiplex)(?=[\s\S]*samSmartSelectionAvailable = computed\([\s\S]*backendEngineValue\.value\.isRunning && \(samPointBoxAvailable\.value \|\| samTextSupported\.value\))(?=[\s\S]*resolvePreferredMaskMode[\s\S]*samSmartSelectionAvailable\.value \? "smart" : "manual")(?=[\s\S]*nextMode === "smart" && !samSmartSelectionAvailable\.value)(?=[\s\S]*后端服务启动成功后可用)(?=[\s\S]*请先在模型管理中安装 SAM1\/SAM2\.1 点选模型或 SAM3 文本模型)(?=[\s\S]*const order = \["off", "manual", "smart"\])[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page passes backend readiness and blocked smart-selection feedback into footer",
    pattern: /smartSelectionAvailable: samSmartSelectionAvailable\.value,[\s\S]*backendReady: backendEngineValue\.value\.isRunning,[\s\S]*"smart-selection-blocked": \(message\) => \{[\s\S]*message: message \|\| "后端服务启动成功后可用"/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page passes backend preparing state into the shared footer toolbar",
    pattern: /(?=[\s\S]*backendEngineValue = computed\(\(\) => \{[\s\S]*isPreparing: Boolean\(value\.isPreparing\?\.value \?\? value\.isPreparing\))(?=[\s\S]*enginePreparing: backendEngineValue\.value\.isPreparing)(?=[\s\S]*enginePreparingLabel: backendEngineValue\.value\.runDisabledTooltip)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker runs SAM point and box prompts and applies candidates to the current mask",
    pattern: /predictSamMask[\s\S]*runSamPrediction[\s\S]*const runModelId = effectiveSamModelId\.value[\s\S]*rememberExecutedSamModel\(runModelId\)[\s\S]*modelId:\s*runModelId[\s\S]*points:\s*point \? \[point\] : \[\][\s\S]*box,[\s\S]*renderSamCandidates[\s\S]*setSamCandidateEnabled[\s\S]*removeSamCandidate/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker keeps point-box prompts gated by SAM1/SAM2.1 availability",
    pattern: /samAvailable[\s\S]*sam-empty-state[\s\S]*请先在模型管理中安装 SAM1\/SAM2\.1 点选模型[\s\S]*if \(!selectedSamModelSupportsPointBox\.value \|\| !props\.samAvailable \|\| !effectiveSamModelId\.value\)[\s\S]*请先在模型管理中安装 SAM1\/SAM2\.1 点选模型/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker uses a Quasar select for switching installed SAM smart selection models",
    pattern: /<q-select[\s\S]*:options="resolvedSamModelOptions"[\s\S]*emit-value[\s\S]*map-options[\s\S]*@update:model-value="updateSelectedSamModel"/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker exposes SAM3 text prompt controls inside the smart-selection settings popup",
    pattern: /(?=[\s\S]*predictSamMask, predictSamText)(?=[\s\S]*data-testid="sam-settings-button")(?=[\s\S]*v-if="selectedSamModelSupportsText"[\s\S]*data-testid="sam-text-settings-section")(?=[\s\S]*v-model="samTextPrompt")(?=[\s\S]*label="自定义文本")(?=[\s\S]*v-model="samTextColor")(?=[\s\S]*v-model="samTextNoun")(?=[\s\S]*samGeneratedPromptText)(?=[\s\S]*buildSam3LexiconPrompt)(?=[\s\S]*selectedSamModelSupportsText = computed)(?=[\s\S]*selectedSamModelSupportsPointBox = computed)(?=[\s\S]*icon="image_search")(?=[\s\S]*@click="runSamTextPrediction")(?=[\s\S]*icon="select_all")(?=[\s\S]*label="检索选中图片")(?=[\s\S]*@click="requestSamTextBatchPrediction")(?=[\s\S]*samTextAvailable)(?=[\s\S]*canRunSamTextPrediction)(?=[\s\S]*canRunSamBatchTextPrediction)(?=[\s\S]*const runSamTextPrediction = async)(?=[\s\S]*当前 SAM 模型不支持文本智选)(?=[\s\S]*请先选择图片)(?=[\s\S]*predictSamText\()(?=[\s\S]*promptSource: promptSpec\.source)(?=[\s\S]*promptColor: promptSpec\.color)(?=[\s\S]*promptNoun: promptSpec\.noun)(?=[\s\S]*文本候选)(?=[\s\S]*source: "text")[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker constrains the SAM settings menu after dynamic text controls render",
    pattern: /(?=[\s\S]*ref="samSettingsMenuRef"[\s\S]*:content-class="samSettingsPopupContentClass"[\s\S]*ref="samSettingsPanelRef")(?=[\s\S]*sam-settings-toolbar-popup)(?=[\s\S]*syncSamSettingsMenuLayout)(?=[\s\S]*updatePosition)(?=[\s\S]*popupRect\.top < toolbarRect\.top)(?=[\s\S]*panelEl\.style\.maxHeight)(?=[\s\S]*panelEl\.style\.overflowY = "auto")(?=[\s\S]*popupEl\.style\.top)(?=[\s\S]*scheduleSamSettingsMenuLayoutSync)(?=[\s\S]*watch\([\s\S]*samSettingsMenuOpen)(?=[\s\S]*window\.cancelAnimationFrame\(samSettingsMenuLayoutFrame\))[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker keeps the last executed SAM model in the current page session",
    pattern: /(?=[\s\S]*lastExecutedSamModelId = ref\(getLastExecutedSamImageModelId\(\)\))(?=[\s\S]*const getTextModelId = \(\) => \{[\s\S]*selectedSamModelSupportsText\.value && effectiveSamModelId\.value[\s\S]*return effectiveSamModelId\.value)(?=[\s\S]*const rememberExecutedSamModel = \(modelId\) =>[\s\S]*lastExecutedSamModelId\.value = nextModelId[\s\S]*setLastExecutedSamImageModelId\(nextModelId\)[\s\S]*selectedSamModelId\.value = nextModelId)(?=[\s\S]*const runModelId = getTextModelId\(\)[\s\S]*rememberExecutedSamModel\(runModelId\)[\s\S]*modelId:\s*runModelId)(?=[\s\S]*buildSamTextCandidate\(candidate, index, result, prompt, runModelId\))(?=[\s\S]*lastExecutedSamModelId\.value,[\s\S]*props\.samModelId)[\s\S]*/,
  });
  assertAbsentPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker no longer exposes a separate SAM3 text smart-selection toolbar button",
    pattern: /data-testid="sam-text-menu-button"/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker supports selected-images SAM3 text batch progress and candidate session injection",
    pattern: /(?=[\s\S]*samTextBatchState)(?=[\s\S]*notFound)(?=[\s\S]*未检出)(?=[\s\S]*q-linear-progress)(?=[\s\S]*samTextBatchTargetCount)(?=[\s\S]*requestSamTextBatchPrediction)(?=[\s\S]*sam-text-batch-request)(?=[\s\S]*appendExternalSamTextResult)(?=[\s\S]*composeSamMaskDataUrl)(?=[\s\S]*defineExpose\(\{[\s\S]*appendExternalSamTextResult)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker reports SAM point, text, and batch processing state for the global loading overlay",
    pattern: /(?=[\s\S]*"sam-processing-state")(?=[\s\S]*const samProcessingState = computed)(?=[\s\S]*samTextBatchRunning\.value)(?=[\s\S]*samTextPredicting\.value)(?=[\s\S]*samPredicting\.value)(?=[\s\S]*emit\("sam-processing-state", state\))(?=[\s\S]*emit\("sam-processing-state", \{[\s\S]*running: false)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageEditor.vue",
    description: "Image editor forwards SAM processing state from ImageMasker to the page",
    pattern: /(?=[\s\S]*"sam-processing-state")(?=[\s\S]*@sam-processing-state="\$emit\('sam-processing-state', \$event\)")/,
  });
  assertPattern({
    file: "src/components/image/ImageEditor.vue",
    description: "Image editor forwards the current processing model into ImageMasker",
    pattern: /:current-model="currentModel"[\s\S]*currentModel:\s*\{[\s\S]*type:\s*String[\s\S]*default:\s*"lama"/,
  });
  assertPattern({
    file: "src/utils/samMaskAutoExpand.js",
    description: "Shared SAM auto-expand utility maps LaMa expansion radius from the SAM mask long side",
    pattern: /(?=[\s\S]*resolveSamAutoExpandRadius)(?=[\s\S]*maskLongSide)(?=[\s\S]*maskLongSide <= 64\) return 4)(?=[\s\S]*maskLongSide <= 160\) return 5)(?=[\s\S]*maskLongSide <= 360\) return 6)(?=[\s\S]*maskLongSide <= 720\) return 8)(?=[\s\S]*return 10)(?![\s\S]*imageLongSide)(?![\s\S]*normalizedLongSide)(?=[\s\S]*inspectSamMaskPixels)(?=[\s\S]*dilateBinaryAlphaMask)(?=[\s\S]*expandSamMaskImageDataForLama)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker auto-expands visible SAM candidates only for LaMa through the shared utility",
    pattern: /(?=[\s\S]*expandSamMaskImageDataForLama,[\s\S]*from "src\/utils\/samMaskAutoExpand")(?=[\s\S]*currentModel:\s*\{[\s\S]*type:\s*String)(?=[\s\S]*currentProcessingModelId)(?=[\s\S]*shouldAutoExpandSamMasks[\s\S]*=== "lama")(?=[\s\S]*hasEnabledSamCandidates[\s\S]*candidate\.enabled && candidate\.mask)(?=[\s\S]*expandSamMaskForLama[\s\S]*expandSamMaskImageDataForLama)(?=[\s\S]*resolveSamCandidateMaskForRendering)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker lets LaMa users override each SAM candidate expansion radius with a native 0-99px number input",
    pattern: /(?=[\s\S]*autoExpandPx)(?=[\s\S]*expandPx)(?=[\s\S]*resolveSamMaskAutoExpandPx)(?=[\s\S]*hydrateSamCandidateExpandPx)(?=[\s\S]*setSamCandidateExpandPx)(?![\s\S]*stepSamCandidateExpandPx)(?=[\s\S]*<q-input[\s\S]*type="number"[\s\S]*min="0"[\s\S]*max="99"[\s\S]*step="1"[\s\S]*suffix="px"[\s\S]*class="sam-expand-input")(?=[\s\S]*expandSamMaskForLama\(sourceMask, renderWidth, renderHeight, expandPx\))[\s\S]*/,
  });
  assertPattern({
    file: "src/utils/samMaskAutoExpand.js",
    description: "Shared SAM expansion utility accepts a manual radius override where 0 disables expansion",
    pattern: /(?=[\s\S]*normalizeSamExpandRadius)(?=[\s\S]*radiusOverride = null)(?=[\s\S]*radiusOverride == null \? autoRadius : normalizeSamExpandRadius\(radiusOverride, autoRadius\))(?=[\s\S]*if \(!radius\) return \{ imageData, expanded: false, radius: 0 \})[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker expands SAM masks before rendering without mutating the original candidate mask",
    pattern: /(?=[\s\S]*samExpandedMaskCache = new WeakMap\(\))(?=[\s\S]*Keep candidate\.mask untouched so every render starts from the original SAM result)(?=[\s\S]*renderSamCandidates[\s\S]*resolveSamCandidateMaskForRendering\(candidate)(?=[\s\S]*composeSamMaskDataUrl[\s\S]*resolveSamCandidateMaskForRendering\(candidate)(?=[\s\S]*watch\([\s\S]*\(\) => props\.currentModel[\s\S]*scheduleStableMaskComposite\(\))[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker clamps SAM point and box prompts to the canvas before prediction",
    pattern: /(?=[\s\S]*const clampSamCanvasPoint = \(point\) =>)(?=[\s\S]*Math\.max\(0, Math\.min\(width, Number\(point\?\.x \|\| 0\)\)\))(?=[\s\S]*Math\.max\(0, Math\.min\(height, Number\(point\?\.y \|\| 0\)\)\))(?=[\s\S]*const clampedStart = clampSamCanvasPoint\(startPoint\))(?=[\s\S]*const clampedEnd = clampSamCanvasPoint\(endPoint\))(?=[\s\S]*samDragPoint\.value = clampSamCanvasPoint\(getCanvasPoint\(event\)\))(?=[\s\S]*const endPoint = clampSamCanvasPoint\(getCanvasPoint\(event\) \|\| samDragPoint\.value \|\| startPoint\))(?=[\s\S]*samPointerStart\.value = clampSamCanvasPoint\(getCanvasPoint\(event\)\))[\s\S]*/,
  });
  assertPattern({
    file: "src/services/SamPredictionService.js",
    description: "SAM prediction service protects request payloads from negative point and box coordinates",
    pattern: /(?=[\s\S]*const normalizePoints = \(points = \[\]\) =>[\s\S]*Math\.max\(0, Number\(point\.x\) \|\| 0\))(?=[\s\S]*Math\.max\(0, Number\(point\.y\) \|\| 0\))(?=[\s\S]*const normalizeBox = \(box\) =>[\s\S]*Math\.max\(0, Number\(box\.x\) \|\| 0\))(?=[\s\S]*Math\.max\(0, Number\(box\.y\) \|\| 0\))(?=[\s\S]*Math\.max\(1, Number\(box\.width\) \|\| 1\))(?=[\s\S]*Math\.max\(1, Number\(box\.height\) \|\| 1\))[\s\S]*/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/sam_service.py",
    description: "SAM image and text candidates are sorted by score while keeping original model indexes",
    pattern: /(?=[\s\S]*def _sort_candidates_by_score\(candidates: list\[dict\]\) -> list\[dict\]:)(?=[\s\S]*score = candidate\.get\("score"\))(?=[\s\S]*return \(0, -score_value\))(?=[\s\S]*return sorted\(candidates, key=sort_key\))(?=[\s\S]*"index": index,[\s\S]*"score": float\(scores\[index\]\) if index < len\(scores\) else None,[\s\S]*candidates = self\._sort_candidates_by_score\(candidates\))(?=[\s\S]*"index": index,[\s\S]*"score": score,[\s\S]*candidates = self\._sort_candidates_by_score\(candidates\))[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker can erase SAM smart-selection candidates without modifying the manual base layer",
    pattern: /(?=[\s\S]*SAM_TOOL_MODES = Object\.freeze\(\{[\s\S]*SELECT: "select"[\s\S]*ERASE: "erase")(?=[\s\S]*data-testid="sam-tool-toggle-button")(?=[\s\S]*:data-mode="samToolMode")(?=[\s\S]*samToolToggleIcon = computed)(?=[\s\S]*samToolToggleTooltip = computed)(?=[\s\S]*toggleSamToolMode = \(\) => \{[\s\S]*setSamToolMode\(SAM_TOOL_MODES\.ERASE\))(?=[\s\S]*smartEraseDrawingEnabled)(?=[\s\S]*setSamToolMode)(?=[\s\S]*finishSamEraseOperation)(?=[\s\S]*applySamEraseOperationToEnabledCandidates)(?=[\s\S]*candidate\.eraseMask = canvas\.toDataURL\("image\/png"\))(?=[\s\S]*subtractSamEraseMask[\s\S]*globalCompositeOperation = "destination-out")(?=[\s\S]*resolveSamCandidateMaskForRendering[\s\S]*candidate\?\.eraseMask)(?=[\s\S]*renderSamCandidates\(\{ pushHistory: changed \}\))[\s\S]*/,
  });
  assertAbsentPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker no longer keeps separate select and erase smart-selection toolbar buttons",
    pattern: /data-testid="sam-(select|erase)-tool-button"/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker smart-selection popups have close buttons and auto-close when candidates are emptied",
    pattern: /(?=[\s\S]*data-testid="sam-settings-close-button"[\s\S]*@click="samSettingsMenuOpen = false")(?=[\s\S]*data-testid="sam-candidate-close-button"[\s\S]*@click="samCandidateMenuOpen = false")(?=[\s\S]*removeSamCandidate = async[\s\S]*samCandidates\.value\.length === 0[\s\S]*samCandidateMenuOpen\.value = false)(?=[\s\S]*clearSamCandidates = async[\s\S]*samCandidateMenuOpen\.value = false)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker explains how to switch SAM CPU execution to CUDA from the settings popup",
    pattern: /(?=[\s\S]*samCudaUsageHint)(?=[\s\S]*performance\.device[\s\S]*toLowerCase\(\) !== "cpu")(?=[\s\S]*全局设置或后端管理中将启动设备改为 CUDA)(?=[\s\S]*确认 CUDA 版运行时与 PyTorch 可用)(?=[\s\S]*class="sam-cuda-usage-hint")(?=[\s\S]*\.sam-cuda-usage-hint)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker closes smart-selection popups while SAM processing is globally loading",
    pattern: /(?=[\s\S]*samSettingsMenuOpen = ref\(false\))(?=[\s\S]*samCandidateMenuOpen = ref\(false\))(?=[\s\S]*closeSamToolbarPopups[\s\S]*samSettingsMenuOpen\.value = false[\s\S]*samCandidateMenuOpen\.value = false)(?=[\s\S]*watch\([\s\S]*samProcessingState[\s\S]*if \(state\.running\) \{[\s\S]*closeSamToolbarPopups\(\))(?=[\s\S]*sam-toolbar-popup-layer)(?=[\s\S]*sam-toolbar-tooltip-layer)(?=[\s\S]*z-index: 3200 !important)[\s\S]*/,
  });
  assertPattern({
    file: "src/layouts/MainLayout.vue",
    description: "Main layout global loading overlay remains above smart-selection toolbar popups",
    pattern: /\.global-loading \{[\s\S]*z-index: 4000 !important;/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker explains automatic LaMa expansion in the smart-selection model settings",
    pattern: /samAutoExpandNotice[\s\S]*当前结果已自动扩边，以提升 LaMa 边缘修复效果。/,
  });
  assertPattern({
    file: "src/composables/useRasterMaskEditor.js",
    description: "Raster mask editor returns manual operation metadata for SAM base-layer synchronization",
    pattern: /(?=[\s\S]*completedMode = operationMode\.value)(?=[\s\S]*completedTool = operationTool\.value \? \{ \.\.\.operationTool\.value \} : null)(?=[\s\S]*completedDirtyRect = dirtyRect\.value \? \{ \.\.\.dirtyRect\.value \} : null)(?=[\s\S]*completedOperationImageData)(?=[\s\S]*operation:\s*changed[\s\S]*mode: completedMode[\s\S]*tool: completedTool[\s\S]*dirtyRect: completedDirtyRect[\s\S]*imageData: completedOperationImageData)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker applies manual drawing to the SAM base layer before re-rendering smart candidates",
    pattern: /(?=[\s\S]*hasSamCandidateLayer = \(\) => samCandidates\.value\.some\(\(candidate\) => candidate\.mask\))(?=[\s\S]*resolveCurrentSamBaseSnapshot)(?=[\s\S]*applyRasterOperationToImageData)(?=[\s\S]*syncSamBaseSnapshotFromManualOperation[\s\S]*samBaseSnapshot\.value = nextBaseSnapshot[\s\S]*samBaseSnapshotDataUrl\.value = imageDataToDataUrl\(nextBaseSnapshot\)[\s\S]*renderSamCandidates\(\{ pushHistory: true \}\))(?=[\s\S]*finishCurrentOperation[\s\S]*await syncSamBaseSnapshotFromManualOperation\(result\))[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page runs selected-images SAM3 text batch prediction and writes masks per file",
    pattern: /(?=[\s\S]*getSamCapabilities,)(?=[\s\S]*predictSamText)(?=[\s\S]*selectedSamTextBatchFiles = computed)(?=[\s\S]*loadSamCapabilities)(?=[\s\S]*getFilesForSamTextBatch)(?=[\s\S]*resolveSamTextImageInput)(?=[\s\S]*applySamTextResultToFile)(?=[\s\S]*runSamTextBatchPrediction)(?=[\s\S]*let notFound = 0)(?=[\s\S]*predictSamText\()(?=[\s\S]*notFound \+= 1)(?=[\s\S]*failed \+= 1)(?=[\s\S]*未检出 \$\{notFound\} 张)(?=[\s\S]*fileManagerStore\.updateFileMask\(file\.id, applied\.mask\))[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page uses the same global loading overlay while SAM smart selection is processing",
    pattern: /(?=[\s\S]*@sam-processing-state="handleSamProcessingState")(?=[\s\S]*samSmartSelectionProcessingState = ref)(?=[\s\S]*samSmartSelectionOverlayActive = ref)(?=[\s\S]*handleSamProcessingState)(?=[\s\S]*loadingControl\?\.show\?\.\(\{[\s\S]*正在运行 SAM 智能选区)(?=[\s\S]*clearSamSmartSelectionOverlay\(\))[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker stores point, box, and text SAM candidates in one per-image candidate list",
    pattern: /(?=[\s\S]*samContextId)(?=[\s\S]*getSamImageSessionStore)(?=[\s\S]*samSessionByContext = getSamImageSessionStore\(\))(?=[\s\S]*getSamContextId = \(\) => \{[\s\S]*if \(explicitId\) return explicitId;[\s\S]*return `\$\{props\.samImageType \|\| "base64"\}:\$\{props\.samImage \|\| ""\}`)(?=[\s\S]*buildSamContextId = \(contextId\) => \{[\s\S]*return explicitId;)(?=[\s\S]*source: "text",[\s\S]*modelId,)(?=[\s\S]*source: box \? "box" : "point",[\s\S]*modelId: runModelId)(?=[\s\S]*appendExternalSamTextResult[\s\S]*const sessionKey = buildSamContextId\(contextId\)[\s\S]*modelId: modelId \|\| getTextModelId\(\))(?=[\s\S]*\(\) => \[props\.samContextId, props\.samImage, props\.samImageType\])[\s\S]*/,
  });
  assertPattern({
    file: "src/services/SamImageSessionStore.js",
    description: "SAM image candidate sessions survive ImageMasker remounts during image switching",
    pattern: /const samImageSessionByContext = new Map\(\)[\s\S]*let lastExecutedSamImageModelId = ""[\s\S]*export const getSamImageSessionStore = \(\) => samImageSessionByContext[\s\S]*export const getLastExecutedSamImageModelId = \(\) => lastExecutedSamImageModelId[\s\S]*export const setLastExecutedSamImageModelId = \(modelId = ""\) =>[\s\S]*export const clearSamImageSessionStore = \(\) => \{[\s\S]*samImageSessionByContext\.clear\(\)[\s\S]*lastExecutedSamImageModelId = ""/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker versions SAM render inputs instead of hashing mask data URLs",
    pattern: /(?=[\s\S]*let samBaseSnapshotRevision = 0)(?=[\s\S]*let samCandidatesRevision = 0)(?=[\s\S]*bumpSamBaseSnapshotRevision = \(\) => \{[\s\S]*samBaseSnapshotRevision \+= 1)(?=[\s\S]*bumpSamCandidatesRevision = \(\) => \{[\s\S]*samCandidatesRevision \+= 1)(?=[\s\S]*buildSamRenderSignature[\s\S]*baseRevision: samBaseSnapshotRevision[\s\S]*candidatesRevision: samCandidatesRevision[\s\S]*baseAlpha: getEffectiveMaskDisplayAlpha\(\))(?![\s\S]*compactDataUrlSignature)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker coalesces restored SAM candidate rendering after image switches",
    pattern: /(?=[\s\S]*let maskImageLoadVersion = 0)(?=[\s\S]*let stableCompositeFrame = 0)(?=[\s\S]*createMaskImageLoadGuard = \(\) => \{[\s\S]*contextId[\s\S]*maskImageLoadVersion \+= 1[\s\S]*isCurrent: \(\) => version === maskImageLoadVersion && contextId === getSamContextId\(\))(?=[\s\S]*scheduleStableMaskComposite = \(\) => \{[\s\S]*requestAnimationFrame[\s\S]*await nextTick\(\)[\s\S]*runStableMaskComposite\(contextId\))(?=[\s\S]*runStableMaskComposite = async \(contextId\) => \{[\s\S]*applyToolState\(\)[\s\S]*hasSamContextCandidates\(contextId\)[\s\S]*rerenderSamContextCandidates\(contextId\))(?![\s\S]*stableCompositeReasons)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker commits SAM mask composition to the visible canvas once",
    pattern: /(?=[\s\S]*renderSamCandidates = async[\s\S]*renderSignature === lastSamRenderSignature)(?=[\s\S]*samRenderInFlightSignature === renderSignature)(?=[\s\S]*const compositeCanvas = document\.createElement\("canvas"\))(?=[\s\S]*const compositeContext = compositeCanvas\.getContext\("2d", \{ willReadFrequently: true \}\))(?=[\s\S]*renderToken !== samRenderToken[\s\S]*contextId !== getSamContextId\(\))(?=[\s\S]*ctx\.value\.clearRect\(0, 0, width, height\)[\s\S]*ctx\.value\.drawImage\(compositeCanvas, 0, 0, width, height\))[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker routes SAM image switching through the stable composite path",
    pattern: /(?=[\s\S]*rerenderSamContextCandidates = async \(contextId = getSamContextId\(\)\)[\s\S]*contextId !== getSamContextId\(\)[\s\S]*!\(contextId === activeSamContextId\.value && hasActiveSamCandidateLayer\(\)\)[\s\S]*restoreSamContextSession\(\)[\s\S]*hasActiveSamCandidateLayer\(\)[\s\S]*renderSamCandidates\(\{ pushHistory: false \}\))(?=[\s\S]*if \(hasSamContextCandidates\(\)\) \{[\s\S]*scheduleStableMaskComposite\(\)[\s\S]*return;[\s\S]*if \(!props\.mask\))(?=[\s\S]*updateMask = \(newMask\)[\s\S]*hasSamContextCandidates\(\)[\s\S]*scheduleStableMaskComposite\(\))(?=[\s\S]*props\.mask[\s\S]*hasSamContextCandidates\(\)[\s\S]*scheduleStableMaskComposite\(\))(?=[\s\S]*props\.samContextId, props\.samImage, props\.samImageType[\s\S]*scheduleStableMaskComposite\(\))(?=[\s\S]*props\.toolState[\s\S]*scheduleStableMaskComposite\(\))[\s\S]*/,
  });
  assertPattern({
    file: "src/services/SamImageRenderCache.js",
    description: "SAM image render cache evicts only rendered cache while preserving original SAM candidates",
    pattern: /(?=[\s\S]*clearSamCandidateRenderCache = \(candidate = \{\}\) => \{[\s\S]*delete candidate\.renderedMask;[\s\S]*delete candidate\.renderedMaskMeta;)(?=[\s\S]*clearSamSessionRenderCache = \(session = \{\}\) => \{[\s\S]*for \(const candidate of session\.candidates \|\| \[\]\)[\s\S]*clearSamCandidateRenderCache\(candidate\))(?=[\s\S]*evictSamRenderCache[\s\S]*clearSamRenderCacheContext)[\s\S]*/,
  });
  assertPattern({
    file: "src/services/SamImageRenderCache.js",
    description: "SAM image render cache does not retain disabled or oversized contexts in the LRU table",
    pattern: /(?=[\s\S]*touchSamRenderCacheContext = \(\{[\s\S]*const canKeep = shouldKeepSamRenderedCache)(?=[\s\S]*if \(!config\.enabled\) \{[\s\S]*evictSamRenderCache\(\{ sessionStore, maskingConfig: config \}\);[\s\S]*return null;)(?=[\s\S]*if \(!canKeep\) \{[\s\S]*clearSamRenderCacheContext\(normalizedContextId, sessionStore\);[\s\S]*return null;)[\s\S]*/,
  });
  assertAbsentPattern({
    file: "src/services/SamImageRenderCache.js",
    description: "SAM image render cache does not keep unused whole-cache or preload-cancel exports",
    pattern: /export const (clearSamRenderCache|cancelSamRenderPreload) =/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker preserves rendered cache only when cache policy allows and session dimensions are known",
    pattern: /(?=[\s\S]*cloneSamCandidates = \(items = \[\], \{ preserveRenderCache = false \} = \{\}\)[\s\S]*delete nextCandidate\.renderedMask[\s\S]*delete nextCandidate\.renderedMaskMeta)(?=[\s\S]*canPreserveSamRenderCache[\s\S]*shouldKeepSamRenderedCache)(?=[\s\S]*resolveSamSessionDimensions = \(session = \{\}\)[\s\S]*session\.width[\s\S]*session\.height)(?=[\s\S]*saveSamContextSession[\s\S]*width:\s*Math\.max\(0, Number\(maskCanvas\.value\?\.width \|\| store\.imageWidth \|\| 0\)\)[\s\S]*height:\s*Math\.max\(0, Number\(maskCanvas\.value\?\.height \|\| store\.imageHeight \|\| 0\)\))[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker lazily renders inactive SAM candidates and generates previews on demand",
    pattern: /(?=[\s\S]*@mouseenter="prepareSamCandidatePreview\(candidate\.localId\)")(?=[\s\S]*const prepareSamCandidatePreview = async \(localId\) => \{(?:(?!bumpSamCandidatesRevision)[\s\S])*resolveSamCandidateMaskForRendering\(candidate[\s\S]*saveSamContextSession\(\);[\s\S]*\};)(?=[\s\S]*for \(const candidate of samCandidates\.value\)[\s\S]*if \(!candidate\.enabled\) continue)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker consumes SAM render preload queue off the visible canvas during idle time",
    pattern: /(?=[\s\S]*dequeueSamRenderPreload)(?=[\s\S]*preloadSamRenderContext = async \(contextId = "", priority = "visible"\)[\s\S]*normalizedContextId === getSamContextId\(\)[\s\S]*return false)(?=[\s\S]*resolveSamCandidateMaskForRendering\(candidate,[\s\S]*contextId: normalizedContextId)(?=[\s\S]*touchSamRenderCacheContext\(\{[\s\S]*contextId: normalizedContextId)(?=[\s\S]*flushSamRenderPreloadQueue = async \(\{ maxItems = 6, maxSucceeded = 2 \} = \{\}\)[\s\S]*let attempted = 0;[\s\S]*let succeeded = 0;[\s\S]*attempted < maxAttempts && succeeded < successLimit[\s\S]*succeeded \+= 1)(?=[\s\S]*requestIdleCallback)[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page queues visible and neighbor SAM render preloads without directly touching the visible canvas",
    pattern: /(?=[\s\S]*enqueueNeighborSamRenderPreload = \(\) => \{[\s\S]*normalizeSamRenderCacheConfig[\s\S]*cacheConfig\.neighborPreloadCount[\s\S]*enqueueSamRenderPreloadIds)(?=[\s\S]*handleLeftFileVisibleRangeChange = \(range = \{\}\) => \{[\s\S]*cacheConfig\.preloadVisibleList[\s\S]*window\.setTimeout\(\(\) => \{[\s\S]*enqueueSamRenderPreloadIds\(fileIds, "visible"\))(?=[\s\S]*clearSamRenderPreloadQueue\(\{ priority: "visible" \}\))(?=[\s\S]*scheduleSamRenderPreloadFlush)[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page exposes SAM render debug stats only through the test bridge or dev-only debug alias",
    pattern: /(?=[\s\S]*getSamRenderStats: \(\) => editorRef\.value\?\.getSamRenderStats\?\.\(\) \|\| null)(?=[\s\S]*flushSamRenderPreloadQueue: async \(options = \{\}\) =>)(?=[\s\S]*if \(import\.meta\.env\.DEV \|\| window\.__MOONSHINE_ENABLE_DEBUG_BRIDGE__\) \{[\s\S]*window\.__moonshineDebug)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker records SAM prompt metadata and exposes hover preview without mutating the mask",
    pattern: /(?=[\s\S]*v-if="samCandidateMenuOpen && hoveredSamCandidate"[\s\S]*sam-candidate-preview)(?=[\s\S]*hoveredSamCandidate = computed\(\(\) =>[\s\S]*samCandidateMenuOpen\.value[\s\S]*hoveredSamCandidateId\.value)(?=[\s\S]*hoveredCandidateId: "")(?=[\s\S]*hoveredSamCandidateId\.value = "")(?=[\s\S]*watch\([\s\S]*samCandidateMenuOpen[\s\S]*hoveredSamCandidateId\.value = "")(?=[\s\S]*prompt:\s*box \? \{ box \} : \{ point \})(?=[\s\S]*createdAt:\s*new Date\(\)\.toISOString\(\))[\s\S]*/,
  });
  assertPattern({
    file: "src/components/image/ImageMasker.vue",
    description: "Image masker displays SAM cache and timing feedback in the smart selection panel",
    pattern: /samPerformanceText[\s\S]*首次处理当前图片会计算图片特征[\s\S]*imageCacheHit[\s\S]*已复用图片特征[\s\S]*sam-performance-state/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image page passes the current file id as the SAM candidate context",
    pattern: /(?=[\s\S]*:sam-context-id="currentFile\.id")(?=[\s\S]*const handleMaskUpdate = \(maskData\) => \{[\s\S]*maskData\?\.contextId[\s\S]*fileManagerStore\.currentFile\?\.id[\s\S]*fileManagerStore\.updateFileMask\(targetFileId, maskData\?\.clear \? null : maskData\))[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Image E2E bridge can enter and inspect SAM smart selection mode",
    pattern: /setMaskMode: \(value\) => \{[\s\S]*setMaskMode\(value,\s*\{ persist: true \}\)[\s\S]*maskMode: maskMode\.value[\s\S]*smartSelectionMode: isSmartSelectionMode\.value/,
  });
  assertPattern({
    file: "scripts/e2e-sam-smart-selection-ui.mjs",
    description: "SAM UI smoke test checks SAM1/SAM2.1 point-box options, SAM3 text entry, and dark mode",
    pattern: /samModelOptions\.includes\("sam_vit_b"\)[\s\S]*samModelOptions\.includes\("sam2_1_hiera_large"\)[\s\S]*samModelOptions\.includes\("sam3_1_multiplex"\)[\s\S]*!smartSnapshot\.smart\.samModelOptions\.includes\("sam3"\)[\s\S]*defaultSamTextModelId === "sam3_1_multiplex"[\s\S]*SAM text prompt should be enabled when SAM3 is installed[\s\S]*Current-image and selected-images text search should be enabled[\s\S]*distinct dark-mode style/,
  });

  logSection("Bulk Import");
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron exposes get-files-stats IPC",
    pattern: /ipcMain\.handle\("get-files-stats", async \(event, filePaths = \[\]\) =>/,
  });
  assertPattern({
    file: "src/stores/fileManager.js",
    description: "File store supports chunked path-file insertion with path-key dedupe",
    pattern: /addPathFiles\(descriptors = \[\]\)[\s\S]*existingPathKeys[\s\S]*this\.files\.push\(\.\.\.createdFiles\)/,
  });
  assertPattern({
    file: "src/components/common/MoonshineFile.vue",
    description: "Uploader uses batch stats, chunked insertion, and virtual floating list",
    pattern: /<q-virtual-scroll[\s\S]*get-files-stats[\s\S]*loadFilesFromPathsOptimized[\s\S]*addPathFiles\(chunk\)/,
  });
  assertPattern({
    file: "src/components/common/MoonshineFile.vue",
    description: "Uploader only shows the floating file indicator when there are files to show and keeps the button content on one line",
    pattern: /v-if="shouldShowFileIndicator"[\s\S]*const shouldShowFileIndicator = computed\(\(\) => floatingListFiles\.value\.length > 0\)[\s\S]*\.file-select-btn \:deep\(\.q-btn__content\) \{[\s\S]*flex-wrap: nowrap;[\s\S]*white-space: nowrap;/,
  });
  assertPattern({
    file: "src/components/common/MaskBrushControls.vue",
    description: "Manual mask drawing toolbar uses compact button groups like the SAM smart selection toolbar",
    pattern: /(?=[\s\S]*\.tool-main-group \{[\s\S]*flex: 0 0 auto)(?=[\s\S]*\.control-button \{[\s\S]*min-width: 46px)(?=[\s\S]*\.mode-toggle \{[\s\S]*min-width: 0;[\s\S]*flex: 0 0 auto)(?=[\s\S]*\.mode-button \{[\s\S]*flex: 0 0 auto;[\s\S]*min-width: 46px)(?=[\s\S]*--mask-controls-min-width": `\$\{minWidthMap\[resolvedButtonSize\.value\] \|\| minWidthMap\.md\}px`)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/common/MoonshineFile.vue",
    description: "Image footer file popup can show selected files/current preview with lazy thumbnails and mask tags",
    pattern: /(?=[\s\S]*listMode)(?=[\s\S]*selectedImageFiles)(?=[\s\S]*currentPreviewFile)(?=[\s\S]*floatingListTitle)(?=[\s\S]*loading="lazy")(?=[\s\S]*moonshine-file-mask-tag)(?=[\s\S]*moonshine-file-unselect)[\s\S]*moonshine-file-delete/,
  });
  assertPattern({
    file: "src/components/image/ImageProcessingToolbar.vue",
    description: "Image processing footer uses the selected-file popup mode",
    pattern: /<moonshine-file[\s\S]*list-mode="selection"/,
  });
  assertPattern({
    file: "src/components/common/FileList.vue",
    description: "Left image list uses QVirtualScroll",
    pattern: /<q-virtual-scroll[\s\S]*:items="filteredFiles"[\s\S]*virtual-scroll-item-size/,
  });
  assertPattern({
    file: "src/components/common/FileList.vue",
    description: "Left image list exposes toggleable select all, invert selection, shortened delete, and middle ellipsis tooltip",
    pattern: /(?=[\s\S]*data-testid="image-file-list-select-all")(?=[\s\S]*allVisibleImagesSelected)(?=[\s\S]*data-testid="image-file-list-invert-selection")(?=[\s\S]*label="删除")(?=[\s\S]*formatMiddleEllipsis)[\s\S]*<q-tooltip>\{\{ file\.name \}\}<\/q-tooltip>/,
  });

  console.log("\nAll P1 image regression assertions passed.");
}

try {
  runAssertions();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
