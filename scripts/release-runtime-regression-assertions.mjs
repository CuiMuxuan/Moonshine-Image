import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function requireText(relativePath, expected) {
  const source = read(relativePath);
  assert.ok(
    source.includes(expected),
    `${relativePath} must contain ${JSON.stringify(expected)}`
  );
}

const checks = [
  ["scripts/build-runtime-win.mjs", "MOONSHINE_SAM3_SOURCE_DIR"],
  ["scripts/build-runtime-win.mjs", "--no-deps"],
  ["scripts/build-runtime-win.mjs", "wheel-non-editable-no-deps"],
  ["scripts/build-runtime-win.mjs", "__editable__.sam3*"],
  ["scripts/build-runtime-win.mjs", "sourcePathLeak"],
  ["scripts/build-runtime-win.mjs", "samRuntime"],
  ["scripts/build-runtime-win.mjs", '"third_party", "sam3"'],
  ["scripts/build-runtime-win.mjs", "sam3RuntimeOptionalModules"],
  ["scripts/build-runtime-win.mjs", "MOONSHINE_SAM3_DISABLE_TRITON"],
  ["scripts/audit-release-runtime.mjs", "PYTHONNOUSERSITE"],
  ["scripts/audit-release-runtime.mjs", "auditPackagedRuntimeZip"],
  ["scripts/audit-release-runtime.mjs", "System.IO.Compression.ZipFile"],
  ["scripts/audit-release-runtime.mjs", "MOONSHINE_RUNTIME_AUDIT_TEMP_DIR"],
  ["scripts/audit-release-runtime.mjs", "verify_sam3_image_smoke.py"],
  ["scripts/audit-release-runtime.mjs", "verify_sam3_compatibility.py"],
  ["scripts/audit-release-runtime.mjs", 'backend: "compatibility-fallback"'],
  ["scripts/audit-release-runtime.mjs", "trailingJsonOffset"],
  ["scripts/verify-packaged-runtime.py", "editable SAM3 metadata"],
  ["scripts/verify-packaged-runtime.py", "SAM3_OPTIONAL_MODULES"],
  ["scripts/verify-packaged-runtime.py", "not applicable"],
  ["scripts/verify_sam3_image_smoke.py", "red rectangle"],
  ["scripts/verify_sam3_compatibility.py", "compatibility-fallback"],
  ["scripts/run-sam3-compatibility-regression.mjs", "MOONSHINE_SAM3_DISABLE_TRITON"],
  ["scripts/package-win-matrix.mjs", "auditPackagedRuntimeDirectory"],
  ["scripts/package-win-matrix.mjs", "verification: artifact.audit"],
  ["server/moonshine_server/moonshine/sam_service.py", "CUDA-only and is not included in the CPU release"],
  ["server/moonshine_server/moonshine/sam_service.py", '"notApplicable": list(SAM3_REQUIRED_MODULES)'],
  ["server/moonshine_server/moonshine/sam_service.py", "CUDA release package is incomplete"],
  ["server/moonshine_server/moonshine/sam_service.py", "sam3RuntimeExpectedByPackage"],
  ["server/moonshine_server/moonshine/sam_service.py", "SAM3 compatibility backend"],
  ["third_party/sam3/UPSTREAM.md", "8e451d5"],
  ["third_party/sam3/UPSTREAM.md", "SAM License"],
  ["third_party/sam3/sam3/_moonshine_compat.py", "MOONSHINE_SAM3_DISABLE_TRITON"],
];

for (const [relativePath, expected] of checks) {
  requireText(relativePath, expected);
}

assert.ok(
  !read("scripts/audit-release-runtime.mjs").includes("Expand-Archive"),
  "release runtime ZIP audit must avoid Windows PowerShell's brittle Expand-Archive cleanup path"
);

const packageJson = JSON.parse(read("package.json"));
assert.equal(
  packageJson.scripts?.["test:regression:release-runtime"],
  "node scripts/release-runtime-regression-assertions.mjs",
  "package.json must expose the release runtime regression command"
);
assert.equal(
  packageJson.scripts?.["test:regression:sam3-compat"],
  "node scripts/run-sam3-compatibility-regression.mjs",
  "package.json must expose the SAM3 compatibility regression command"
);

console.log(`Passed ${checks.length + 2} self-contained SAM runtime regression assertions.`);
