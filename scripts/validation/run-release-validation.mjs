#!/usr/bin/env node

import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { inspectOfflineBundle } from "../build-offline-bundle-win.mjs";
import { parseCliArgs } from "../release/app-release-lib.mjs";
import {
  APP_EDITION,
  APP_EDITION_IDENTITIES,
  assertEditionChannel,
  resolveAppEdition,
} from "../../src-electron/updater/edition.js";
import {
  checkRemoteObject,
  createValidationReport,
  evaluateSourceAvailability,
  fetchJson,
  inspectLocalInstall,
  inspectManagedEnvironment,
  objectUrl,
  recordCheck as recordValidationCheck,
  resolveReleaseArtifactPath,
  sanitizeText,
  verifyManifestDocument,
  writeValidationReport,
} from "./release-validation-lib.mjs";
import {
  evaluateCudaCompatibility,
  environmentRootFromPython,
  inspectConfiguration,
  inspectEffectiveRuntime,
  inspectExternalEnvironment,
  inspectFailureReceipt,
  inspectHostEnvironment,
  inspectPythonInstallations,
  inspectPythonEnvironment,
  pathType,
  probeConfiguredService,
  probeNetworkEndpoint,
} from "./support-diagnostics-lib.mjs";

const usage = `Usage: node scripts/validation/run-release-validation.mjs [options]

Runs network, source-failover and optional local-install checks on another Windows PC.
The report contains no credentials or private key material.

Options:
  --source <https-url>       primary public source (required)
  --mirror <https-url>       independent mirror source (optional)
  --channel <test|stable>     channel (must match the app edition)
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
  --python-executable <path>  explicit Python executable for development diagnostics
  --service-project <path>    explicit service project root for development diagnostics
  --user-data <path>          application user-data root (defaults to the matching edition under APPDATA)
  --config <path>             optional application config.json override
  --requirements-root <path>  validator requirements lock directory
  --report <path>              output JSON report path
  --mode <network|clean-install|canary|rollback|source-failover|offline-cpu|offline-cu130>
  --help                       show this help
`;

const VALIDATION_STAGE_COUNT = 9;
let activeProgress = null;

function formatElapsed(startedAt) {
  const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function createValidationProgress(report) {
  const startedAt = Date.now();
  let stage = 0;
  let stageLabel = "初始化";
  const write = (state, message) => {
    const completed = report.summary.passed + report.summary.failed + report.summary.skipped;
    process.stdout.write(
      `[验证][阶段 ${stage}/${VALIDATION_STAGE_COUNT}][${state}]` +
      `[已完成 ${completed}，失败 ${report.summary.failed}]` +
      `[耗时 ${formatElapsed(startedAt)}] ${sanitizeText(message)}\n`,
    );
  };
  return {
    stage(nextStage, label, currentCheck) {
      stage = nextStage;
      stageLabel = label;
      write("进行中", currentCheck ? `${label}：${currentCheck}` : label);
    },
    check(entry) {
      const state = entry.status === "fail" ? "失败" : entry.status === "skip" ? "跳过" : "通过";
      write(state, `检查项 ${entry.id}`);
    },
    heartbeat(currentCheck = stageLabel) {
      write("进行中", `${currentCheck}（仍在运行）`);
    },
    startHeartbeat(currentCheck, intervalMs = 10_000) {
      const timer = setInterval(() => this.heartbeat(currentCheck), intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    finish(outputPath) {
      write(report.summary.failed > 0 ? "完成但有失败" : "完成", `报告已生成：${outputPath}`);
    },
  };
}

export function resolveValidationEdition({ appVersion, channel } = {}) {
  if (appVersion) {
    const edition = resolveAppEdition(appVersion);
    const normalizedChannel = String(channel || edition.channel).trim().toLowerCase();
    return assertEditionChannel(appVersion, normalizedChannel);
  }
  const normalizedChannel = String(channel || "stable").trim().toLowerCase();
  if (normalizedChannel === "test") return APP_EDITION_IDENTITIES[APP_EDITION.TEST];
  if (normalizedChannel === "stable") return APP_EDITION_IDENTITIES[APP_EDITION.OFFICIAL];
  throw new Error(`Unsupported validation channel: ${normalizedChannel || "<empty>"}`);
}

export function defaultUserDataRoot({
  appData = process.env.APPDATA,
  appVersion,
  channel = "stable",
} = {}) {
  const root = String(appData || "").trim();
  if (!root) return null;
  const identity = resolveValidationEdition({ appVersion, channel });
  return path.join(root, identity.userDataName);
}

async function resolveRequirementsLock({ requirementsRoot, installRoot, flavor }) {
  const fileName = `requirements-${flavor === "cu130" ? "cu130" : "cpu"}.lock.txt`;
  const candidates = [
    requirementsRoot ? path.join(requirementsRoot, fileName) : null,
    installRoot ? path.join(installRoot, "resources", "backend", "server", fileName) : null,
    path.join(process.cwd(), "build-resources", "backend", "server", fileName),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await pathType(candidate) === "file") return candidate;
  }
  return candidates[0] || null;
}

function checkResult(report, id, result) {
  recordCheck(report, {
    id,
    status: result?.status || "fail",
    details: result?.details || {},
    error: result?.error,
  });
}

function recordCheck(report, check) {
  const entry = recordValidationCheck(report, check);
  activeProgress?.check(entry);
  return entry;
}

export async function run(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv, {
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
      "python-executable",
      "service-project",
      "user-data",
      "config",
      "requirements-root",
      "report",
      "mode",
    ],
  });
  if (args.help) {
    process.stdout.write(usage);
    return 0;
  }
  if (!args.source) throw new Error("--source is required");
  const channel = args.channel || (args["app-version"] ? resolveAppEdition(args["app-version"]).channel : "stable");
  const identity = resolveValidationEdition({ appVersion: args["app-version"], channel });
  const report = createValidationReport({ mode: args.mode || "network", primaryUrl: args.source, mirrorUrl: args.mirror });
  activeProgress = createValidationProgress(report);
  const fullDownload = !args["metadata-only"];
  const userData = args["user-data"] || defaultUserDataRoot({ appVersion: args["app-version"], channel: identity.channel });

  activeProgress.stage(1, "主机能力", "检测操作系统、显卡与驱动");
  const host = await inspectHostEnvironment();
  checkResult(report, "host.capabilities", host);

  activeProgress.stage(2, "联网能力", "检查 pip、PyTorch、Hugging Face 与应用分发源");
  const networkTargets = [
    { id: "network.pypi", url: "https://pypi.org/simple/pip/" },
    { id: "network.python-installer", url: "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe" },
    { id: "network.pytorch-cpu", url: "https://download.pytorch.org/whl/cpu/" },
    { id: "network.pytorch-cu130", url: "https://download.pytorch.org/whl/cu130/" },
    { id: "network.hugging-face", url: "https://huggingface.co/" },
    { id: "network.hugging-face-model", url: "https://huggingface.co/CuiMuxuan/moonshine-models/resolve/main/big-lama.pt" },
    { id: "network.distribution-primary", url: args.source },
    ...(args.mirror ? [{ id: "network.distribution-mirror", url: args.mirror }] : []),
  ];
  const stopNetworkHeartbeat = activeProgress.startHeartbeat("正在等待联网检查返回");
  const networkResults = await Promise.all(networkTargets.map((target) => probeNetworkEndpoint(target)))
    .finally(stopNetworkHeartbeat);
  for (const result of networkResults) checkResult(report, result.id, result);

  activeProgress.stage(3, "配置与发布源", "读取应用配置并验证签名发布清单");
  let configuration = null;
  if (userData || args.config) {
    configuration = await inspectConfiguration({ userData, configPath: args.config });
    checkResult(report, "configuration.application", configuration);
  } else {
    recordCheck(report, { id: "configuration.application", status: "skip", details: { reason: "APPDATA and --user-data are unavailable" } });
  }

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
    const stopSourceHeartbeat = activeProgress.startHeartbeat(`正在验证 ${source.id} 发布源`);
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
    } finally {
      stopSourceHeartbeat();
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

  activeProgress.stage(4, "软件安装", "检查安装路径、可执行文件与内置资源完整性");
  let localInstall = null;
  if (args["install-root"] || args["app-executable"]) {
    try {
      localInstall = await inspectLocalInstall({
        installRoot: args["install-root"],
        appExecutable: args["app-executable"],
        runExecutable: Boolean(args["run-executable"]),
      });
      recordCheck(report, {
        id: "local.installation",
        status: localInstall.integrity?.status === "fail" || localInstall.executable?.status === "fail" ? "fail" : "pass",
        details: localInstall,
      });
    } catch (error) {
      recordCheck(report, { id: "local.installation", status: "fail", error });
    }
  } else {
    recordCheck(report, { id: "local.installation", status: "skip", details: { reason: "No local install path supplied" } });
  }

  activeProgress.stage(5, "运行环境路径", "读取受管环境、已有环境与实际生效收据");
  let externalEnvironment = null;
  if (userData) {
    externalEnvironment = await inspectExternalEnvironment({ userData });
    checkResult(report, "environment.external", externalEnvironment);
  } else {
    recordCheck(report, { id: "environment.external", status: "skip", details: { reason: "No user-data root supplied" } });
  }

  let managedEnvironment = null;
  const managedRoot = args["environment-root"] || userData;
  if (managedRoot) {
    try {
      managedEnvironment = await inspectManagedEnvironment({
        environmentRoot: managedRoot,
        expectedFlavor: args["environment-flavor"],
      });
      recordCheck(report, { id: "environment.managed", status: "pass", details: managedEnvironment });
    } catch (error) {
      const externalActive = externalEnvironment?.status === "pass" && externalEnvironment.effective;
      recordCheck(report, {
        id: "environment.managed",
        status: externalActive ? "skip" : "fail",
        details: externalActive ? { reason: "An external environment is configured" } : {},
        error: externalActive ? null : error,
      });
    }
  } else {
    recordCheck(report, {
      id: "environment.managed",
      status: "skip",
      details: { reason: "No user-data or environment root supplied" },
    });
  }

  let effectiveRuntime = null;
  if (userData) {
    effectiveRuntime = await inspectEffectiveRuntime({
      userData,
      installRoot: args["install-root"],
      configuredServiceProjectPath: args["service-project"] || configuration?.effective?.backendProjectPath,
      configuredPort: configuration?.effective?.backendPort,
      configuredAccelerator: configuration?.effective?.launchMode,
    });
    checkResult(report, "runtime.effective", effectiveRuntime);
  } else {
    recordCheck(report, { id: "runtime.effective", status: "skip", details: { reason: "No user-data root supplied" } });
  }

  const runningReceipt = effectiveRuntime?.effective?.status === "running" ? effectiveRuntime.effective : null;
  const explicitPython = args["python-executable"] ? path.resolve(args["python-executable"]) : null;
  const selectedEnvironment = explicitPython
    ? {
        source: "explicit",
        root: environmentRootFromPython(explicitPython),
        python: explicitPython,
        flavor: args["environment-flavor"] || "cpu",
      }
    : runningReceipt
    ? {
        source: runningReceipt.environmentSource || "receipt",
        root: runningReceipt.environmentRoot,
        python: runningReceipt.pythonExecutable,
        flavor: runningReceipt.accelerator,
      }
    : externalEnvironment?.effective
      ? {
          source: "external",
          root: externalEnvironment.effective.normalizedPath,
          python: externalEnvironment.effective.pythonExecutable,
          flavor: externalEnvironment.effective.accelerator,
        }
      : managedEnvironment
        ? {
            source: "managed",
            root: managedEnvironment.environmentPath,
            python: managedEnvironment.pythonExecutable,
            flavor: managedEnvironment.flavor,
          }
        : null;
  const serviceProjectPath = args["service-project"]
    || runningReceipt?.serviceProjectPath
    || configuration?.effective?.backendProjectPath
    || (args["install-root"] ? path.join(args["install-root"], "resources", "backend", "server") : null);
  activeProgress.stage(6, "Python 与依赖", "枚举 Python 并验证锁定依赖、PyTorch 和 CUDA");
  const stopPythonHeartbeat = activeProgress.startHeartbeat("正在检查 Python 解释器与依赖包");
  const pythonInstallations = await inspectPythonInstallations({
    additionalCandidates: selectedEnvironment?.python ? [selectedEnvironment.python] : [],
  }).finally(stopPythonHeartbeat);
  checkResult(report, "host.python-interpreters", pythonInstallations);
  let pythonEnvironment = null;
  if (selectedEnvironment?.python) {
    const flavor = selectedEnvironment.flavor === "cu130" ? "cu130" : "cpu";
    const lockPath = await resolveRequirementsLock({
      requirementsRoot: args["requirements-root"],
      installRoot: args["install-root"],
      flavor,
    });
    const stopDependencyHeartbeat = activeProgress.startHeartbeat("正在核对 Python 与 PyTorch 依赖");
    pythonEnvironment = await inspectPythonEnvironment({
      pythonExecutable: selectedEnvironment.python,
      backendProjectPath: serviceProjectPath,
      flavor,
      lockPath,
    }).finally(stopDependencyHeartbeat);
    pythonEnvironment.details.source = selectedEnvironment.source;
    checkResult(report, "environment.dependencies", pythonEnvironment);
    checkResult(report, "environment.cuda", evaluateCudaCompatibility({
      host: host.details,
      environment: pythonEnvironment.diagnostics,
      flavor,
    }));
  } else {
    recordCheck(report, { id: "environment.dependencies", status: "fail", details: { reason: "No active managed or external Python environment was found" } });
    recordCheck(report, { id: "environment.cuda", status: "skip", details: { reason: "No active Python environment was found" } });
  }

  activeProgress.stage(7, "服务可用性", "按实际配置检查当前服务或执行隔离烟测");
  if (effectiveRuntime?.status === "pass" && effectiveRuntime.details?.health?.ok) {
    recordCheck(report, {
      id: "service.configured",
      status: "pass",
      details: {
        mode: "running-application",
        safety: "validated the application-owned process without starting another service",
        serviceProjectPath: effectiveRuntime.details.serviceProjectPath,
        pythonExecutable: effectiveRuntime.details.pythonExecutable,
        environmentRoot: effectiveRuntime.details.environmentRoot,
        accelerator: effectiveRuntime.details.accelerator,
        port: effectiveRuntime.details.port,
        health: effectiveRuntime.details.health,
      },
    });
  } else if (pythonEnvironment?.status === "pass" && selectedEnvironment?.python && serviceProjectPath && configuration?.effective) {
    const stopServiceHeartbeat = activeProgress.startHeartbeat("正在启动并检查隔离服务；此步骤可能需要数分钟");
    const serviceResult = await probeConfiguredService({
      pythonExecutable: selectedEnvironment.python,
      serviceProjectPath,
      flavor: selectedEnvironment.flavor,
      launchMode: configuration.effective.launchMode,
      model: configuration.effective.defaultModel,
      modelDir: configuration.effective.modelDir,
    }).finally(stopServiceHeartbeat);
    checkResult(report, "service.configured", serviceResult);
  } else {
    recordCheck(report, {
      id: "service.configured",
      status: "fail",
      details: {
        reason: !configuration?.effective
          ? "The application configuration is invalid"
          : !pythonEnvironment || pythonEnvironment.status !== "pass"
            ? "A complete Python environment is required before the configured service can be tested"
            : "The configured service project path is unavailable",
      },
    });
  }

  activeProgress.stage(8, "历史诊断与离线包", "检查历史失败收据和可选离线完整包");
  if (userData) {
    const failureReceipt = await inspectFailureReceipt({ userData });
    if (failureReceipt.status === "fail" && pythonEnvironment?.status === "pass") {
      failureReceipt.status = "skip";
      failureReceipt.details.reason = "A historical managed-environment failure exists, but the effective environment is healthy";
    }
    checkResult(report, "environment.last-failure", failureReceipt);
  } else {
    recordCheck(report, { id: "environment.last-failure", status: "skip", details: { reason: "No user-data root supplied" } });
  }

  if (args["offline-bundle"]) {
    const stopOfflineHeartbeat = activeProgress.startHeartbeat("正在校验离线完整包；大文件哈希计算可能需要较长时间");
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
    } finally {
      stopOfflineHeartbeat();
    }
  } else {
    recordCheck(report, {
      id: "offline.bundle",
      status: "skip",
      details: { reason: "No --offline-bundle supplied" },
    });
  }

  activeProgress.stage(9, "生成报告", "写入脱敏 JSON 与汇总结果");
  const result = await writeValidationReport(report, { reportPath: args.report });
  activeProgress.finish(result.outputPath);
  process.stdout.write(`${JSON.stringify({ report: result.outputPath, ok: result.report.ok })}\n`);
  return result.report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
    .then((exitCode) => {
      process.exitCode = Number(exitCode) || 0;
    })
    .catch(async (error) => {
      const message = sanitizeText(error);
      process.stderr.write(`Release validation failed: ${message}\n`);
      process.exitCode = 1;
    });
}
