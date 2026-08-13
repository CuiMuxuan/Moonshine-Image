import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../src/components/global/BackendManager.vue", import.meta.url),
  "utf8"
);

const setupEnvironment = source.slice(
  source.indexOf("const setupEnvironment = async () =>"),
  source.indexOf("// 启动服务")
);

test("managed environment preparation success adds the start-service instruction immediately after readiness", () => {
  const readyIndex = setupEnvironment.indexOf("运行环境已就绪");
  const instructionIndex = setupEnvironment.indexOf(
    "请点击左方启动服务按钮，以启动服务。"
  );

  assert.ok(readyIndex >= 0, "Managed environment success should be reported.");
  assert.ok(instructionIndex > readyIndex, "The start-service instruction should follow readiness.");
  assert.match(
    setupEnvironment.slice(readyIndex, instructionIndex + 80),
    /addTerminalLog\("请点击左方启动服务按钮，以启动服务。", "success"\)/
  );
});

test("completed model tasks emit one green terminal line with their display name", () => {
  assert.match(source, /import \{ useModelRegistryStore \} from "src\/stores\/modelRegistry"/);
  assert.match(source, /const completedModelDownloadTaskIds = new Set\(\)/);
  assert.match(source, /const reportCompletedModelDownload = \(task = \{\}\) =>/);
  assert.match(source, /completedModelDownloadTaskIds\.has\(taskId\)/);
  assert.match(source, /completedModelDownloadTaskIds\.add\(taskId\)/);
  assert.match(source, /modelRegistryStore\.models\.find\(\(item\) => item\.id === modelId\)/);
  assert.match(source, /addTerminalLog\(`模型\$\{displayName\}下载成功。`, "success"\)/);
  assert.match(source, /task\?\.status === "completed" && task\.done/);
});

test("model task polling remains a collapsed summary rather than a completion source", () => {
  const terminalLogHandlerStart = source.indexOf(
    'const addTerminalLog = (message, type = "info") =>'
  );
  const terminalLogHandler = source.slice(
    terminalLogHandlerStart,
    source.indexOf("const fallbackMatDefaultModelIfNeeded", terminalLogHandlerStart)
  );

  assert.match(terminalLogHandler, /updateModelTaskPollSummary\(modelTaskPoll\)/);
  assert.doesNotMatch(terminalLogHandler, /reportCompletedModelDownload\(/);
});
