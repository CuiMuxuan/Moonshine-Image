import { v4 as uuidv4 } from "uuid";

const WINDOWS_RESERVED_PATTERN = /[<>:"/\\|?*]/g;
const TRAILING_DOT_SPACE_PATTERN = /[. ]+$/g;

export const splitFileName = (fileName = "") => {
  const normalized = String(fileName || "").trim();
  const lastDotIndex = normalized.lastIndexOf(".");

  if (lastDotIndex <= 0) {
    return {
      baseName: normalized || "file",
      extension: "",
    };
  }

  return {
    baseName: normalized.slice(0, lastDotIndex) || "file",
    extension: normalized.slice(lastDotIndex),
  };
};

const replaceControlCharacters = (value = "") =>
  Array.from(String(value || ""))
    .map((char) => (char.charCodeAt(0) < 32 ? "_" : char))
    .join("");

export const sanitizeFileNameSegment = (value, fallback = "file") => {
  const normalized = replaceControlCharacters(value)
    .replace(WINDOWS_RESERVED_PATTERN, "_")
    .replace(TRAILING_DOT_SPACE_PATTERN, "")
    .trim();

  return normalized || fallback;
};

export const buildImageOutputBaseName = ({
  originalName = "",
  namingMode = "original",
  fixedPrefix = "moonshine",
} = {}) => {
  if (namingMode === "prefixUuid") {
    const safePrefix = sanitizeFileNameSegment(fixedPrefix, "moonshine");
    return `${safePrefix}_${uuidv4()}`;
  }

  return sanitizeFileNameSegment(splitFileName(originalName).baseName, "image");
};
