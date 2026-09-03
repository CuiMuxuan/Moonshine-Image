import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getFailedModelDownloadDisplayMessage,
  getModelDownloadOriginalError,
  isRemoteUnreachableError,
  REMOTE_UNREACHABLE_ERROR_KIND,
  REMOTE_UNREACHABLE_USER_MESSAGE,
} from "../src/utils/modelDownloadErrors.js";

const readSource = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("connection timeouts map to the remote unreachable user message", () => {
  const task = {
    errorKind: REMOTE_UNREACHABLE_ERROR_KIND,
    message: REMOTE_UNREACHABLE_USER_MESSAGE,
    error:
      "URLError: <urlopen error [WinError 10060] 由于连接方在一段时间后没有正确答复或连接的主机没有反应，连接尝试失败。>",
  };

  assert.equal(isRemoteUnreachableError(task), true);
  assert.equal(
    getFailedModelDownloadDisplayMessage(task, "下载失败"),
    REMOTE_UNREACHABLE_USER_MESSAGE
  );
  assert.match(getModelDownloadOriginalError(task), /WinError 10060/);
});

test("raw URLError text is still classified without errorKind", () => {
  const errorText =
    "urllib.error.URLError: <urlopen error [WinError 10060] 由于连接方在一段时间后没有正确答复或连接的主机没有反应，连接尝试失败。>";
  assert.equal(isRemoteUnreachableError(errorText), true);
  assert.equal(
    getFailedModelDownloadDisplayMessage({ error: errorText }),
    REMOTE_UNREACHABLE_USER_MESSAGE
  );
});

test("checksum and license failures keep their original messages", () => {
  const checksumTask = {
    message: "模型下载失败。",
    error: "模型文件大小校验失败：ocr/det.onnx（期望 4，实际 3）",
  };
  const licenseError = new Error("下载该模型前必须确认并接受对应许可证。");

  assert.equal(isRemoteUnreachableError(checksumTask), false);
  assert.match(
    getFailedModelDownloadDisplayMessage(checksumTask, "下载失败"),
    /大小校验失败/
  );
  assert.equal(isRemoteUnreachableError(licenseError), false);
  assert.equal(
    getFailedModelDownloadDisplayMessage(licenseError, "模型下载失败"),
    licenseError.message
  );
});

test("model management banners prefer the user-facing download message", async () => {
  const panelSource = await readSource("src/components/global/ModelManagementPanel.vue");
  const storeSource = await readSource("src/stores/modelRegistry.js");

  assert.match(panelSource, /getFailedModelDownloadDisplayMessage\(task, "下载失败"\)/);
  assert.match(
    panelSource,
    /getFailedModelDownloadDisplayMessage\(preparation, preparationStageLabels\.failed\)/
  );
  assert.match(
    panelSource,
    /getFailedModelDownloadDisplayMessage\(error, error\.message \|\| "模型下载失败"\)/
  );
  assert.match(
    storeSource,
    /getFailedModelDownloadDisplayMessage\(task, "模型下载失败"\)/
  );
});
