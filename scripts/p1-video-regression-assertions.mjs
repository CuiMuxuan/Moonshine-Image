import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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

function assertOrder({ file, description, before, after }) {
  const content = readText(file);
  const beforeIndex = content.indexOf(before);
  const afterIndex = content.indexOf(after);
  if (beforeIndex < 0 || afterIndex < 0 || beforeIndex >= afterIndex) {
    throw new Error(`Assertion failed: ${description}\nFile: ${file}`);
  }
  console.log(`PASS  ${description}`);
}

function logSection(title) {
  console.log(`\n[${title}]`);
}

function resolveFfmpegBinRoot() {
  const candidates = [
    process.env.MOONSHINE_FFMPEG_ROOT,
    "C:\\code\\ffmpeg",
    "C:\\code\\ffmpeg\\bin",
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const binRoot = fs.existsSync(path.join(candidate, "ffmpeg.exe"))
      ? candidate
      : path.join(candidate, "bin");
    const ffmpegPath = path.join(binRoot, "ffmpeg.exe");
    const ffprobePath = path.join(binRoot, "ffprobe.exe");
    if (fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath)) {
      return { binRoot, ffmpegPath, ffprobePath };
    }
  }

  throw new Error(
    "FFmpeg runtime not found. Set MOONSHINE_FFMPEG_ROOT or place it at C:\\code\\ffmpeg."
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  return result;
}

function writePpmFrame(filePath, width, height, color) {
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii");
  const pixels = Buffer.alloc(width * height * 3);
  for (let index = 0; index < pixels.length; index += 3) {
    pixels[index] = color[0];
    pixels[index + 1] = color[1];
    pixels[index + 2] = color[2];
  }
  fs.writeFileSync(filePath, Buffer.concat([header, pixels]));
}

function escapeConcatPath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

function runFfmpegSmoke() {
  const { ffmpegPath, ffprobePath } = resolveFfmpegBinRoot();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-video-regression-"));
  try {
    const frames = [
      path.join(workDir, "frame_000001.ppm"),
      path.join(workDir, "frame_000002.ppm"),
      path.join(workDir, "frame_000003.ppm"),
    ];
    writePpmFrame(frames[0], 64, 64, [138, 113, 212]);
    writePpmFrame(frames[1], 64, 64, [38, 121, 166]);
    writePpmFrame(frames[2], 64, 64, [230, 207, 173]);

    const concatPath = path.join(workDir, "frames.ffconcat");
    const concatLines = ["ffconcat version 1.0"];
    frames.forEach((framePath) => {
      concatLines.push(`file '${escapeConcatPath(framePath)}'`);
      concatLines.push("duration 0.10000000");
    });
    concatLines.push(`file '${escapeConcatPath(frames.at(-1))}'`);
    fs.writeFileSync(concatPath, `${concatLines.join("\n")}\n`, "utf8");

    const segmentPath = path.join(workDir, "segment.mp4");
    run(ffmpegPath, [
      "-y",
      "-hide_banner",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatPath,
      "-r",
      "10",
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      segmentPath,
    ]);

    const sourcePath = path.join(workDir, "source-with-audio.mp4");
    run(ffmpegPath, [
      "-y",
      "-hide_banner",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x64:r=10:d=0.4",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:duration=0.4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      sourcePath,
    ]);

    const finalPath = path.join(workDir, "final.mp4");
    run(ffmpegPath, [
      "-y",
      "-hide_banner",
      "-i",
      segmentPath,
      "-i",
      sourcePath,
      "-map",
      "0:v:0",
      "-map",
      "1:a?",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-shortest",
      finalPath,
    ]);

    const probeResult = run(ffprobePath, [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      finalPath,
    ]);
    const probe = JSON.parse(probeResult.stdout || "{}");
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    if (!streams.some((stream) => stream.codec_type === "video")) {
      throw new Error("FFmpeg smoke output has no video stream.");
    }
    if (!streams.some((stream) => stream.codec_type === "audio")) {
      throw new Error("FFmpeg smoke output has no audio stream.");
    }

    console.log("PASS  FFmpeg smoke encodes frame sequence and muxes source audio");
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function runAssertions() {
  console.log("Running P1 video regression assertions...");

  logSection("Video Engine Config");
  assertPattern({
    file: "src/shared/appConfigSchema.js",
    description: "Shared schema exposes auto/webav/ffmpeg video engine options",
    pattern: /VIDEO_PROCESSING_ENGINE_OPTIONS = Object\.freeze\(\["auto", "webav", "ffmpeg"\]\)[\s\S]*videoProcessingEngine:\s*"auto"/,
  });
  assertPattern({
    file: "src/components/global/GlobalSettings.vue",
    description: "Global settings exposes video engine select in advanced video settings",
    pattern: /<q-tab-panel name="video"[\s\S]*v-model="localConfig\.advanced\.videoProcessingEngine"[\s\S]*global-settings-video-processing-engine/,
  });

  logSection("FFmpeg Export Path");
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron resolves packaged and development FFmpeg paths",
    pattern: /getPackagedFfmpegResourceRootPath[\s\S]*MOONSHINE_FFMPEG_ROOT[\s\S]*C:\\\\code\\\\ffmpeg\\\\bin/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "Electron exposes FFmpeg encode, concat, mux and cancel IPC",
    pattern: /check-ffmpeg-runtime[\s\S]*ffprobe-media[\s\S]*ffmpeg-encode-frame-sequence[\s\S]*ffmpeg-concat-segments[\s\S]*ffmpeg-mux-audio[\s\S]*cancel-ffmpeg-task/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video page can retry WebAV export stages through FFmpeg",
    pattern: /runWithVideoProcessingEngine[\s\S]*exportProcessedBatchSegmentWithFfmpeg[\s\S]*finalizeProcessedVideoWithFfmpeg/,
  });

  logSection("Video Progress Feedback");
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video processing progress uses explicit frontend phases",
    pattern: /VIDEO_PROCESSING_PHASES = Object\.freeze\(\{[\s\S]*PREPARING: "preparing"[\s\S]*STAGING: "staging"[\s\S]*BACKEND: "backend"[\s\S]*FINALIZING: "finalizing"[\s\S]*WRITING: "writing"/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Backend management hint is only shown during backend model processing",
    pattern: /normalizedPhase === VIDEO_PROCESSING_PHASES\.BACKEND && backendRunningState\?\.value[\s\S]*可打开后端管理页面查看进度/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Preparation, frame staging, encoding and finalization update their own phases",
    pattern: /(?=[\s\S]*VIDEO_PROCESSING_PHASES\.PREPARING)(?=[\s\S]*VIDEO_PROCESSING_PHASES\.STAGING)(?=[\s\S]*VIDEO_PROCESSING_PHASES\.ENCODING)(?=[\s\S]*VIDEO_PROCESSING_PHASES\.FINALIZING)(?=[\s\S]*VIDEO_PROCESSING_PHASES\.WRITING)/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video processing messages can show current stage progress",
    pattern: /formatStageProgressText[\s\S]*当前阶段 \$\{percent\}%[\s\S]*etaProgress: normalizedEtaProgress/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video page passes backend preparing state into the resource manager run button",
    pattern: /(?=[\s\S]*:engine-preparing="backendEngineValue\.isPreparing")(?=[\s\S]*:engine-preparing-label="backendEngineValue\.runDisabledTooltip")(?=[\s\S]*backendEngineValue = computed\(\(\) => \{[\s\S]*isPreparing: Boolean\(value\.isPreparing\?\.value \?\? value\.isPreparing\))[\s\S]*/,
  });
  assertPattern({
    file: "src/components/video/ResourceManage.vue",
    description: "Video resource manager run button shows loading startup state while backend engine is preparing",
    pattern: /(?=[\s\S]*enginePreparing:\s*\{[\s\S]*type:\s*Boolean)(?=[\s\S]*enginePreparingLabel:\s*\{[\s\S]*type:\s*String)(?=[\s\S]*:icon="runButtonIcon")(?=[\s\S]*:loading="isProcessing \|\| enginePreparing")(?=[\s\S]*<q-spinner size="20px" class="on-left" \/>)(?=[\s\S]*backendPreparingText = computed)(?=[\s\S]*props\.enginePreparing \? "sync" : "play_arrow")(?=[\s\S]*if \(props\.enginePreparing\) return "启动中")(?=[\s\S]*engineRunDisabled \|\| enginePreparing)(?=[\s\S]*if \(props\.enginePreparing\) return backendPreparingText\.value)[\s\S]*/,
  });

  logSection("SAM2 Video Workflow");
  assertPattern({
    file: "server/moonshine_server/schema.py",
    description: "SAM2 video request supports direct video paths and multi-object prompts while keeping legacy fields",
    pattern: /class SamVideoObjectPrompt[\s\S]*object_id:\s*int[\s\S]*points:\s*List\[SamPromptPoint\][\s\S]*class MoonshineSamVideoPropagateRequest[\s\S]*input_type:\s*Literal\["jpegFrameDirectory",\s*"videoPath"\][\s\S]*frame_dir:\s*Optional\[str\][\s\S]*video_path:\s*Optional\[str\][\s\S]*object_id:\s*int[\s\S]*objects:\s*List\[SamVideoObjectPrompt\][\s\S]*frame_dir is required[\s\S]*video_path is required/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/sam_service.py",
    description: "SAM2 video service stages local video paths, registers multiple object prompts, and reports real progress phases",
    pattern: /(?=[\s\S]*import cv2)(?=[\s\S]*def _emit_progress)(?=[\s\S]*def _stage_video_to_jpeg_frames[\s\S]*progress_callback)(?=[\s\S]*cv2\.VideoCapture)(?=[\s\S]*cv2\.imwrite)(?=[\s\S]*def _normalize_video_objects)(?=[\s\S]*duplicate_ids)(?=[\s\S]*def propagate_video)(?=[\s\S]*input_type: str = "jpegFrameDirectory")(?=[\s\S]*video_path: Optional\[str\])(?=[\s\S]*progress_callback: Optional\[Callable)(?=[\s\S]*emit_frame_loading_progress)(?=[\s\S]*progress_callback=emit_frame_loading_progress)(?=[\s\S]*for prompt_index, prompt in enumerate\(normalized_objects)(?=[\s\S]*predictor\.add_new_points_or_box)(?=[\s\S]*status="propagating")(?=[\s\S]*status="writing_masks")(?=[\s\S]*"objectCount": len\(normalized_objects\))(?=[\s\S]*"type": normalized_input_type)[\s\S]*/,
  });
  assertPattern({
    file: "server/moonshine_server/plugins/segment_anything2/sam2_video_predictor.py",
    description: "Bundled SAM2 video predictor passes optional frame-loading progress callbacks through init_state",
    pattern: /def init_state\([\s\S]*progress_callback=None[\s\S]*load_video_frames\([\s\S]*progress_callback=progress_callback/,
  });
  assertPattern({
    file: "server/moonshine_server/plugins/segment_anything2/utils/misc.py",
    description: "Bundled SAM2 frame loading reports real frame-loading progress without changing default callers",
    pattern: /(?=[\s\S]*class AsyncVideoFrameLoader[\s\S]*progress_callback=None)(?=[\s\S]*self\.progress_callback = progress_callback)(?=[\s\S]*def load_video_frames\([\s\S]*progress_callback=None)(?=[\s\S]*def load_video_frames_from_jpg_images\([\s\S]*progress_callback=None)(?=[\s\S]*progress_callback\(n \+ 1, num_frames\))(?=[\s\S]*def load_video_frames_from_video_file\([\s\S]*progress_callback=None)(?=[\s\S]*progress_callback\(index \+ 1, total\))[\s\S]*/,
  });
  assertPattern({
    file: "server/moonshine_server/api.py",
    description: "SAM2 video API keeps the sync endpoint and adds pollable real-progress job endpoints",
    pattern: /(?=[\s\S]*add_api_route\("\/api\/v1\/moonshine\/sam\/video\/propagate", self\.api_moonshine_sam_video_propagate)(?=[\s\S]*add_api_route\("\/api\/v1\/moonshine\/sam\/video\/propagate\/jobs", self\.api_moonshine_sam_video_propagate_job_create)(?=[\s\S]*add_api_route\("\/api\/v1\/moonshine\/sam\/video\/propagate\/jobs\/\{task_id\}", self\.api_moonshine_sam_video_propagate_job)(?=[\s\S]*add_api_route\("\/api\/v1\/moonshine\/sam\/video\/propagate\/jobs\/\{task_id\}\/result", self\.api_moonshine_sam_video_propagate_job_result)(?=[\s\S]*add_api_route\("\/api\/v1\/moonshine\/sam\/video\/propagate\/jobs\/\{task_id\}\/cancel", self\.api_moonshine_sam_video_propagate_job_cancel)(?=[\s\S]*def api_moonshine_sam_video_propagate[\s\S]*video_path=req\.video_path[\s\S]*input_type=req\.input_type[\s\S]*objects=req\.objects)(?=[\s\S]*def _run_sam_video_propagate_task[\s\S]*progress_callback=sam_video_task_manager\.make_progress_callback\(task_id\))[\s\S]*/,
  });
  assertPattern({
    file: "server/moonshine_server/api.py",
    description: "SAM2 video status polling access logs are filtered without silencing result or cancel requests",
    pattern: /(?=[\s\S]*class SamVideoPollingAccessLogFilter\(logging\.Filter\))(?=[\s\S]*SAM_VIDEO_POLLING_PATH_PREFIX = "\/api\/v1\/moonshine\/sam\/video\/propagate\/jobs\/")(?=[\s\S]*record\.name != "uvicorn\.access")(?=[\s\S]*"GET " not in message)(?=[\s\S]*return "\/result" in message or "\/cancel" in message)(?=[\s\S]*access_logger = logging\.getLogger\("uvicorn\.access"\))(?=[\s\S]*access_logger\.addFilter\(SamVideoPollingAccessLogFilter\(\)\))[\s\S]*/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/sam_video_tasks.py",
    description: "SAM2 video task manager stores in-memory job status, result, error, and best-effort cancellation state",
    pattern: /(?=[\s\S]*SAM_VIDEO_TASK_STATUSES[\s\S]*"queued"[\s\S]*"frame_loading"[\s\S]*"prompt_encoding"[\s\S]*"propagating"[\s\S]*"writing_masks"[\s\S]*"completed"[\s\S]*"failed"[\s\S]*"canceled")(?=[\s\S]*class SamVideoTask)(?=[\s\S]*def to_dict)(?=[\s\S]*class SamVideoTaskManager)(?=[\s\S]*def create_task)(?=[\s\S]*def cancel_task)(?=[\s\S]*def finish_task)(?=[\s\S]*def fail_task)(?=[\s\S]*def make_progress_callback)[\s\S]*/,
  });
  assertPattern({
    file: "src/services/SamPredictionService.js",
    description: "Frontend SAM service sends SAM2 video payloads and exposes sync plus job polling APIs",
    pattern: /(?=[\s\S]*const buildSamVideoPayload = \(request = \{\}\) =>)(?=[\s\S]*inputType)(?=[\s\S]*objects = Array\.isArray\(request\.objects\))(?=[\s\S]*input_type: inputType)(?=[\s\S]*video_path: request\.video_path \|\| request\.videoPath)(?=[\s\S]*response_type: request\.response_type \|\| request\.responseType \|\| "base64")(?=[\s\S]*mask_output_dir: request\.mask_output_dir \|\| request\.maskOutputDir \|\| null)(?=[\s\S]*propagateSamVideo[\s\S]*\/api\/v1\/moonshine\/sam\/video\/propagate)(?=[\s\S]*createSamVideoPropagationJob[\s\S]*\/api\/v1\/moonshine\/sam\/video\/propagate\/jobs)(?=[\s\S]*getSamVideoPropagationJob)(?=[\s\S]*getSamVideoPropagationJobResult)(?=[\s\S]*cancelSamVideoPropagationJob)[\s\S]*/,
  });
  assertPattern({
    file: "src-electron/electron-preload.js",
    description: "Electron preload exposes webUtils.getPathForFile so desktop video uploads can keep their real local path",
    pattern: /const \{ contextBridge, ipcRenderer, webUtils \} = require\("electron"\)[\s\S]*getPathForFile: \(file\) => \{[\s\S]*typeof webUtils\?\.getPathForFile !== "function"[\s\S]*return webUtils\.getPathForFile\(file\);/,
  });
  assertPattern({
    file: "src/components/video/VideoUploaderButton.vue",
    description: "Video uploader records Electron local file paths before falling back to browser file.path",
    pattern: /const getVideoFileLocalPath = \(file\) => \{[\s\S]*window\.electron\?\.ipcRenderer\?\.getPathForFile\?\.\(file\)[\s\S]*file\.path[\s\S]*const sourcePath = getVideoFileLocalPath\(file\);[\s\S]*videoStore\.setVideoFile\(file,[\s\S]*sourcePath,[\s\S]*emit\("uploaded", \{[\s\S]*sourcePath,/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video drag/drop records Electron local file paths before falling back to browser file.path",
    pattern: /const getVideoFileLocalPath = \(file\) => \{[\s\S]*window\.electron\?\.ipcRenderer\?\.getPathForFile\?\.\(file\)[\s\S]*file\.path[\s\S]*const loadDroppedVideoFile = async \(file\) => \{[\s\S]*const sourcePath = getVideoFileLocalPath\(file\);[\s\S]*videoStore\.setVideoFile\(file,[\s\S]*sourcePath,/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video page creates empty SAM smart-selection tracks and writes bidirectional job results back into the selected track",
    pattern: /(?=[\s\S]*sam-video-action-disabled)(?=[\s\S]*samVideoSelectionActionTooltip)(?=[\s\S]*run-sam-video-selection)(?=[\s\S]*runSamVideoSelectionFromMaskList[\s\S]*createEmptySamVideoMaskTrack)(?=[\s\S]*selectedMaskIsSamVideo)(?=[\s\S]*selectedSamVideoPromptObjects)(?=[\s\S]*canRunSamVideoPropagation[\s\S]*selectedSamVideoPromptObjects\.value\.length > 0)(?=[\s\S]*handleSamVideoPromptFromOverlay)(?=[\s\S]*runSamVideoPropagationJob)(?=[\s\S]*getSamVideoPropagationJobResult)(?=[\s\S]*mergeSamVideoPropagationResults)(?=[\s\S]*propagation: "bidirectional")(?=[\s\S]*reverse: true)(?=[\s\S]*updateSamVideoMaskTrackResult\(targetMaskId, result\))(?=[\s\S]*正在写入智能选区轨道)[\s\S]*/,
  });
  assertAbsentPattern({
    file: "src/pages/VideoPage.vue",
    description: "SAM video unified select tool no longer keeps point/box mode constants that can trigger setup TDZ regressions",
    pattern: /SAM_VIDEO_TOOL_MODES|samVideoToolMode/,
  });
  assertAbsentPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video page no longer renders the old standalone SAM2 video settings panel",
    pattern: /SAM2 视频选区设置|sam-video-panel/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "SAM2 video selection remains runnable for previewable desktop files and resolves a temp local path at runtime",
    pattern: /(?=[\s\S]*const canRunSamVideoPropagation = computed\([\s\S]*videoStore\.hasVideoFile[\s\S]*Boolean\(videoStore\.videoFile\)[\s\S]*selectedMaskIsSamVideo\.value[\s\S]*selectedSamVideoPromptObjects\.value\.length > 0)(?=[\s\S]*const checkLocalFileExists = async \(filePath\) => \{[\s\S]*get-file-stats)(?=[\s\S]*const ensureSamVideoSourcePath = async \(\) => \{[\s\S]*await checkLocalFileExists\(existingPath\)[\s\S]*原视频路径已失效，正在缓存当前视频到本地临时文件[\s\S]*resolveVideoSourcePath\(videoStore\.videoFile, \{[\s\S]*preferExistingPath: !existingPath)(?=[\s\S]*videoStore\.setCurrentSourceMeta\(\{[\s\S]*sourcePath,[\s\S]*sourceName: videoStore\.currentSourceName \|\| videoStore\.videoFile\??\.name \|\| "")[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video source resolver validates stale file.path values before falling back to the desktop temp video cache",
    pattern: /const resolveVideoSourcePath = async \(file, options = \{\}\) => \{[\s\S]*preferExistingPath = true[\s\S]*await checkLocalFileExists\(filePath\)[\s\S]*视频原始路径已不可用，正在保存临时视频副本[\s\S]*file\.arrayBuffer[\s\S]*save-temp-video[\s\S]*temporarySourcePath: sourcePath/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "SAM2 video selection uses global loading with job progress and explains missing local video paths",
    pattern: /(?=[\s\S]*v-if="isProcessing \|\| samVideoState\.running")(?=[\s\S]*samVideoMissingLocalPathMessage)(?=[\s\S]*当前视频没有后端可读取的本地文件路径)(?=[\s\S]*getSamVideoJobStageText)(?=[\s\S]*applySamVideoJobProgress)(?=[\s\S]*runSamVideoPropagationJob)(?=[\s\S]*createSamVideoPropagationJob)(?=[\s\S]*getSamVideoPropagationJob)(?=[\s\S]*getSamVideoPropagationJobResult)(?=[\s\S]*正向传播)(?=[\s\S]*反向传播)(?=[\s\S]*缓存阶段 · 写入本地蒙版资产)(?=[\s\S]*updateSamVideoGlobalLoadingOverlay\("完成阶段：正在写入智能选区轨道", 1\))(?=[\s\S]*actionLabel: "打开后端管理")(?=[\s\S]*可打开后端管理页面查看进度)(?=[\s\S]*hideGlobalLoadingOverlay\(\))[\s\S]*/,
  });
  assertPattern({
    file: "src/layouts/MainLayout.vue",
    description: "Global loading overlay can expose a backend-management action while preserving progress-only callers",
    pattern: /(?=[\s\S]*loadingState\.actionLabel)(?=[\s\S]*class="global-loading-action")(?=[\s\S]*@click="loadingState\.onAction\?\.\(\)")(?=[\s\S]*actionLabel: String\(messageOrOptions\.actionLabel \|\| ""\)\.trim\(\))(?=[\s\S]*typeof messageOrOptions\.onAction === "function")(?=[\s\S]*pointer-events:\s*auto;)[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Fullscreen toolbar switches between manual drawing tools and SAM smart-selection tools by selected track type",
    pattern: /(?=[\s\S]*const selectedMaskIsEditableStandard = computed\(\(\) =>[\s\S]*isEditableStandardMask\(videoStore\.selectedMask\))(?=[\s\S]*const selectedMaskIsSamVideo = computed)(?=[\s\S]*const isFullscreenLamaViewportMode = computed\([\s\S]*selectedMaskIsEditableStandard\.value[\s\S]*!samVideoState\.running[\s\S]*!isProcessing\.value)(?=[\s\S]*const isFullscreenSamViewportMode = computed\([\s\S]*selectedMaskIsSamVideo\.value[\s\S]*!samVideoState\.running)(?=[\s\S]*<MaskFloatingToolbar[\s\S]*v-if="isFullscreenLamaViewportMode")(?=[\s\S]*v-if="isFullscreenSamViewportMode")[\s\S]*(?=[\s\S]*class="sam-video-floating-toolbar toolbar-container app-floating-toolbar")(?=[\s\S]*data-testid="video-sam-fullscreen-settings-button")(?=[\s\S]*data-testid="video-sam-fullscreen-candidate-button")(?=[\s\S]*data-testid="video-sam-fullscreen-clear-button")(?=[\s\S]*data-testid="video-sam-fullscreen-hold-hide-button")(?=[\s\S]*setFullscreenMaskPreviewVisible\(false\))(?=[\s\S]*handleSamVideoPromptFromOverlay)[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Fullscreen SAM smart-selection toolbar keeps controls inset from the drag handle and lower shell border",
    pattern: /(?=[\s\S]*class="sam-video-floating-toolbar__bar rounded-b-pill")(?=[\s\S]*class="sam-video-floating-toolbar__controls")(?=[\s\S]*\.sam-video-floating-toolbar__bar\s*\{[\s\S]*min-height:\s*58px;[\s\S]*padding:\s*8px 22px 10px;)(?=[\s\S]*\.sam-video-floating-toolbar__controls\s*\{[\s\S]*display:\s*flex;[\s\S]*gap:\s*8px;)(?=[\s\S]*\.sam-video-tool-group :deep\(\.q-btn\)\s*\{[\s\S]*min-height:\s*42px;)(?=[\s\S]*\.sam-video-floating-toolbar__controls > :deep\(\.q-btn\)\s*\{[\s\S]*min-height:\s*42px;)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/video/ResourceManage.vue",
    description: "Video resource manager places SAM smart selection at the same level as creating a manual mask",
    pattern: /(?=[\s\S]*isSlbrModel \? '增加范围' : '新建蒙版')(?=[\s\S]*label="智能选区")(?=[\s\S]*samVideoActionDisabled)(?=[\s\S]*samVideoActionTooltip)(?=[\s\S]*run-sam-video-selection)(?=[\s\S]*mask\.type === ['"]samVideo['"])(?=[\s\S]*emit\('remove-mask', mask\.id\))(?![\s\S]*setSamVideoObjectEnabled)(?![\s\S]*remove-sam-video-object)[\s\S]*/,
  });
  assertPattern({
    file: "src/stores/videoManager.js",
    description: "Video store supports empty full-duration SAM smart-selection tracks, prompt objects, result writeback, object visibility, and full clear",
    pattern: /(?=[\s\S]*createEmptySamVideoMaskTrack[\s\S]*type:\s*MASK_TRACK_TYPES\.SAM_VIDEO[\s\S]*startTime,[\s\S]*endTime,[\s\S]*samFrames: \[\][\s\S]*samPromptObjects: \[\])(?=[\s\S]*maskPath)(?=[\s\S]*maskAssetId)(?=[\s\S]*maskSignature)(?=[\s\S]*updateSamVideoMaskTrackResult)(?=[\s\S]*addSamVideoPromptObject)(?=[\s\S]*removeSamVideoPromptObject)(?=[\s\S]*setSamVideoObjectEnabled)(?=[\s\S]*removeSamVideoObject)(?=[\s\S]*clearSamVideoResult[\s\S]*samObjects: \[\][\s\S]*samFrames: \[\][\s\S]*samPromptObjects: \[\][\s\S]*samPromptFrameIndex: null)(?=[\s\S]*时间范围由 SAM2 传播结果决定)[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "SAM video propagation keeps only backend path-backed mask assets before writing track state",
    pattern: /(?=[\s\S]*SAM_VIDEO_MASK_ASSET_DIRECTORY = "moonshine-sam-video-masks")(?=[\s\S]*buildSamVideoMaskAssetRoot)(?=[\s\S]*persistSamVideoMaskAssets)(?=[\s\S]*const maskPath = String\(item\.maskPath \|\| ""\)\.trim\(\))(?=[\s\S]*persistedMasks\.push\(\{[\s\S]*objectId,[\s\S]*maskPath,[\s\S]*maskAssetId:[\s\S]*maskSize:[\s\S]*maskSignature:)(?=[\s\S]*skippedCount)(?=[\s\S]*let result = await persistSamVideoMaskAssets)(?=[\s\S]*result = await hydrateSamVideoObjectExpandDefaults\(result\))(?=[\s\S]*videoStore\.updateSamVideoMaskTrackResult\(targetMaskId, result\))(?=[\s\S]*collectSamVideoMaskAssetPaths)(?=[\s\S]*cleanupSamVideoMaskAssetPaths)(?=[\s\S]*removeVideoMaskTrack)(?=[\s\S]*cleanup-temp-file)[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "SAM2 video propagation requests backend path-backed masks to avoid base64 response spikes",
    pattern: /(?=[\s\S]*const assetRoot = await buildSamVideoMaskAssetRoot)(?=[\s\S]*forwardMaskOutputDir)(?=[\s\S]*backwardMaskOutputDir)(?=[\s\S]*responseType: "path")(?=[\s\S]*maskOutputDir: forwardMaskOutputDir)(?=[\s\S]*maskOutputDir: backwardMaskOutputDir)(?=[\s\S]*normalizePathMaskFrame)(?=[\s\S]*maskPath: item\.maskPath \|\| "")[\s\S]*/,
  });
  assertPattern({
    file: "src/components/video/VideoPreviewOverlay.vue",
    description: "SAM video preview shows only same-frame prompt markers and preloads a bounded future mask window",
    pattern: /(?=[\s\S]*class="sam-prompt-marker")(?=[\s\S]*visibleSamPromptMarkers)(?=[\s\S]*Number\(prompt\.frameIndex \|\| 0\) === currentFrameIndex)(?=[\s\S]*createSamPointMarker)(?=[\s\S]*createSamBoxMarker)(?=[\s\S]*SAM_FRAME_PRELOAD_WINDOW = 30)(?=[\s\S]*SAM_FRAME_IMAGE_CACHE_LIMIT = 96)(?=[\s\S]*lastSamFramePreloadKey)(?=[\s\S]*windowBucket)(?=[\s\S]*preloadKey === lastSamFramePreloadKey)(?=[\s\S]*preloadSamFrameMasks)(?=[\s\S]*slice\(startIndex, startIndex \+ SAM_FRAME_PRELOAD_WINDOW \+ 1\))(?=[\s\S]*void preloadSamFrameMasks\(\{ mask, asset, nearestFrame \}\))[\s\S]*/,
  });
  assertPattern({
    file: "src/components/video/VideoMaskEditor.vue",
    description: "SAM video selected-track editor lists prompt objects before running and supports delete plus source-frame seeking",
    pattern: /(?=[\s\S]*data-testid="video-sam-prompt-list")(?=[\s\S]*v-for="prompt in samPromptObjects")(?=[\s\S]*帧 \{\{ prompt\.frameIndex \}\} ·)(?=[\s\S]*@click="seekToSamPromptFrame\(prompt\)")(?=[\s\S]*@click\.stop="videoStore\.removeSamVideoPromptObject\(videoStore\.selectedMaskId, prompt\.objectId\)")(?=[\s\S]*const getSamPromptForObject)(?=[\s\S]*const seekToSamPromptFrame)(?=[\s\S]*videoStore\.setCurrentTime\(clamp\(frameIndex \/ fps, 0, duration\)\))[\s\S]*/,
  });
  assertAbsentPattern({
    file: "src/components/video/VideoMaskEditor.vue",
    description: "SAM video candidate objects stay operable after their prompt object is deleted",
    pattern: /:disable="disabled \|\| samVideoRunning \|\| !getSamPromptForObject\(objectItem\.objectId\)"/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video processing preflights disk space before batch artifact, segment, and final video writes",
    pattern: /(?=[\s\S]*DISK_SPACE_SAFETY_BYTES)(?=[\s\S]*estimateVideoDiskUsage)(?=[\s\S]*ensureVideoDiskSpace)(?=[\s\S]*ensureVideoProcessingDiskSpace)(?=[\s\S]*await ensureVideoProcessingDiskSpace\()(?=[\s\S]*operation: "视频处理")(?=[\s\S]*operation: "编码临时视频分段")(?=[\s\S]*operation: "写入最终视频文件")(?=[\s\S]*estimatedOutputBytes)[\s\S]*/,
  });
  assertPattern({
    file: "server/moonshine_server/schema.py",
    description: "SAM2 video API supports path response with a required mask output directory",
    pattern: /(?=[\s\S]*class MoonshineSamVideoPropagateRequest)(?=[\s\S]*response_type: Literal\["base64", "path"\])(?=[\s\S]*mask_output_dir: Optional\[str\])(?=[\s\S]*if values\.response_type == "path" and not values\.mask_output_dir)[\s\S]*/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/sam_service.py",
    description: "SAM2 video service writes propagated masks as binary JPG files when path response is requested",
    pattern: /(?=[\s\S]*SAM_VIDEO_MASK_JPEG_QUALITY)(?=[\s\S]*def _save_video_mask)(?=[\s\S]*np\.where\(mask > 128, 255, 0\))(?=[\s\S]*mask_f\{frame_index:06d\}_o\{object_id:03d\}\.jpg)(?=[\s\S]*cv2\.imencode\([\s\S]*"\.jpg"[\s\S]*IMWRITE_JPEG_QUALITY)(?=[\s\S]*mask_path\.write_bytes\(mask_bytes\))(?=[\s\S]*"maskPath": str\(mask_path\))(?=[\s\S]*response_type: str = "base64")(?=[\s\S]*mask_output_dir: Optional\[str\] = None)(?=[\s\S]*normalized_response_type == "path")(?=[\s\S]*self\._save_video_mask)[\s\S]*/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/sam_service.py",
    description: "SAM2 video service uses the shared disk-space guard before writing path-backed mask frames",
    pattern: /(?=[\s\S]*from moonshine_server\.disk_space import DEFAULT_DISK_SPACE_SAFETY_BYTES, ensure_disk_space)(?=[\s\S]*def _estimate_video_mask_disk_bytes)(?=[\s\S]*def _ensure_video_mask_disk_space)(?=[\s\S]*ensure_disk_space\([\s\S]*operation="SAM2 视频蒙版临时文件写入")(?=[\s\S]*operation="SAM2 视频蒙版写入")(?=[\s\S]*remaining_frames=estimated_output_frame_count)(?=[\s\S]*remaining_frames=max\(1, estimated_output_frame_count - len\(frames\)\))[\s\S]*/,
  });
  assertPattern({
    file: "src/services/SamPredictionService.js",
    description: "SAM2 video client forwards path response options to the backend",
    pattern: /(?=[\s\S]*response_type: request\.response_type \|\| request\.responseType \|\| "base64")(?=[\s\S]*mask_output_dir: request\.mask_output_dir \|\| request\.maskOutputDir \|\| null)[\s\S]*/,
  });
  assertAbsentPattern({
    file: "src/pages/VideoPage.vue",
    description: "SAM video asset persistence must not accept inline/base64 mask writeback",
    pattern: /dataUrlToMaskJpegBlob|dataUrlToBlob|imageBlobToElement|item\?\.mask|const maskData = item\.mask|maskSignature: getMaskDataSignature|保存 SAM 视频蒙版资产失败/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "SAM video propagation keeps only a summary in reactive page state after writing the track",
    pattern: /(?=[\s\S]*lastResultSummary: null)(?=[\s\S]*const summarizeSamVideoResult = \(result = \{\}\) =>)(?=[\s\S]*samVideoState\.lastResultSummary = summarizeSamVideoResult\(result\))(?=[\s\S]*videoStore\.updateSamVideoMaskTrackResult\(targetMaskId, result\))(?=[\s\S]*resultFrameCount: samVideoState\.lastResultSummary\?\.frameCount \|\| 0)(?![\s\S]*samVideoState\.lastResult(?!Summary))[\s\S]*/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/sam_service.py",
    description: "SAM video mask asset writes happen in the backend with disk-space preflight",
    pattern: /(?=[\s\S]*def _ensure_video_mask_disk_space)(?=[\s\S]*operation="SAM2 视频蒙版临时文件写入")(?=[\s\S]*operation="SAM2 视频蒙版写入")(?=[\s\S]*def _save_video_mask)(?=[\s\S]*mask_path\.write_bytes\(mask_bytes\))(?=[\s\S]*"maskPath": str\(mask_path\))[\s\S]*/,
  });
  assertAbsentPattern({
    file: "src/pages/VideoPage.vue",
    description: "SAM video mask asset writes must not happen through renderer base64-to-file conversion",
    pattern: /const persistSamVideoMaskAssets = async[\s\S]*?saveBlobToPath\(maskBlob, maskPath\)[\s\S]*?const ensureSamVideoSourcePath|operation: "保存 SAM 视频蒙版资产"/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "LaMa video processing writes temporary frame masks as JPEG files by binarizing source alpha",
    pattern: /(?=[\s\S]*const maskName = `mask_\$\{String\(frameIndex\)\.padStart\(6, "0"\)\}\.jpg`)(?=[\s\S]*encodeMaskImageAsJpegBlob\(canvas, width, height\))(?=[\s\S]*const maskValue = data\[index \+ 3\] > 0 \? 255 : 0)(?=[\s\S]*data\[index \+ 3\] = 255)(?=[\s\S]*mimeType: "image\/jpeg")(?=[\s\S]*quality: 0\.92)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/video/VideoPreviewOverlay.vue",
    description: "SAM video preview converts transparent PNG masks by alpha and JPEG masks by luminance, then recolors with brush settings",
    pattern: /(?=[\s\S]*createPreviewMaskImage)(?=[\s\S]*const sourceAlpha = data\[index \+ 3\])(?=[\s\S]*sourceAlpha < 255 \? sourceAlpha > 0 : luminance > 127)(?=[\s\S]*data\[index \+ 3\] = isMaskPixel \? 255 : 0)(?=[\s\S]*const previewData = imageData\.data)(?=[\s\S]*const previewColor = parseMaskPreviewColor\(color \|\| videoStore\.maskTool\.brushColor\))(?=[\s\S]*const previewAlpha = Math\.round\([\s\S]*videoStore\.maskTool\.brushAlpha[\s\S]*\* 255[\s\S]*\))(?=[\s\S]*previewData\[index\] = previewColor\.r)(?=[\s\S]*previewData\[index \+ 3\] = isMaskPixel \? previewAlpha : 0)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/video/VideoPreviewOverlay.vue",
    description: "SAM video preview auto-expands masks with the shared LaMa rule before recoloring",
    pattern: /(?=[\s\S]*import \{ expandSamMaskImageDataForLama \} from "src\/utils\/samMaskAutoExpand")(?=[\s\S]*currentModel:\s*\{[\s\S]*type:\s*String[\s\S]*default:\s*"lama")(?=[\s\S]*getSamFrameCacheKey[\s\S]*"lama-expanded"[\s\S]*"original")(?=[\s\S]*createPreviewMaskImage[\s\S]*String\(props\.currentModel \|\| ""\)\.toLowerCase\(\) === "lama"[\s\S]*expandSamMaskImageDataForLama\(imageData)(?=[\s\S]*previewColor = parseMaskPreviewColor)[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video page forwards the active processing model into SAM video preview overlay",
    pattern: /<VideoPreviewOverlay[\s\S]*:current-model="currentModel"/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Final SAM video mask renderer converts PNG by alpha and JPEG by luminance into white alpha masks for backend processing",
    pattern: /(?=[\s\S]*createBinaryAlphaMaskBitmap)(?=[\s\S]*const alpha = data\[index \+ 3\])(?=[\s\S]*const maskValue = alpha < 255 \? \(alpha > 0 \? 255 : 0\) : \(luminance > 127 \? 255 : 0\))(?=[\s\S]*data\[index\] = 255)(?=[\s\S]*data\[index \+ 3\] = maskValue)[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Final SAM video mask renderer auto-expands LaMa masks with the shared utility before processing",
    pattern: /(?=[\s\S]*expandSamMaskImageDataForLama,[\s\S]*from "src\/utils\/samMaskAutoExpand")(?=[\s\S]*createBinaryAlphaMaskBitmap[\s\S]*expandForLama = false)(?=[\s\S]*if \(expandForLama\)[\s\S]*expandSamMaskImageDataForLama\(imageData)(?=[\s\S]*createCombinedMaskRenderer = async \(\{ masks, width, height, modelId = currentModel\.value \}\))(?=[\s\S]*shouldAutoExpandSamVideoMasks[\s\S]*toLowerCase\(\) === "lama")(?=[\s\S]*"lama-expanded"[\s\S]*"original")(?=[\s\S]*createBinaryAlphaMaskBitmap\(image, width, height, \{[\s\S]*expandForLama: shouldAutoExpandSamVideoMasks)[\s\S]*/,
  });
  assertPattern({
    file: "src/stores/videoManager.js",
    description: "SAM video objects keep manual LaMa expansion values by objectId",
    pattern: /(?=[\s\S]*const normalizeSamVideoObject = \(object = \{\}\) =>)(?=[\s\S]*autoExpandPx)(?=[\s\S]*expandPx)(?=[\s\S]*const setSamVideoObjectExpandPx = \(maskId, objectId, expandPx\) =>)(?=[\s\S]*samObjects: \(mask\.samObjects \|\| \[\]\)\.map\(\(item\) =>[\s\S]*expandPx: normalizedExpandPx)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/video/VideoMaskEditor.vue",
    description: "SAM video sidebar exposes per-object LaMa expansion controls",
    pattern: /(?=[\s\S]*sam-object-expand-input)(?=[\s\S]*:model-value="objectItem\.expandPx \?\? objectItem\.autoExpandPx \?\? 0")(?=[\s\S]*type="number")(?=[\s\S]*icon="remove")(?=[\s\S]*icon="add")(?=[\s\S]*setSamVideoObjectExpandPx)(?=[\s\S]*stepSamVideoObjectExpandPx)[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Fullscreen SAM video candidate popup and final renderer share object expansion values",
    pattern: /(?=[\s\S]*video-sam-object-expand-input)(?=[\s\S]*setSelectedSamVideoObjectExpandPx)(?=[\s\S]*stepSelectedSamVideoObjectExpandPx)(?=[\s\S]*hydrateSamVideoObjectExpandDefaults)(?=[\s\S]*resolveSamVideoMaskAutoExpandPxFromPath)(?=[\s\S]*radiusOverride: expandPx)(?=[\s\S]*samObjectMap\.get\(Number\(item\.objectId\)\) \?\? 0)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/video/VideoPreviewOverlay.vue",
    description: "SAM video preview cache and preload use per-object expansion values",
    pattern: /(?=[\s\S]*expandPx = null)(?=[\s\S]*normalizeSamObjectExpandPx\(expandPx\))(?=[\s\S]*radiusOverride: expandPx)(?=[\s\S]*samObjectMap)(?=[\s\S]*preloadKey[\s\S]*`\$\{objectId\}:\$\{samObjectMap\.get\(objectId\) \?\? 0\}`)(?=[\s\S]*expandPx: samObjectMap\.get\(Number\(item\.objectId\)\) \?\? 0)[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video processing passes the requested model into combined mask rendering",
    pattern: /createCombinedMaskRenderer\(\{[\s\S]*masks: videoStore\.masks,[\s\S]*width: videoStore\.videoWidth,[\s\S]*height: videoStore\.videoHeight,[\s\S]*modelId: requestedModelId/,
  });
  assertPattern({
    file: "server/moonshine_server/api.py",
    description: "Video batch JPEG mask loading thresholds compression noise instead of treating any non-zero pixel as foreground",
    pattern: /def _load_mask_from_path[\s\S]*if not keep_grayscale:[\s\S]*np\.where\(mask > 127, 255, 0\)\.astype\(np\.uint8\)/,
  });
  assertPattern({
    file: "src/components/video/ResourceManage.vue",
    description: "Video resource manager delegates SAM track deletion only; per-object deletion stays in the right editor",
    pattern: /(?=[\s\S]*emit\('remove-mask', mask\.id\))(?=[\s\S]*"remove-mask")(?![\s\S]*emit\('remove-sam-video-object')(?![\s\S]*"remove-sam-video-object")[\s\S]*/,
  });
  assertPattern({
    file: "src-electron/electron-main.js",
    description: "App temp cleanup includes persisted SAM video mask asset directories",
    pattern: /buildTempCleanupTargets[\s\S]*"moonshine-videos"[\s\S]*"moonshine-sam-video-masks"/,
  });
  assertPattern({
    file: "src/components/video/VideoPreviewOverlay.vue",
    description: "Video preview lazily loads only path-backed nearest SAM video frame masks",
    pattern: /(?=[\s\S]*videoStore\.selectedMask\?\.type === "samVideo")(?=[\s\S]*const samFrameImageCache = new Map\(\))(?=[\s\S]*getLocalMaskImageUrl)(?=[\s\S]*getSamFrameListSignature)(?=[\s\S]*loadSamFrameMaskImage)(?=[\s\S]*buildSamFrameIndex)(?=[\s\S]*findNearestSamFrame)(?=[\s\S]*while \(left <= right\))(?=[\s\S]*mask\.type === "samVideo")(?=[\s\S]*maskPath: item\.maskPath \|\| "")(?=[\s\S]*\.filter\(\(item\) => item\.objectId > 0 && item\.maskPath\))(?=[\s\S]*samFrameIndex: buildSamFrameIndex\(samFrames\))(?=[\s\S]*enabledObjects)(?=[\s\S]*const nearestFrame = findNearestSamFrame\(asset, videoStore\.currentTime\))(?=[\s\S]*await loadSamFrameMaskImage)(?=[\s\S]*maskPath: item\.maskPath)(?=[\s\S]*ctx\.drawImage\(image, 0, 0, safeSourceWidth\.value, safeSourceHeight\.value\))[\s\S]*/,
  });
  assertPattern({
    file: "src/components/video/VideoPreviewOverlay.vue",
    description: "Video preview overlay degrades render failures without crashing the page",
    pattern: /(?=[\s\S]*const handleOverlayRenderError = \(error\) =>)(?=[\s\S]*samFrameImageCache\.clear\(\))(?=[\s\S]*视频蒙版预览渲染失败，已跳过本次覆盖层绘制)(?=[\s\S]*try \{[\s\S]*for \(const mask of videoStore\.masks\))(?=[\s\S]*catch \(error\) \{[\s\S]*handleOverlayRenderError\(error\))[\s\S]*/,
  });
  assertPattern({
    file: "src/stores/videoManager.js",
    description: "SAM video result writeback stores only path-backed frame masks",
    pattern: /(?=[\s\S]*const normalizeSamVideoFrame = \(frame = \{\}\) =>)(?=[\s\S]*const maskPath = typeof item\.maskPath === "string" \? item\.maskPath : "")(?=[\s\S]*maskPath,)(?=[\s\S]*\.filter\(\(item\) => item\.objectId > 0 && item\.maskPath\))(?=[\s\S]*updateSamVideoMaskTrackResult)[\s\S]*/,
  });
  assertAbsentPattern({
    file: "src/stores/videoManager.js",
    description: "SAM video result writeback must not keep inline-mask compatibility options",
    pattern: /dropInlineMask|shouldDropInlineMasks|samVideoFrameOptions|typeof item\.mask(?!Path|AssetId|Signature|Size)|\bmask:\s*inlineMask/,
  });
  assertAbsentPattern({
    file: "src/components/video/VideoPreviewOverlay.vue",
    description: "Video preview overlay must not load inline SAM frame masks",
    pattern: /item\.mask(?!Id|Path|AssetId|Signature|Size)|getMaskDataSignature|loadImageElement\(mask\)|loadImageElement\(item\.mask\)/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Final video mask renderer lazily loads only path-backed nearest SAM video frame masks",
    pattern: /(?=[\s\S]*const createCombinedMaskRenderer)(?=[\s\S]*const samFrameImageCache = new Map\(\))(?=[\s\S]*loadSamFrameMaskImage)(?=[\s\S]*getSamFrameEntries)(?=[\s\S]*buildSamFrameIndex)(?=[\s\S]*findNearestSamFrame)(?=[\s\S]*maskPath: item\.maskPath \|\| "")(?=[\s\S]*\.filter\(\(item\) => item\.objectId > 0 && item\.maskPath\))(?=[\s\S]*samFrameIndex: buildSamFrameIndex\(samFrames\))(?=[\s\S]*const nearestFrame = findNearestSamFrame\(asset, time\))(?=[\s\S]*await loadSamFrameMaskImage)(?=[\s\S]*maskPath: item\.maskPath)(?=[\s\S]*ctx\.drawImage\(image, 0, 0, width, height\))[\s\S]*/,
  });
  assertAbsentPattern({
    file: "src/pages/VideoPage.vue",
    description: "Final video mask renderer must not read inline SAM frame masks",
    pattern: /loadSamFrameImages|image:\s*await loadImageElement\(item\.mask\)|ctx\.drawImage\(item\.image|maskPath \|\| item\.mask|item\.maskPath \|\| item\.mask/,
  });
  assertPattern({
    file: "src/components/video/VideoMaskEditor.vue",
    description: "Video mask editor treats SAM smart-selection as a special mask track with smart tools and candidate object list",
    pattern: /(?=[\s\S]*videoStore\.selectedMask\?\.type === 'samVideo')(?=[\s\S]*label="轨道名称")(?=[\s\S]*智能选区轨道使用 SAM2 点选\/框选传播生成)(?=[\s\S]*data-testid="video-sam-smart-tool-section")(?=[\s\S]*sam-video-tool-group)(?=[\s\S]*data-testid="video-sam-settings-button")(?=[\s\S]*data-testid="video-sam-select-tool-button")(?=[\s\S]*data-testid="video-sam-clear-result-button")(?=[\s\S]*清空提示、候选对象和传播结果)(?=[\s\S]*运行智能选区)(?=[\s\S]*data-testid="video-sam-prompt-list")(?=[\s\S]*data-testid="video-sam-candidate-list-section")(?=[\s\S]*候选蒙版列表)(?=[\s\S]*setSamVideoObjectEnabled)(?=[\s\S]*@click\.stop)(?=[\s\S]*remove-sam-video-object)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/video/VideoPreviewOverlay.vue",
    description: "Video preview overlay uses one SAM smart-selection tool: click adds point prompts and drag adds box prompts",
    pattern: /(?=[\s\S]*samVideoPromptEnabled)(?=[\s\S]*startSamVideoPrompt)(?=[\s\S]*samPromptOperation\.value = \{[\s\S]*startPoint,[\s\S]*moved: false)(?=[\s\S]*nextBox\.width >= 4 \|\| nextBox\.height >= 4)(?=[\s\S]*emit\("sam-prompt", \{ box \}\))(?=[\s\S]*emit\("sam-prompt", \{ point: operation\.startPoint \}\))[\s\S]*/,
  });
  assertPattern({
    file: "src/components/common/MaskBrushControls.vue",
    description: "Video sidebar manual brush toolbar keeps primary tools together and moves secondary actions into a more menu",
    pattern: /(?=[\s\S]*layout-video-sidebar)(?=[\s\S]*secondaryActionsInMenu)(?=[\s\S]*data-testid="mask-brush-more-menu-button")(?=[\s\S]*更多画笔操作)(?=[\s\S]*\.mask-brush-controls\.layout-video-sidebar[\s\S]*container-type: inline-size)(?=[\s\S]*\.mask-brush-controls\.layout-video-sidebar \.tool-main-group \{[\s\S]*max-width: 100%;[\s\S]*flex-wrap: nowrap;[\s\S]*overflow: visible;)(?=[\s\S]*\.brush-more-menu)[\s\S]*/,
  });

  logSection("Runtime Smoke");
  runFfmpegSmoke();

  console.log("\nAll P1 video regression assertions passed.");
}

try {
  runAssertions();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
