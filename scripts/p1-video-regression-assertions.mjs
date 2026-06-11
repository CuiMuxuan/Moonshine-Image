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

  logSection("SAM2 Video Workflow");
  assertPattern({
    file: "server/moonshine_server/schema.py",
    description: "SAM2 video request supports direct video paths and multi-object prompts while keeping legacy fields",
    pattern: /class SamVideoObjectPrompt[\s\S]*object_id:\s*int[\s\S]*points:\s*List\[SamPromptPoint\][\s\S]*class MoonshineSamVideoPropagateRequest[\s\S]*input_type:\s*Literal\["jpegFrameDirectory",\s*"videoPath"\][\s\S]*frame_dir:\s*Optional\[str\][\s\S]*video_path:\s*Optional\[str\][\s\S]*object_id:\s*int[\s\S]*objects:\s*List\[SamVideoObjectPrompt\][\s\S]*frame_dir is required[\s\S]*video_path is required/,
  });
  assertPattern({
    file: "server/moonshine_server/moonshine/sam_service.py",
    description: "SAM2 video service stages local video paths with OpenCV and registers multiple object prompts",
    pattern: /(?=[\s\S]*import cv2)(?=[\s\S]*def _stage_video_to_jpeg_frames)(?=[\s\S]*cv2\.VideoCapture)(?=[\s\S]*cv2\.imwrite)(?=[\s\S]*def _normalize_video_objects)(?=[\s\S]*duplicate_ids)(?=[\s\S]*def propagate_video)(?=[\s\S]*input_type: str = "jpegFrameDirectory")(?=[\s\S]*video_path: Optional\[str\])(?=[\s\S]*normalized_objects)(?=[\s\S]*for prompt in normalized_objects:)(?=[\s\S]*predictor\.add_new_points_or_box)(?=[\s\S]*"objectCount": len\(normalized_objects\))(?=[\s\S]*"type": normalized_input_type)[\s\S]*/,
  });
  assertPattern({
    file: "server/moonshine_server/api.py",
    description: "SAM2 video API passes direct video path and multi-object prompts into the service",
    pattern: /def api_moonshine_sam_video_propagate[\s\S]*video_path=req\.video_path[\s\S]*input_type=req\.input_type[\s\S]*objects=req\.objects/,
  });
  assertPattern({
    file: "src/services/SamPredictionService.js",
    description: "Frontend SAM service sends SAM2 video input type, video path, and objects",
    pattern: /propagateSamVideo[\s\S]*inputType[\s\S]*objects = Array\.isArray\(request\.objects\)[\s\S]*input_type: inputType[\s\S]*video_path: request\.video_path \|\| request\.videoPath[\s\S]*objects,/,
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
    description: "Video page exposes a mask-list-level SAM video action plus dark-aware SAM2 settings panel and E2E bridge",
    pattern: /(?=[\s\S]*sam-video-action-disabled)(?=[\s\S]*samVideoSelectionActionTooltip)(?=[\s\S]*run-sam-video-selection)(?=[\s\S]*runSamVideoSelectionFromMaskList)(?=[\s\S]*sam-video-panel)(?=[\s\S]*SAM2 视频选区设置)(?=[\s\S]*q-linear-progress)(?=[\s\S]*samVideoState)(?=[\s\S]*canRunSamVideoPropagation)(?=[\s\S]*runSamVideoPropagation)(?=[\s\S]*propagateSamVideo\()(?=[\s\S]*inputType: "videoPath")(?=[\s\S]*createSamVideoTrackFromResult)(?=[\s\S]*createSamVideoTrack)(?=[\s\S]*addSamVideoObject)(?=[\s\S]*setSamVideoResult)(?=[\s\S]*:global\(body\.body--dark\) \.sam-video-panel)[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "SAM2 video selection remains runnable for previewable desktop files and resolves a temp local path at runtime",
    pattern: /(?=[\s\S]*const canRunSamVideoPropagation = computed\([\s\S]*videoStore\.hasVideoFile[\s\S]*Boolean\(videoStore\.videoFile\)[\s\S]*samVideoState\.objects\.length > 0)(?=[\s\S]*当前视频可预览但未暴露原始本地路径，运行时会先缓存为本地临时文件)(?=[\s\S]*已导入视频，运行时会先缓存为本地临时文件)(?=[\s\S]*const checkLocalFileExists = async \(filePath\) => \{[\s\S]*get-file-stats)(?=[\s\S]*const ensureSamVideoSourcePath = async \(\) => \{[\s\S]*await checkLocalFileExists\(existingPath\)[\s\S]*原视频路径已失效，正在缓存当前视频到本地临时文件[\s\S]*resolveVideoSourcePath\(videoStore\.videoFile, \{[\s\S]*preferExistingPath: !existingPath)(?=[\s\S]*videoStore\.setCurrentSourceMeta\(\{[\s\S]*sourcePath,[\s\S]*sourceName: videoStore\.currentSourceName \|\| videoStore\.videoFile\??\.name \|\| "")[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Video source resolver validates stale file.path values before falling back to the desktop temp video cache",
    pattern: /const resolveVideoSourcePath = async \(file, options = \{\}\) => \{[\s\S]*preferExistingPath = true[\s\S]*await checkLocalFileExists\(filePath\)[\s\S]*视频原始路径已不可用，正在保存临时视频副本[\s\S]*file\.arrayBuffer[\s\S]*save-temp-video[\s\S]*temporarySourcePath: sourcePath/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "SAM2 video selection uses global loading and explains missing local video paths",
    pattern: /(?=[\s\S]*v-if="isProcessing \|\| samVideoState\.running")(?=[\s\S]*samVideoMissingLocalPathMessage)(?=[\s\S]*当前视频没有后端可读取的本地文件路径)(?=[\s\S]*updateGlobalLoadingOverlay\("正在运行 SAM2 视频智能选区", samVideoState\.progress\))(?=[\s\S]*updateGlobalLoadingOverlay\("SAM2 视频智能选区已完成，正在创建蒙版轨道", 1\))(?=[\s\S]*hideGlobalLoadingOverlay\(\))[\s\S]*/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Fullscreen drawing toolbar is only available for editable non-SAM mask tracks",
    pattern: /(?=[\s\S]*const selectedMaskIsEditableStandard = computed\(\(\) =>[\s\S]*isEditableStandardMask\(videoStore\.selectedMask\))(?=[\s\S]*const isFullscreenLamaViewportMode = computed\([\s\S]*selectedMaskIsEditableStandard\.value[\s\S]*!samVideoState\.running[\s\S]*!isProcessing\.value)(?=[\s\S]*<MaskFloatingToolbar[\s\S]*v-if="isFullscreenLamaViewportMode"[\s\S]*:disabled="!selectedMaskIsEditableStandard \|\| isProcessing \|\| samVideoState\.running")(?=[\s\S]*showFullscreenDrawingToolbar\.value = false)[\s\S]*/,
  });
  assertPattern({
    file: "src/components/video/ResourceManage.vue",
    description: "Video resource manager places SAM smart selection at the same level as creating a manual mask",
    pattern: /(?=[\s\S]*isSlbrModel \? '增加范围' : '新建蒙版')(?=[\s\S]*label="智能选区")(?=[\s\S]*samVideoActionDisabled)(?=[\s\S]*samVideoActionTooltip)(?=[\s\S]*run-sam-video-selection)(?=[\s\S]*mask\.type === ['"]samVideo['"])(?=[\s\S]*setSamVideoObjectEnabled)(?=[\s\S]*removeSamVideoObject)[\s\S]*/,
  });
  assertPattern({
    file: "src/stores/videoManager.js",
    description: "Video store persists SAM video frames and manages object visibility separately from deletion",
    pattern: /(?=[\s\S]*type:\s*MASK_TRACK_TYPES\.SAM_VIDEO)(?=[\s\S]*samObjects)(?=[\s\S]*samFrames)(?=[\s\S]*setSamVideoObjectEnabled)(?=[\s\S]*enabled:\s*Boolean\(enabled\))(?=[\s\S]*removeSamVideoObject)(?=[\s\S]*filter\(\(item\) => item\.objectId !== normalizedObjectId\))/,
  });
  assertPattern({
    file: "src/components/video/VideoPreviewOverlay.vue",
    description: "Video preview renders enabled SAM video objects and blocks manual SAM track editing",
    pattern: /(?=[\s\S]*videoStore\.selectedMask\?\.type === "samVideo")(?=[\s\S]*mask\.type === "samVideo")(?=[\s\S]*enabledObjects)(?=[\s\S]*nearestFrame)(?=[\s\S]*ctx\.drawImage\(item\.image)/,
  });
  assertPattern({
    file: "src/pages/VideoPage.vue",
    description: "Final video mask renderer composites enabled SAM video objects by nearest propagated frame",
    pattern: /(?=[\s\S]*const loadSamFrameImages)(?=[\s\S]*mask\.type === "samVideo")(?=[\s\S]*enabledObjects)(?=[\s\S]*nearestFrame)(?=[\s\S]*ctx\.drawImage\(item\.image)/,
  });
  assertPattern({
    file: "src/components/video/VideoMaskEditor.vue",
    description: "Video mask editor shows SAM video tracks as object-managed read-only tracks",
    pattern: /videoStore\.selectedMask\?\.type === 'samVideo'[\s\S]*label="轨道名称"[\s\S]*updateSelectedMaskName[\s\S]*SAM 视频轨道由 SAM2 传播结果生成[\s\S]*samObjects/,
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
