export async function runStartupIpcOperation(operation, normalizeFailure) {
  if (typeof operation !== "function") {
    throw new TypeError("Startup IPC operation must be a function.");
  }
  if (typeof normalizeFailure !== "function") {
    throw new TypeError("Startup IPC failure normalizer must be a function.");
  }

  try {
    return await operation();
  } catch (error) {
    return await normalizeFailure(error);
  }
}

export function registerDeprecatedStartupHandler(options = {}) {
  const {
    ipcMain,
    channel,
    replacement,
    handler,
    deprecationCode = "DEPRECATED_STARTUP_IPC",
    onDeprecated,
  } = options;

  if (!ipcMain || typeof ipcMain.handle !== "function") {
    throw new TypeError("Deprecated startup IPC registration requires ipcMain.handle.");
  }
  if (typeof channel !== "string" || !channel.trim()) {
    throw new TypeError("Deprecated startup IPC registration requires a channel.");
  }
  if (typeof replacement !== "string" || !replacement.trim()) {
    throw new TypeError("Deprecated startup IPC registration requires a replacement channel.");
  }
  if (typeof handler !== "function") {
    throw new TypeError("Deprecated startup IPC registration requires a handler.");
  }

  const wrappedHandler = async (...args) => {
    try {
      onDeprecated?.({ channel, replacement, deprecationCode });
    } catch {
      // Deprecation reporting must not change the legacy handler's behavior.
    }

    const result = await handler(...args);
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return result;
    }

    return {
      ...result,
      deprecated: true,
      deprecationCode,
      replacement,
    };
  };

  ipcMain.handle(channel, wrappedHandler);
  return wrappedHandler;
}
