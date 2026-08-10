import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");
const generatorPath = path.join(repoRoot, "scripts", "release", "generate-manifest-keypair.mjs");

test("release manifest key generator creates matching Ed25519 keys and refuses overwrite", (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "moonshine-release-key-test-"));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  const first = spawnSync(process.execPath, [generatorPath, "--output-dir", outputDir], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(first.status, 0, first.stderr);

  const result = JSON.parse(first.stdout);
  const privatePem = fs.readFileSync(result.privateKeyPath, "utf8");
  const publicPem = fs.readFileSync(result.publicKeyPath, "utf8");
  const metadata = JSON.parse(fs.readFileSync(result.metadataPath, "utf8"));
  const derivedPublicPem = crypto
    .createPublicKey(crypto.createPrivateKey(privatePem))
    .export({ type: "spki", format: "pem" });

  assert.equal(crypto.createPrivateKey(privatePem).asymmetricKeyType, "ed25519");
  assert.equal(crypto.createPublicKey(publicPem).asymmetricKeyType, "ed25519");
  assert.equal(derivedPublicPem, publicPem);
  assert.equal(metadata.fingerprintSha256, result.fingerprintSha256);
  assert.equal(result.privateKeyPrinted, false);
  assert.equal(first.stdout.includes(privatePem.trim()), false);

  const privateHashBefore = crypto.createHash("sha256").update(privatePem).digest("hex");
  const second = spawnSync(process.execPath, [generatorPath, "--output-dir", outputDir], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /Refusing to overwrite existing release key material/);
  const privateHashAfter = crypto
    .createHash("sha256")
    .update(fs.readFileSync(result.privateKeyPath))
    .digest("hex");
  assert.equal(privateHashAfter, privateHashBefore);
});

test("release manifest key generator requires an explicit output directory", () => {
  const result = spawnSync(process.execPath, [generatorPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--output-dir is required/);
});
