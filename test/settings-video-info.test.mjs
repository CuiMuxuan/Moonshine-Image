import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const source = fs.readFileSync(
  path.join(repoRoot, "src/components/video/ResourceManage.vue"),
  "utf8"
);

test("video information uses semantic responsive metadata groups", () => {
  assert.match(source, /<dl class="media-info-grid" aria-label="媒体信息">/);
  assert.match(source, /<div class="info-section-title">处理信息<\/div>/);
  assert.match(source, /<dl class="processing-info-grid" aria-label="处理信息">/);
  assert.match(source, /<dt>显示尺寸<\/dt>/);
  assert.match(source, /grid-template-columns:\s*repeat\(auto-fit, minmax\(120px, 1fr\)\)/);
  assert.match(source, /overflow-wrap:\s*anywhere/);
  assert.match(source, /font-variant-numeric:\s*tabular-nums/);
});

test("video information keeps long names accessible without exposing local paths", () => {
  assert.match(source, /class="video-file-name"[\s\S]*tabindex="0"/);
  assert.match(source, /<q-tooltip v-model="fileNameTooltipVisible" class="video-file-tooltip">/);
  assert.match(source, /name\.split\(\/\[\\\\\/\]\//);
  assert.doesNotMatch(source, /videoInfo\.value\?\.path/);
  assert.match(source, /videoStore\.currentSourceIsReplacement \? "替换源" : "原始视频"/);
});

test("video metadata display rejects invalid numeric values", () => {
  assert.match(source, /Number\.isFinite\(number\) && number > 0/);
  assert.match(source, /metadataPending\.value \? "读取中…" : "—"/);
  assert.match(source, /props\.metadataState === "loading"/);
  assert.match(source, /Number\.isFinite\(size\) && size > 0/);
});
