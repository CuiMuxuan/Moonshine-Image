import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");
const editorSource = read("src/components/image/ImageEditor.vue");
const maskerSource = read("src/components/image/ImageMasker.vue");

test("ImageMasker owns canvas positioning without editor-level duplicate transforms", () => {
  assert.doesNotMatch(
    editorSource,
    /maskerRef\.value\.\$el\.style\.(?:transform|left|top)/
  );
  assert.match(maskerSource, /left: `\$\{store\.offsetX\}px`/);
  assert.match(maskerSource, /transform: `scale\(\$\{store\.scale\}\)`/);
});

test("drawing coordinates use the rendered canvas dimensions", () => {
  assert.match(
    maskerSource,
    /\(event\.clientX - rect\.left\) \* \(maskCanvas\.value\.width \/ rect\.width\)/
  );
  assert.match(
    maskerSource,
    /\(event\.clientY - rect\.top\) \* \(maskCanvas\.value\.height \/ rect\.height\)/
  );
  assert.doesNotMatch(maskerSource, /x: \(event\.clientX - rect\.left\) \/ props\.scale/);
});

test("drawing pointer ownership handles remote-control event ordering and cancellation", () => {
  assert.match(maskerSource, /const activePointerId = ref\(null\)/);
  assert.match(maskerSource, /event\?\.pointerId === activePointerId\.value/);
  assert.match(maskerSource, /setPointerCapture\(event\.pointerId\)/);
  assert.match(maskerSource, /pointercancel/);
  assert.match(maskerSource, /lostpointercapture/);
  assert.match(maskerSource, /cancelCurrentOperation\(\)/);
  assert.doesNotMatch(
    maskerSource,
    /useEventListener\(window, "mousemove", \(event\) =>[\s\S]*?cursorPosition\.value/
  );
});
