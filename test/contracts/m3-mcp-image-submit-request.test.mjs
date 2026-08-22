import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

const root = path.resolve('.');
const contractPath = path.join(root, 'docs/contracts/mcp-ocr/mcp-image-submit-request-v1.yaml');
const dispatcherPath = path.join(root, 'src-electron/mcp-application-dispatcher.js');

function loadContract() {
  return YAML.parse(fs.readFileSync(contractPath, 'utf8'));
}

test('SEC-007 freezes required-mask, bounded workspace-relative submit inputs', () => {
  const contract = loadContract();
  assert.equal(contract.contract_id, 'mcp-image-submit-request-v1');
  assert.equal(contract.implementation_status, 'local_e2_candidate');
  assert.deepEqual(contract.request.bridge_input.required, [
    'workspace_id', 'items', 'client_id', 'request_id', 'idempotency_key',
    'policy_snapshot_id', 'confirmation',
  ]);
  assert.deepEqual(contract.request.body.properties.items.required_item_fields, [
    'id', 'input_path', 'mask_path',
  ]);
  assert.match(contract.request.body.properties.items.item.mask_path.semantics, /must reject omission/);
  assert.ok(contract.request.body.forbidden_fields.includes('output_root'));
  assert.ok(contract.request.bridge_input.forbidden.includes('absolute_path'));
  assert.equal(contract.request.body.properties.items.max_items, 100);
  assert.equal(contract.request.body.properties.items.item.model_id.max_length, 64);
});

test('SEC-007 freezes bridge boundary, queued identity, policy drift, and artifact ownership', () => {
  const contract = loadContract();
  assert.deepEqual(contract.request.headers.required, [
    'Idempotency-Key', 'X-Moonshine-Client', 'X-Moonshine-Request-Id', 'X-Moonshine-Policy-Snapshot',
  ]);
  assert.equal(contract.queue.submit_behavior.status, 202);
  assert.equal(contract.queue.submit_behavior.response_body.status_const, 'queued');
  assert.equal(contract.queue.submit_behavior.response_header.must_equal_body_field, 'job_id');
  assert.match(contract.queue.worker_policy_drift, /do not process inputs/);
  assert.match(contract.artifacts.root_ownership, /job-scoped artifact root/);
  assert.match(contract.artifacts.publication, /never absolute paths/);
  assert.equal(contract.errors.mapping.idempotency_conflict, 409);
  assert.ok(contract.stop_conditions.some((entry) => entry.includes('202 response body job_id')));
});

test('dispatcher exposes only the frozen submit route and rejects unsafe payloads', () => {
  const source = fs.readFileSync(dispatcherPath, 'utf8');
  assert.match(source, /"moonshine\.image\.process_batch"/);
  assert.match(source, /\/api\/v1\/jobs\/image-batch-inpaint/);
  assert.match(source, /X-Moonshine-Policy-Snapshot/);
  assert.match(source, /headerJobId !== bodyJobId/);
  assert.match(source, /function normalizeWorkspaceRelativePath/);
  assert.match(source, /normalized\.startsWith\("\/"\)/);
  assert.ok(source.includes('/^[A-Za-z][A-Za-z0-9+.-]*:/'));
  assert.match(source, /part === "\." \|\| part === "\.\."/);
});
