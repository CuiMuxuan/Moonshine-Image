#!/usr/bin/env node

import {
  commonCliOptions,
  createR2Client,
  loadReleaseDescriptor,
  parseCliArgs,
  resolveR2Config,
  safeCliError,
  verifyRelease,
  writeReleaseReport,
} from "./app-release-lib.mjs";

const usage = `Usage: node scripts/release/verify-app-feed.mjs [options]

Verifies deterministic release keys without listing the bucket.

Options:
  --scope <immutable|channel|stable> object set to verify (default: immutable)
  --channel <test|stable>      channel to verify (must match the app edition)
  --public-only              verify the public custom domain without R2 credentials
  --artifact-dir <path>      electron-builder output directory
  --manifest <path>          latest.yml path (defaults inside artifact-dir)
  --installer <path>         installer path (defaults from latest.yml)
  --blockmap <path>          blockmap path (defaults to <installer>.blockmap)
  --app-manifest <path>      optional signed app manifest JSON
  --version <version>        require this exact release version
  --config-file <path>       optional KEY=VALUE R2 configuration file
  --report <path>            write the sanitized JSON report to a file
  --attempts <count>         public verification attempts (default: 6)
  --retry-delay-ms <ms>      base delay between attempts (default: 2000)
  --request-timeout-ms <ms>  timeout for each public HTTP request (default: 300000)
  --dry-run                  validate local files and print the verification plan
  --help                     show this help
`;

async function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    boolean: ["public-only", "dry-run", "help"],
    values: [
      "scope",
      "channel",
      "artifact-dir",
      "manifest",
      "installer",
      "blockmap",
      "app-manifest",
      "version",
      "config-file",
      "report",
      "attempts",
      "retry-delay-ms",
      "request-timeout-ms",
    ],
  });
  if (args.help) {
    process.stdout.write(usage);
    return;
  }

  const publicOnly = Boolean(args["public-only"]);
  const dryRun = Boolean(args["dry-run"]);
  const descriptor = await loadReleaseDescriptor({
    artifactDir: args["artifact-dir"],
    manifestPath: args.manifest,
    installerPath: args.installer,
    blockmapPath: args.blockmap,
    appManifestPath: args["app-manifest"],
    channel: args.channel,
    version: args.version,
  });
  const config = resolveR2Config({
    configFile: args["config-file"],
    requireCredentials: !dryRun && !publicOnly,
  });
  const client = dryRun || publicOnly ? undefined : createR2Client(config);
  const result = await verifyRelease({
    client,
    config,
    descriptor,
    scope: args.scope || "immutable",
    channel: args.channel,
    publicOnly,
    dryRun,
    ...commonCliOptions(args),
  });

  writeReleaseReport(
    {
      releaseVersion: descriptor.version,
      bucket: config.bucket,
      publicBaseUrl: config.publicBaseUrl,
      releasePrefix: config.releasePrefix,
      ...result,
    },
    args.report
  );
}

main().catch((error) => {
  process.stderr.write(`App feed verification failed: ${safeCliError(error)}\n`);
  process.exitCode = 1;
});
