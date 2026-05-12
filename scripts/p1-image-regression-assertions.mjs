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
    file: "src-electron/electron-main.js",
    description: "Electron save-app-config validates raw payload before sanitizing",
    pattern: /validateConfig\(mergeConfigForStrictValidation\(newConfig\)\)[\s\S]*const sanitizedConfig = sanitizeAppConfig\(newConfig\)/,
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
  assertPattern({
    file: "src/pages/IndexPage.vue",
    description: "Download filenames use latest result extension",
    pattern: /const outputExtension = latestImage\?\.extension \|\| extension \|\| "\.png";/,
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
    file: "src/components/common/FileList.vue",
    description: "Left image list uses QVirtualScroll",
    pattern: /<q-virtual-scroll[\s\S]*:items="filteredFiles"[\s\S]*virtual-scroll-item-size/,
  });

  console.log("\nAll P1 image regression assertions passed.");
}

try {
  runAssertions();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
