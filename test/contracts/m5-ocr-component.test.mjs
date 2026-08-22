import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import YAML from "yaml";

const root = path.resolve(".");
function runPython(source) {
  const python = process.env.PYTHON || process.env.PYTHON3 || "python";
  const result = spawnSync(python, ["-c", source], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: path.join(root, "server") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

const validComponent = {
  schema_version: "ocr-component/v1",
  engine_id: "ocr_rapid_onnx_mobile",
  engine_version: "1.0.0",
  model_revision: "ppocr-mobile-r1",
  model_sha256: "a".repeat(64),
  size_bytes: 123456,
  license_id: "apache-2.0",
  languages: ["zh-Hans", "en"],
  runtime_flavor: "cpu",
  supports_gpu: false,
  supports_orientation: true,
  memory_limit_mb: 1024,
  source_kind: "signed_manifest",
  default: true,
};
const validComponentJson = JSON.stringify(JSON.stringify(validComponent));

function validateGovernanceRecord(filePath, definition) {
  const schema = YAML.parse(
    fs.readFileSync(
      path.join(root, "docs/contracts/mcp-ocr/schemas/governance-v1.schema.yaml"),
      "utf8",
    ),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(schema);
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` });
  const record = YAML.parse(fs.readFileSync(path.join(root, filePath), "utf8"));
  assert.equal(validate(record), true, `${filePath}: ${JSON.stringify(validate.errors)}`);
}

test("M5 validates the default RapidOCR CPU component and safe health projection", () => {
  const output = runPython(`
import json
from server.moonshine_server.ocr_contract import evaluate_component_health, validate_component_manifest
manifest = json.loads(${validComponentJson})
assert validate_component_manifest(manifest)['engine_id'] == 'ocr_rapid_onnx_mobile'
assert evaluate_component_health(manifest)['status'] == 'missing'
assert evaluate_component_health(manifest, installed_sha256='${"a".repeat(64)}', installed_size_bytes=123456)['status'] == 'ready'
assert evaluate_component_health(manifest, installed_sha256='${"a".repeat(64)}', installed_size_bytes=123456, runtime_flavor='cu130')['status'] == 'incompatible'
print('component-ok')
`);
  assert.equal(output, "component-ok");
});

test("M5 rejects unsafe component metadata and never treats a mismatch as ready", () => {
  const output = runPython(`
import json
from server.moonshine_server.ocr_contract import OcrManifestError, evaluate_component_health, validate_component_manifest
manifest = json.loads(${validComponentJson})
try:
    bad = dict(manifest, model_sha256='not-a-hash')
    validate_component_manifest(bad)
except OcrManifestError:
    pass
else:
    raise AssertionError('invalid hash accepted')
try:
    validate_component_manifest(dict(manifest, engine_version=''))
except OcrManifestError:
    pass
else:
    raise AssertionError('malformed engine version accepted')
assert evaluate_component_health(manifest, installed_sha256='${"b".repeat(64)}', installed_size_bytes=123456)['status'] == 'integrity_error'
try:
    validate_component_manifest(dict(manifest, supports_gpu=True))
except OcrManifestError:
    pass
else:
    raise AssertionError('default GPU component accepted')
print('negative-ok')
`);
  assert.equal(output, "negative-ok");
});

test("M5 evidence task and handoff records satisfy governance-v1", () => {
  validateGovernanceRecord("docs/evidence/M5/M5-OCR-001/task.yaml", "taskDeclaration");
  validateGovernanceRecord("docs/evidence/M5/M5-OCR-001/handoff.yaml", "handoff");
});

test("M5 keeps the planned golden-set license gate closed until samples are ready", () => {
  const output = runPython(`
from server.moonshine_server.ocr_contract import GoldenSetManifestError, validate_golden_set_manifest
planned = {
  'manifest_version': 1, 'status': 'planned', 'required_sample_count': 30,
  'target_sample_count': 50, 'updated_at': '2026-08-16T00:00:00Z',
  'coverage': {'languages': ['zh-Hans', 'en'], 'scenarios': ['rotated']},
  'samples': [], 'license_gate': {'owner': 'REL', 'rule': 'license and SHA required'},
}
assert validate_golden_set_manifest(planned)['status'] == 'planned'
assert validate_golden_set_manifest(dict(planned, status='in_progress'))['status'] == 'in_progress'
try:
    validate_golden_set_manifest(dict(planned, updated_at='2026-08-16 00:00:00'))
except GoldenSetManifestError:
    pass
else:
    raise AssertionError('non-UTC updated_at accepted')
try:
    validate_golden_set_manifest(dict(planned, required_sample_count=True))
except GoldenSetManifestError:
    pass
else:
    raise AssertionError('non-integer golden sample count used the wrong error type')
ready_samples = [
    {
        'sample_id': f'OCR-GOLD-{index:03d}',
        'relative_path': f'golden/{index:03d}.png',
        'sha256': 'a' * 64,
        'source': 'licensed-fixture-source',
        'license': 'Apache-2.0',
        'redistribution': 'allowed',
        'language': 'en',
        'scenarios': ['rotated'],
        'expected_detection': 'exact',
        'expected_recognition': 'normalized',
        'expected_coordinates': 'polygon_tolerant',
    }
    for index in range(30)
]
ready = dict(planned, status='ready', samples=ready_samples)
assert validate_golden_set_manifest(ready)['sample_count'] == 30
try:
    duplicate_samples = list(ready_samples)
    duplicate_samples[1] = dict(duplicate_samples[0], relative_path='golden/001-copy.png')
    validate_golden_set_manifest(dict(ready, samples=duplicate_samples))
except GoldenSetManifestError:
    pass
else:
    raise AssertionError('duplicate sample id accepted')
try:
    validate_golden_set_manifest(dict(planned, status='in_progress', required_sample_count=29))
except GoldenSetManifestError:
    pass
else:
    raise AssertionError('governance minimum sample count accepted')
try:
    validate_golden_set_manifest(dict(planned, status='ready'))
except GoldenSetManifestError:
    pass
else:
    raise AssertionError('ready golden set accepted without licensed samples')
print('golden-gate-closed')
`);
  assert.equal(output, "golden-gate-closed");
});
