export class ApplicationBootstrapError extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "ApplicationBootstrapError";
    this.code = options.code || "APP_BOOTSTRAP_FAILED";
    this.phase = options.phase || "app-bootstrap";
    this.exitCode = options.exitCode || 174;
    this.recoveryHint = options.recoveryHint || "Open the startup log for details.";
    this.diagnostic = options.diagnostic || options.cause?.diagnostic || null;
  }
}

export function createFatalStartupHandler(handleFatalError) {
  if (typeof handleFatalError !== "function") {
    throw new TypeError("createFatalStartupHandler requires a handler function.");
  }
  let handlingPromise = null;
  return async (error) => {
    if (!handlingPromise) {
      handlingPromise = Promise.resolve().then(() => handleFatalError(error));
    }
    return await handlingPromise;
  };
}

async function runStep(step, phase) {
  try {
    return await step();
  } catch (error) {
    if (error instanceof ApplicationBootstrapError) throw error;
    throw new ApplicationBootstrapError(error?.message || `Application ${phase} failed.`, {
      code: "APP_BOOTSTRAP_FAILED",
      phase,
      cause: error,
      recoveryHint: "Restart the application. If the problem continues, open the startup log.",
    });
  }
}

export async function bootstrapApplication(options = {}) {
  const {
    verifyIntegrity,
    registerProtocol,
    loadConfig,
    cleanupTemporaryFiles,
    createWindow,
  } = options;

  const integrityResult = await runStep(verifyIntegrity, "resource-integrity");
  if (!integrityResult?.success) {
    throw new ApplicationBootstrapError(
      integrityResult?.error || "Application resource integrity verification failed.",
      {
        code: "APP_RESOURCE_INTEGRITY_FAILED",
        phase: "resource-integrity",
        exitCode: 173,
        recoveryHint: "Reinstall the application or restore the protected resources.",
      }
    );
  }

  await runStep(registerProtocol, "protocol-registration");
  await runStep(loadConfig, "config-loading");
  await runStep(cleanupTemporaryFiles, "temporary-cleanup");
  await runStep(createWindow, "window-creation");

  return { success: true };
}
