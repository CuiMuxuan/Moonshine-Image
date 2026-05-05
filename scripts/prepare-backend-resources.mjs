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
const sourceBackendRoot = path.join(repoRoot, PACKAGED_BACKEND_PROJECT_DIR);
const packagedBackendRoot = path.join(
  repoRoot,
  "build-resources",
  PACKAGED_BACKEND_RESOURCE_DIR,
  PACKAGED_BACKEND_PROJECT_DIR
);

const excludedDirNames = new Set([
  "__pycache__",
  ".git",
  ".venv",
  "venv",
  "env",
  ".pytest_cache",
  "tests",
]);
const excludedFileNames = new Set([".DS_Store"]);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resetDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

function listFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentPath = queue.pop();
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirNames.has(entry.name)) {
          queue.push(fullPath);
        }
        continue;
      }

      if (
        excludedFileNames.has(entry.name) ||
        entry.name.endsWith(".pyc") ||
        entry.name.endsWith(".pyo")
      ) {
        continue;
      }

      files.push(fullPath);
    }
  }

  return files.sort();
}

export function prepareBackendResources() {
  if (!fs.existsSync(sourceBackendRoot)) {
    throw new Error(`Backend source directory does not exist: ${sourceBackendRoot}`);
  }

  resetDir(packagedBackendRoot);
  for (const absolutePath of listFiles(sourceBackendRoot)) {
    const relativePath = path.relative(sourceBackendRoot, absolutePath);
    const destinationPath = path.join(packagedBackendRoot, relativePath);
    ensureDir(path.dirname(destinationPath));
    fs.copyFileSync(absolutePath, destinationPath);
  }

  return packagedBackendRoot;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const result = prepareBackendResources();
  console.log(`Prepared backend resources at ${result}`);
}
