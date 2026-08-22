import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

const root = path.resolve(".");
const contractPath = path.join(root, "docs/contracts/mcp-ocr/mcp-image-process-batch.yaml");
const dispatcherPath = path.join(root, "src-electron/mcp-application-dispatcher.js");

function loadContract() {
  return YAML.parse(fs.readFileSync(contractPath, "utf8"));
}

test("M3 freezes canonical batch request and header contract without raw bytes", () => {
  const contract = loadContract();
  assert.equal(contract.contract_id, "mcp-image-process-batch-v1");
  assert.equal(contract.implementation_status, "local_e2_candidate");
  assert.equal(contract.tool.name, "moonshine.image.process_batch");
  assert.equal(contract.http.method, "POST");
  assert.equal(contract.http.path, "/api/v1/batch_inpaint");
  assert.deepEqual(contract.request.headers.required, ["Idempotency-Key", "X-Moonshine-Client", "request_id"]);
  assert.deepEqual(contract.request.body.required, ["workspace_id", "input_paths", "output_root"]);
  assert.equal(contract.request.body.properties.input_paths.item_type, "canonical_workspace_relative_path");
  assert.equal(contract.request.body.properties.mask_paths.cardinality, "omitted or exactly equal to input_paths; item i masks input_paths item i.");
  assert.equal(contract.request.body.properties.output_root.properties.mode.const, "job_scoped");
  assert.ok(contract.request.body.forbidden_fields.includes("raw_base64"));
  assert.ok(contract.request.body.forbidden_fields.includes("output_path"));
  assert.ok(contract.request.path_rules.canonical_workspace_relative_path.rules.includes("no_drive_letter"));
  assert.ok(contract.request.path_rules.canonical_workspace_relative_path.rules.includes("resolves_inside_registered_workspace"));
});

test("M3 freezes job header mapping, artifact-only results, confirmation and rollback", () => {
  const contract = loadContract();
  assert.equal(contract.response.accepted.status, 202);
  assert.equal(contract.response.accepted.header_mapping["X-Moonshine-Job-Id"], "job_id");
  assert.equal(contract.response.result.required_header_mapping["X-Moonshine-Job-Id"], "job_id");
  assert.ok(contract.response.result.body.artifacts.items.forbidden.includes("absolute_path"));
  assert.equal(contract.response.result.body.artifacts.items.resource_link.scheme, "artifact");
  assert.deepEqual(contract.confirmation.required_when, [
    "output_root_is_outside_default_root",
    "replace_existing_output_is_requested",
  ]);
  assert.match(contract.rollback.cancellation, /never delete pre-existing user files/);
  assert.ok(contract.stop_conditions.some((entry) => entry.includes("X-Moonshine-Job-Id")));
});

test("runtime dispatcher preserves the frozen submit boundary", () => {
  const source = fs.readFileSync(dispatcherPath, "utf8");
  assert.match(source, /moonshine\.image\.process_batch/);
  assert.match(source, /\/api\/v1\/jobs\/image-batch-inpaint/);
  assert.match(source, /Idempotency-Key/);
  assert.match(source, /X-Moonshine-Policy-Snapshot/);
  assert.match(source, /safeSubmitParams/);
});
