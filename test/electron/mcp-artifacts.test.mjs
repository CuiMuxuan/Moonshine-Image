import assert from "node:assert/strict";
import test from "node:test";

import { projectMcpJob } from "../../src-electron/mcp-artifacts.js";

test("projectMcpJob exposes only bounded per-file result fields", () => {
  const results = Array.from({ length: 1005 }, (_, index) => ({
    success: index % 2 === 0,
    id: `file:${String(index).padStart(4, "0")}`,
    artifact_id: `art_${String(index).padStart(8, "0")}`,
    error_code: "PATH_NOT_ALLOWED",
    input_path: `C:/private/input-${index}.png`,
    output_path: `C:/private/output-${index}.png`,
    bytes: Buffer.from("private-bytes"),
    text: "private diagnostic text",
    token: "private-token",
    nested: { path: "C:/private/nested.png" },
  }));

  const projected = projectMcpJob({
    job_id: "job_12345678",
    status: "succeeded",
    results,
  });

  assert.equal(projected.results.length, 1000);
  assert.deepEqual(projected.results[0], {
    success: true,
    id: "file:0000",
    artifact_id: "art_00000000",
    error_code: "PATH_NOT_ALLOWED",
  });
  assert.deepEqual(Object.keys(projected.results[999]).sort(), [
    "artifact_id",
    "error_code",
    "id",
    "success",
  ]);
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /C:\/private|private-bytes|private diagnostic|private-token|nested/);
  assert.doesNotMatch(serialized, /file:1000/);
});

test("projectMcpJob rejects malformed result identifiers, error text, and non-boolean states", () => {
  const projected = projectMcpJob({
    job_id: "job_12345678",
    status: "failed",
    results: [
      {
        success: false,
        id: "../private/file.png",
        artifact_id: "bad",
        error_code: "lowercase_error",
        error: "PATH_NOT_ALLOWED",
        path: "C:/private/file.png",
        image_base64: "must-not-escape",
      },
      { success: "false", id: "file:ignored", error_code: "PATH_NOT_ALLOWED" },
      null,
      ["unexpected"],
      { success: true, id: "file:ok", artifact_id: "art_12345678", error_code: "OCR_RUNTIME_ERROR" },
    ],
  });

  assert.deepEqual(projected.results, [
    { success: false },
    { success: true, id: "file:ok", artifact_id: "art_12345678", error_code: "OCR_RUNTIME_ERROR" },
  ]);
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /PATH_NOT_ALLOWED|C:\/private|must-not-escape|lowercase_error/);
});
