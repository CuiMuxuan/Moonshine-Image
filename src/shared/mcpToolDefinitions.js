/*
 * MCP tool capability metadata shared by the renderer, configuration schema,
 * and Electron dispatcher. The dispatcher owns the input schemas and routes;
 * this small dependency-free table keeps the access classification single-
 * sourced so defaults cannot drift from the registered tool surface.
 */
export const MCP_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({ name: "moonshine.status", access: "read" }),
  Object.freeze({ name: "moonshine.capabilities", access: "read" }),
  Object.freeze({ name: "moonshine.models.list", access: "read" }),
  Object.freeze({ name: "moonshine.ocr.detect", access: "task" }),
  Object.freeze({ name: "moonshine.masks.generate", access: "task" }),
  Object.freeze({ name: "moonshine.image.process", access: "task" }),
  Object.freeze({ name: "moonshine.image.process_batch", access: "task" }),
  Object.freeze({ name: "moonshine.jobs.get", access: "read" }),
  Object.freeze({ name: "moonshine.jobs.result", access: "read" }),
  Object.freeze({ name: "moonshine.jobs.cancel", access: "task" }),
  Object.freeze({ name: "moonshine.job_groups.get", access: "read" }),
  Object.freeze({ name: "moonshine.job_groups.cancel", access: "task" }),
]);

export const MCP_ALLOWED_TOOL_OPTIONS = Object.freeze(
  MCP_TOOL_DEFINITIONS.map((definition) => definition.name),
);

export const MCP_READ_ONLY_TOOL_OPTIONS = Object.freeze(
  MCP_TOOL_DEFINITIONS
    .filter((definition) => definition.access === "read")
    .map((definition) => definition.name),
);

export const getMcpToolDefinition = (name) =>
  MCP_TOOL_DEFINITIONS.find((definition) => definition.name === name) || null;

export const getMcpReadOnlyToolNames = (definitions = MCP_TOOL_DEFINITIONS) =>
  (Array.isArray(definitions) ? definitions : [])
    .filter((definition) => definition?.access === "read" && typeof definition.name === "string")
    .map((definition) => definition.name);
