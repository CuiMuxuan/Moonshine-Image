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
  removeManagedTempRunDirectory,
  removeManagedTempRunDirectoryAsync,
  resolveManagedTempFile,
  resolveCopyFileTarget,
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

test("managed temporary file resolution only accepts ordinary files in declared roots", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-file-cleanup-"));
  const allowedDirectory = path.join(sandbox, "moonshine-videos");
  const allowedFile = path.join(allowedDirectory, "source.mp4");
  const outsideFile = path.join(path.dirname(sandbox), "moonshine-outside-file.tmp");
  const directoryTarget = path.join(allowedDirectory, "nested");

  try {
    fs.mkdirSync(directoryTarget, { recursive: true });
    fs.writeFileSync(allowedFile, "temporary");
    fs.writeFileSync(outsideFile, "outside");

    assert.deepEqual(
      resolveManagedTempFile({
        filePath: allowedFile,
        tempRoot: sandbox,
        allowedParentDirectories: [allowedDirectory],
      }),
      { exists: true, filePath: path.resolve(allowedFile) }
    );
    assert.throws(
      () =>
        resolveManagedTempFile({
          filePath: outsideFile,
          tempRoot: sandbox,
          allowedParentDirectories: [allowedDirectory],
        }),
      /outside the allowed managed temporary paths/
    );
    assert.throws(
      () =>
        resolveManagedTempFile({
          filePath: directoryTarget,
          tempRoot: sandbox,
          allowedParentDirectories: [allowedDirectory],
        }),
      /not a file/
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
    fs.rmSync(outsideFile, { force: true });
  }
});

test("managed temporary file resolution rejects symbolic links in the allowed path", () => {
  const root = path.join(path.parse(process.cwd()).root, "moonshine-temp");
  const allowedDirectory = path.join(root, "moonshine-videos");
  const targetFile = path.join(allowedDirectory, "linked", "source.mp4");
  const normalStats = {
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  const linkedStats = {
    isFile: () => false,
    isSymbolicLink: () => true,
  };
  const fsImpl = {
    existsSync: () => true,
    lstatSync: (candidate) =>
      path.resolve(candidate) === path.resolve(path.join(allowedDirectory, "linked"))
        ? linkedStats
        : normalStats,
  };

  assert.throws(
    () =>
      resolveManagedTempFile({
        filePath: targetFile,
        tempRoot: root,
        allowedParentDirectories: [allowedDirectory],
        fsImpl,
      }),
    /symbolic-link temporary path/
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

test("temporary run cleanup removes only an allowed per-run directory", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-run-cleanup-"));
  const imageDirectory = path.join(sandbox, "images");
  const runParent = path.join(imageDirectory, "chain-inputs");
  const runDirectory = path.join(runParent, "run-1");
  const siblingRunDirectory = path.join(runParent, "run-2");
  const rootSentinel = path.join(sandbox, "keep.txt");

  try {
    fs.mkdirSync(path.join(runDirectory, "nested"), { recursive: true });
    fs.mkdirSync(siblingRunDirectory, { recursive: true });
    fs.writeFileSync(path.join(runDirectory, "nested", "remove.txt"), "remove");
    fs.writeFileSync(path.join(siblingRunDirectory, "keep.txt"), "keep");
    fs.writeFileSync(rootSentinel, "keep");

    const result = removeManagedTempRunDirectory({
      directory: runDirectory,
      tempRoot: sandbox,
      allowedRunParentDirectories: [runParent],
    });

    assert.equal(result.removed, true);
    assert.equal(fs.existsSync(runDirectory), false);
    assert.equal(fs.existsSync(siblingRunDirectory), true);
    assert.equal(fs.existsSync(rootSentinel), true);
    assert.equal(
      removeManagedTempRunDirectory({
        directory: runDirectory,
        tempRoot: sandbox,
        allowedRunParentDirectories: [runParent],
      }).removed,
      false
    );
    assert.throws(
      () =>
        removeManagedTempRunDirectory({
          directory: sandbox,
          tempRoot: sandbox,
          allowedRunParentDirectories: [runParent],
        }),
      /per-run temporary directory/
    );
    assert.throws(
      () =>
        removeManagedTempRunDirectory({
          directory: runParent,
          tempRoot: sandbox,
          allowedRunParentDirectories: [runParent],
        }),
      /per-run temporary directory/
    );
    assert.throws(
      () =>
        removeManagedTempRunDirectory({
          directory: path.join(path.dirname(sandbox), "outside-run"),
          tempRoot: sandbox,
          allowedRunParentDirectories: [runParent],
        }),
      /per-run temporary directory/
    );
    assert.throws(
      () =>
        removeManagedTempRunDirectory({
          directory: path.join(siblingRunDirectory, "nested"),
          tempRoot: sandbox,
          allowedRunParentDirectories: [runParent],
        }),
      /per-run temporary directory/
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("temporary run cleanup can remove a nested run asynchronously", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-run-cleanup-async-"));
  const runParent = path.join(sandbox, "images", "folder-chain-inputs");
  const runDirectory = path.join(runParent, "run-1");
  const siblingRunDirectory = path.join(runParent, "run-2");

  try {
    fs.mkdirSync(path.join(runDirectory, "nested"), { recursive: true });
    fs.mkdirSync(siblingRunDirectory, { recursive: true });
    fs.writeFileSync(path.join(runDirectory, "nested", "remove.txt"), "remove");
    fs.writeFileSync(path.join(siblingRunDirectory, "keep.txt"), "keep");

    const result = await removeManagedTempRunDirectoryAsync({
      directory: runDirectory,
      tempRoot: sandbox,
      allowedRunParentDirectories: [runParent],
    });

    assert.equal(result.removed, true);
    assert.equal(fs.existsSync(runDirectory), false);
    assert.equal(fs.existsSync(siblingRunDirectory), true);
    assert.equal(
      (
        await removeManagedTempRunDirectoryAsync({
          directory: runDirectory,
          tempRoot: sandbox,
          allowedRunParentDirectories: [runParent],
        })
      ).removed,
      false
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("temporary run cleanup rejects symbolic links in the managed path", () => {
  const root = path.join(path.parse(process.cwd()).root, "moonshine-temp");
  const runParent = path.join(root, "images", "chain-inputs");
  const linkedParent = runParent;
  let removed = false;
  const directoryStats = {
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
  const symbolicLinkStats = {
    isDirectory: () => false,
    isSymbolicLink: () => true,
  };
  const fsImpl = {
    existsSync: () => true,
    lstatSync: (candidate) =>
      path.resolve(candidate) === path.resolve(linkedParent)
        ? symbolicLinkStats
        : directoryStats,
    rmSync: () => {
      removed = true;
    },
  };

  assert.throws(
    () =>
      removeManagedTempRunDirectory({
        directory: path.join(linkedParent, "run-1"),
        tempRoot: root,
        allowedRunParentDirectories: [runParent],
        fsImpl,
      }),
    /symbolic-link/
  );
  assert.equal(removed, false);
});

test("copy target conflict policy preserves rename by default and supports strict errors", () => {
  const target = path.join(path.parse(process.cwd()).root, "outputs", "result.png");
  const fsImpl = { existsSync: () => true };
  const now = new Date("2026-07-16T01:02:03.456Z");

  assert.equal(
    resolveCopyFileTarget(target, { fsImpl, now }),
    path.join(path.dirname(target), "result_2026-07-16T01-02-03-456Z.png")
  );
  assert.equal(
    resolveCopyFileTarget(target, { fsImpl: { existsSync: () => false }, now }),
    target
  );
  assert.throws(
    () => resolveCopyFileTarget(target, { fsImpl, conflictPolicy: "error", now }),
    (error) => error?.code === "COPY_TARGET_EXISTS"
  );
  assert.throws(
    () => resolveCopyFileTarget(target, { fsImpl, conflictPolicy: "overwrite", now }),
    /conflict policy/
  );
});
