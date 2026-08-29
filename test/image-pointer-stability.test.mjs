import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");
const editorSource = read("src/components/image/ImageEditor.vue");
const maskerSource = read("src/components/image/ImageMasker.vue");
const imagePageSource = read("src/pages/IndexPage.vue");
const fileExplorerSource = read("src/components/common/FileExplorer.vue");

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

test("image drawers mount only after their persisted state has been restored", () => {
  assert.doesNotMatch(imagePageSource, /left: true/);
  assert.match(imagePageSource, /const pageDrawerStateReady = ref\(false\)/);
  assert.match(
    imagePageSource,
    /if \(!layoutDrawers \|\| !pageDrawerStateReady\.value\) return;/
  );
  assert.match(
    imagePageSource,
    /await restorePageState\(\);\s*pageDrawerStateReady\.value = true;/
  );
  assert.doesNotMatch(fileExplorerSource, /show-if-above/);
});

test("an emitted empty-mask round trip does not reset the undo and redo history", () => {
  assert.match(maskerSource, /const pendingMaskSyncClear = ref\(false\)/);
  assert.match(
    maskerSource,
    /if \(!canvasHasVisibleMaskPixels\(\)\) \{[\s\S]*?pendingMaskSyncClear\.value = true;/
  );
  assert.match(
    maskerSource,
    /if \(!nextMaskDataUrl && pendingMaskSyncClear\.value\) \{\s*pendingMaskSyncClear\.value = false;\s*return;/
  );
});
