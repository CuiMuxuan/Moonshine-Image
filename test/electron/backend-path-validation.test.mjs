import assert from "node:assert/strict";
import test from "node:test";

import {
  BACKEND_PATH_CJK_WARNING_MESSAGE,
  buildBackendPathCompatibilityResult,
  containsCjkCharacter,
} from "../../src-electron/backend-path-validation.js";
import {
  buildBackendPathWarningMessage,
  validateBackendPaths,
} from "../../src/utils/backendPathValidation.js";

test("CJK backend and model paths produce a non-blocking warning", () => {
  const result = buildBackendPathCompatibilityResult({
    backendProjectPath: "C:\\月光\\后端",
    modelDir: "D:\\模型\\权重",
    bundledMode: false,
    effectiveModelDir: "",
  });

  assert.equal(result.success, true);
  assert.equal(result.valid, true);
  assert.equal(result.warning, true);
  assert.equal(result.severity, "warning");
  assert.equal(result.code, "BACKEND_PATH_CONTAINS_CJK");
  assert.equal(result.message, BACKEND_PATH_CJK_WARNING_MESSAGE);
  assert.deepEqual(
    result.warningPaths.map((item) => item.field),
    ["backendProjectPath", "modelDir"]
  );
  assert.equal(result.invalidPaths, result.warningPaths);
});

test("ASCII backend paths remain valid without warnings", () => {
  const result = buildBackendPathCompatibilityResult({
    backendProjectPath: "C:\\Moonshine\\server",
    modelDir: "D:\\Moonshine\\models",
    bundledMode: false,
    effectiveModelDir: "",
  });

  assert.equal(result.valid, true);
  assert.equal(result.warning, false);
  assert.equal(result.code, "");
  assert.deepEqual(result.warningPaths, []);
});

test("bundled model paths are included in compatibility warnings", () => {
  const result = buildBackendPathCompatibilityResult({
    backendProjectPath: "C:\\Moonshine\\server",
    modelDir: "",
    bundledMode: true,
    effectiveModelDir: "C:\\用户数据\\models",
  });

  assert.equal(result.valid, true);
  assert.equal(result.warning, true);
  assert.deepEqual(
    result.warningPaths.map((item) => item.field),
    ["effectiveModelDir"]
  );
});

test("CJK detection does not classify every non-ASCII character as Chinese", () => {
  assert.equal(containsCjkCharacter("C:\\模型"), true);
  assert.equal(containsCjkCharacter("C:\\cafe-accent-é"), false);
});

test("renderer validation preserves the non-blocking warning contract", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    electron: {
      ipcRenderer: {
        invoke: async () => ({
          success: true,
          valid: true,
          warning: true,
          severity: "warning",
          code: "BACKEND_PATH_CONTAINS_CJK",
          message: BACKEND_PATH_CJK_WARNING_MESSAGE,
          invalidPaths: [
            { field: "modelDir", label: "模型目录路径", path: "C:\\模型" },
          ],
        }),
      },
    },
  };

  try {
    const result = await validateBackendPaths({ modelDir: "C:\\模型" });
    assert.equal(result.valid, true);
    assert.equal(result.warning, true);
    assert.match(buildBackendPathWarningMessage(result), /C:\\模型/u);
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});
