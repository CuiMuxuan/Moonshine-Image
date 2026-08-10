#!/usr/bin/env node

import fs from "node:fs/promises";

import {
  commonCliOptions,
  createR2Client,
  parseCliArgs,
  resolveR2Config,
  safeCliError,
  writeReleaseReport,
} from "./app-release-lib.mjs";
import {
  createComponentReleasePlan,
  sanitizeComponentPlan,
} from "./component-release-lib.mjs";
import { uploadComponentRelease } from "./component-release-upload-lib.mjs";

const usage = `Usage: node scripts/release/upload-component-release.mjs [options]

Uploads immutable Runtime/FFmpeg archives, verifies every source, then publishes
the signed channel manifest last. No bucket-listing API is used.

Options:
  --components-file <path>      JSON descriptor with a components array
  --base-dir <path>             base directory for descriptor artifact paths
  --version <version>           application compatibility version (required)
  --channel <test|beta|stable>  release channel (default: test)
  --sequence <number>           monotonically increasing manifest sequence
  --published-at <ISO time>     fixed manifest publication time from the approved candidate
  --expires-at <ISO time>       fixed manifest expiry time from the approved candidate
  --private-key-file <path>     Ed25519 private key (or use environment secret)
  --key-id <id>                 manifest key id
  --config-file <path>          primary KEY=VALUE R2 configuration file
  --mirror-config-file <path>   optional independent mirror configuration file
  --confirm-channel <value>     exact <channel>:<version> publication confirmation
  --report <path>               write the sanitized JSON report
  --attempts <count>            public verification attempts (default: 6)
  --retry-delay-ms <ms>         base delay between attempts (default: 2000)
  --request-timeout-ms <ms>     timeout for each public HTTP request
  --dry-run                     validate and print the exact plan without writes
  --help                        show this help
`;

async function readOptionalFile(filePath) {
  return filePath ? fs.readFile(filePath, "utf8") : "";
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    boolean: ["dry-run", "help"],
    values: [
      "components-file",
      "base-dir",
      "version",
      "channel",
      "sequence",
      "published-at",
      "expires-at",
      "private-key-file",
      "key-id",
      "config-file",
      "mirror-config-file",
      "confirm-channel",
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
  if (!args["components-file"] || !args.version || !args.sequence) {
    throw new Error("--components-file, --version and --sequence are required");
  }
  if (/^v?1\.3\./i.test(String(args.version))) {
    throw new Error("Runtime/FFmpeg component publication is disabled for v1.3 app-only releases");
  }

  const dryRun = Boolean(args["dry-run"]);
  const privateKey = await readOptionalFile(args["private-key-file"])
    || process.env.MOONSHINE_MANIFEST_PRIVATE_KEY_PEM
    || "";
  if (!dryRun && !privateKey) {
    throw new Error("A manifest private key is required for component publication");
  }

  const primaryConfig = resolveR2Config({
    configFile: args["config-file"],
    requireCredentials: !dryRun,
  });
  const mirrorConfig = args["mirror-config-file"]
    ? resolveR2Config({
        configFile: args["mirror-config-file"],
        env: {},
        requireCredentials: !dryRun,
      })
    : null;
  const descriptor = JSON.parse(await fs.readFile(args["components-file"], "utf8"));
  const plan = await createComponentReleasePlan({
    descriptor,
    baseDir: args["base-dir"] || process.cwd(),
    appVersion: args.version,
    channel: args.channel || "test",
    sequence: args.sequence,
    publishedAt: args["published-at"],
    expiresAt: args["expires-at"],
    privateKey: privateKey || undefined,
    keyId: args["key-id"],
    primaryBaseUrl: primaryConfig.publicBaseUrl,
    mirrorBaseUrl: mirrorConfig?.publicBaseUrl,
  });
  const targets = [
    {
      id: "primary",
      config: primaryConfig,
      client: dryRun ? undefined : createR2Client(primaryConfig),
    },
    ...(mirrorConfig
      ? [{ id: "mirror", config: mirrorConfig, client: dryRun ? undefined : createR2Client(mirrorConfig) }]
      : []),
  ];
  const result = await uploadComponentRelease({
    plan,
    targets,
    confirmation: args["confirm-channel"],
    dryRun,
    ...commonCliOptions(args),
  });

  writeReleaseReport({
    release: sanitizeComponentPlan(plan),
    ...result,
  }, args.report);
}

main().catch((error) => {
  process.stderr.write(`Component release upload failed: ${safeCliError(error)}\n`);
  process.exitCode = 1;
});
