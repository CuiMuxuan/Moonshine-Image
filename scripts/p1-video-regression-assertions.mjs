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
