import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import test from 'node:test';

const BRIDGE_SOURCE = String.raw`
import net from 'node:net';

const protocolVersion = 'm3-spike-v1';
const capabilityToken = process.env.MOONSHINE_SPIKE_TOKEN;
const allowedProfile = process.env.MOONSHINE_SPIKE_PROFILE;
const instanceId = process.env.MOONSHINE_SPIKE_INSTANCE_ID;

function send(socket, id, payload) {
  socket.write(JSON.stringify({ jsonrpc: '2.0', id, ...payload }) + '\n');
}

function reject(socket, id, code) {
  send(socket, id, { error: { code, message: code } });
}

const bridge = net.createServer((socket) => {
  let authorized = false;
  let pending = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    pending += chunk;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
      if (!line) continue;

      let request;
      try {
        request = JSON.parse(line);
      } catch {
        reject(socket, null, 'PARSE_ERROR');
        continue;
      }

      if (request.jsonrpc !== '2.0' || !Object.hasOwn(request, 'id')) {
        reject(socket, request.id ?? null, 'INVALID_REQUEST');
        continue;
      }

      const params = request.params ?? {};
      if (request.method === 'bridge.handshake') {
        if (params.protocol_version !== protocolVersion) {
          reject(socket, request.id, 'PROTOCOL_MISMATCH');
        } else if (params.token !== capabilityToken) {
          reject(socket, request.id, 'AUTH_DENIED');
        } else if (params.profile !== allowedProfile) {
          reject(socket, request.id, 'PROFILE_DENIED');
        } else {
          authorized = true;
          send(socket, request.id, {
            result: {
              protocol_version: protocolVersion,
              profile: allowedProfile,
              policy_snapshot_id: 'm3-spike-policy-v1',
            },
          });
        }
        continue;
      }

      if (request.method === 'bridge.call') {
        if (!authorized) {
          reject(socket, request.id, 'AUTH_REQUIRED');
        } else {
          reject(socket, request.id, 'APP_NOT_RUNNING');
        }
        continue;
      }

      reject(socket, request.id, 'METHOD_NOT_FOUND');
    }
  });
});

bridge.listen({ host: '127.0.0.1', port: 0 }, () => {
  const address = bridge.address();
  process.stdout.write(JSON.stringify({
    protocol_version: protocolVersion,
    instance_id: instanceId,
    endpoint: { host: '127.0.0.1', port: address.port },
    expires_at: '2099-01-01T00:00:00Z',
  }) + '\n');
  process.stderr.write('m3 loopback bridge spike ready\n');
});
`;

function sendSequence(endpoint, messages) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
    let pending = '';
    const responses = [];
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('bridge response timeout'));
    }, 5000);

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);
    });
    socket.on('data', (chunk) => {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
        if (line) responses.push(JSON.parse(line));
      }
      if (responses.length === messages.length) socket.end();
    });
    socket.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      if (responses.length !== messages.length) {
        reject(new Error(`expected ${messages.length} bridge responses, received ${responses.length}`));
        return;
      }
      resolve(responses);
    });
  });
}

function startScratchBridge(t, token, profile) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', BRIDGE_SOURCE], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MOONSHINE_SPIKE_TOKEN: token,
      MOONSHINE_SPIKE_PROFILE: profile,
      MOONSHINE_SPIKE_INSTANCE_ID: randomUUID(),
    },
  });
  let stdout = '';
  let stderr = '';
  let descriptor;

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    const line = stdout.split('\n').find(Boolean);
    if (line && !descriptor) descriptor = JSON.parse(line);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const ready = new Promise((resolve, reject) => {
    child.on('error', reject);
    const interval = setInterval(() => {
      if (descriptor) {
        clearInterval(interval);
        resolve(descriptor);
      }
    }, 10);
    child.on('close', (code) => {
      clearInterval(interval);
      if (!descriptor) reject(new Error(`scratch bridge exited before ready (${code}): ${stderr}`));
    });
  });

  t.after(async () => {
    if (!child.killed) child.kill();
    await new Promise((resolve) => child.once('close', resolve));
  });

  return { child, ready, output: () => ({ stdout, stderr }) };
}

function assertError(response, id, code) {
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, id);
  assert.equal(response.error.code, code);
}

test('private loopback bridge rejects arbitrary calls and never emits token values', async (t) => {
  const token = 'm3-loopback-token-must-not-be-emitted';
  const profile = 'desktop-default';
  const bridge = startScratchBridge(t, token, profile);
  const descriptor = await bridge.ready;

  assert.equal(descriptor.protocol_version, 'm3-spike-v1');
  assert.equal(descriptor.endpoint.host, '127.0.0.1');
  assert.equal(Number.isInteger(descriptor.endpoint.port), true);
  assert.ok(descriptor.endpoint.port > 0);
  assert.equal(Object.hasOwn(descriptor, 'token'), false, 'descriptor must not contain a token');
  assert.doesNotMatch(JSON.stringify(descriptor), new RegExp(token));

  const arbitraryCall = await sendSequence(descriptor.endpoint, [
    { jsonrpc: '2.0', id: 1, method: 'bridge.call', params: { tool: 'moonshine.jobs.list' } },
  ]);
  assertError(arbitraryCall[0], 1, 'AUTH_REQUIRED');

  const wrongToken = await sendSequence(descriptor.endpoint, [
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'bridge.handshake',
      params: { protocol_version: 'm3-spike-v1', token: 'attacker-token', profile },
    },
  ]);
  assertError(wrongToken[0], 2, 'AUTH_DENIED');

  const wrongProfile = await sendSequence(descriptor.endpoint, [
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'bridge.handshake',
      params: { protocol_version: 'm3-spike-v1', token, profile: 'untrusted-profile' },
    },
  ]);
  assertError(wrongProfile[0], 3, 'PROFILE_DENIED');

  const incompatibleProtocol = await sendSequence(descriptor.endpoint, [
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'bridge.handshake',
      params: { protocol_version: 'unsupported', token, profile },
    },
  ]);
  assertError(incompatibleProtocol[0], 4, 'PROTOCOL_MISMATCH');

  const authenticated = await sendSequence(descriptor.endpoint, [
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'bridge.handshake',
      params: { protocol_version: 'm3-spike-v1', token, profile },
    },
    { jsonrpc: '2.0', id: 6, method: 'bridge.call', params: { tool: 'moonshine.jobs.list' } },
  ]);
  assert.equal(authenticated[0].result.profile, profile);
  assert.equal(authenticated[0].result.policy_snapshot_id, 'm3-spike-policy-v1');
  assertError(authenticated[1], 6, 'APP_NOT_RUNNING');

  const output = bridge.output();
  assert.match(output.stderr, /loopback bridge spike ready/);
  assert.doesNotMatch(output.stdout, new RegExp(token), 'session descriptor must not disclose a token');
  assert.doesNotMatch(output.stderr, new RegExp(token), 'bridge diagnostics must not disclose a token');
  assert.equal(BRIDGE_SOURCE.includes('electron'), false, 'spike bridge must not import Electron');
});
