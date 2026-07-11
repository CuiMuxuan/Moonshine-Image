function normalizeAbortReason(reason, fallbackMessage) {
  if (reason instanceof Error) return reason;
  if (reason !== undefined && reason !== null && String(reason)) {
    return new Error(String(reason));
  }
  return new Error(fallbackMessage);
}

export class StartupOperationRegistry {
  constructor(options = {}) {
    this._records = new Set();
    this._now = options.now || Date.now;
    this._setTimeout = options.setTimeoutImpl || globalThis.setTimeout;
    this._clearTimeout = options.clearTimeoutImpl || globalThis.clearTimeout;
    this._getInitialAbortReason = options.getInitialAbortReason || (() => null);
  }

  get size() {
    return this._records.size;
  }

  async run(operation, externalSignal) {
    if (typeof operation !== "function") {
      throw new TypeError("Startup operation must be a function.");
    }

    const controller = new AbortController();
    const relayAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort(
          normalizeAbortReason(externalSignal?.reason, "Startup operation was cancelled.")
        );
      }
    };

    if (externalSignal?.aborted) {
      relayAbort();
    } else {
      externalSignal?.addEventListener?.("abort", relayAbort, { once: true });
    }

    const initialAbortReason = this._getInitialAbortReason();
    if (initialAbortReason && !controller.signal.aborted) {
      controller.abort(
        normalizeAbortReason(initialAbortReason, "Startup operation was cancelled.")
      );
    }

    const record = { controller, promise: null };
    this._records.add(record);
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    record.promise = operationPromise;

    try {
      return await operationPromise;
    } finally {
      externalSignal?.removeEventListener?.("abort", relayAbort);
      this._records.delete(record);
    }
  }

  abort(reason) {
    const abortReason = normalizeAbortReason(reason, "Startup operations were cancelled.");
    let aborted = 0;
    for (const { controller } of this._records) {
      if (controller.signal.aborted) continue;
      controller.abort(abortReason);
      aborted += 1;
    }
    return aborted;
  }

  async waitForSettled(timeoutMs = 10000) {
    const normalizedTimeoutMs = Number.isFinite(Number(timeoutMs))
      ? Math.max(0, Number(timeoutMs))
      : 10000;
    const deadline = this._now() + normalizedTimeoutMs;

    while (this._records.size > 0) {
      const pending = [...this._records].map((record) => record.promise).filter(Boolean);
      if (pending.length === 0) {
        await Promise.resolve();
        continue;
      }

      const remainingMs = deadline - this._now();
      if (remainingMs <= 0) {
        return { settled: false, pending: this._records.size };
      }

      let timeoutHandle;
      const outcome = await Promise.race([
        Promise.allSettled(pending).then(() => "settled"),
        new Promise((resolve) => {
          timeoutHandle = this._setTimeout(() => resolve("timeout"), remainingMs);
          timeoutHandle?.unref?.();
        }),
      ]);
      if (timeoutHandle !== undefined) this._clearTimeout(timeoutHandle);
      if (outcome === "timeout") {
        return { settled: false, pending: this._records.size };
      }
    }

    return { settled: true, pending: 0 };
  }
}
