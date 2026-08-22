import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const schemaPath = path.resolve('server/moonshine_server/schema.py');

test('M3-APP-005 submit schema validates submit fields independently from legacy batch fields', () => {
  const source = fs.readFileSync(schemaPath, 'utf8');
  const start = source.indexOf('class McpImageSubmitRequest');
  const end = source.indexOf('\nclass BatchInpaintByFolderRequest', start);
  assert.ok(start >= 0 && end > start);
  const submitSource = source.slice(start, end);
  assert.match(submitSource, /workspace_id/);
  assert.match(submitSource, /items: List\[McpImageSubmitItem\]/);
  assert.match(submitSource, /confirmation: McpImageSubmitConfirmation/);
  assert.match(submitSource, /item_ids = \[item\.id for item in self\.items\]/);
  assert.doesNotMatch(submitSource, /values\.data|values\.output_format/);
});
