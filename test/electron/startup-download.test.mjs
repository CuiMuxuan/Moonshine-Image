import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { downloadHttpsFile } from "../../src-electron/startup-download.js";

class FakeWriteStream extends Writable {
  constructor(options = {}) {
    super();
    this.chunks = [];
    this.closeCalls = 0;
    this.destroyCalls = 0;
    this.writeError = options.writeError || null;
  }

  _write(chunk, _encoding, callback) {
    if (this.writeError) {
      callback(this.writeError);
      return;
    }
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  close(callback) {
    this.closeCalls += 1;
    queueMicrotask(() => callback?.());
  }

  destroy(error) {
    this.destroyCalls += 1;
    return super.destroy(error);
  }

  get contents() {
    return Buffer.concat(this.chunks);
  }
}

function createFakeFs(fileOptions = {}) {
  const files = [];
  const unlinked = [];
  return {
    files,
    unlinked,
    impl: {
      createWriteStream() {
        const file = new FakeWriteStream(fileOptions);
        files.push(file);
        return file;
      },
      unlink(filePath, callback) {
        unlinked.push(filePath);
        callback?.();
      },
    },
  };
}

function createFakeHttps(actions) {
  const calls = [];
  const requests = [];
  const responses = [];

  const impl = {
    get(url, onResponse) {
      const action = actions[calls.length];
      if (!action) throw new Error(`Unexpected request: ${url}`);

      const request = new EventEmitter();
      request.destroyCalls = 0;
      request.destroy = () => {
        request.destroyCalls += 1;
      };
      calls.push(url);
      requests.push(request);

      queueMicrotask(() => {
        if (action.requestError) {
          request.emit("error", action.requestError);
          return;
        }
        if (action.noResponse) return;

        const response = new PassThrough();
        response.statusCode = action.statusCode ?? 200;
        response.headers = action.headers || {};
        response.destroyCalls = 0;
        const destroy = response.destroy.bind(response);
        response.destroy = (...args) => {
          response.destroyCalls += 1;
          return destroy(...args);
        };
        responses.push(response);
        onResponse(response);

        if (action.hang) return;
        if (action.responseError) {
          response.emit("error", action.responseError);
          return;
        }
        if (action.aborted) {
          response.emit("aborted");
          return;
        }
        for (const chunk of action.chunks || []) response.write(chunk);
        response.end();
      });

      return request;
    },
  };

  return { impl, calls, requests, responses };
}

function createHarness(actions, options = {}) {
  const fakeFs = createFakeFs(options.fileOptions);
  const fakeHttps = createFakeHttps(actions);
  const diskChecks = [];
  const byteLengths = [];
  const ensureDiskSpace =
    options.ensureDiskSpace ||
    ((filePath, payload) => {
      diskChecks.push({ filePath, payload });
    });
  const getByteLength = (chunk) => {
    const length = Buffer.byteLength(chunk);
    byteLengths.push(length);
    return length;
  };
  return {
    fakeFs,
    fakeHttps,
    diskChecks,
    byteLengths,
    options: {
      fsImpl: fakeFs.impl,
      httpsImpl: fakeHttps.impl,
      ensureDiskSpace,
      getByteLength,
      ...options.downloadOptions,
    },
  };
}

function createFakeTimers() {
  let nextId = 0;
  const records = [];
  return {
    records,
    setTimeoutImpl(callback, delay) {
      const record = { id: ++nextId, callback, delay, active: true, cleared: false };
      records.push(record);
      return record;
    },
    clearTimeoutImpl(record) {
      if (!record) return;
      record.active = false;
      record.cleared = true;
    },
    fireByDelay(delay, { includeCleared = false } = {}) {
      const record = records.find(
        (candidate) => candidate.delay === delay && (candidate.active || includeCleared)
      );
      assert.ok(record, `Expected a ${delay} ms timer`);
      record.active = false;
      record.callback();
      return record;
    },
    get activeCount() {
      return records.filter((record) => record.active).length;
    },
  };
}

function createTrackedAbortSignal() {
  const target = new EventTarget();
  const signal = {
    aborted: false,
    reason: undefined,
    added: 0,
    removed: 0,
    addEventListener(eventName, listener, options) {
      signal.added += 1;
      target.addEventListener(eventName, listener, options);
    },
    removeEventListener(eventName, listener) {
      signal.removed += 1;
      target.removeEventListener(eventName, listener);
    },
  };
  return {
    signal,
    abort(reason) {
      if (signal.aborted) return;
      signal.aborted = true;
      signal.reason = reason;
      target.dispatchEvent(new Event("abort"));
    },
  };
}

test("downloads a complete 2xx response through injected dependencies", async () => {
  const harness = createHarness([
    {
      statusCode: 200,
      headers: { "content-length": "5" },
      chunks: [Buffer.from("abc"), Buffer.from("de")],
    },
  ]);

  const result = await downloadHttpsFile(
    "https://downloads.example/python.exe",
    "C:/temp/python.exe",
    harness.options
  );

  assert.deepEqual(result, {
    bytes: 5,
    url: "https://downloads.example/python.exe",
  });
  assert.deepEqual(harness.fakeHttps.calls, ["https://downloads.example/python.exe"]);
  assert.deepEqual(harness.byteLengths, [3, 2]);
  assert.deepEqual(harness.diskChecks, [
    {
      filePath: "C:/temp/python.exe",
      payload: { requiredBytes: 5, operation: "下载 Python 安装包" },
    },
  ]);
  assert.equal(harness.fakeFs.files[0].contents.toString(), "abcde");
  assert.equal(harness.fakeFs.files[0].closeCalls, 1);
  assert.deepEqual(harness.fakeFs.unlinked, []);
});

test("follows HTTPS redirects and reports the final URL", async () => {
  const harness = createHarness([
    { statusCode: 302, headers: { location: "/python.exe" } },
    { statusCode: 200, headers: { "content-length": "2" }, chunks: ["ok"] },
  ]);

  const result = await downloadHttpsFile(
    "https://redirect.example/start",
    "C:/temp/python.exe",
    harness.options
  );

  assert.deepEqual(harness.fakeHttps.calls, [
    "https://redirect.example/start",
    "https://redirect.example/python.exe",
  ]);
  assert.equal(result.url, "https://redirect.example/python.exe");
  assert.equal(result.bytes, 2);
});

test("a late error from an old redirect response is consumed without replacing success", async () => {
  const fakeFs = createFakeFs();
  const calls = [];
  const responses = [];
  let resolveInspection;
  let rejectInspection;
  const inspection = new Promise((resolve, reject) => {
    resolveInspection = resolve;
    rejectInspection = reject;
  });

  const httpsImpl = {
    get(url, onResponse) {
      const request = new EventEmitter();
      request.destroy = () => {};
      calls.push(url);

      if (calls.length === 1) {
        queueMicrotask(() => {
          const response = new PassThrough();
          response.statusCode = 302;
          response.headers = { location: "/final" };
          responses.push(response);
          try {
            onResponse(response);
            assert.equal(calls.length, 2, "the next redirect request must already be active");
            assert.ok(
              response.listenerCount("error") > 0,
              "the response error listener must be attached before status handling"
            );
            response.emit("error", new Error("late error from redirected response"));
            response.end();
            resolveInspection();
          } catch (error) {
            rejectInspection(error);
          }
        });
      } else {
        queueMicrotask(() => {
          const response = new PassThrough();
          response.statusCode = 200;
          response.headers = { "content-length": "2" };
          responses.push(response);
          onResponse(response);
          response.end("ok");
        });
      }
      return request;
    },
  };

  const download = downloadHttpsFile(
    "https://redirect.example/start",
    "C:/temp/python.exe",
    {
      fsImpl: fakeFs.impl,
      httpsImpl,
      ensureDiskSpace: () => {},
      getByteLength: (chunk) => Buffer.byteLength(chunk),
    }
  );
  const [result] = await Promise.all([download, inspection]);

  assert.deepEqual(calls, [
    "https://redirect.example/start",
    "https://redirect.example/final",
  ]);
  assert.equal(result.bytes, 2);
  assert.equal(result.url, "https://redirect.example/final");
  assert.equal(responses[0].listenerCount("error"), 0);
  assert.deepEqual(fakeFs.unlinked, []);
});

test("rejects non-HTTPS input and redirects", async (t) => {
  await t.test("initial URL", async () => {
    const harness = createHarness([]);
    await assert.rejects(
      downloadHttpsFile("http://downloads.example/python.exe", "C:/temp/python.exe", harness.options),
      /non-HTTPS URL/u
    );
    assert.deepEqual(harness.fakeHttps.calls, []);
    assert.deepEqual(harness.fakeFs.unlinked, ["C:/temp/python.exe"]);
  });

  await t.test("redirect", async () => {
    const harness = createHarness([
      { statusCode: 302, headers: { location: "http://downloads.example/python.exe" } },
    ]);
    await assert.rejects(
      downloadHttpsFile("https://redirect.example/start", "C:/temp/python.exe", harness.options),
      /non-HTTPS redirect/u
    );
    assert.deepEqual(harness.fakeHttps.calls, ["https://redirect.example/start"]);
    assert.deepEqual(harness.fakeFs.unlinked, ["C:/temp/python.exe"]);
  });
});

test("enforces the redirect limit", async () => {
  const harness = createHarness(
    [{ statusCode: 302, headers: { location: "https://redirect.example/again" } }],
    { downloadOptions: { maxRedirects: 0 } }
  );

  await assert.rejects(
    downloadHttpsFile("https://redirect.example/start", "C:/temp/python.exe", harness.options),
    /redirect limit/u
  );
  assert.deepEqual(harness.fakeHttps.calls, ["https://redirect.example/start"]);
  assert.deepEqual(harness.fakeFs.unlinked, ["C:/temp/python.exe"]);
});

test("normalizes malformed redirect errors and removes the destination", async () => {
  const harness = createHarness([
    { statusCode: 302, headers: { location: "https://[invalid" } },
  ]);

  await assert.rejects(
    downloadHttpsFile("https://redirect.example/start", "C:/temp/python.exe", harness.options),
    /invalid redirect/u
  );
  assert.deepEqual(harness.fakeFs.unlinked, ["C:/temp/python.exe"]);
});

test("rejects non-2xx responses and removes the destination", async () => {
  const harness = createHarness([{ statusCode: 503 }]);

  await assert.rejects(
    downloadHttpsFile("https://downloads.example/python.exe", "C:/temp/python.exe", harness.options),
    /HTTP 503/u
  );
  assert.deepEqual(harness.fakeFs.files, []);
  assert.deepEqual(harness.fakeFs.unlinked, ["C:/temp/python.exe"]);
});

test("rejects incomplete and empty responses", async (t) => {
  await t.test("content length mismatch", async () => {
    const harness = createHarness([
      { statusCode: 200, headers: { "content-length": "5" }, chunks: ["abc"] },
    ]);
    await assert.rejects(
      downloadHttpsFile("https://downloads.example/python.exe", "C:/temp/python.exe", harness.options),
      /incomplete \(3\/5 bytes\)/u
    );
    assert.ok(harness.fakeFs.files[0].destroyCalls >= 1);
    assert.deepEqual(harness.fakeFs.unlinked, ["C:/temp/python.exe"]);
  });

  await t.test("empty response without content length", async () => {
    const harness = createHarness([{ statusCode: 200 }]);
    await assert.rejects(
      downloadHttpsFile("https://downloads.example/python.exe", "C:/temp/python.exe", harness.options),
      /incomplete \(0\/unknown bytes\)/u
    );
    assert.ok(harness.fakeFs.files[0].destroyCalls >= 1);
    assert.deepEqual(harness.fakeFs.unlinked, ["C:/temp/python.exe"]);
  });
});

test("request and response errors remove partial output", async (t) => {
  await t.test("request error", async () => {
    const harness = createHarness([{ requestError: new Error("network unavailable") }]);
    await assert.rejects(
      downloadHttpsFile("https://downloads.example/python.exe", "C:/temp/python.exe", harness.options),
      /network unavailable/u
    );
    assert.deepEqual(harness.fakeFs.files, []);
    assert.deepEqual(harness.fakeFs.unlinked, ["C:/temp/python.exe"]);
  });

  await t.test("response error", async () => {
    const harness = createHarness([{ responseError: new Error("connection reset") }]);
    await assert.rejects(
      downloadHttpsFile("https://downloads.example/python.exe", "C:/temp/python.exe", harness.options),
      /connection reset/u
    );
    assert.ok(harness.fakeFs.files[0].destroyCalls >= 1);
    assert.deepEqual(harness.fakeFs.unlinked, ["C:/temp/python.exe"]);
  });
});

test("write errors remove the partial file and settle once", async () => {
  const harness = createHarness(
    [{ statusCode: 200, headers: { "content-length": "3" }, chunks: ["abc"] }],
    { fileOptions: { writeError: new Error("disk write failed") } }
  );

  await assert.rejects(
    downloadHttpsFile("https://downloads.example/python.exe", "C:/temp/python.exe", harness.options),
    /disk write failed/u
  );
  assert.ok(harness.fakeFs.files[0].destroyCalls >= 1);
  assert.deepEqual(harness.fakeFs.unlinked, ["C:/temp/python.exe"]);
});

test("disk-space validation failures stop the response before opening a file", async () => {
  const diskError = new Error("insufficient disk space");
  const harness = createHarness(
    [{ statusCode: 200, headers: { "content-length": "3" }, chunks: ["abc"] }],
    {
      ensureDiskSpace() {
        throw diskError;
      },
    }
  );

  await assert.rejects(
    downloadHttpsFile("https://downloads.example/python.exe", "C:/temp/python.exe", harness.options),
    /insufficient disk space/u
  );
  assert.deepEqual(harness.fakeFs.files, []);
  assert.ok(harness.fakeHttps.responses[0].destroyCalls >= 1);
  assert.deepEqual(harness.fakeFs.unlinked, ["C:/temp/python.exe"]);
});

test("one total deadline covers every redirect and cleans all requests", async () => {
  const timers = createFakeTimers();
  const harness = createHarness(
    [
      { statusCode: 302, headers: { location: "/second" } },
      { noResponse: true },
    ],
    {
      downloadOptions: {
        totalTimeoutMs: 100,
        requestIdleTimeoutMs: 0,
        setTimeoutImpl: timers.setTimeoutImpl,
        clearTimeoutImpl: timers.clearTimeoutImpl,
      },
    }
  );

  const promise = downloadHttpsFile(
    "https://redirect.example/start",
    "C:/temp/python.exe",
    harness.options
  );
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(harness.fakeHttps.calls, [
    "https://redirect.example/start",
    "https://redirect.example/second",
  ]);
  assert.equal(timers.records.filter((record) => record.delay === 100).length, 1);
  timers.fireByDelay(100);

  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "ETIMEDOUT");
    assert.equal(error.timedOut, true);
    assert.equal(error.timeoutKind, "total");
    assert.match(error.message, /timed out after 100 ms/u);
    return true;
  });
  assert.equal(timers.activeCount, 0);
  assert.deepEqual(harness.fakeFs.unlinked, ["C:/temp/python.exe"]);
  assert.ok(harness.fakeHttps.requests.every((request) => request.destroyCalls >= 1));
  assert.ok(harness.fakeHttps.requests.every((request) => request.listenerCount("error") === 0));
});

test("request idle timeout rejects a half-open connection", async () => {
  const timers = createFakeTimers();
  const harness = createHarness([{ noResponse: true }], {
    downloadOptions: {
      totalTimeoutMs: 0,
      requestIdleTimeoutMs: 25,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    },
  });

  const promise = downloadHttpsFile(
    "https://downloads.example/python.exe",
    "C:/temp/python.exe",
    harness.options
  );
  timers.fireByDelay(25);

  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "ETIMEDOUT");
    assert.equal(error.timedOut, true);
    assert.equal(error.timeoutKind, "idle");
    assert.match(error.message, /idle for more than 25 ms/u);
    return true;
  });
  assert.equal(timers.activeCount, 0);
  assert.equal(harness.fakeHttps.requests[0].destroyCalls, 1);
  assert.equal(harness.fakeHttps.requests[0].listenerCount("error"), 0);
  assert.deepEqual(harness.fakeFs.unlinked, ["C:/temp/python.exe"]);
});

test("stale idle callbacks cannot time out a request after new activity", async () => {
  const timers = createFakeTimers();
  const harness = createHarness([{ statusCode: 200, hang: true }], {
    downloadOptions: {
      totalTimeoutMs: 0,
      requestIdleTimeoutMs: 25,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    },
  });

  const promise = downloadHttpsFile(
    "https://downloads.example/python.exe",
    "C:/temp/python.exe",
    harness.options
  );
  await Promise.resolve();
  harness.fakeHttps.responses[0].emit("data", Buffer.from("a"));

  for (const record of timers.records.filter((candidate) => candidate.cleared)) {
    record.callback();
  }
  assert.deepEqual(harness.fakeFs.unlinked, []);
  assert.equal(timers.activeCount, 1);

  timers.fireByDelay(25);
  await assert.rejects(promise, (error) => error.timeoutKind === "idle");
  assert.deepEqual(harness.fakeFs.unlinked, ["C:/temp/python.exe"]);
});

test("AbortSignal cancels active work once and clears pending timers", async () => {
  const timers = createFakeTimers();
  const controller = createTrackedAbortSignal();
  const harness = createHarness([{ noResponse: true }], {
    downloadOptions: {
      signal: controller.signal,
      totalTimeoutMs: 100,
      requestIdleTimeoutMs: 25,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    },
  });

  const promise = downloadHttpsFile(
    "https://downloads.example/python.exe",
    "C:/temp/python.exe",
    harness.options
  );
  controller.abort("user cancelled");

  await assert.rejects(promise, (error) => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.code, "ABORT_ERR");
    assert.equal(error.reason, "user cancelled");
    return true;
  });
  assert.equal(controller.signal.added, 1);
  assert.equal(controller.signal.removed, 1);
  assert.equal(timers.activeCount, 0);
  assert.equal(harness.fakeHttps.requests[0].listenerCount("error"), 0);
  assert.deepEqual(harness.fakeFs.unlinked, ["C:/temp/python.exe"]);

  for (const record of timers.records) record.callback();
  assert.deepEqual(harness.fakeFs.unlinked, ["C:/temp/python.exe"]);
});

test("an already-aborted signal prevents requests and timers", async () => {
  const timers = createFakeTimers();
  const controller = new AbortController();
  controller.abort("cancelled before download");
  const harness = createHarness([], {
    downloadOptions: {
      signal: controller.signal,
      totalTimeoutMs: 100,
      requestIdleTimeoutMs: 25,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    },
  });

  await assert.rejects(
    downloadHttpsFile(
      "https://downloads.example/python.exe",
      "C:/temp/python.exe",
      harness.options
    ),
    (error) => error.name === "AbortError" && error.code === "ABORT_ERR"
  );
  assert.deepEqual(harness.fakeHttps.calls, []);
  assert.deepEqual(timers.records, []);
  assert.deepEqual(harness.fakeFs.unlinked, ["C:/temp/python.exe"]);
});

test("successful settlement clears timers and registered listeners", async () => {
  const timers = createFakeTimers();
  const controller = createTrackedAbortSignal();
  const harness = createHarness(
    [{ statusCode: 200, headers: { "content-length": "2" }, chunks: ["ok"] }],
    {
      downloadOptions: {
        signal: controller.signal,
        totalTimeoutMs: 100,
        requestIdleTimeoutMs: 25,
        setTimeoutImpl: timers.setTimeoutImpl,
        clearTimeoutImpl: timers.clearTimeoutImpl,
      },
    }
  );

  const result = await downloadHttpsFile(
    "https://downloads.example/python.exe",
    "C:/temp/python.exe",
    harness.options
  );

  assert.equal(result.bytes, 2);
  assert.equal(timers.activeCount, 0);
  assert.equal(controller.signal.added, 1);
  assert.equal(controller.signal.removed, 1);
  assert.equal(harness.fakeHttps.requests[0].listenerCount("error"), 0);
  assert.equal(harness.fakeHttps.responses[0].listenerCount("data"), 0);
  assert.equal(harness.fakeHttps.responses[0].listenerCount("error"), 0);
  assert.equal(harness.fakeFs.files[0].listenerCount("error"), 0);
  assert.deepEqual(harness.fakeFs.unlinked, []);
});
