import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PACKAGED_BACKEND_PROJECT_DIR,
  PACKAGED_BACKEND_RESOURCE_DIR,
} from "../src-electron/integrity/public-key.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const sourceBackendRoot = path.join(repoRoot, "IOPaint");
const sourcePatchRoot = path.join(repoRoot, "iopaint-change");
const buildResourcesRoot = path.join(repoRoot, "build-resources");
const packagedBackendRoot = path.join(
  buildResourcesRoot,
  PACKAGED_BACKEND_RESOURCE_DIR,
  PACKAGED_BACKEND_PROJECT_DIR
);

const excludedDirNames = new Set([".venv", "__pycache__", "tests"]);
const excludedFileNames = new Set(["requirements-dev.txt", "setup.py", ".gitignore"]);
const allowedRootFiles = new Set(["main.py", "requirements.txt"]);
const allowedRuntimeExtensions = new Set([".py", ".txt", ".yaml"]);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resetDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

function toPosixPath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function listFiles(rootDir) {
  const files = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentPath = queue.pop();
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (excludedDirNames.has(entry.name)) {
          continue;
        }
        queue.push(fullPath);
        continue;
      }
      files.push(fullPath);
    }
  }

  return files.sort();
}

function shouldCopyBackendFile(relativePath) {
  const normalizedPath = toPosixPath(relativePath);
  const segments = normalizedPath.split("/");
  const fileName = segments.at(-1);

  if (segments.some((segment) => excludedDirNames.has(segment))) {
    return false;
  }

  if (excludedFileNames.has(fileName)) {
    return false;
  }

  if (segments.length === 1) {
    return allowedRootFiles.has(fileName);
  }

  if (segments[0] !== "iopaint") {
    return false;
  }

  return allowedRuntimeExtensions.has(path.extname(fileName).toLowerCase());
}

function shouldCopyPatchFile(relativePath) {
  const normalizedPath = toPosixPath(relativePath);
  const fileName = path.basename(normalizedPath);
  return (
    !normalizedPath.includes("/__pycache__/") &&
    !excludedFileNames.has(fileName) &&
    allowedRuntimeExtensions.has(path.extname(fileName).toLowerCase())
  );
}

function copyFiles(rootDir, destinationMapper, predicate) {
  for (const absolutePath of listFiles(rootDir)) {
    const relativePath = path.relative(rootDir, absolutePath);
    if (!predicate(relativePath)) {
      continue;
    }

    const destinationPath = destinationMapper(relativePath);
    ensureDir(path.dirname(destinationPath));
    fs.copyFileSync(absolutePath, destinationPath);
  }
}

export function materializePackagedBackend() {
  if (!fs.existsSync(sourceBackendRoot)) {
    throw new Error(`Backend source directory does not exist: ${sourceBackendRoot}`);
  }

  resetDir(packagedBackendRoot);

  copyFiles(
    sourceBackendRoot,
    (relativePath) => path.join(packagedBackendRoot, relativePath),
    shouldCopyBackendFile
  );

  if (fs.existsSync(sourcePatchRoot)) {
    copyFiles(
      sourcePatchRoot,
      (relativePath) => path.join(packagedBackendRoot, "iopaint", relativePath),
      shouldCopyPatchFile
    );
  }

  return {
    packagedBackendRoot,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const result = materializePackagedBackend();
  console.log(`Materialized packaged backend at ${result.packagedBackendRoot}`);
}
