import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const mainSource = fs.readFileSync("src-electron/electron-main.js", "utf8");
const preloadSource = fs.readFileSync("src-electron/electron-preload.js", "utf8");
const layoutSource = fs.readFileSync("src/layouts/MainLayout.vue", "utf8");
const brokerSource = fs.readFileSync("src-electron/mcp-native-broker/src/main.rs", "utf8");

test("MCP artifact open is a validated main-to-renderer file descriptor flow", () => {
  assert.match(mainSource, /resolveMcpLocalArtifact\(jobId, artifactId\)/);
  assert.match(mainSource, /MCP_ARTIFACT_NOT_IMAGE/);
  assert.match(mainSource, /sendToMainWindow\("mcp-open-artifact"/);
  assert.match(mainSource, /lastModified:/);
  assert.match(preloadSource, /"mcp-open-artifact"/);
  assert.match(preloadSource, /onMcpOpenArtifact/);
  assert.match(layoutSource, /useFileManagerStore/);
  assert.match(layoutSource, /onMcpOpenArtifact/);
  assert.match(layoutSource, /fileManagerStore\.addPathFiles/);
  assert.match(layoutSource, /router\.push\("\/image"\)/);
});

test("MCP broker lifecycle tears down every failure and close path", () => {
  assert.match(mainSource, /async function stopMcpExternalTransport\(\{ errorCode = null \} = \{\}\)/);
  assert.match(mainSource, /broker\.once\?\.\("close", finish\)/);
  assert.match(mainSource, /stopMcpExternalTransport\(\{ errorCode: code \}\)/);
  assert.match(mainSource, /MCP_BROKER_BOOTSTRAP_FAILED/);
  assert.match(mainSource, /onClientDisconnected: \(clientId\)/);
  assert.match(mainSource, /mcpApplicationDispatcher\.onPolicyChanged/);
  assert.match(mainSource, /child\.stdin\.write\(bootstrap/);
  assert.doesNotMatch(mainSource, /child\.stdin\.end\(bootstrap/);
  assert.match(mainSource, /broker\.stdin\?\.end\(\)/);
});

test("failed local MCP jobs clean partial artifacts before publishing bounded failures", () => {
  const start = mainSource.indexOf("function finishMcpLocalJob");
  const end = mainSource.indexOf("function resolveMcpLocalArtifact", start);
  assert.ok(start >= 0 && end > start, "finishMcpLocalJob source must remain present");
  const finishSource = mainSource.slice(start, end);
  assert.match(finishSource, /const succeeded = status === "succeeded"/);
  assert.match(finishSource, /if \(!succeeded\) \{[\s\S]*?cleanupMcpLocalArtifacts\(record\);/);
  assert.match(finishSource, /record\.results = Array\.isArray\(results\) \? results\.slice\(0, 1_000\) : \[\];/);
  assert.match(finishSource, /record\.artifacts = succeeded && Array\.isArray\(artifacts\)/);
  assert.match(finishSource, /record\.candidates = succeeded && Array\.isArray\(candidates\)/);
  assert.match(mainSource, /results\.push\(\{ success: false, id: item\?\.id \|\| null, error_code: "BACKEND_CAPABILITY_UNAVAILABLE" \}\)/);
  assert.doesNotMatch(mainSource, /results\.push\(\{ success: false, id: item\?\.id \|\| null, error: "BACKEND_CAPABILITY_UNAVAILABLE" \}\)/);
});

test("MCP external audit records retain bounded client metadata", () => {
  assert.match(mainSource, /clientName: request\?\.clientInfo\?\.name/);
  assert.match(mainSource, /clientVersion: request\?\.clientInfo\?\.version/);
  assert.match(mainSource, /clientName: record\.clientInfo\?\.name/);
  assert.match(mainSource, /clientVersion: record\.clientInfo\?\.version/);
  assert.match(mainSource, /createMcpLocalJob\(\{ tool, clientId, clientInfo \}\)/);
});

test("native MCP broker exits when its Electron parent closes bootstrap stdin", () => {
  assert.match(brokerSource, /fn watch_parent_stdin\(\)/);
  assert.match(brokerSource, /match input\.read\(&mut buffer\)/);
  assert.match(brokerSource, /Ok\(0\) \| Err\(_\) => std::process::exit\(0\)/);
  assert.match(brokerSource, /thread::spawn\(watch_parent_stdin\)/);
});
