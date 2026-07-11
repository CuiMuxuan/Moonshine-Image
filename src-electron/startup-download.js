import nodeFs from "node:fs";
import nodeHttps from "node:https";

function defaultGetByteLength(value) {
  if (!value) return 0;
  if (Buffer.isBuffer(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value === "string") return Buffer.byteLength(value);
  return 0;
}

function destroySafely(stream) {
  if (typeof stream?.destroy !== "function") return;
  try {
    stream.destroy();
  } catch {
    // Cleanup must not mask the original download failure.
  }
}

function unlinkSafely(fsImpl, filePath) {
  if (typeof fsImpl?.unlink !== "function") return;
  try {
    fsImpl.unlink(filePath, () => {});
  } catch {
    // A missing or locked partial file is secondary to the download error.
  }
}

function parseHttpsUrl(value, redirect = false) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    const context = redirect ? "redirect" : "URL";
    throw new Error(`Python installer returned an invalid ${context}: ${error.message}`);
  }
  if (parsed.protocol !== "https:") {
    const context = redirect ? "redirect" : "URL";
    throw new Error(`Python installer download refused a non-HTTPS ${context}.`);
  }
  return parsed;
}

function resolveRedirectUrl(location, currentUrl) {
  try {
    return new URL(location, currentUrl);
  } catch (error) {
    throw new Error(`Python installer returned an invalid redirect: ${error.message}`);
  }
}

export const DEFAULT_DOWNLOAD_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_DOWNLOAD_REQUEST_IDLE_TIMEOUT_MS = 30 * 1000;

function normalizeTimeout(value, fallback) {
  if (value === 0 || value === false) return 0;
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createTimeoutError(message, timeoutKind) {
  const error = new Error(message);
  error.code = "ETIMEDOUT";
  error.timedOut = true;
  error.timeoutKind = timeoutKind;
  return error;
}

function createAbortError(reason) {
  const error = new Error("Python installer download was aborted.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  if (reason !== undefined) error.reason = reason;
  return error;
}

export async function downloadHttpsFile(downloadUrl, filePath, options = {}) {
  const {
    httpsImpl = nodeHttps,
    fsImpl = nodeFs,
    ensureDiskSpace = () => {},
    getByteLength = defaultGetByteLength,
  } = options;
  const maxRedirects = options.maxRedirects ?? 5;
  const totalTimeoutMs = normalizeTimeout(
    options.totalTimeoutMs ?? options.timeoutMs,
    DEFAULT_DOWNLOAD_TOTAL_TIMEOUT_MS
  );
  const requestIdleTimeoutMs = normalizeTimeout(
    options.requestIdleTimeoutMs ?? options.idleTimeoutMs ?? options.requestTimeoutMs,
    DEFAULT_DOWNLOAD_REQUEST_IDLE_TIMEOUT_MS
  );
  const setTimeoutImpl = options.setTimeoutImpl || options.setTimeout || globalThis.setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl || options.clearTimeout || globalThis.clearTimeout;
  const signal = options.signal;

  return await new Promise((resolve, reject) => {
    let settled = false;
    let activeGeneration = 0;
    let totalTimer = null;
    let idleTimer = null;
    let currentResponse = null;
    let currentFile = null;
    let abortListenerAttached = false;
    const resources = new Set();
    const listenerDisposers = new Set();

    const clearTimerSafely = (timer) => {
      if (timer === null || timer === undefined) return;
      try {
        clearTimeoutImpl(timer);
      } catch {
        // Timer cleanup cannot change the download result.
      }
    };

    const clearTotalTimer = () => {
      const timer = totalTimer;
      totalTimer = null;
      clearTimerSafely(timer);
    };

    const clearIdleTimer = () => {
      const timer = idleTimer;
      idleTimer = null;
      clearTimerSafely(timer);
    };

    const listen = (target, eventName, listener, once = false) => {
      const method = once ? "once" : "on";
      if (typeof target?.[method] !== "function" || typeof target?.removeListener !== "function") {
        throw new TypeError(`Download stream does not support the ${eventName} event.`);
      }

      let dispose = () => {};
      const wrapped = once
        ? (...args) => {
            listenerDisposers.delete(dispose);
            listener(...args);
          }
        : listener;
      target[method](eventName, wrapped);
      dispose = () => {
        try {
          target.removeListener(eventName, wrapped);
        } catch {
          // Listener cleanup cannot change the download result.
        }
      };
      listenerDisposers.add(dispose);
    };

    const removeListeners = () => {
      for (const dispose of listenerDisposers) dispose();
      listenerDisposers.clear();
    };

    const detachAbortListener = () => {
      if (!abortListenerAttached) return;
      abortListenerAttached = false;
      try {
        signal.removeEventListener("abort", handleAbort);
      } catch {
        // Abort listener cleanup cannot change the download result.
      }
    };

    const cleanup = (destroyResources) => {
      clearTotalTimer();
      clearIdleTimer();
      detachAbortListener();
      if (destroyResources) {
        try {
          currentResponse?.unpipe?.(currentFile);
        } catch {
          // Stream teardown continues even if unpipe fails.
        }
        for (const resource of resources) destroySafely(resource);
      }
      removeListeners();
      resources.clear();
      currentResponse = null;
      currentFile = null;
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup(true);
      unlinkSafely(fsImpl, filePath);
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const succeed = (result) => {
      if (settled) return;
      settled = true;
      cleanup(false);
      resolve(result);
    };

    function handleAbort() {
      fail(createAbortError(signal?.reason));
    }

    const armTotalTimer = () => {
      if (!(totalTimeoutMs > 0) || settled) return;
      let timer;
      try {
        timer = setTimeoutImpl(() => {
          if (totalTimer === timer) totalTimer = null;
          fail(
            createTimeoutError(
              `Python installer download timed out after ${totalTimeoutMs} ms.`,
              "total"
            )
          );
        }, totalTimeoutMs);
      } catch (error) {
        fail(error);
        return;
      }
      if (settled) {
        clearTimerSafely(timer);
      } else {
        totalTimer = timer;
      }
    };

    const armIdleTimer = (generation) => {
      clearIdleTimer();
      if (!(requestIdleTimeoutMs > 0) || settled || generation !== activeGeneration) return;
      let timer;
      try {
        timer = setTimeoutImpl(() => {
          if (idleTimer !== timer) return;
          idleTimer = null;
          if (settled || generation !== activeGeneration) return;
          fail(
            createTimeoutError(
              `Python installer download was idle for more than ${requestIdleTimeoutMs} ms.`,
              "idle"
            )
          );
        }, requestIdleTimeoutMs);
      } catch (error) {
        fail(error);
        return;
      }
      if (settled || generation !== activeGeneration) {
        clearTimerSafely(timer);
      } else {
        idleTimer = timer;
      }
    };

    const beginRequest = (currentUrl, redirectCount) => {
      if (settled) return;

      let parsedUrl;
      try {
        parsedUrl = parseHttpsUrl(currentUrl, redirectCount > 0);
      } catch (error) {
        fail(error);
        return;
      }

      const generation = ++activeGeneration;
      currentResponse = null;
      currentFile = null;
      clearIdleTimer();

      const handleResponse = (response) => {
        if (settled || generation !== activeGeneration) {
          destroySafely(response);
          return;
        }
        currentResponse = response;
        resources.add(response);
        armIdleTimer(generation);

        try {
          listen(
            response,
            "error",
            (error) => {
              if (generation === activeGeneration) fail(error);
            },
            true
          );
          listen(
            response,
            "aborted",
            () => {
              if (generation === activeGeneration) {
                fail(new Error("Python installer download was aborted."));
              }
            },
            true
          );

          const statusCode = Number(response.statusCode || 0);
          const headers = response.headers || {};
          if (statusCode >= 300 && statusCode < 400 && headers.location) {
            response.resume();
            if (redirectCount >= maxRedirects) {
              fail(new Error("Python installer download exceeded the redirect limit."));
              return;
            }

            let redirectUrl;
            try {
              redirectUrl = resolveRedirectUrl(headers.location, parsedUrl);
              parseHttpsUrl(redirectUrl, true);
            } catch (error) {
              fail(error);
              return;
            }
            beginRequest(redirectUrl.toString(), redirectCount + 1);
            return;
          }

          if (statusCode < 200 || statusCode >= 300) {
            response.resume();
            fail(
              new Error(`Python installer download failed with HTTP ${statusCode || "unknown"}.`)
            );
            return;
          }

          const contentLength = Number(headers["content-length"] || 0);
          if (Number.isFinite(contentLength) && contentLength > 0) {
            ensureDiskSpace(filePath, {
              requiredBytes: contentLength,
              operation: "下载 Python 安装包",
            });
          }

          let receivedBytes = 0;
          const file = fsImpl.createWriteStream(filePath);
          currentFile = file;
          resources.add(file);
          listen(response, "data", (chunk) => {
            if (settled || generation !== activeGeneration) return;
            armIdleTimer(generation);
            try {
              const byteLength = getByteLength(chunk);
              receivedBytes += byteLength;
              if (!(contentLength > 0)) {
                ensureDiskSpace(filePath, {
                  requiredBytes: byteLength,
                  operation: "下载 Python 安装包",
                });
              }
            } catch (error) {
              fail(error);
            }
          });
          listen(file, "error", fail, true);
          listen(
            file,
            "finish",
            () => {
              if (settled || generation !== activeGeneration) return;
              clearIdleTimer();
              if (receivedBytes === 0 || (contentLength > 0 && receivedBytes !== contentLength)) {
                fail(
                  new Error(
                    `Python installer download was incomplete (${receivedBytes}/${contentLength || "unknown"} bytes).`
                  )
                );
                return;
              }

              const complete = (error) => {
                if (error) {
                  fail(error);
                  return;
                }
                succeed({ bytes: receivedBytes, url: parsedUrl.toString() });
              };
              try {
                if (typeof file.close === "function") {
                  file.close(complete);
                } else {
                  complete();
                }
              } catch (error) {
                fail(error);
              }
            },
            true
          );
          response.pipe(file);
        } catch (error) {
          fail(error);
        }
      };

      try {
        const request = httpsImpl.get(parsedUrl.toString(), handleResponse);
        if (settled) {
          destroySafely(request);
          return;
        }
        resources.add(request);
        listen(
          request,
          "error",
          (error) => {
            if (generation === activeGeneration) fail(error);
          },
          true
        );
        armIdleTimer(generation);
      } catch (error) {
        fail(error);
      }
    };

    if (signal?.aborted) {
      fail(createAbortError(signal.reason));
      return;
    }
    if (typeof signal?.addEventListener === "function") {
      try {
        signal.addEventListener("abort", handleAbort, { once: true });
        abortListenerAttached = true;
      } catch (error) {
        fail(error);
        return;
      }
    }

    armTotalTimer();
    if (!settled) beginRequest(downloadUrl, 0);
  });
}
