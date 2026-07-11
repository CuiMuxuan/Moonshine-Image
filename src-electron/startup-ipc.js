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
