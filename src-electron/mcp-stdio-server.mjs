import { runMcpStdioAdapter, startMcpStdioAdapter } from "./mcp-sdk-adapter.js";

const controlledError = (code) => {
  const error = new Error(code);
  error.code = code;
  return error;
};

function waitForControlledBootstrap() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(controlledError("MCP_BOOTSTRAP_TIMEOUT")), 15_000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off("message", onMessage);
      error ? reject(error) : resolve(value);
    };
    const onMessage = (message) => {
      if (!message || message.type !== "moonshine-mcp-bootstrap") return;
      if (!message.descriptor || typeof message.token !== "string" || typeof message.profile !== "string") {
        finish(controlledError("MCP_BOOTSTRAP_INVALID"));
        return;
      }
      finish(null, message);
    };
    process.on("message", onMessage);
  });
}

async function runControlledAdapter() {
  if (process.env.MOONSHINE_MCP_CONTROLLED !== "1" || typeof process.send !== "function") {
    return await runMcpStdioAdapter();
  }
  const bootstrap = await waitForControlledBootstrap();
  const adapter = await startMcpStdioAdapter({
    descriptor: bootstrap.descriptor,
    token: bootstrap.token,
    profile: bootstrap.profile,
    clientId: bootstrap.clientId,
  });
  return { enabled: true, ...adapter };
}

try {
  const result = await runControlledAdapter();
  if (result.enabled && typeof process.send === "function") {
    process.send({ type: "moonshine-mcp-ready" });
  }
} catch (error) {
  const code = error?.code || "MCP_START_FAILED";
  if (typeof process.send === "function") process.send({ type: "moonshine-mcp-failed", code });
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
