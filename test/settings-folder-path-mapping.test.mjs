import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCollisionAwareRelativePath,
  buildRelativeStemLookup,
  collectFolderStemCollisions,
  collectRelativeStemCollisions,
  reserveUniqueRelativeStemPath,
  resolveRelativeStemMatch,
  selectStagedSourceSize,
} from "../src/utils/folderPathMapping.js";

test("global stem fallback is disabled when multiple target images share that stem", () => {
  const images = [
    { relativePath: "a/foo.jpg" },
    { relativePath: "b/foo.jpg" },
  ];
  const lookup = buildRelativeStemLookup([{ relativePath: "unrelated/foo.png" }]);
  const ambiguousTargetStems = collectFolderStemCollisions(images);

  assert.equal(
    resolveRelativeStemMatch(images[0], lookup, { ambiguousTargetStems }),
    null
  );
  assert.equal(
    resolveRelativeStemMatch(images[1], lookup, { ambiguousTargetStems }),
    null
  );
});

test("relative matches still win when target stems repeat in different folders", () => {
  const images = [
    { relativePath: "a/foo.jpg" },
    { relativePath: "b/foo.jpg" },
  ];
  const masks = [
    { relativePath: "a/foo.png" },
    { relativePath: "b/foo.png" },
  ];
  const lookup = buildRelativeStemLookup(masks);
  const ambiguousTargetStems = collectFolderStemCollisions(images);

  assert.equal(
    resolveRelativeStemMatch(images[0], lookup, { ambiguousTargetStems }),
    masks[0]
  );
  assert.equal(
    resolveRelativeStemMatch(images[1], lookup, { ambiguousTargetStems }),
    masks[1]
  );
});

test("derived collision names cannot collide with an ordinary source stem", () => {
  const entries = [
    { relativePath: "same.jpg" },
    { relativePath: "same.png" },
    { relativePath: "same_jpg.webp" },
  ];
  const collisions = collectRelativeStemCollisions(entries);
  const usedStemKeys = new Set();
  const allocated = entries.map((entry) => {
    const extension = entry.relativePath.match(/\.[^.]+$/)?.[0] || ".png";
    const candidate = buildCollisionAwareRelativePath(entry, extension, collisions);
    return reserveUniqueRelativeStemPath(candidate, usedStemKeys, extension);
  });

  assert.equal(new Set(allocated.map((value) => value.replace(/\.[^.]+$/, ""))).size, 3);
  assert.deepEqual(allocated, ["same_jpg.jpg", "same_png.png", "same_jpg_webp.webp"]);
});

test("a reserved LaMa template stem cannot be overwritten by a staged image mask", () => {
  const usedStemKeys = new Set(["mask_template"]);
  assert.equal(
    reserveUniqueRelativeStemPath(
      "mask_template.jpg",
      usedStemKeys,
      ".jpg"
    ),
    "mask_template_jpg.jpg"
  );
});

test("staging size selects exactly one final image source", () => {
  assert.equal(
    selectStagedSourceSize({
      sourceType: "base64",
      fallbackSize: 10_000,
      inlineSize: 4_000,
      pathSize: 20_000,
    }),
    4_000
  );
  assert.equal(
    selectStagedSourceSize({
      sourceType: "path",
      fallbackSize: 10_000,
      inlineSize: 4_000,
      pathSize: 20_000,
    }),
    20_000
  );
  assert.equal(selectStagedSourceSize({ fallbackSize: 10_000 }), 10_000);
});
