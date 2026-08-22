import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACT_ROOT = path.join(ROOT, 'docs/contracts/mcp-ocr');
const SCHEMA_ROOT = path.join(CONTRACT_ROOT, 'schemas');
const FIXTURE_ROOT = path.join(ROOT, 'test/contracts/fixtures');
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function loadYaml(filePath) {
  return YAML.parse(fs.readFileSync(filePath, 'utf8'));
}

function createValidator(schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(schema);
  return (target) => ajv.compile({ $ref: `${schema.$id}#/$defs/${target}` });
}

function assertSchemaValid(validate, fixture) {
  assert.equal(
    validate(fixture.value),
    true,
    `${fixture.id} should pass ${fixture.target}: ${JSON.stringify(validate.errors)}`,
  );
}

function assertSchemaInvalid(validate, fixture) {
  assert.equal(validate(fixture.value), false, `${fixture.id} should be rejected`);
  assert.ok(
    validate.errors?.some((error) => error.keyword === fixture.expected_keyword),
    `${fixture.id} should report ${fixture.expected_keyword}: ${JSON.stringify(validate.errors)}`,
  );
}

function isWorkspaceRelativePath(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) return false;
  return !candidate.split(/[\\/]+/).includes('..');
}

function assertEvidenceFilesAreSafe(manifest, source) {
  for (const entry of manifest.files) {
    assert.ok(isWorkspaceRelativePath(entry.path), `${source}: workspace_relative_path (${entry.path})`);
    assert.ok(Number.isInteger(entry.size_bytes) && entry.size_bytes > 0, `${source}: positive_integer (${entry.path})`);
    assert.match(entry.sha256, SHA256_PATTERN, `${source}: sha256 (${entry.path})`);

    const artifactPath = path.resolve(ROOT, entry.path);
    assert.ok(fs.existsSync(artifactPath), `${source}: artifact_exists (${entry.path})`);
    assert.equal(fs.statSync(artifactPath).size, entry.size_bytes, `${source}: size_bytes (${entry.path})`);
    const sha256 = createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
    assert.equal(sha256, entry.sha256, `${source}: sha256 (${entry.path})`);
  }
}

function evidenceManifestPaths(directory) {
  if (!fs.existsSync(directory)) return [];
  const manifests = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) manifests.push(...evidenceManifestPaths(entryPath));
    if (entry.isFile() && entry.name === 'manifest.yaml') manifests.push(entryPath);
  }
  return manifests;
}

const coreSchema = loadYaml(path.join(SCHEMA_ROOT, 'core-v2.schema.yaml'));
const governanceSchema = loadYaml(path.join(SCHEMA_ROOT, 'governance-v1.schema.yaml'));
const coreFixtures = loadYaml(path.join(FIXTURE_ROOT, 'core-v2.yaml'));
const governanceFixtures = loadYaml(path.join(FIXTURE_ROOT, 'governance-v1.yaml'));

test('core-v2 schema accepts positive fixtures and rejects declared negative fixtures', () => {
  const compile = createValidator(coreSchema);
  for (const fixture of coreFixtures.valid) assertSchemaValid(compile(fixture.target), fixture);
  for (const fixture of coreFixtures.invalid) assertSchemaInvalid(compile(fixture.target), fixture);
});

test('governance-v1 schema accepts positive fixtures and rejects declared negative fixtures', () => {
  const compile = createValidator(governanceSchema);
  for (const fixture of governanceFixtures.valid) assertSchemaValid(compile(fixture.target), fixture);
  for (const fixture of governanceFixtures.invalid) {
    const validate = compile(fixture.target);
    if (
      fixture.expected_keyword === 'workspace_relative_path'
      || fixture.expected_keyword === 'positive_integer'
      || fixture.expected_keyword === 'artifact_exists'
    ) {
      assertSchemaValid(validate, fixture);
      assert.throws(
        () => assertEvidenceFilesAreSafe(fixture.value, fixture.id),
        new RegExp(fixture.expected_keyword),
        `${fixture.id} should be rejected by evidence manifest validation`,
      );
      continue;
    }
    assertSchemaInvalid(validate, fixture);
  }
});

test('contract templates validate against their declared governance records', () => {
  const compile = createValidator(governanceSchema);
  const templates = [
    ['task-declaration.yaml', 'taskDeclaration'],
    ['handoff.yaml', 'handoff'],
    ['evidence-manifest.yaml', 'evidenceManifest'],
    ['gate-record.yaml', 'gateRecord'],
  ];

  for (const [fileName, target] of templates) {
    const template = loadYaml(path.join(CONTRACT_ROOT, 'templates', fileName));
    const validate = compile(target);
    assert.equal(validate(template), true, `${fileName}: ${JSON.stringify(validate.errors)}`);
  }
});

test('unknown register keeps each unknown identifier unique', () => {
  const register = loadYaml(path.join(CONTRACT_ROOT, 'unknown-register.yaml'));
  const validate = createValidator(governanceSchema)('unknownRegister');
  assert.equal(validate(register), true, `unknown-register.yaml: ${JSON.stringify(validate.errors)}`);
  assert.equal(new Set(register.items.map((entry) => entry.id)).size, register.items.length, 'unknown IDs must be unique');
});

test('golden set manifest remains contract-valid', () => {
  const manifest = loadYaml(path.join(CONTRACT_ROOT, 'golden-set-manifest.yaml'));
  const validate = createValidator(governanceSchema)('goldenSetManifest');
  assert.equal(validate(manifest), true, `golden-set-manifest.yaml: ${JSON.stringify(validate.errors)}`);
});

test('evidence manifests use safe paths and verify present artifact metadata', () => {
  const validate = createValidator(governanceSchema)('evidenceManifest');
  const fixture = governanceFixtures.valid.find((entry) => entry.target === 'evidenceManifest');
  assertSchemaValid(validate, fixture);
  assertEvidenceFilesAreSafe(fixture.value, fixture.id);

  for (const manifestPath of evidenceManifestPaths(path.join(ROOT, 'docs/evidence'))) {
    const manifest = loadYaml(manifestPath);
    assert.equal(validate(manifest), true, `${path.relative(ROOT, manifestPath)}: ${JSON.stringify(validate.errors)}`);
    assertEvidenceFilesAreSafe(manifest, path.relative(ROOT, manifestPath));
  }
});
