#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import { parseCliArgs, safeCliError, writeReleaseReport } from "./app-release-lib.mjs";
import {
  createComponentReleasePlan,
  sanitizeComponentPlan,
} from "./component-release-lib.mjs";

const usage = `Usage: node scripts/release/plan-component-release.mjs [options]

Builds a local, deterministic Runtime/FFmpeg release plan. It never uploads objects
and never publishes a channel pointer.

Options:
  --components-file <path>  JSON descriptor with a components array
  --base-dir <path>         base directory for descriptor artifact paths
  --version <version>       application compatibility version (required)
  --channel <test|beta|stable>  release channel (default: stable)
  --sequence <number>       monotonically increasing manifest sequence (required)
  --published-at <ISO time> fixed manifest publication time for reproducible review
  --expires-at <ISO time>   fixed manifest expiry time for reproducible review
  --manifest-output <path>  write the signed manifest JSON (optional)
  --private-key-file <path> Ed25519 private key; may be omitted for dry-run planning
  --key-id <id>              manifest key id (default: moonshine-app-manifest-v1)
  --primary-base-url <url>  public primary source (default: download.moonshine.email)
  --mirror-base-url <url>   independent mirror source (optional)
  --report <path>            write the sanitized plan report
  --dry-run                  allow an unsigned plan; no publication side effects
  --help                     show this help
`;

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
      "manifest-output",
      "private-key-file",
      "key-id",
      "primary-base-url",
      "mirror-base-url",
      "report",
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
    throw new Error("Runtime/FFmpeg component planning is disabled for v1.3 app-only releases");
  }
  const privateKey = args["private-key-file"]
    ? await fs.readFile(args["private-key-file"], "utf8")
    : process.env.MOONSHINE_MANIFEST_PRIVATE_KEY_PEM || "";
  if (!privateKey && !args["dry-run"]) {
    throw new Error("A manifest private key is required for a non-dry-run release plan");
  }
  const descriptor = JSON.parse(await fs.readFile(args["components-file"], "utf8"));
  const plan = await createComponentReleasePlan({
    descriptor,
    baseDir: args["base-dir"] || process.cwd(),
    appVersion: args.version,
    channel: args.channel || "stable",
    sequence: args.sequence,
    publishedAt: args["published-at"],
    expiresAt: args["expires-at"],
    privateKey: privateKey || undefined,
    keyId: args["key-id"],
    primaryBaseUrl: args["primary-base-url"] || undefined,
    mirrorBaseUrl: args["mirror-base-url"],
  });

  if (args["manifest-output"]) {
    if (!plan.manifest) throw new Error("--manifest-output requires a signing key");
    const manifestOutput = path.resolve(args["manifest-output"]);
    await fs.mkdir(path.dirname(manifestOutput), { recursive: true });
    await fs.writeFile(manifestOutput, `${JSON.stringify(plan.manifest, null, 2)}\n`, "utf8");
  }

  writeReleaseReport(
    {
      phase: "component-plan",
      dryRun: Boolean(args["dry-run"]),
      ...sanitizeComponentPlan(plan),
    },
    args.report,
  );
}

main().catch((error) => {
  process.stderr.write(`Component release planning failed: ${safeCliError(error)}\n`);
  process.exitCode = 1;
});
