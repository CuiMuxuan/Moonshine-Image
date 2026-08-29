import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCELERATOR_PREFERENCES,
  buildEnvironmentSpec,
  computeEnvironmentSpecHash,
  normalizeAcceleratorPreference,
  verifyEnvironmentSpecHash,
} from "../../src-electron/runtime/environment-spec.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

test("environment spec hash is deterministic and excludes specHash", () => {
  const first = buildEnvironmentSpec({
    appVersion: "1.3.0",
    pythonVersion: "3.12.10",
    accelerator: "cpu",
    requirementsLockHash: HASH_A,
    ffmpegHash: HASH_B,
  });
  const second = buildEnvironmentSpec({
    ffmpegHash: HASH_B,
    requirementsLockHash: HASH_A,
    accelerator: "CPU",
    pythonVersion: "3.12.10",
    appVersion: "1.3.0",
  });

  assert.deepEqual(first, second);
  assert.match(first.specHash, /^[a-f0-9]{64}$/);
  assert.equal(computeEnvironmentSpecHash({ ...first, specHash: "f".repeat(64) }), first.specHash);
  assert.equal(verifyEnvironmentSpecHash(first), true);
  assert.equal(verifyEnvironmentSpecHash({ ...first, ffmpegHash: HASH_A }), false);
});

test("environment spec normalizes accelerator preferences and rejects unsupported values", () => {
  assert.deepEqual(ACCELERATOR_PREFERENCES, ["auto", "cpu", "cu130"]);
  assert.equal(normalizeAcceleratorPreference(), "auto");
  assert.equal(normalizeAcceleratorPreference(" CU130 "), "cu130");
  assert.throws(() => normalizeAcceleratorPreference("cuda"), /Unsupported accelerator/);
});

test("CUDA environment identity includes the packaged SAM3 wheel hash", () => {
  const base = buildEnvironmentSpec({
    appVersion: "1.3.0",
    pythonVersion: "3.12.10",
    accelerator: "cu130",
    requirementsLockHash: HASH_A,
    ffmpegHash: HASH_B,
  });
  const withWheel = buildEnvironmentSpec({
    ...base,
    specHash: undefined,
    sam3WheelHash: HASH_A,
  });

  assert.equal(Object.hasOwn(base, "sam3WheelHash"), false);
  assert.equal(withWheel.sam3WheelHash, HASH_A);
  assert.notEqual(withWheel.specHash, base.specHash);
  assert.equal(verifyEnvironmentSpecHash(withWheel), true);
});
