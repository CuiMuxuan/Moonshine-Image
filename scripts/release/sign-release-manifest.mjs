import path from "node:path";
import process from "node:process";

import { signManifestFile } from "./manifest-signing.mjs";

function parseArgs(argv) {
  const values = {};
  for (const argument of argv) {
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const separator = argument.indexOf("=");
    if (separator < 3) throw new Error(`Option must use --name=value: ${argument}`);
    const key = argument.slice(2, separator);
    if (Object.hasOwn(values, key)) throw new Error(`Option repeated: ${key}`);
    values[key] = argument.slice(separator + 1);
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const payloadPath = path.resolve(args.payload || "");
const outputPath = path.resolve(args.output || "");
const keyPath = args["private-key-file"] ? path.resolve(args["private-key-file"]) : "";
const keyPem = process.env.MOONSHINE_MANIFEST_PRIVATE_KEY_PEM || "";

if (!args.payload || !args.output || (!keyPath && !keyPem)) {
  console.error("Usage: node scripts/release/sign-release-manifest.mjs --payload=payload.json --output=signed.json --private-key-file=key.pem");
  process.exitCode = 2;
} else {
  try {
    const result = await signManifestFile({
      payloadPath,
      outputPath,
      privateKeyPath: keyPath,
      privateKeyPem: keyPem,
      keyId: args["key-id"],
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
