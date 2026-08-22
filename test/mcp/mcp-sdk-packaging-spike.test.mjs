import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

const ADAPTER_SOURCE = String.raw`
import readline from 'node:readline';

const emit = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let requestCount = 0;

process.stderr.write('m3 stdio adapter spike ready\n');

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    emit({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'PARSE_ERROR' } });
    return;
  }

  requestCount += 1;
  if (request.jsonrpc !== '2.0' || !Object.hasOwn(request, 'id')) {
    emit({ jsonrpc: '2.0', id: request.id ?? null, error: { code: -32600, message: 'INVALID_REQUEST' } });
    return;
  }

  if (request.method === 'initialize') {
    emit({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'moonshine-m3-spike', version: '0.0.0-spike' },
      },
    });
    return;
  }

  if (request.method === 'tools/list') {
    emit({
      jsonrpc: '2.0',
      id: request.id,
      result: { tools: [{ name: 'moonshine.spike.status', inputSchema: { type: 'object' } }] },
    });
    return;
  }

  if (request.method === 'moonshine.spike.status') {
    emit({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        execution: 'same_process',
        adapter_pid: process.pid,
        spawned_backend_count: 0,
        listener_count: 0,
        request_count: requestCount,
      },
    });
    return;
  }

  emit({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'METHOD_NOT_FOUND' } });
});

input.on('close', () => process.exit(0));
`;

function runScratchAdapter(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', ADAPTER_SOURCE], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`scratch adapter exited with ${code}: ${stderr}`));
        return;
      }
      resolve({ pid: child.pid, stdout, stderr });
    });

    child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join('\n')}\n`);
  });
}

test('candidate Node stdio adapter keeps stdout JSON-RPC-only and never starts a backend', async () => {
  const secret = 'm3-stdio-token-must-not-be-emitted';
  const result = await runScratchAdapter([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { token: secret } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'moonshine.spike.status' },
  ]);

  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 3, 'each request should yield exactly one stdout record');
  const responses = lines.map((line) => {
    assert.doesNotThrow(() => JSON.parse(line), `stdout must not contain diagnostics: ${line}`);
    assert.doesNotMatch(line, new RegExp(secret), 'stdout must not disclose a token');
    const response = JSON.parse(line);
    assert.equal(response.jsonrpc, '2.0');
    assert.ok(Object.hasOwn(response, 'id'));
    assert.ok(Object.hasOwn(response, 'result') || Object.hasOwn(response, 'error'));
    return response;
  });

  assert.equal(responses[0].id, 1);
  assert.equal(responses[1].id, 2);
  assert.equal(responses[2].id, 3);
  assert.equal(responses[2].result.execution, 'same_process');
  assert.equal(responses[2].result.adapter_pid, result.pid);
  assert.equal(responses[2].result.spawned_backend_count, 0);
  assert.equal(responses[2].result.listener_count, 0);
  assert.match(result.stderr, /stdio adapter spike ready/);
  assert.doesNotMatch(result.stderr, new RegExp(secret), 'stderr must not disclose a token');

  for (const forbiddenModule of ['node:child_process', 'node:net', 'node:http', 'electron']) {
    assert.equal(ADAPTER_SOURCE.includes(forbiddenModule), false, `candidate must not import ${forbiddenModule}`);
  }
});
