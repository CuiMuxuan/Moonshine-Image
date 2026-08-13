#!/usr/bin/env node

import fs from "node:fs/promises";
import { parseCliArgs, safeCliError } from "./app-release-lib.mjs";
import { signAppManifestFile } from "./app-manifest-lib.mjs";

const usage = `Usage: node scripts/release/sign-app-manifest.mjs [options]

Creates the signed app manifest consumed by AppManifestGuard. It writes only the
requested local output and never uploads or publishes a channel pointer.

Options:
  --artifact-dir <path>      electron-builder output directory
  --manifest <path>          latest.yml path
  --installer <path>         installer path
  --blockmap <path>          blockmap path
  --version <version>        exact app version
  --channel <test|stable>     channel (must match the app edition)
  --sequence <number>        signed sequence (required)
  --output <path>            signed manifest output (required)
  --private-key-file <path>  Ed25519 private key file
  --key-id <id>               manifest key id
  --help                      show this help
`;

async function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    boolean: ["help"],
    values: ["artifact-dir", "manifest", "installer", "blockmap", "version", "channel", "sequence", "output", "private-key-file", "key-id"],
  });
  if (args.help) {
    process.stdout.write(usage);
    return;
  }
  if (!args.output || !args.sequence) throw new Error("--output and --sequence are required");
  const privateKey = args["private-key-file"]
    ? await fs.readFile(args["private-key-file"], "utf8")
    : process.env.MOONSHINE_MANIFEST_PRIVATE_KEY_PEM;
  const result = await signAppManifestFile({
    artifactDir: args["artifact-dir"],
    latestYmlPath: args.manifest,
    installerPath: args.installer,
    blockmapPath: args.blockmap,
    appVersion: args.version,
    channel: args.channel || "stable",
    sequence: args.sequence,
    outputPath: args.output,
    privateKey,
    keyId: args["key-id"],
  });
  process.stdout.write(JSON.stringify({ outputPath: result.outputPath, sequence: result.payload.sequence, keyId: result.manifest.signature.keyId }) + "\n");
}

main().catch((error) => {
  process.stderr.write(`Signed app manifest generation failed: ${safeCliError(error)}\n`);
  process.exitCode = 1;
});
