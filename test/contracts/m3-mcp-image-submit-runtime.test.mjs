import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';

import { createMcpApplicationDispatcher, McpApplicationDispatchError } from '../../src-electron/mcp-application-dispatcher.js';
import { McpBridge, MCP_PROTOCOL_VERSION, workspaceIdForRoot } from '../../src-electron/mcp-bridge.js';

const root = path.resolve('.');
const policyId = 'pol_abcdefgh';
const workspaceRoot = 'C:/moonshine/inputs';
const workspaceId = workspaceIdForRoot(workspaceRoot);

function requestParams(overrides = {}) {
  return {
    workspace_id: workspaceId,
    items: [{ id: 'itm_abcdefgh', input_path: 'a.png', mask_path: 'a.mask.png' }],
    client_id: 'stdio-adapter',
    request_id: 'req_abcdefgh',
    idempotency_key: 'batch-key-001',
    policy_snapshot_id: policyId,
    confirmation: { policy_snapshot_id: policyId, mode: 'not_required' },
    ...overrides,
  };
}

test('M3-APP-005 dispatcher forwards the fixed body/header boundary and verifies queued identity', async () => {
  const requests = [];
  const dispatcher = createMcpApplicationDispatcher({
    request: async (request) => {
      requests.push(request);
      return {
        ok: true,
        status: 202,
        body: { schema_version: 'batch-submit-response/v1', job_id: 'job_abcdefgh', request_id: 'req_abcdefgh', status: 'queued' },
        headers: { 'x-moonshine-job-id': 'job_abcdefgh' },
      };
    },
  });

  const result = await dispatcher.dispatch({
    tool: 'moonshine.image.process_batch',
    params: requestParams(),
    policy: { id: policyId, allowedTools: ['moonshine.image.process_batch'] },
  });

  assert.deepEqual(result, { job_id: 'job_abcdefgh', request_id: 'req_abcdefgh', status: 'queued' });
  assert.deepEqual(requests, [{
    method: 'POST',
    path: '/api/v1/jobs/image-batch-inpaint',
    headers: {
      'Idempotency-Key': 'batch-key-001',
      'X-Moonshine-Client': 'stdio-adapter',
      'X-Moonshine-Request-Id': 'req_abcdefgh',
      'X-Moonshine-Policy-Snapshot': policyId,
    },
    body: {
      workspace_id: workspaceId,
      items: [{ id: 'itm_abcdefgh', input_path: 'a.png', mask_path: 'a.mask.png' }],
      confirmation: { policy_snapshot_id: policyId, mode: 'not_required' },
    },
  }]);

  const mismatched = createMcpApplicationDispatcher({
    request: async () => ({
      ok: true,
      status: 202,
      body: { job_id: 'job_abcdefgh', request_id: 'req_abcdefgh', status: 'queued' },
      headers: { 'x-moonshine-job-id': 'job_other123' },
    }),
  });
  await assert.rejects(
    mismatched.dispatch({
      tool: 'moonshine.image.process_batch',
      params: requestParams(),
      policy: { id: policyId, allowedTools: ['moonshine.image.process_batch'] },
    }),
    (error) => error instanceof McpApplicationDispatchError && error.code === 'QUEUE_UNAVAILABLE',
  );
});

test('M3-APP-005 bridge issues opaque workspace ids and keeps submitted paths relative', async () => {
  const received = [];
  const bridge = new McpBridge({
    confirmationRequired: false,
    resolvePath: async (candidate) => ({
      canonical_path: candidate,
      is_device: false,
      is_junction: false,
      is_symlink: false,
      is_unc: false,
      is_file: true,
    }),
    dispatch: async (payload) => {
      received.push(payload);
      return { job_id: 'job_abcdefgh', status: 'queued' };
    },
  });
  const descriptor = await bridge.start({
    enabled: true,
    profile: 'desktop-default',
    token: 'secret',
    allowedRoots: [workspaceRoot],
    confirmationRequired: false,
  });
  try {
    assert.deepEqual(descriptor.workspace_ids, [workspaceId]);
    const response = await new Promise((resolve, reject) => {
      const socket = net.createConnection(descriptor.endpoint);
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => {
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bridge.handshake', params: {
          protocol_version: MCP_PROTOCOL_VERSION, profile: 'desktop-default', token: 'secret', client_id: 'stdio-adapter',
        } })}\n`);
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'bridge.call', params: {
          tool: 'moonshine.image.process_batch',
          ...requestParams({
            policy_snapshot_id: descriptor.policy_snapshot_id,
            confirmation: { policy_snapshot_id: descriptor.policy_snapshot_id, mode: 'not_required' },
          }),
        } })}\n`);
      });
      socket.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) if (line) {
          const parsed = JSON.parse(line);
          if (parsed.id === 2) { socket.end(); resolve(parsed); }
        }
      });
      socket.on('error', reject);
    });
    assert.deepEqual(response.result, { job_id: 'job_abcdefgh', status: 'queued' });
    assert.equal(received[0].params.items[0].input_path, 'a.png');
    assert.equal(Object.hasOwn(received[0].params, 'absolute_path'), false);
  } finally {
    await bridge.stop();
  }
});

test('M3-APP-005 source boundary exposes the private route without path or raw-body leakage', () => {
  const dispatcher = fs.readFileSync(path.join(root, 'src-electron/mcp-application-dispatcher.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src-electron/electron-main.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'server/moonshine_server/api.py'), 'utf8');
  assert.match(dispatcher, /\/api\/v1\/jobs\/image-batch-inpaint/);
  assert.match(dispatcher, /headerJobId !== bodyJobId/);
  assert.match(main, /JSON\.stringify\(body\)/);
  assert.match(main, /X-Moonshine-Policy-Snapshot/);
  assert.match(api, /def api_mcp_image_submit/);
  assert.match(api, /status_code=202/);
  assert.match(api, /X-Moonshine-Job-Id/);
  assert.doesNotMatch(dispatcher, /output_root/);
});
