import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import YAML from "yaml";

const root = path.resolve(".");
const probePath = "docs/contracts/mcp-ocr/rapidocr-runtime-probe.yaml";
const evidenceRoot = "docs/evidence/M5/M5-OCR-003";
const sha256Pattern = /^[a-f0-9]{64}$/;

function loadYaml(relativePath) {
  return YAML.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function validateGovernanceRecord(filePath, definition) {
  const schema = loadYaml("docs/contracts/mcp-ocr/schemas/governance-v1.schema.yaml");
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(schema);
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/${definition}` });
  const record = loadYaml(filePath);
  assert.equal(validate(record), true, `${filePath}: ${JSON.stringify(validate.errors)}`);
}

test("M5 runtime probe keeps the RapidOCR candidate deferred and non-downloading", () => {
  const probe = loadYaml(probePath);
  assert.equal(probe.contract_version, "rapidocr-runtime-probe/v1");
  assert.equal(probe.status, "deferred");
  assert.equal(probe.engine_id, "ocr_rapid_onnx_mobile");
  assert.equal(probe.scope.page, "none");
  assert.equal(probe.scope.ipc_boundary, "none");
  assert.equal(probe.upstream.rapidocr.version, "3.9.2");
  assert.match(probe.upstream.rapidocr.wheel_sha256, sha256Pattern);
  assert.equal(probe.upstream.onnxruntime.provider_requirement, "CPUExecutionProvider");
  assert.equal(probe.model_layout.redistribution_license_status, "unresolved");
  assert.deepEqual(probe.model_layout.required_roles.map(({ role }) => role), ["det", "rec"]);
  assert.match(probe.model_layout.required_roles[0].upstream_sha256, sha256Pattern);
  assert.equal(probe.read_only_probe.model_inference_run, false);
  assert.equal(probe.read_only_probe.dependency_install_run, false);
  assert.equal(probe.read_only_probe.model_download_run, false);
  assert.equal(probe.read_only_probe.model_write_run, false);
  assert.equal(probe.quality_and_performance.result, "not_measured");
  assert.equal(probe.quality_and_performance.existing_minimum_sample_count, 30);
  assert.ok(probe.stop_conditions.includes("automatic_model_download_path"));
});

test("M5 runtime probe evidence records satisfy governance-v1", () => {
  validateGovernanceRecord(`${evidenceRoot}/task.yaml`, "taskDeclaration");
  validateGovernanceRecord(`${evidenceRoot}/handoff.yaml`, "handoff");
  validateGovernanceRecord(`${evidenceRoot}/manifest.yaml`, "evidenceManifest");
  validateGovernanceRecord(`${evidenceRoot}/gate.yaml`, "gateRecord");
});

test("M5 runtime probe manifest attests only present workspace evidence", () => {
  const manifest = loadYaml(`${evidenceRoot}/manifest.yaml`);
  assert.equal(manifest.task_id, "M5-OCR-003");
  assert.equal(manifest.evidence_level, "E2");
  for (const file of manifest.files) {
    assert.ok(!path.isAbsolute(file.path) && !path.win32.isAbsolute(file.path), file.path);
    assert.ok(!file.path.split(/[\\/]+/).includes(".."), file.path);
    const absolutePath = path.join(root, file.path);
    assert.ok(fs.existsSync(absolutePath), file.path);
    assert.equal(fs.statSync(absolutePath).size, file.size_bytes, file.path);
    assert.equal(createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex"), file.sha256, file.path);
  }
});
