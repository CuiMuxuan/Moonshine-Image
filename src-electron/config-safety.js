import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_MANAGED_FOLDER_NAMES,
  isValidManagedFolderName,
} from "../src/shared/appConfigSchema.js";

const BUILTIN_VIDEO_TEMP_FOLDERS = Object.freeze([
  "video_frames",
  "moonshine-videos",
  "moonshine-sam-video-masks",
]);

export function isValidConfiguredDirectoryPath(value) {
  return (
    typeof value === "string" &&
    (!value.trim() || path.isAbsolute(value))
  );
}

export function normalizeConfiguredDirectoryPath(value, fallback) {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) {
    return path.normalize(fallback);
  }
  return path.normalize(value);
}

export function isStrictSubdirectoryPath(candidatePath, rootPath) {
  if (
    typeof candidatePath !== "string" ||
    typeof rootPath !== "string" ||
    !path.isAbsolute(candidatePath) ||
    !path.isAbsolute(rootPath)
  ) {
    return false;
  }

  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return (
    Boolean(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

export function resolveStrictTempSubdirectory(tempRoot, folderName) {
  if (typeof tempRoot !== "string" || !tempRoot.trim() || !path.isAbsolute(tempRoot)) {
    throw new Error("Temporary root path must be an absolute path.");
  }
  if (!isValidManagedFolderName(folderName)) {
    throw new Error("Managed temporary folder name is invalid.");
  }

  const resolvedRoot = path.resolve(tempRoot);
  const resolvedDirectory = path.resolve(resolvedRoot, folderName);
  if (!isStrictSubdirectoryPath(resolvedDirectory, resolvedRoot)) {
    throw new Error(`Refusing to use a non-child temporary path: ${resolvedDirectory}`);
  }
  return resolvedDirectory;
}

export function buildTempCleanupTargets({
  tempRoot,
  cleanupOptions = {},
  imageFolderName = DEFAULT_MANAGED_FOLDER_NAMES.image,
  videoFolderName = DEFAULT_MANAGED_FOLDER_NAMES.video,
} = {}) {
  const folderNames = [];
  if (cleanupOptions.includeImages) {
    folderNames.push(imageFolderName);
  }
  if (cleanupOptions.includeVideos) {
    folderNames.push(videoFolderName, ...BUILTIN_VIDEO_TEMP_FOLDERS);
  }

  return Array.from(new Set(folderNames)).map((folderName) =>
    resolveStrictTempSubdirectory(tempRoot, folderName)
  );
}

function shouldRemoveTempEntry(stats, cutoffMs) {
  return Number(stats?.mtimeMs || 0) < cutoffMs;
}

export function cleanupManagedTempDirectory({
  directory,
  tempRoot,
  cutoffMs,
  fsImpl = fs,
} = {}) {
  const result = {
    removedFileCount: 0,
    removedDirectoryCount: 0,
    removedBytes: 0,
    skippedCount: 0,
  };

  if (!isStrictSubdirectoryPath(directory, tempRoot)) {
    throw new Error(`Refusing to clean a non-child temporary path: ${directory}`);
  }
  if (!fsImpl.existsSync(directory)) {
    return result;
  }

  const directoryStats = fsImpl.lstatSync(directory);
  if (directoryStats.isSymbolicLink()) {
    throw new Error(`Refusing to clean a symbolic-link temporary directory: ${directory}`);
  }
  if (!directoryStats.isDirectory()) {
    if (shouldRemoveTempEntry(directoryStats, cutoffMs)) {
      result.removedBytes += directoryStats.size || 0;
      fsImpl.rmSync(directory, { force: true });
      result.removedFileCount += 1;
    } else {
      result.skippedCount += 1;
    }
    return result;
  }

  fsImpl.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (!isStrictSubdirectoryPath(entryPath, tempRoot)) {
      result.skippedCount += 1;
      return;
    }

    const entryStats = fsImpl.lstatSync(entryPath);
    if (!shouldRemoveTempEntry(entryStats, cutoffMs)) {
      result.skippedCount += 1;
      return;
    }

    result.removedBytes += entryStats.size || 0;
    fsImpl.rmSync(entryPath, { recursive: true, force: true });
    if (entryStats.isDirectory() && !entryStats.isSymbolicLink()) {
      result.removedDirectoryCount += 1;
    } else {
      result.removedFileCount += 1;
    }
  });

  return result;
}
