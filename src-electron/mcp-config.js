import fs from "node:fs";
import path from "node:path";

import {
  containsMcpTokenMaterial,
  DEFAULT_MCP_CONFIG,
  MAX_MCP_ALLOWED_ROOTS,
  MCP_CONFIG_FIELD_NAMES,
  normalizeMcpConfigMetadata,
} from "../src/shared/appConfigSchema.js";

export const MCP_CONFIG_IPC_CHANNELS = Object.freeze({
  getConfig: "mcp-get-config",
  saveConfig: "mcp-save-config",
  selectRoot: "mcp-select-root",
});

export class McpConfigError extends Error {
  constructor(message, code = "MCP_CONFIG_INVALID", data = undefined) {
    super(message);
    this.name = "McpConfigError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

const isUnsafeWindowsPath = (value) => /^(?:\\\\[?.]|\\\\\.|\\\\|\/\/)/.test(value);

function normalizeAbsoluteRoot(value) {
  const root = String(value || "").trim();
  if (!root || isUnsafeWindowsPath(root)) return null;
  const win32 = path.win32.isAbsolute(root);
  const posix = !win32 && path.posix.isAbsolute(root);
  if (!win32 && !posix && !path.isAbsolute(root)) return null;
  const normalized = win32 ? path.win32.normalize(root) : posix ? path.posix.normalize(root) : path.normalize(root);
  return normalized && !isUnsafeWindowsPath(normalized) ? normalized : null;
}

function rootIdentity(value) {
  return path.win32.isAbsolute(value) ? value.replaceAll("\\", "/").toLowerCase() : value;
}

function configErrorPayload(error) {
  const code = error instanceof McpConfigError ? error.code : "MCP_CONFIG_INVALID";
  const payload = { success: false, code, error: code };
  if (error?.data && typeof error.data === "object" && !Array.isArray(error.data)) {
    payload.data = {
      enabled: error.data.enabled === true,
      profileId: typeof error.data.profileId === "string" ? error.data.profileId : "",
      allowedTools: Array.isArray(error.data.allowedTools) ? [...error.data.allowedTools] : [],
      allowedRoots: Array.isArray(error.data.allowedRoots) ? [...error.data.allowedRoots] : [],
      confirmationMode: typeof error.data.confirmationMode === "string"
        ? error.data.confirmationMode
        : "read_only",
    };
  }
  return payload;
}

export function createSerialMutationQueue() {
  let tail = Promise.resolve();
  return (mutation) => {
    if (typeof mutation !== "function") {
      return Promise.reject(new TypeError("Mutation queue requires a function."));
    }
    const next = tail.then(mutation, mutation);
    tail = next.catch(() => undefined);
    return next;
  };
}

function assertMcpPolicyShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpConfigError("MCP configuration must be an object.", "MCP_CONFIG_INVALID");
  }
  const unknownField = Object.keys(value).find((key) => !MCP_CONFIG_FIELD_NAMES.includes(key));
  if (unknownField) {
    throw new McpConfigError("MCP configuration contains an unknown field.", "MCP_CONFIG_INVALID");
  }
}

export function normalizeMcpConfig(value = {}) {
  if (containsMcpTokenMaterial(value)) {
    throw new McpConfigError("MCP configuration must not contain token material.", "MCP_TOKEN_MATERIAL_REJECTED");
  }
  assertMcpPolicyShape(value);

  const metadata = normalizeMcpConfigMetadata(value);
  const seen = new Set();
  const allowedRoots = metadata.allowedRoots.reduce((roots, root) => {
    const normalized = normalizeAbsoluteRoot(root);
    if (!normalized || seen.has(rootIdentity(normalized))) return roots;
    seen.add(rootIdentity(normalized));
    roots.push(normalized);
    return roots;
  }, []);

  return Object.freeze({
    enabled: metadata.enabled,
    profileId: metadata.profileId,
    allowedTools: Object.freeze([...metadata.allowedTools]),
    allowedRoots: Object.freeze(allowedRoots),
    confirmationMode: metadata.confirmationMode,
  });
}

export async function resolveTrustedMcpPath(candidate) {
  const lexicalRoot = normalizeAbsoluteRoot(candidate);
  if (!lexicalRoot) return null;
  try {
    const stats = fs.lstatSync(lexicalRoot);
    const canonicalPath = fs.realpathSync.native(lexicalRoot);
    const device = stats.isBlockDevice?.() || stats.isCharacterDevice?.() || stats.isFIFO?.() || stats.isSocket?.();
    const symlink = stats.isSymbolicLink?.() === true;
    const isDirectory = stats.isDirectory?.() === true;
    const isFile = stats.isFile?.() === true;
    if ((!isDirectory && !isFile) || symlink || device) return null;
    const canonicalRoot = normalizeAbsoluteRoot(canonicalPath);
    if (!canonicalRoot || rootIdentity(canonicalRoot) !== rootIdentity(lexicalRoot)) return null;
    return {
      canonical_path: canonicalRoot,
      is_directory: isDirectory,
      is_file: isFile,
      is_symlink: false,
      is_junction: false,
      is_device: false,
      is_unc: isUnsafeWindowsPath(canonicalRoot),
    };
  } catch {
    return null;
  }
}

export async function resolveTrustedMcpDirectory(candidate) {
  const resolved = await resolveTrustedMcpPath(candidate);
  if (!resolved?.is_directory) return null;
  return {
    canonical_path: resolved.canonical_path,
    is_directory: true,
    is_symlink: resolved.is_symlink,
    is_junction: resolved.is_junction,
    is_device: resolved.is_device,
    is_unc: resolved.is_unc,
  };
}

export async function canonicalizeMcpConfig(value = {}, resolveRoot) {
  if (typeof resolveRoot !== "function") {
    throw new McpConfigError("MCP root resolver is unavailable.", "MCP_CONFIG_INVALID");
  }

  const metadata = normalizeMcpConfig(value);
  const rawRoots = value && typeof value === "object" && !Array.isArray(value)
    ? value.allowedRoots
    : undefined;
  if (rawRoots !== undefined && !Array.isArray(rawRoots)) {
    throw new McpConfigError("MCP allowed roots must be an array.", "MCP_ROOT_INVALID");
  }
  if (Array.isArray(rawRoots) && rawRoots.length > MAX_MCP_ALLOWED_ROOTS) {
    throw new McpConfigError("MCP allowed roots exceed the configured limit.", "MCP_ROOT_INVALID");
  }

  const roots = [];
  const seen = new Set();
  for (const candidate of rawRoots || []) {
    const lexicalRoot = normalizeAbsoluteRoot(candidate);
    if (!lexicalRoot) {
      throw new McpConfigError("MCP allowed root is invalid.", "MCP_ROOT_INVALID");
    }
    const resolved = await resolveRoot(lexicalRoot);
    if (
      !resolved ||
      resolved.is_directory !== true ||
      resolved.is_symlink ||
      resolved.is_junction ||
      resolved.is_device ||
      resolved.is_unc ||
      typeof resolved.canonical_path !== "string"
    ) {
      throw new McpConfigError("MCP allowed root is not a trusted directory.", "MCP_ROOT_INVALID");
    }
    const canonicalRoot = normalizeAbsoluteRoot(resolved.canonical_path);
    if (!canonicalRoot) {
      throw new McpConfigError("MCP allowed root is invalid.", "MCP_ROOT_INVALID");
    }
    const identity = rootIdentity(canonicalRoot);
    if (!seen.has(identity)) {
      seen.add(identity);
      roots.push(canonicalRoot);
    }
  }

  return Object.freeze({
    ...metadata,
    allowedTools: Object.freeze([...metadata.allowedTools]),
    allowedRoots: Object.freeze(roots),
  });
}

export function registerMcpConfigIpc({ ipcMain, getConfig, saveConfig, selectRoot }) {
  if (!ipcMain || typeof ipcMain.handle !== "function") {
    throw new TypeError("MCP config IPC requires ipcMain.handle.");
  }
  if (typeof getConfig !== "function" || typeof saveConfig !== "function" || typeof selectRoot !== "function") {
    throw new TypeError("MCP config IPC requires named config callbacks.");
  }

  ipcMain.handle(MCP_CONFIG_IPC_CHANNELS.getConfig, async () => {
    try {
      return { success: true, data: normalizeMcpConfig(getConfig() || DEFAULT_MCP_CONFIG) };
    } catch (error) {
      return configErrorPayload(error);
    }
  });
  ipcMain.handle(MCP_CONFIG_IPC_CHANNELS.saveConfig, async (_event, value) => {
    try {
      return { success: true, data: await saveConfig(value) };
    } catch (error) {
      return configErrorPayload(error);
    }
  });
  ipcMain.handle(MCP_CONFIG_IPC_CHANNELS.selectRoot, async () => {
    try {
      const root = await selectRoot();
      return root ? { success: true, data: root } : { success: true, cancelled: true };
    } catch (error) {
      return configErrorPayload(error);
    }
  });
}
