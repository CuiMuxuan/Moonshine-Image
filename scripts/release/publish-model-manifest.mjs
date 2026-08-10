#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import {
  commonCliOptions,
  createR2Client,
  parseCliArgs,
  resolveR2Config,
  safeCliError,
  writeReleaseReport,
} from "./app-release-lib.mjs";
import {
  createModelReleasePlan,
  publishModelManifest,
  sanitizeModelReleasePlan,
} from "./model-release-lib.mjs";

const usage = `Usage: node scripts/release/publish-model-manifest.mjs [options]

Builds and optionally publishes a signed model catalog. This command uploads only
models/<channel>/manifest.json; it never uploads model weight files.

Options:
  --models-file <path>          exported model registry JSON (required)
  --version <version>           compatible application version (required)
  --channel <test|beta|stable>  release channel (default: test)
  --sequence <number>           monotonically increasing sequence (required)
  --published-at <ISO time>     fixed manifest publication time from the approved candidate
  --expires-at <ISO time>       fixed manifest expiry time from the approved candidate
  --private-key-file <path>     Ed25519 private key (or environment secret)
  --key-id <id>                 manifest key id
  --manifest-output <path>      write the exact signed manifest JSON
  --config-file <path>          primary KEY=VALUE R2 configuration file
  --mirror-config-file <path>   optional independent mirror configuration
  --confirm-channel <value>     exact <channel>:<version> confirmation
  --report <path>               write the sanitized release report
  --attempts <count>            public verification attempts (default: 6)
  --retry-delay-ms <ms>         base retry delay (default: 2000)
  --request-timeout-ms <ms>     public request timeout
  --dry-run                     validate and print the plan without writes
  --help                        show this help
`;

async function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    boolean: ["dry-run", "help"],
    values: [
      "models-file",
      "version",
      "channel",
      "sequence",
      "published-at",
      "expires-at",
      "private-key-file",
      "key-id",
      "manifest-output",
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
  if (!args["models-file"] || !args.version || !args.sequence) {
    throw new Error("--models-file, --version and --sequence are required");
  }
  if (/^v?1\.3\./i.test(String(args.version))) {
    throw new Error("Model manifest publication is disabled for v1.3 app-only releases; use Hugging Face and Quark sources");
  }
  const dryRun = Boolean(args["dry-run"]);
  const privateKey = args["private-key-file"]
    ? await fs.readFile(args["private-key-file"], "utf8")
    : process.env.MOONSHINE_MANIFEST_PRIVATE_KEY_PEM || "";
  if (!dryRun && !privateKey) throw new Error("A manifest private key is required for model publication");

  const primaryConfig = resolveR2Config({
    configFile: args["config-file"],
    requireCredentials: !dryRun,
  });
  const mirrorConfig = args["mirror-config-file"]
    ? resolveR2Config({ configFile: args["mirror-config-file"], env: {}, requireCredentials: !dryRun })
    : null;
  const descriptor = JSON.parse(await fs.readFile(args["models-file"], "utf8"));
  const plan = await createModelReleasePlan({
    descriptor,
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
  if (args["manifest-output"]) {
    if (!plan.manifest) throw new Error("--manifest-output requires a signing key");
    const output = path.resolve(args["manifest-output"]);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(plan.manifest, null, 2)}\n`, "utf8");
  }

  const targets = [
    { id: "primary", config: primaryConfig, client: dryRun ? undefined : createR2Client(primaryConfig) },
    ...(mirrorConfig
      ? [{ id: "mirror", config: mirrorConfig, client: dryRun ? undefined : createR2Client(mirrorConfig) }]
      : []),
  ];
  const result = await publishModelManifest({
    plan,
    targets,
    confirmation: args["confirm-channel"],
    dryRun,
    ...commonCliOptions(args),
  });
  writeReleaseReport({
    release: sanitizeModelReleasePlan(plan),
    ...result,
  }, args.report);
}

main().catch((error) => {
  process.stderr.write(`Model manifest publication failed: ${safeCliError(error)}\n`);
  process.exitCode = 1;
});
