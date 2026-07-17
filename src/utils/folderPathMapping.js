const normalizeSlashes = (value = "") =>
  String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");

const splitRelativePath = (value = "") => {
  const relativePath = normalizeSlashes(value);
  const slashIndex = relativePath.lastIndexOf("/");
  return slashIndex < 0
    ? { directory: "", fileName: relativePath }
    : {
        directory: relativePath.slice(0, slashIndex),
        fileName: relativePath.slice(slashIndex + 1),
      };
};

const splitFileName = (value = "") => {
  const fileName = String(value || "");
  const extensionMatch = fileName.match(/(\.[^./\\]+)$/);
  const extension = extensionMatch?.[1] || "";
  return {
    stem: extension ? fileName.slice(0, -extension.length) : fileName,
    extension,
  };
};

const getEntryRelativePath = (entry = {}) =>
  normalizeSlashes(entry.relativePath || entry.name || entry.path || "");

const getRelativeExactKey = (entry = {}) => getEntryRelativePath(entry).toLowerCase();

const getRelativeStemKey = (entry = {}) => {
  const { directory, fileName } = splitRelativePath(getEntryRelativePath(entry));
  const { stem } = splitFileName(fileName);
  return normalizeSlashes(directory ? `${directory}/${stem}` : stem).toLowerCase();
};

const getStemKey = (entry = {}) => {
  const { fileName } = splitRelativePath(getEntryRelativePath(entry));
  return splitFileName(fileName).stem.toLowerCase();
};

const addUniqueEntry = (map, duplicates, key, entry) => {
  if (!key || duplicates.has(key)) return;
  if (map.has(key)) {
    map.delete(key);
    duplicates.add(key);
    return;
  }
  map.set(key, entry);
};

export const normalizeFolderRelativePath = normalizeSlashes;

export const buildRelativeStemLookup = (entries = []) => {
  const relativeExact = new Map();
  const relative = new Map();
  const uniqueStem = new Map();
  const duplicateRelative = new Set();
  const duplicateStems = new Set();

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!relativeExact.has(getRelativeExactKey(entry))) {
      relativeExact.set(getRelativeExactKey(entry), entry);
    }
    addUniqueEntry(relative, duplicateRelative, getRelativeStemKey(entry), entry);
    addUniqueEntry(uniqueStem, duplicateStems, getStemKey(entry), entry);
  }

  return {
    relativeExact,
    relative,
    uniqueStem,
    duplicateRelative,
    duplicateStems,
  };
};

export const resolveRelativeStemMatch = (entry = {}, lookup = {}, options = {}) => {
  const exactMatch = lookup.relativeExact?.get(getRelativeExactKey(entry));
  if (exactMatch) return exactMatch;
  const relativeMatch = lookup.relative?.get(getRelativeStemKey(entry));
  if (relativeMatch) return relativeMatch;
  if (options.ambiguousTargetStems?.has(getStemKey(entry))) return null;
  return lookup.uniqueStem?.get(getStemKey(entry)) || null;
};

const getCollisionKey = (entry = {}) => getRelativeStemKey(entry);

export const collectRelativeStemCollisions = (entries = []) => {
  const counts = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = getCollisionKey(entry);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
};

export const collectFolderStemCollisions = (entries = []) => {
  const counts = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const key = getStemKey(entry);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
};

const normalizeExtension = (extension = "") => {
  const value = String(extension || "").trim();
  if (!value) return "";
  return value.startsWith(".") ? value : `.${value}`;
};

const getSourceExtensionSuffix = (entry = {}) => {
  const { fileName } = splitRelativePath(getEntryRelativePath(entry));
  const { extension } = splitFileName(fileName);
  const suffix = extension.replace(/^\./, "").replace(/[^a-zA-Z0-9]+/g, "_");
  return suffix || "file";
};

export const buildCollisionAwareRelativePath = (
  entry = {},
  targetExtension = "",
  collisions = new Set()
) => {
  const relativePath = getEntryRelativePath(entry);
  const { directory, fileName } = splitRelativePath(relativePath);
  const { stem, extension: sourceExtension } = splitFileName(fileName);
  const extension = normalizeExtension(targetExtension) || sourceExtension;
  const collisionSuffix = collisions.has(getCollisionKey(entry))
    ? `_${getSourceExtensionSuffix(entry)}`
    : "";
  const targetName = `${stem}${collisionSuffix}${extension}`;
  return directory ? `${directory}/${targetName}` : targetName;
};

export const reserveUniqueRelativeStemPath = (
  relativePath,
  usedStemKeys = new Set(),
  suffixHint = "file"
) => {
  const normalizedPath = normalizeSlashes(relativePath);
  const { directory, fileName } = splitRelativePath(normalizedPath);
  const { stem, extension } = splitFileName(fileName);
  const safeSuffix =
    String(suffixHint || "file").replace(/^\./, "").replace(/[^a-zA-Z0-9]+/g, "_") ||
    "file";
  let candidate = normalizedPath;
  let duplicateIndex = 0;
  while (usedStemKeys.has(getRelativeStemKey({ relativePath: candidate }))) {
    duplicateIndex += 1;
    const numberedSuffix = duplicateIndex === 1 ? safeSuffix : `${safeSuffix}_${duplicateIndex}`;
    const candidateName = `${stem}_${numberedSuffix}${extension}`;
    candidate = directory ? `${directory}/${candidateName}` : candidateName;
  }
  usedStemKeys.add(getRelativeStemKey({ relativePath: candidate }));
  return candidate;
};

export const selectStagedSourceSize = ({
  sourceType = "original",
  fallbackSize = 0,
  inlineSize = 0,
  pathSize = 0,
} = {}) => {
  const fallback = Math.max(0, Number(fallbackSize) || 0);
  if (sourceType === "base64") {
    return Math.max(0, Number(inlineSize) || 0);
  }
  if (sourceType === "path") {
    return Math.max(0, Number(pathSize) || 0) || fallback;
  }
  return fallback;
};
