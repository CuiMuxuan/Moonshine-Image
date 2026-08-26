import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const manifestPath = path.join(repoRoot, "src-electron", "mcp-native-broker", "Cargo.toml");
const targetPath = path.join(repoRoot, "src-electron", "mcp-native-broker", "target", "release", "moonshine-mcp-broker.exe");
const resourcePath = path.join(repoRoot, "build-resources", "mcp", "moonshine-mcp-broker.exe");

export function buildMcpNativeBroker({ cargo = "cargo", spawn = spawnSync } = {}) {
  if (process.platform !== "win32") {
    throw new Error("MCP native broker is only buildable on Windows.");
  }
  const result = spawn(cargo, ["build", "--release", "--manifest-path", manifestPath], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || !fs.existsSync(targetPath)) {
    const detail = String(result.error?.message || result.stderr || result.stdout || "cargo build failed").trim();
    throw new Error(`MCP native broker build failed: ${detail}`);
  }
  fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
  fs.copyFileSync(targetPath, resourcePath);
  return resourcePath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(buildMcpNativeBroker());
}
