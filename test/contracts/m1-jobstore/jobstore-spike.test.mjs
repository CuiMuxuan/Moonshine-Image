import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const FIXTURE_PATH = path.join(ROOT, 'test/contracts/m1-jobstore/jobstore-spike.yaml');
const fixture = YAML.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

const TRANSITIONS = new Map([
  ['queued', new Set(['running'])],
  ['running', new Set(['succeeded', 'failed', 'cancelling'])],
  ['cancelling', new Set(['cancelled', 'failed'])],
  ['succeeded', new Set()],
  ['failed', new Set()],
  ['cancelled', new Set()],
]);

function transition(from, to) {
  if (!TRANSITIONS.get(from)?.has(to)) throw new Error('invalid_transition');
  return to;
}

function submit(registry, request) {
  const key = `${request.scope}:${request.idempotency_key}`;
  const existing = registry.get(key);
  if (!existing) {
    const job = { job_id: 'job_spike0001', fingerprint: request.fingerprint, status: 'queued' };
    registry.set(key, job);
    return { result: 'created', job };
  }
  if (existing.fingerprint !== request.fingerprint) throw new Error('idempotency_conflict');
  return { result: 'reused', job: existing };
}

function appendEvent(previousSequence, sequence) {
  const expected = previousSequence === null ? 0 : previousSequence + 1;
  if (sequence !== expected) throw new Error('event_sequence');
  return sequence;
}

function recover(stagingState) {
  if (stagingState === 'started') throw new Error('replay_requires_confirmation');
  return 'inspect';
}

test('M1 fixture contains only bounded reversible spike cases', () => {
  assert.equal(fixture.fixture_version, 1);
  assert.deepEqual(fixture.contract_refs, ['core-v2', 'governance-v1']);
  assert.equal(fixture.invalid.length, 6);
  assert.match(import.meta.dirname, /test[\\/]contracts[\\/]m1-jobstore$/);
});

test('idempotency returns the same job for a matching fingerprint', () => {
  const registry = new Map();
  for (const request of fixture.valid_submissions) {
    const result = submit(registry, request);
    assert.equal(result.result, request.expected);
  }
  assert.equal(registry.size, 1);
});

test('valid status transitions and contiguous event cursors are accepted', () => {
  for (const record of fixture.valid_transitions) assert.equal(transition(record.from, record.to), record.to);
  for (const record of fixture.valid_events) {
    assert.equal(appendEvent(record.previous_sequence, record.sequence), record.sequence);
  }
});

test('invalid transitions, idempotency conflicts, gaps, rewinds, and replay are rejected', () => {
  const registry = new Map();
  submit(registry, fixture.valid_submissions[0]);
  for (const record of fixture.invalid) {
    assert.throws(() => {
      if (record.kind === 'transition') return transition(record.from, record.to);
      if (record.kind === 'submission') return submit(registry, record);
      if (record.kind === 'event') return appendEvent(record.previous_sequence, record.sequence);
      return recover(record.staging_state);
    }, new RegExp(record.expected_error), record.id);
  }
});
