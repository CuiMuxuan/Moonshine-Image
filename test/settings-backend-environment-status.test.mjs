import assert from "node:assert/strict";
import test from "node:test";

import {
  finalizeEnvironmentItemStates,
  mapEnvironmentFailureToItems,
  resolveEnvironmentItemGroupState,
} from "../src/utils/backendEnvironmentStatus.js";

test("project failures fail the project and block checks that depend on it", () => {
  const result = mapEnvironmentFailureToItems({
    stage: "check-project",
    code: "PROJECT_PATH_NOT_FOUND",
  });

  assert.deepEqual(result.states, {
    python: "blocked",
    project: "failure",
    venv: "blocked",
    dependencies: "blocked",
  });
});

test("prepare-project-python codes identify the actual failed environment item", () => {
  const invalidVenv = mapEnvironmentFailureToItems(
    { stage: "prepare-project-python", code: "INVALID_PROJECT_VENV" },
    { completedItems: ["project"] }
  );
  assert.deepEqual(invalidVenv.failedItems, ["venv"]);
  assert.equal(invalidVenv.states.project, "success");
  assert.equal(invalidVenv.states.python, "blocked");
  assert.equal(invalidVenv.states.dependencies, "blocked");

  const unsupportedPython = mapEnvironmentFailureToItems(
    { stage: "prepare-project-python", code: "SYSTEM_PYTHON_UNSUPPORTED" },
    { completedItems: ["project"] }
  );
  assert.deepEqual(unsupportedPython.failedItems, ["python"]);
  assert.equal(unsupportedPython.states.venv, "blocked");
});

test("dependency failures preserve all completed prerequisites", () => {
  const result = mapEnvironmentFailureToItems(
    { stage: "check-dependencies", code: "DEPENDENCY_CHECK_FAILED" },
    { completedItems: ["project", "python", "venv"] }
  );

  assert.deepEqual(result.states, {
    python: "success",
    project: "success",
    venv: "success",
    dependencies: "failure",
  });
});

test("unknown prepare failures fail that stage without leaving pending items", () => {
  const result = mapEnvironmentFailureToItems(
    { stage: "prepare-project-python", code: "PREPARE_PROJECT_PYTHON_FAILED" },
    { completedItems: ["project"] }
  );

  assert.deepEqual(result.failedItems, ["python", "venv"]);
  assert.equal(result.states.dependencies, "blocked");
});

test("UI lifecycle stage takes priority over nested runtime diagnostic stages", () => {
  const bundled = mapEnvironmentFailureToItems(
    {
      code: "BUNDLED_RUNTIME_UNUSABLE",
      diagnostic: { stage: "bundled-runtime-verification" },
    },
    {
      completedItems: ["project"],
      lifecycleStage: "prepare-project-python",
    }
  );
  assert.deepEqual(bundled.failedItems, ["python", "venv"]);
  assert.equal(bundled.states.dependencies, "blocked");

  const external = mapEnvironmentFailureToItems(
    { diagnostic: { stage: "python-version-check" } },
    {
      completedItems: ["project"],
      lifecycleStage: "prepare-project-python",
    }
  );
  assert.deepEqual(external.failedItems, ["python", "venv"]);
});

test("finalization replaces unfinished display states with a terminal blocked state", () => {
  assert.deepEqual(
    finalizeEnvironmentItemStates({
      python: "success",
      project: "failure",
      venv: "checking",
      dependencies: "idle",
    }),
    {
      python: "success",
      project: "failure",
      venv: "blocked",
      dependencies: "blocked",
    }
  );
});

test("bundled runtime display combines Python and virtual-environment states", () => {
  assert.equal(
    resolveEnvironmentItemGroupState(
      { python: "checking", venv: "failure" },
      ["python", "venv"]
    ),
    "checking"
  );
  assert.equal(
    resolveEnvironmentItemGroupState(
      { python: "success", venv: "failure" },
      ["python", "venv"]
    ),
    "failure"
  );
  assert.equal(
    resolveEnvironmentItemGroupState(
      { python: "success", venv: "blocked" },
      ["python", "venv"]
    ),
    "blocked"
  );
  assert.equal(
    resolveEnvironmentItemGroupState(
      { python: "success", venv: "success" },
      ["python", "venv"]
    ),
    "success"
  );
});
