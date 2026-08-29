import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const backendManagerSource = await readFile(
  new URL("../src/components/global/BackendManager.vue", import.meta.url),
  "utf8"
);
const mainLayoutSource = await readFile(
  new URL("../src/layouts/MainLayout.vue", import.meta.url),
  "utf8"
);

const between = (source, start, end) => {
  const startIndex = source.indexOf(start);
  assert.ok(startIndex >= 0, `Missing source marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(endIndex > startIndex, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
};

test("external environment validation owns the global loading lifecycle", () => {
  const loadingHelper = between(
    backendManagerSource,
    "const withGlobalLoading",
    "const markExternalEnvironmentUnavailable"
  );
  const probeWorkflow = between(
    backendManagerSource,
    "const handleProbeExternalEnvironment",
    "const handleSelectExternalEnvironment"
  );

  assert.match(backendManagerSource, /inject\("loadingControl", null\)/);
  assert.match(loadingHelper, /loadingControl\?\.show\?\.\(message\)/);
  assert.match(loadingHelper, /finally\s*\{[\s\S]*loadingControl\?\.hide\?\.\(\)/);
  assert.match(probeWorkflow, /withGlobalLoading\("正在校验已有 Python 环境…"/);
  assert.match(probeWorkflow, /updateManager\.probeExternalEnvironment/);
});

test("activating an external environment performs a full recheck without rollback", () => {
  const markUnavailable = between(
    backendManagerSource,
    "const markExternalEnvironmentUnavailable",
    "const handleProbeExternalEnvironment"
  );
  const activationWorkflow = between(
    backendManagerSource,
    "const handleActivateExternalEnvironment",
    "const performForgetExternalEnvironment"
  );

  assert.match(activationWorkflow, /withGlobalLoading\("正在重新检测所选 Python 环境…"/);
  assert.match(activationWorkflow, /checkEnvironment\(\{ syncServiceStatus: true \}\)/);
  assert.match(activationWorkflow, /if \(!environmentStatus\.configured\)/);
  assert.match(activationWorkflow, /markExternalEnvironmentUnavailable\(message\)/);
  assert.doesNotMatch(
    activationWorkflow,
    /returnToManagedEnvironment|forgetExternalEnvironment/
  );

  assert.match(markUnavailable, /updateManager\.applyRuntimeState\(\{/);
  assert.match(markUnavailable, /source: "external"/);
  assert.match(markUnavailable, /status: "failed"/);
  assert.match(markUnavailable, /status: "invalid"/);
  assert.match(markUnavailable, /\.\.\.externalEnvironment\.value/);
});

test("service health-check start is logged at the renderer probe boundary", () => {
  const layoutStartWorkflow = between(
    mainLayoutSource,
    "const startBackendService",
    "const refreshBackendServiceStatus"
  );
  const managerStartWorkflow = between(
    backendManagerSource,
    "const startService = async",
    "// 停止服务"
  );

  const callbackIndex = layoutStartWorkflow.indexOf("lifecycle.onHealthCheckStart?.()");
  const probeIndex = layoutStartWorkflow.indexOf(
    "checkBackendStatus({ notifyOnFailure: false })"
  );
  assert.ok(callbackIndex >= 0 && callbackIndex < probeIndex);
  assert.match(
    managerStartWorkflow,
    /onHealthCheckStart:[\s\S]*addTerminalLog\("服务健康检查开始……", "success"\)/
  );
  assert.match(
    managerStartWorkflow,
    /addTerminalLog\(\s*"服务健康检查已通过，可以开始使用。",\s*"success"/
  );
});

test("global loading punctuation normalizes only terminal stops and dot runs", () => {
  const normalizationSource = between(
    mainLayoutSource,
    "const normalizeLoadingEllipsis",
    "const normalizeLoadingPayload"
  );
  const createNormalizers = new Function(
    `${normalizationSource}\nreturn { normalizeLoadingEllipsis, normalizeLoadingMessage };`
  );
  const { normalizeLoadingEllipsis, normalizeLoadingMessage } = createNormalizers();

  assert.equal(normalizeLoadingEllipsis("第一句。第二句。"), "第一句。第二句…");
  assert.equal(
    normalizeLoadingEllipsis("加载中...\n仍在处理……"),
    "加载中…\n仍在处理…"
  );
  assert.equal(
    normalizeLoadingMessage("正在下载。，可打开服务管理页面查看进度。"),
    "正在下载…\n可打开服务管理页面查看进度…"
  );
});
