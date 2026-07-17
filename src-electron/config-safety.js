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

function createFileSafetyError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPathContainsNoSymbolicLinks(candidatePath, rootPath, fsImpl) {
  const resolvedRoot = path.resolve(rootPath);
  const relativePath = path.relative(resolvedRoot, path.resolve(candidatePath));
  const segments = relativePath.split(path.sep).filter(Boolean);
  let currentPath = resolvedRoot;

  for (const segment of ["", ...segments]) {
    if (segment) {
      currentPath = path.join(currentPath, segment);
    }
    if (!fsImpl.existsSync(currentPath)) {
      break;
    }
    if (fsImpl.lstatSync(currentPath).isSymbolicLink()) {
      throw createFileSafetyError(
        `Refusing to remove a symbolic-link temporary path: ${currentPath}`,
        "TEMP_RUN_PATH_SYMBOLIC_LINK"
      );
    }
  }
}

export function resolveManagedTempRunDirectory({
  directory,
  tempRoot,
  allowedRunParentDirectories = [],
  fsImpl = fs,
} = {}) {
  if (
    typeof directory !== "string" ||
    !directory.trim() ||
    typeof tempRoot !== "string" ||
    !tempRoot.trim() ||
    !path.isAbsolute(directory) ||
    !path.isAbsolute(tempRoot)
  ) {
    throw createFileSafetyError(
      "Temporary run directory and root must be absolute paths.",
      "TEMP_RUN_PATH_INVALID"
    );
  }

  const resolvedDirectory = path.resolve(directory);
  const resolvedRoot = path.resolve(tempRoot);
  const normalizedParents = allowedRunParentDirectories.map((parentDirectory) =>
    path.resolve(parentDirectory)
  );
  const hasAllowedParent = normalizedParents.some((parentDirectory) => {
    const relativeRunPath = path.relative(parentDirectory, resolvedDirectory);
    return (
      isStrictSubdirectoryPath(parentDirectory, resolvedRoot) &&
      Boolean(relativeRunPath) &&
      !path.isAbsolute(relativeRunPath) &&
      path.dirname(relativeRunPath) === "."
    );
  });

  if (!isStrictSubdirectoryPath(resolvedDirectory, resolvedRoot) || !hasAllowedParent) {
    throw createFileSafetyError(
      `Refusing to remove a path that is not an allowed per-run temporary directory: ${resolvedDirectory}`,
      "TEMP_RUN_PATH_OUTSIDE_ALLOWED_ROOT"
    );
  }

  assertPathContainsNoSymbolicLinks(resolvedDirectory, resolvedRoot, fsImpl);
  return resolvedDirectory;
}

export function resolveManagedTempFile({
  filePath,
  tempRoot,
  allowedParentDirectories = [],
  allowedTempRootChildPrefixes = [],
  fsImpl = fs,
} = {}) {
  if (
    typeof filePath !== "string" ||
    !filePath.trim() ||
    typeof tempRoot !== "string" ||
    !tempRoot.trim() ||
    !path.isAbsolute(filePath) ||
    !path.isAbsolute(tempRoot)
  ) {
    throw createFileSafetyError(
      "Temporary file and root must be absolute paths.",
      "TEMP_FILE_PATH_INVALID"
    );
  }

  const resolvedFilePath = path.resolve(filePath);
  const resolvedRoot = path.resolve(tempRoot);
  const normalizedParents = allowedParentDirectories.map((parentDirectory) =>
    path.resolve(parentDirectory)
  );
  const allowedByParent = normalizedParents.some(
    (parentDirectory) =>
      isStrictSubdirectoryPath(parentDirectory, resolvedRoot) &&
      isStrictSubdirectoryPath(resolvedFilePath, parentDirectory)
  );
  const firstRelativeSegment = path
    .relative(resolvedRoot, resolvedFilePath)
    .split(path.sep)
    .filter(Boolean)[0];
  const allowedByRootChildPrefix = allowedTempRootChildPrefixes.some((prefix) =>
    firstRelativeSegment?.startsWith(String(prefix || ""))
  );

  if (
    !isStrictSubdirectoryPath(resolvedFilePath, resolvedRoot) ||
    (!allowedByParent && !allowedByRootChildPrefix)
  ) {
    throw createFileSafetyError(
      `Refusing to remove a file outside the allowed managed temporary paths: ${resolvedFilePath}`,
      "TEMP_FILE_PATH_OUTSIDE_ALLOWED_ROOT"
    );
  }

  assertPathContainsNoSymbolicLinks(resolvedFilePath, resolvedRoot, fsImpl);
  if (!fsImpl.existsSync(resolvedFilePath)) {
    return { exists: false, filePath: resolvedFilePath };
  }

  const stats = fsImpl.lstatSync(resolvedFilePath);
  if (stats.isSymbolicLink()) {
    throw createFileSafetyError(
      `Refusing to remove a symbolic-link temporary file: ${resolvedFilePath}`,
      "TEMP_FILE_PATH_SYMBOLIC_LINK"
    );
  }
  if (!stats.isFile()) {
    throw createFileSafetyError(
      `Temporary cleanup target is not a file: ${resolvedFilePath}`,
      "TEMP_FILE_PATH_NOT_FILE"
    );
  }

  return { exists: true, filePath: resolvedFilePath };
}

function prepareManagedTempRunDirectoryRemoval(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const directoryPath = resolveManagedTempRunDirectory({ ...options, fsImpl });
  if (!fsImpl.existsSync(directoryPath)) {
    return { fsImpl, directoryPath, exists: false };
  }

  const stats = fsImpl.lstatSync(directoryPath);
  if (stats.isSymbolicLink()) {
    throw createFileSafetyError(
      `Refusing to remove a symbolic-link temporary directory: ${directoryPath}`,
      "TEMP_RUN_PATH_SYMBOLIC_LINK"
    );
  }
  if (!stats.isDirectory()) {
    throw createFileSafetyError(
      `Temporary run cleanup target is not a directory: ${directoryPath}`,
      "TEMP_RUN_PATH_NOT_DIRECTORY"
    );
  }

  return { fsImpl, directoryPath, exists: true };
}

export function removeManagedTempRunDirectory(options = {}) {
  const target = prepareManagedTempRunDirectoryRemoval(options);
  if (!target.exists) {
    return { removed: false, directoryPath: target.directoryPath };
  }

  target.fsImpl.rmSync(target.directoryPath, { recursive: true, force: true });
  return { removed: true, directoryPath: target.directoryPath };
}

export async function removeManagedTempRunDirectoryAsync(options = {}) {
  const target = prepareManagedTempRunDirectoryRemoval(options);
  if (!target.exists) {
    return { removed: false, directoryPath: target.directoryPath };
  }

  if (typeof target.fsImpl.promises?.rm !== "function") {
    throw createFileSafetyError(
      "Asynchronous temporary directory removal is unavailable.",
      "TEMP_RUN_ASYNC_REMOVE_UNAVAILABLE"
    );
  }
  await target.fsImpl.promises.rm(target.directoryPath, {
    recursive: true,
    force: true,
  });
  return { removed: true, directoryPath: target.directoryPath };
}

export function resolveCopyFileTarget(
  target,
  { conflictPolicy = "rename", fsImpl = fs, now = new Date() } = {}
) {
  if (!new Set(["rename", "error"]).has(conflictPolicy)) {
    throw createFileSafetyError(
      `Unsupported copy-file conflict policy: ${String(conflictPolicy)}`,
      "COPY_CONFLICT_POLICY_INVALID"
    );
  }
  if (!fsImpl.existsSync(target)) {
    return target;
  }
  if (conflictPolicy === "error") {
    throw createFileSafetyError(`Target file already exists: ${target}`, "COPY_TARGET_EXISTS");
  }

  const fileExt = path.extname(target);
  const baseName = path.basename(target, fileExt);
  const dirName = path.dirname(target);
  const timestamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  return path.join(dirName, `${baseName}_${timestamp}${fileExt}`);
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
