import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { resolveAppEdition } from "../../src-electron/updater/edition.js";

const hashFile = async (filePath) => {
  const contents = await readFile(filePath);
  return createHash("sha512").update(contents).digest("base64");
};

const requiredPath = (value, label) => {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return path.resolve(normalized);
};

const safeArtifactName = (value, label) => {
  const name = String(value || "").trim();
  if (!name || path.basename(name) !== name || /[\\/]/.test(name)) {
    throw new Error(`${label} must be a file basename`);
  }
  return name;
};

export const createAppUpdateMetadata = async ({ artifactDir, version, releaseDate, output } = {}) => {
  const resolvedArtifactDir = requiredPath(artifactDir, "artifactDir");
  const normalizedVersion = String(version || "").trim();
  const identity = resolveAppEdition(normalizedVersion);
  const installerName = safeArtifactName(
    identity.artifactName.replace("${version}", normalizedVersion).replace("${ext}", "exe"),
    "installer name"
  );
  const installerPath = path.join(resolvedArtifactDir, installerName);
  const blockmapPath = `${installerPath}.blockmap`;
  const [installerStat, blockmapStat] = await Promise.all([stat(installerPath), stat(blockmapPath)]);
  if (!installerStat.isFile()) throw new Error(`Installer is not a file: ${installerPath}`);
  if (!blockmapStat.isFile() || blockmapStat.size <= 0) throw new Error(`Missing or empty blockmap: ${blockmapPath}`);

  const sha512 = await hashFile(installerPath);
  const timestamp = releaseDate ? new Date(releaseDate) : new Date();
  if (Number.isNaN(timestamp.getTime())) throw new Error("releaseDate must be a valid ISO timestamp");

  const payload = {
    version: normalizedVersion,
    files: [
      {
        url: installerName,
        sha512,
        size: installerStat.size,
      },
    ],
    path: installerName,
    sha512,
    releaseDate: timestamp.toISOString(),
  };
  const outputPath = path.resolve(output || path.join(resolvedArtifactDir, "latest.yml"));
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, YAML.stringify(payload), "utf8");
  await rename(temporaryPath, outputPath);

  return {
    artifactDir: resolvedArtifactDir,
    edition: identity.edition,
    channel: identity.channel,
    installerPath,
    blockmapPath,
    outputPath,
    payload,
  };
};

const parseArgs = (argumentsList) => {
  const args = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (name === "help") {
      args.help = true;
      continue;
    }
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    args[name] = value;
    index += 1;
  }
  return args;
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write("Usage: node scripts/release/create-app-update-metadata.mjs --artifact-dir <path> --version <version> [--release-date <ISO>] [--output <path>]\n");
    } else {
      const result = await createAppUpdateMetadata({
        artifactDir: args["artifact-dir"],
        version: args.version,
        releaseDate: args["release-date"],
        output: args.output,
      });
      process.stdout.write(`${JSON.stringify({
        outputPath: result.outputPath,
        edition: result.edition,
        channel: result.channel,
        installerBytes: result.payload.files[0].size,
      }, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
