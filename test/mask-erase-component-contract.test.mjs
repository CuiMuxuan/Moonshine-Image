import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const imageMaskerSource = fs.readFileSync("src/components/image/ImageMasker.vue", "utf8");

test("manual mask edits continue syncing when all smart candidates are temporarily disabled", () => {
  const syncStart = imageMaskerSource.indexOf("const syncSamBaseSnapshotFromManualOperation");
  const syncEnd = imageMaskerSource.indexOf("const renderSamCandidates", syncStart);
  assert.ok(syncStart >= 0 && syncEnd > syncStart);
  const syncSource = imageMaskerSource.slice(syncStart, syncEnd);

  assert.doesNotMatch(syncSource, /!hasSamCandidateLayer\(\)/);
  assert.match(syncSource, /const currentBaseSnapshot = await resolveCurrentSamBaseSnapshot\(\);/);
  assert.match(syncSource, /if \(!currentBaseSnapshot\) \{/);
  assert.match(syncSource, /const nextBaseSnapshot = applyRasterOperationToImageData\(currentBaseSnapshot, operation\);/);

  const resolveStart = imageMaskerSource.indexOf("const resolveCurrentSamBaseSnapshot");
  const resolveEnd = imageMaskerSource.indexOf("const applyRasterOperationToImageData", resolveStart);
  const resolveSource = imageMaskerSource.slice(resolveStart, resolveEnd);
  assert.match(resolveSource, /!hasSamCandidateLayer\(\) && ctx\.value/);
  assert.match(resolveSource, /ctx\.value\.getImageData\(0, 0, width, height\)/);
});

test("pure manual drawing does not reapply its first completed operation through SAM composition", () => {
  const syncStart = imageMaskerSource.indexOf("const syncSamBaseSnapshotFromManualOperation");
  const syncEnd = imageMaskerSource.indexOf("const renderSamCandidates", syncStart);
  const syncSource = imageMaskerSource.slice(syncStart, syncEnd);

  assert.match(syncSource, /const hasSamBackedMask = Boolean\(/);
  assert.match(syncSource, /samBaseSnapshot\.value/);
  assert.match(syncSource, /samBaseSnapshotDataUrl\.value/);
  assert.match(syncSource, /samCandidates\.value\.length/);
  assert.match(syncSource, /if \(!hasSamBackedMask\) \{\s*return false;/);
});
