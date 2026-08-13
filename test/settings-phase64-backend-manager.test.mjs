import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../src/components/global/BackendManager.vue", import.meta.url),
  "utf8"
);

const between = (start, end) => {
  const startIndex = source.indexOf(start);
  return source.slice(startIndex, source.indexOf(end, startIndex));
};

test("service status row contains only the label and status chip", () => {
  const statusHeader = between(
    '<div class="service-overview__header">',
    '<dl class="service-info-grid">'
  );

  assert.match(statusHeader, />服务状态</);
  assert.match(statusHeader, /class="service-status-chip"/);
  assert.doesNotMatch(statusHeader, /<q-btn/);
  assert.match(source, /\.service-overview__header\s*\{[\s\S]*justify-content: space-between/);
});

test("service lifecycle controls share the lower centered location", () => {
  const configuration = between(
    '<section class="service-configuration"',
    "</section>"
  );

  assert.ok(
    configuration.indexOf("model-management-notice") <
      configuration.indexOf('data-testid="backend-service-controls"'),
    "Service controls should follow the model-management hint."
  );
  assert.match(configuration, /data-testid="backend-start-service-button"/);
  assert.match(configuration, /data-testid="backend-stop-service-button"/);
  assert.match(configuration, /data-testid="backend-restart-service-button"/);
  assert.match(source, /\.service-controls\s*\{[\s\S]*grid-template-columns: repeat\(2/);
  assert.match(source, /\.service-controls--single\s*\{[\s\S]*justify-content: center/);
});

test("manager panes own height and scroll independently without horizontal overflow", () => {
  assert.match(source, /:horizontal="\$q\.screen\.lt\.md"/);
  assert.match(source, /\.backend-manager-card\s*\{[\s\S]*display: flex;[\s\S]*flex-direction: column/);
  assert.match(source, /\.backend-content\s*\{[\s\S]*min-height: 0;[\s\S]*overflow: hidden/);
  assert.match(source, /\.control-panel\s*\{[\s\S]*min-width: 0;[\s\S]*overflow: hidden/);
  assert.match(source, /\.backend-stepper\s*\{[\s\S]*overflow-y: auto/);
  assert.match(source, /\.terminal-output\s*\{[\s\S]*min-height: 0;[\s\S]*overflow-x: hidden;[\s\S]*overflow-y: auto/);
});

test("successful model task polling is collapsed into one stable terminal summary", () => {
  assert.match(source, /const parseModelTaskPollLog =/);
  assert.match(source, /moonshine\\\/models\\\/tasks/);
  assert.match(source, /modelTaskPollCount \+= 1/);
  assert.match(source, /modelTaskPollSummaryLine\.message = message/);
  assert.match(source, /statusCode >= 200 && modelTaskPoll\.statusCode < 400/);
  assert.match(source, /getModelTaskPollSummary:/);
});
