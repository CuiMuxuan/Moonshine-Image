import assert from "node:assert/strict";
import test from "node:test";

import { mergeEraseMaskPixels } from "../src/utils/maskEraseLayer.js";

test("successive smart-mask erase strokes preserve earlier holes inside the new dirty rectangle", () => {
  const existing = new Uint8ClampedArray([
    0, 0, 0, 255,
    0, 0, 0, 180,
    0, 0, 0, 0,
  ]);
  const nextStroke = new Uint8ClampedArray([
    0, 0, 0, 0,
    20, 30, 40, 160,
    20, 30, 40, 255,
  ]);

  const merged = mergeEraseMaskPixels(existing, nextStroke);

  assert.equal(merged[3], 255, "transparent stroke pixels cannot clear an earlier erase hole");
  assert.equal(merged[7], 227, "overlapping antialiased strokes use source-over alpha");
  assert.equal(merged[11], 255, "new stroke pixels are added to the erase layer");
});

test("erase-mask merging rejects mismatched dirty-rectangle buffers", () => {
  assert.throws(
    () => mergeEraseMaskPixels(new Uint8ClampedArray(4), new Uint8ClampedArray(8)),
    /matching lengths/
  );
});
