import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const keyDir = path.join(repoRoot, "build-keys");
const privateKeyPath = path.join(keyDir, "integrity-private.pem");
const publicKeyPath = path.join(keyDir, "integrity-public.pem");
const forceOverwrite = process.argv.includes("--force");

if (fs.existsSync(privateKeyPath) && !forceOverwrite) {
  throw new Error(
    `Private key already exists at ${privateKeyPath}. Re-run with --force to overwrite it.`
  );
}

fs.mkdirSync(keyDir, { recursive: true });

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });

fs.writeFileSync(privateKeyPath, privateKeyPem);
fs.writeFileSync(publicKeyPath, publicKeyPem);

console.log("Generated integrity keypair:");
console.log(`  Private: ${privateKeyPath}`);
console.log(`  Public:  ${publicKeyPath}`);
console.log("");
console.log("Update src-electron/integrity/public-key.js with the new public key:");
console.log(publicKeyPem);
