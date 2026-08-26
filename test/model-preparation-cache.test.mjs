import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const source = fs.readFileSync("src/stores/modelRegistry.js", "utf8");
const layoutSource = fs.readFileSync(path.join("src", "layouts", "MainLayout.vue"), "utf8");

test("model preparation keeps a fingerprinted cache after the first load", () => {
  assert.match(source, /const preparedModelCache = new Map\(\)/);
  assert.match(source, /buildPreparedModelCacheKey/);
  assert.match(source, /preparedModelCache\.set\(/);
  assert.match(source, /preparedModelCache\.get\(normalizedModelId\) === cacheKey/);
  assert.match(source, /options\.force !== true/);
});

test("model preparation exposes explicit invalidation for service restarts", () => {
  assert.match(source, /const invalidatePreparedModels = \(modelId = ""\)/);
  assert.match(source, /preparedModelCache\.clear\(\)/);
  assert.match(source, /invalidatePreparedModels,/);
  assert.match(source, /preparedModelCache\.delete\(modelId\)/);
  assert.match(layoutSource, /modelRegistryStore\.invalidatePreparedModels\(\)/);
});
