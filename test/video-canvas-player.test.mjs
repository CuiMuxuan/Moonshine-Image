import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../src/components/video/CanvasPlayer.vue", import.meta.url),
  "utf8",
);

test("video canvas empty state presents bilingual, responsive instructions", () => {
  const messageBlock = source.match(
    /<p class="empty-state-message q-mt-md"[^>]*>([\s\S]*?)<\/p>/,
  )?.[1];

  assert.ok(messageBlock, "missing video canvas empty-state message");
  const chineseIndex = messageBlock.indexOf(
    'lang="zh-CN">请从左侧面板上传视频以开始编辑。',
  );
  const englishIndex = messageBlock.indexOf(
    'lang="en">Upload a video from the left panel to start editing.',
  );
  assert.ok(chineseIndex >= 0, "missing Chinese empty-state instruction");
  assert.ok(englishIndex > chineseIndex, "English instruction must follow Chinese instruction");
  assert.match(messageBlock, /class="empty-state-line"/g);
  assert.match(
    source,
    /\.empty-state-message\s*\{[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?text-wrap:\s*balance;/,
  );
});
