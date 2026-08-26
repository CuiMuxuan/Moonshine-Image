export const MCP_API_METHODS = Object.freeze([
  "getMcpConfig",
  "saveMcpConfig",
  "selectMcpRoot",
  "getMcpState",
  "getMcpActivity",
]);

// These endpoints are added with the external stdio proxy.  They are optional
// so an already-installed application can still show its persisted policy
// rather than pretending that a partially upgraded preload is a usable proxy.
export const MCP_EXTERNAL_API_METHODS = Object.freeze([
  "getMcpClientConfiguration",
  "probeMcpExternalProxy",
  "getMcpClientSessions",
  "disconnectMcpClient",
  "getMcpApprovals",
  "resolveMcpApproval",
  "openMcpArtifactInEditor",
]);

const isCompleteMcpApi = (candidate) =>
  Boolean(candidate && MCP_API_METHODS.every((method) => typeof candidate[method] === "function"));

export function getElectronMcpCapability(targetWindow) {
  const browserWindow = arguments.length > 0
    ? targetWindow
    : typeof window !== "undefined"
      ? window
      : null;
  const electronBridge = browserWindow?.electron;
  if (!electronBridge) {
    return { environment: "browser", available: false, externalAvailable: false, api: null };
  }

  const api = [electronBridge.ipcRenderer, electronBridge].find(isCompleteMcpApi) || null;
  return {
    environment: "electron",
    available: Boolean(api),
    externalAvailable: Boolean(
      api && MCP_EXTERNAL_API_METHODS.every((method) => typeof api[method] === "function"),
    ),
    api,
  };
}

export const hasElectronMcpExternalApi = (api) =>
  Boolean(api && MCP_EXTERNAL_API_METHODS.every((method) => typeof api[method] === "function"));
