#!/usr/bin/env node

import {
  commonCliOptions,
  createR2Client,
  loadReleaseDescriptor,
  parseCliArgs,
  publishStableRelease,
  resolveR2Config,
  safeCliError,
  writeReleaseReport,
} from "./app-release-lib.mjs";

const usage = `Usage: node scripts/release/publish-stable-app-manifest.mjs [options]

Publishes stable/latest.yml only after verifying all immutable release objects.

Options:
  --confirm-stable <version>  required exact version confirmation for a real publish
  --artifact-dir <path>       electron-builder output directory
  --manifest <path>           latest.yml path (defaults inside artifact-dir)
  --installer <path>          installer path (defaults from latest.yml)
  --blockmap <path>           blockmap path (defaults to <installer>.blockmap)
  --app-manifest <path>       optional signed app manifest JSON
  --version <version>         require this exact release version
  --config-file <path>        optional KEY=VALUE R2 configuration file
  --report <path>             write the sanitized JSON report to a file
  --attempts <count>          public verification attempts (default: 6)
  --retry-delay-ms <ms>       base delay between attempts (default: 2000)
  --request-timeout-ms <ms>   timeout for each public HTTP request (default: 300000)
  --dry-run                   validate local files and print the stable publish plan
  --help                      show this help
`;

async function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    boolean: ["dry-run", "help"],
    values: [
      "confirm-stable",
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

  const dryRun = Boolean(args["dry-run"]);
  const descriptor = await loadReleaseDescriptor({
    artifactDir: args["artifact-dir"],
    manifestPath: args.manifest,
    installerPath: args.installer,
    blockmapPath: args.blockmap,
    appManifestPath: args["app-manifest"],
    version: args.version,
  });
  const config = resolveR2Config({
    configFile: args["config-file"],
    requireCredentials: !dryRun,
  });
  const client = dryRun ? undefined : createR2Client(config);
  const result = await publishStableRelease({
    client,
    config,
    descriptor,
    confirmation: args["confirm-stable"],
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
  process.stderr.write(`Stable manifest publication failed: ${safeCliError(error)}\n`);
  process.exitCode = 1;
});
