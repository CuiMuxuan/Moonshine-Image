import fs from "node:fs/promises";
import path from "node:path";

export const EFFECTIVE_RUNTIME_RECEIPT_SCHEMA = 1;
export const EFFECTIVE_RUNTIME_RECEIPT_RELATIVE_PATH = path.join(
  "diagnostics",
  "effective-runtime.json",
);

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function absolutePath(value, label) {
  return path.resolve(requiredText(value, label));
}

export function effectiveRuntimeReceiptPath(userData) {
  return path.join(absolutePath(userData, "userData"), EFFECTIVE_RUNTIME_RECEIPT_RELATIVE_PATH);
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeEffectiveRuntimeReceipt({
  userData,
  appVersion,
  appProcessId = process.pid,
  serviceProcessId,
  serviceProjectPath,
  pythonExecutable,
  environmentRoot,
  environmentSource,
  accelerator,
  specHash,
  port,
  startedAt = new Date().toISOString(),
} = {}) {
  const receipt = {
    schemaVersion: EFFECTIVE_RUNTIME_RECEIPT_SCHEMA,
    appVersion: requiredText(appVersion, "appVersion"),
    status: "running",
    appProcessId: Number(appProcessId) || null,
    serviceProcessId: Number(serviceProcessId) || null,
    serviceProjectPath: absolutePath(serviceProjectPath, "serviceProjectPath"),
    pythonExecutable: absolutePath(pythonExecutable, "pythonExecutable"),
    environmentRoot: absolutePath(environmentRoot, "environmentRoot"),
    environmentSource: String(environmentSource || "unknown"),
    accelerator: String(accelerator || "unknown"),
    specHash: specHash ? String(specHash) : null,
    port: Number(port) || null,
    startedAt: new Date(startedAt).toISOString(),
    recordedAt: new Date().toISOString(),
  };
  const filePath = effectiveRuntimeReceiptPath(userData);
  await writeJsonAtomic(filePath, receipt);
  return { filePath, receipt };
}

export async function markEffectiveRuntimeReceiptStopped({
  userData,
  status = "stopped",
  stoppedAt = new Date().toISOString(),
} = {}) {
  const filePath = effectiveRuntimeReceiptPath(userData);
  let current;
  try {
    current = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { success: true, changed: false, filePath };
    throw error;
  }
  const receipt = {
    ...current,
    status: String(status || "stopped"),
    stoppedAt: new Date(stoppedAt).toISOString(),
    recordedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(filePath, receipt);
  return { success: true, changed: true, filePath, receipt };
}
