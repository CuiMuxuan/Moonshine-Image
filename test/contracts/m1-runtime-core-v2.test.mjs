import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import YAML from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCHEMA_PATH = path.join(ROOT, "docs/contracts/mcp-ocr/schemas/core-v2.schema.yaml");
const schema = YAML.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));

function validator(target) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addSchema(schema);
  return ajv.compile({ $ref: `${schema.$id}#/$defs/${target}` });
}

function runtimeOutputs() {
  const script = String.raw`
import json
import sys
import tempfile
from pathlib import Path

server_root = Path.cwd() / "server"
sys.path.insert(0, str(server_root))

from moonshine_server.application_facade import ApplicationFacade
from moonshine_server.jobs import SqliteJobStore

class Request:
    def model_dump(self, *, mode="python"):
        return {
            "data": [{"id": "item-1", "image": "image-bytes", "mask": "mask-bytes"}],
            "image_type": "base64",
            "mask_type": "base64",
            "response_type": "base64",
            "output_format": "png",
        }

with tempfile.TemporaryDirectory(prefix="moonshine-runtime-contract-") as temporary:
    root = Path(temporary)
    store = SqliteJobStore(root / "jobs.sqlite3")
    facade = ApplicationFacade(store)

    def processor(context):
        context.publish_bytes(
            root=root / "artifacts",
            relative_path="results/output.png",
            payload=b"artifact-bytes",
            mime_type="image/png",
        )
        return {"results": [], "processed_count": 1, "success_count": 1}

    record, _, _ = facade.submit_batch_inpaint(
        Request(),
        processor,
        client_scope="desktop",
        idempotency_key="runtime-contract-key",
    )
    print(json.dumps({
        "job": facade.get_job(record.job_id),
        "events": facade.get_events(record.job_id),
        "artifacts": facade.get_artifacts(record.job_id),
        "special_artifacts": [
            ApplicationFacade._public_artifact({
                "artifact_id": "art_preview01",
                "job_id": record.job_id,
                "artifact_type": "preview",
                "mime_type": "image/png",
                "sha256": "d" * 64,
                "size_bytes": 3,
                "created_at": "2026-01-01T00:00:00Z",
            }),
            ApplicationFacade._public_artifact({
                "artifact_id": "art_diag0001",
                "job_id": record.job_id,
                "artifact_type": "diagnostic",
                "mime_type": "application/json",
                "sha256": "e" * 64,
                "size_bytes": 3,
                "created_at": "2026-01-01T00:00:00Z",
            }),
        ],
    }))
    store.close()
`;
  return JSON.parse(execFileSync("python", ["-c", script], { cwd: ROOT, encoding: "utf8" }));
}

test("M1 runtime Job, Event, and Artifact DTOs satisfy core-v2", () => {
  const outputs = runtimeOutputs();
  const validateJob = validator("job");
  const validateEvent = validator("jobEvent");
  const validateArtifact = validator("artifact");

  assert.equal(validateJob(outputs.job), true, JSON.stringify(validateJob.errors));
  for (const event of outputs.events) {
    assert.equal(validateEvent(event), true, JSON.stringify(validateEvent.errors));
  }
  for (const artifact of outputs.artifacts) {
    assert.equal(validateArtifact(artifact), true, JSON.stringify(validateArtifact.errors));
  }
  for (const artifact of outputs.special_artifacts) {
    assert.equal(validateArtifact(artifact), true, JSON.stringify(validateArtifact.errors));
  }
});
