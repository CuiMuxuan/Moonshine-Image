#!/usr/bin/env node

import fs from "node:fs/promises";
import { createHash } from "node:crypto";

import { parse as parseYaml } from "yaml";

import { inspectOfflineBundle } from "../build-offline-bundle-win.mjs";
import { parseCliArgs } from "../release/app-release-lib.mjs";
import {
  checkRemoteObject,
  createValidationReport,
  evaluateSourceAvailability,
  fetchJson,
  inspectLocalInstall,
  inspectManagedEnvironment,
  objectUrl,
  recordCheck,
  resolveReleaseArtifactPath,
  sanitizeText,
  verifyManifestDocument,
  writeValidationReport,
} from "./release-validation-lib.mjs";

const usage = `Usage: node scripts/validation/run-release-validation.mjs [options]

Runs network, source-failover and optional local-install checks on another Windows PC.
The report contains no credentials or private key material.

Options:
  --source <https-url>       primary public source (required)
  --mirror <https-url>       independent mirror source (optional)
  --channel <test|beta|stable> channel (default: stable)
  --app-version <version>    expected app version (optional)
  --public-key-file <path>   Ed25519 public key PEM (required unless --skip-signature)
  --manifest-path <path>     app manifest path (default: manifests/<channel>/latest.json)
  --offline-bundle <path>    optional CPU/cu130 outer ZIP to inspect locally
  --offline-variant <cpu|cu130> expected offline ZIP variant
  --metadata-only             skip full archive downloads (HEAD + Range only)
  --skip-signature            diagnostic mode; do not verify Ed25519 signatures
  --install-root <path>       optional installed app root to inspect
  --app-executable <path>     optional executable to inspect
  --run-executable             run --version against --app-executable
  --environment-root <path>   optional managed environment root to inspect
  --environment-flavor <cpu|cu130> expected managed environment flavor
  --report <path>              output JSON report path
  --mode <network|clean-install|canary|rollback|source-failover|offline-cpu|offline-cu130>
  --help                       show this help
`;

async function run() {
  const args = parseCliArgs(process.argv.slice(2), {
    boolean: ["metadata-only", "skip-signature", "run-executable", "help"],
    values: [
      "source",
      "mirror",
      "channel",
      "app-version",
      "public-key-file",
      "manifest-path",
      "offline-bundle",
      "offline-variant",
      "install-root",
      "app-executable",
      "environment-root",
      "environment-flavor",
      "report",
      "mode",
    ],
  });
  if (args.help) {
    process.stdout.write(usage);
    return 0;
  }
  if (!args.source) throw new Error("--source is required");
  const channel = args.channel || "stable";
  const report = createValidationReport({ mode: args.mode || "network", primaryUrl: args.source, mirrorUrl: args.mirror });
  const fullDownload = !args["metadata-only"];
  let publicKeys = {};
  if (!args["skip-signature"]) {
    if (!args["public-key-file"]) throw new Error("--public-key-file is required unless --skip-signature is used");
    publicKeys = { "moonshine-app-manifest-v1": await fs.readFile(args["public-key-file"], "utf8") };
  }

  const appManifestPath = args["manifest-path"] || `manifests/${channel}/latest.json`;
  const sourceResults = new Map();
  const sourceErrors = new Map();
  const sources = [{ id: "primary", url: args.source }];
  if (args.mirror) sources.push({ id: "mirror", url: args.mirror });

  for (const source of sources) {
    try {
      const app = args["skip-signature"]
        ? await fetchJson(globalThis.fetch, objectUrl(source.url, appManifestPath))
        : await verifyManifestDocument({
            baseUrl: source.url,
            manifestPath: appManifestPath,
            publicKeys,
            channel,
            appVersion: args["app-version"],
          });
      sourceResults.set(source.id, { app });
      recordCheck(report, {
        id: `${source.id}.signed-app-manifest`,
        status: "pass",
        details: {
          appManifestPath,
        },
      });

      if (!args["skip-signature"] && app.manifest?.payload?.app) {
        const appInfo = app.manifest.payload.app;
        const latestYml = await checkRemoteObject({
          baseUrl: source.url,
          relativePath: appInfo.latestYmlPath,
          expectedSize: undefined,
          expectedSha256: appInfo.latestYmlSha256,
          fullDownload,
          returnBody: true,
        });
        recordCheck(report, { id: `${source.id}.latest-yml`, status: "pass", details: { path: appInfo.latestYmlPath } });
        if (latestYml.body) {
          const latest = parseYaml(latestYml.body.toString("utf8"));
          const installerPathValue = latest.path || latest.files?.find((entry) => String(entry?.url || "").toLowerCase().endsWith(".exe"))?.url;
          if (!installerPathValue) throw new Error("latest.yml does not identify an installer");
          const installerPath = resolveReleaseArtifactPath(appInfo.latestYmlPath, installerPathValue);
          const installer = await checkRemoteObject({
            baseUrl: source.url,
            relativePath: installerPath,
            expectedSize: latest.files?.find((entry) => entry.url === installerPath)?.size,
            expectedSha256: appInfo.installerSha256,
            fullDownload,
            returnBody: true,
          });
          if (fullDownload && installer.body) {
            const sha512 = createHash("sha512").update(installer.body).digest("base64");
            if (sha512 !== String(appInfo.installerSha512).trim()) throw new Error("Installer sha512 does not match signed app manifest");
          }
          recordCheck(report, { id: `${source.id}.installer`, status: "pass", details: { path: installerPath } });
        }
      }
      recordCheck(report, {
        id: `${source.id}.app-assets`,
        status: "pass",
        details: { fullDownload },
      });
    } catch (error) {
      sourceErrors.set(source.id, error);
      const expectedPrimaryOutage = report.mode === "source-failover"
        && source.id === "primary"
        && Boolean(args.mirror);
      recordCheck(report, {
        id: `${source.id}.network`,
        status: expectedPrimaryOutage ? "skip" : "fail",
        details: expectedPrimaryOutage ? { expectedOutage: true } : {},
        error,
      });
    }
  }

  const availability = evaluateSourceAvailability({
    mode: report.mode,
    primaryOk: sourceResults.has("primary"),
    mirrorConfigured: Boolean(args.mirror),
    mirrorOk: sourceResults.has("mirror"),
  });
  recordCheck(report, {
    id: "sources.availability",
    status: availability.status,
    details: {
      ...availability,
      primaryError: sourceErrors.has("primary") ? sourceErrors.get("primary").message : null,
      mirrorError: sourceErrors.has("mirror") ? sourceErrors.get("mirror").message : null,
    },
  });

  if (args.mirror && sourceResults.has("primary") && sourceResults.has("mirror")) {
    const primary = sourceResults.get("primary");
    const mirror = sourceResults.get("mirror");
    const pairs = [["app", primary.app, mirror.app]];
    const differences = pairs.filter(([, primaryValue, mirrorValue]) => {
      const primaryBytes = primaryValue.bytes || Buffer.from(JSON.stringify(primaryValue.value));
      const mirrorBytes = mirrorValue.bytes || Buffer.from(JSON.stringify(mirrorValue.value));
      return Buffer.compare(primaryBytes, mirrorBytes) !== 0;
    }).map(([name]) => name);
    if (differences.length) {
      recordCheck(report, {
        id: "mirror.manifest-parity",
        status: "fail",
        error: new Error(`Primary and mirror manifests differ: ${differences.join(", ")}`),
      });
    } else {
      recordCheck(report, {
        id: "mirror.manifest-parity",
        status: "pass",
        details: { byteIdentical: true, documents: pairs.map(([name]) => name) },
      });
    }
  }

  if (args["install-root"] || args["app-executable"]) {
    try {
      const local = await inspectLocalInstall({
        installRoot: args["install-root"],
        appExecutable: args["app-executable"],
        runExecutable: Boolean(args["run-executable"]),
      });
      recordCheck(report, { id: "local.installation", status: "pass", details: local });
    } catch (error) {
      recordCheck(report, { id: "local.installation", status: "fail", error });
    }
  } else {
    recordCheck(report, { id: "local.installation", status: "skip", details: { reason: "No local install path supplied" } });
  }

  if (args["environment-root"]) {
    try {
      const environment = await inspectManagedEnvironment({
        environmentRoot: args["environment-root"],
        expectedFlavor: args["environment-flavor"],
      });
      recordCheck(report, { id: "environment.managed", status: "pass", details: environment });
    } catch (error) {
      recordCheck(report, { id: "environment.managed", status: "fail", error });
    }
  } else {
    recordCheck(report, {
      id: "environment.managed",
      status: "skip",
      details: { reason: "No --environment-root supplied" },
    });
  }

  if (args["offline-bundle"]) {
    try {
      const offline = await inspectOfflineBundle({
        zipPath: args["offline-bundle"],
        expectedVersion: args["app-version"],
        expectedVariant: args["offline-variant"],
        publicKeyPem: publicKeys["moonshine-app-manifest-v1"],
      });
      recordCheck(report, {
        id: `offline.${args["offline-variant"] || "bundle"}`,
        status: "pass",
        details: offline,
      });
    } catch (error) {
      recordCheck(report, {
        id: `offline.${args["offline-variant"] || "bundle"}`,
        status: "fail",
        error,
      });
    }
  } else {
    recordCheck(report, {
      id: "offline.bundle",
      status: "skip",
      details: { reason: "No --offline-bundle supplied" },
    });
  }

  const result = await writeValidationReport(report, { reportPath: args.report });
  process.stdout.write(`${JSON.stringify({ report: result.outputPath, ok: result.report.ok })}\n`);
  return result.report.ok ? 0 : 1;
}

run()
  .then((exitCode) => {
    process.exitCode = Number(exitCode) || 0;
  })
  .catch(async (error) => {
    const message = sanitizeText(error);
    process.stderr.write(`Release validation failed: ${message}\n`);
    process.exitCode = 1;
  });
