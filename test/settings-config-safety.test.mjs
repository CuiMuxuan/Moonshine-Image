import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  APP_CONFIG_INTEGER_LIMITS,
  DEFAULT_MANAGED_FOLDER_NAMES,
  isFiniteIntegerInRange,
  isValidManagedFolderName,
  normalizeConfigToCurrentSchema,
  normalizeIntegerInRange,
  normalizeManagedFolderName,
} from "../src/shared/appConfigSchema.js";
import {
  buildTempCleanupTargets,
  cleanupManagedTempDirectory,
  isStrictSubdirectoryPath,
  isValidConfiguredDirectoryPath,
  normalizeConfiguredDirectoryPath,
} from "../src-electron/config-safety.js";

test("managed output folder names allow ordinary Chinese and Latin names", () => {
  ["images", "修复结果", "视频-导出_2026", "my.folder"].forEach((value) => {
    assert.equal(isValidManagedFolderName(value), true, value);
  });
});

test("managed output folder names reject path traversal and cross-platform reserved names", () => {
  [
    "",
    " ",
    ".",
    "..",
    "sub\\..",
    "sub/..",
    "C:\\temp",
    "/tmp",
    "CON",
    "con.txt",
    "LPT9.logs",
    "bad.",
    "bad ",
    "bad:name",
    `bad${String.fromCharCode(0)}name`,
  ].forEach((value) => {
    assert.equal(isValidManagedFolderName(value), false, JSON.stringify(value));
  });

  assert.equal(normalizeManagedFolderName("..", DEFAULT_MANAGED_FOLDER_NAMES.image), "images");
});

test("legacy invalid output folder names normalize without changing the schema", () => {
  const normalized = normalizeConfigToCurrentSchema({
    fileManagement: {
      imageFolderName: "..",
      videoFolderName: "C:\\outside",
    },
  });

  assert.equal(normalized.fileManagement.imageFolderName, "images");
  assert.equal(normalized.fileManagement.videoFolderName, "videos");
});

test("shared integer limits reject fractions and preserve an unbounded batch size", () => {
  const cases = [
    [APP_CONFIG_INTEGER_LIMITS.imageHistoryLimit, 1, 100],
    [APP_CONFIG_INTEGER_LIMITS.imageWarningSize, 1, 1000],
    [APP_CONFIG_INTEGER_LIMITS.stateSaveLimit, 10, 500],
    [APP_CONFIG_INTEGER_LIMITS.brushSize, 1, 120],
    [APP_CONFIG_INTEGER_LIMITS.minMaskArea, 1, 1000000],
  ];
  cases.forEach(([limits, minimum, maximum]) => {
    assert.equal(isFiniteIntegerInRange(minimum, limits), true);
    assert.equal(isFiniteIntegerInRange(maximum, limits), true);
    assert.equal(isFiniteIntegerInRange(minimum - 1, limits), false);
    assert.equal(isFiniteIntegerInRange(maximum + 1, limits), false);
    assert.equal(isFiniteIntegerInRange(minimum + 0.5, limits), false);
  });
  assert.equal(isFiniteIntegerInRange(Number.POSITIVE_INFINITY, { min: 1 }), false);
  assert.equal(isFiniteIntegerInRange(1000000, APP_CONFIG_INTEGER_LIMITS.batchFrameCount), true);
  assert.equal(
    normalizeIntegerInRange(1000000, 120, APP_CONFIG_INTEGER_LIMITS.batchFrameCount),
    1000000
  );
});

test("configured directory paths allow empty defaults but reject non-absolute values", () => {
  const absolutePath = path.join(path.parse(process.cwd()).root, "moonshine-data");
  const fallback = path.join(path.parse(process.cwd()).root, "moonshine-default");

  assert.equal(isValidConfiguredDirectoryPath(""), true);
  assert.equal(isValidConfiguredDirectoryPath(absolutePath), true);
  assert.equal(isValidConfiguredDirectoryPath("relative/path"), false);
  assert.equal(isValidConfiguredDirectoryPath(null), false);
  assert.equal(normalizeConfiguredDirectoryPath("", fallback), path.normalize(fallback));
  assert.equal(
    normalizeConfiguredDirectoryPath("relative/path", fallback),
    path.normalize(fallback)
  );
});

test("temporary cleanup targets are always strict children of the configured root", () => {
  const tempRoot = path.join(path.parse(process.cwd()).root, "moonshine-temp-root");
  const targets = buildTempCleanupTargets({
    tempRoot,
    cleanupOptions: { includeImages: true, includeVideos: true },
    imageFolderName: "修复图片",
    videoFolderName: "processed-videos",
  });

  assert.equal(targets.length, 5);
  targets.forEach((target) => assert.equal(isStrictSubdirectoryPath(target, tempRoot), true));
  assert.throws(
    () =>
      buildTempCleanupTargets({
        tempRoot,
        cleanupOptions: { includeImages: true },
        imageFolderName: "..",
      }),
    /invalid/
  );
});

test("temporary cleanup removes only stale entries inside a managed subdirectory", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-config-safety-"));
  assert.equal(isStrictSubdirectoryPath(sandbox, os.tmpdir()), true);

  try {
    const managedDirectory = path.join(sandbox, "images");
    const sentinelPath = path.join(sandbox, "root-sentinel.txt");
    const staleFilePath = path.join(managedDirectory, "stale.tmp");
    const recentFilePath = path.join(managedDirectory, "recent.tmp");
    const staleDirectoryPath = path.join(managedDirectory, "stale-directory");
    fs.mkdirSync(staleDirectoryPath, { recursive: true });
    fs.writeFileSync(sentinelPath, "keep");
    fs.writeFileSync(staleFilePath, "remove");
    fs.writeFileSync(recentFilePath, "keep");
    fs.writeFileSync(path.join(staleDirectoryPath, "nested.tmp"), "remove");

    const now = Date.now();
    const staleTime = new Date(now - 3 * 24 * 60 * 60 * 1000);
    const recentTime = new Date(now);
    fs.utimesSync(sentinelPath, staleTime, staleTime);
    fs.utimesSync(staleFilePath, staleTime, staleTime);
    fs.utimesSync(staleDirectoryPath, staleTime, staleTime);
    fs.utimesSync(recentFilePath, recentTime, recentTime);

    const result = cleanupManagedTempDirectory({
      directory: managedDirectory,
      tempRoot: sandbox,
      cutoffMs: now - 24 * 60 * 60 * 1000,
    });

    assert.equal(fs.existsSync(sentinelPath), true);
    assert.equal(fs.existsSync(staleFilePath), false);
    assert.equal(fs.existsSync(staleDirectoryPath), false);
    assert.equal(fs.existsSync(recentFilePath), true);
    assert.equal(result.removedFileCount, 1);
    assert.equal(result.removedDirectoryCount, 1);
    assert.throws(
      () =>
        cleanupManagedTempDirectory({
          directory: sandbox,
          tempRoot: sandbox,
          cutoffMs: now,
        }),
      /non-child/
    );
    assert.throws(
      () =>
        cleanupManagedTempDirectory({
          directory: path.dirname(sandbox),
          tempRoot: sandbox,
          cutoffMs: now,
        }),
      /non-child/
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
