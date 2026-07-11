import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { StartupProcessError } from "../../src-electron/startup-diagnostics.js";
import { runStartupProcess } from "../../src-electron/startup-process.js";

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killedWith = [];
  child.kill = (signal) => {
    child.killedWith.push(signal);
    return true;
  };
  return child;
}

test("successful execution captures output and streams callbacks", async () => {
  const child = createFakeChild();
  const stdoutEvents = [];
  const stderrEvents = [];
  let observedOptions;
  const resultPromise = runStartupProcess("python", ["--version"], {
    cwd: "C:/project",
    env: { PATH: "test-path" },
    spawnImpl: (_command, _args, options) => {
      observedOptions = options;
      queueMicrotask(() => {
        child.stdout.write(Buffer.from("Python "));
        child.stdout.write(Buffer.from("3.12.1\n"));
        child.stderr.write("warning\n");
        child.emit("close", 0, null);
      });
      return child;
    },
    onStdout: (text, metadata) => stdoutEvents.push([text, metadata.stream]),
    onStderr: (text, metadata) => stderrEvents.push([text, metadata.stream]),
  });

  const result = await resultPromise;
  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "Python 3.12.1\n");
  assert.equal(result.stderr, "warning\n");
  assert.equal(result.stdoutTail, result.stdout);
  assert.equal(result.stderrTail, result.stderr);
  assert.equal(observedOptions.cwd, "C:/project");
  assert.deepEqual(observedOptions.stdio, ["ignore", "pipe", "pipe"]);
  assert.deepEqual(stdoutEvents, [
    ["Python ", "stdout"],
    ["3.12.1\n", "stdout"],
  ]);
  assert.deepEqual(stderrEvents, [["warning\n", "stderr"]]);
});

test("successful execution retains at most the last 4 MiB per output stream", async () => {
  const child = createFakeChild();
  const captureLimit = 4 * 1024 * 1024;
  const discardedPrefix = "discarded-prefix";
  const retainedTail = `tail-${"x".repeat(captureLimit - 5)}`;
  const resultPromise = runStartupProcess("command", [], {
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stdout.write(`${discardedPrefix}${retainedTail}`);
        child.stderr.write(`${discardedPrefix}${retainedTail}`);
        child.emit("close", 0, null);
      });
      return child;
    },
  });

  const result = await resultPromise;
  assert.equal(Buffer.byteLength(result.stdout, "utf8"), captureLimit);
  assert.equal(Buffer.byteLength(result.stderr, "utf8"), captureLimit);
  assert.equal(result.stdout, retainedTail);
  assert.equal(result.stderr, retainedTail);
  assert.doesNotMatch(result.stdout, /discarded-prefix/u);
  assert.doesNotMatch(result.stderr, /discarded-prefix/u);
});

for (const osCode of ["ENOENT", "EACCES"]) {
  test(`spawn ${osCode} is diagnosed once even when close follows error`, async () => {
    const child = createFakeChild();
    let nowCalls = 0;
    const now = () => {
      nowCalls += 1;
      return nowCalls === 1 ? 100 : 125;
    };
    const promise = runStartupProcess("missing-command", [], {
      spawnImpl: () => {
        queueMicrotask(() => {
          child.emit(
            "error",
            Object.assign(new Error(`${osCode} while spawning`), { code: osCode })
          );
          child.emit("close", 1, null);
        });
        return child;
      },
      now,
      stage: "runtime-prepare",
    });

    await assert.rejects(promise, (error) => {
      assert.ok(error instanceof StartupProcessError);
      assert.equal(error.code, "PROCESS_SPAWN_FAILED");
      assert.equal(error.diagnostic.osCode, osCode);
      assert.equal(error.diagnostic.exitCode, null);
      assert.equal(error.diagnostic.stage, "runtime-prepare");
      assert.equal(error.diagnostic.durationMs, 25);
      return true;
    });
    assert.equal(nowCalls, 2);
  });
}

test("a synchronous spawn exception is normalized", async () => {
  const cause = Object.assign(new Error("blocked by policy"), { code: "EPERM" });
  await assert.rejects(
    runStartupProcess("installer", [], {
      spawnImpl: () => {
        throw cause;
      },
      failureCode: "PYTHON_INSTALLER_FAILED",
      userMessage: "Python 安装程序无法启动。",
    }),
    (error) => {
      assert.ok(error instanceof StartupProcessError);
      assert.equal(error.code, "PYTHON_INSTALLER_FAILED");
      assert.equal(error.diagnostic.osCode, "EPERM");
      assert.equal(error.userMessage, "Python 安装程序无法启动。");
      return true;
    }
  );
});

test("non-zero exit preserves metadata and caps diagnostic output tails", async () => {
  const child = createFakeChild();
  const stderr = `discard-${"错".repeat(20_000)}`;
  const promise = runStartupProcess("conda-unpack", ["--token", "hidden"], {
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stdout.write("some output");
        child.stderr.write(stderr);
        child.emit("close", 9, "SIGTERM");
      });
      return child;
    },
    failureCode: "BUNDLED_RUNTIME_RELOCATION_FAILED",
    stage: "runtime-relocation",
    recoveryHint: "请重新解压完整安装包。",
  });

  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof StartupProcessError);
    assert.equal(error.code, "BUNDLED_RUNTIME_RELOCATION_FAILED");
    assert.equal(error.diagnostic.exitCode, 9);
    assert.equal(error.diagnostic.signal, "SIGTERM");
    assert.equal(error.diagnostic.timedOut, false);
    assert.ok(Buffer.byteLength(error.diagnostic.stderrTail, "utf8") <= 32 * 1024);
    assert.ok(error.diagnostic.stderrTail.endsWith("错".repeat(100)));
    assert.doesNotMatch(error.diagnostic.commandLine, /hidden/u);

    const failure = error.toFailure();
    assert.equal(failure.success, false);
    assert.equal(failure.code, error.code);
    assert.equal(failure.recoveryHint, "请重新解压完整安装包。");
    return true;
  });
});

test("timeout terminates the child and records timeout diagnostics", async () => {
  const child = createFakeChild();
  const promise = runStartupProcess("slow-command", [], {
    spawnImpl: () => child,
    timeoutMs: 10,
    killSignal: "SIGKILL",
    timeoutCode: "BACKEND_START_TIMEOUT",
  });

  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof StartupProcessError);
    assert.equal(error.code, "BACKEND_START_TIMEOUT");
    assert.equal(error.diagnostic.timedOut, true);
    assert.equal(error.diagnostic.exitCode, null);
    assert.match(error.diagnostic.reason, /timed out after 10 ms/u);
    return true;
  });
  assert.deepEqual(child.killedWith, ["SIGKILL"]);

  child.emit("close", null, "SIGKILL");
});

test("timeout uses the injected process-tree terminator and preserves its failure", async () => {
  const child = createFakeChild();
  const terminationDiagnostic = {
    id: "taskkill-failure",
    code: "PROCESS_TREE_TERMINATION_FAILED",
    commandLine: "taskkill /pid 42 /t /f",
    exitCode: 1,
    stderrTail: "process not found",
  };
  const promise = runStartupProcess("slow-command", [], {
    spawnImpl: () => child,
    timeoutMs: 5,
    terminateProcess: async () => {
      const error = new Error("taskkill failed");
      error.diagnostic = terminationDiagnostic;
      throw error;
    },
  });

  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "PROCESS_TIMEOUT");
    assert.deepEqual(error.diagnostic.attempts, [terminationDiagnostic]);
    return true;
  });
  assert.deepEqual(child.killedWith, []);
});

test("a close racing an asynchronous terminator cannot discard its failure", async () => {
  const child = createFakeChild();
  const terminationDiagnostic = {
    id: "late-taskkill-failure",
    code: "PROCESS_TREE_TERMINATION_FAILED",
    commandLine: "taskkill /pid 42 /t /f",
    exitCode: 1,
    stderrTail: "access denied",
  };
  const promise = runStartupProcess("slow-command", [], {
    spawnImpl: () => child,
    timeoutMs: 5,
    terminateProcess: async () => {
      child.emit("close", null, "SIGKILL");
      await Promise.resolve();
      const error = new Error("taskkill failed after close");
      error.diagnostic = terminationDiagnostic;
      throw error;
    },
  });

  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "PROCESS_TIMEOUT");
    assert.deepEqual(error.diagnostic.attempts, [terminationDiagnostic]);
    return true;
  });
});

test("a failed fallback kill is captured as a termination attempt", async () => {
  const child = createFakeChild();
  child.kill = () => {
    throw Object.assign(new Error("kill access denied"), { code: "EPERM" });
  };
  const callbackErrors = [];
  const promise = runStartupProcess("slow-command", [], {
    spawnImpl: () => child,
    timeoutMs: 5,
    onCallbackError: (error, metadata) => callbackErrors.push([error.message, metadata.operation]),
  });

  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "PROCESS_TIMEOUT");
    assert.deepEqual(error.diagnostic.attempts, [
      {
        stage: "process-termination",
        reason: "kill access denied",
        osCode: "EPERM",
      },
    ]);
    return true;
  });
  assert.deepEqual(callbackErrors, [["kill access denied", "terminate"]]);
});

test("an already-aborted signal prevents spawning", async () => {
  const controller = new AbortController();
  controller.abort("user requested stop");
  let spawnCalls = 0;

  await assert.rejects(
    runStartupProcess("python", [], {
      signal: controller.signal,
      spawnImpl: () => {
        spawnCalls += 1;
        return createFakeChild();
      },
    }),
    (error) => {
      assert.equal(error.code, "PROCESS_ABORTED");
      assert.equal(error.diagnostic.timedOut, false);
      assert.match(error.diagnostic.reason, /user requested stop/u);
      return true;
    }
  );
  assert.equal(spawnCalls, 0);
});

test("abort after spawning terminates the child", async () => {
  const controller = new AbortController();
  const child = createFakeChild();
  const promise = runStartupProcess("python", ["server.py"], {
    signal: controller.signal,
    spawnImpl: () => child,
    onSpawn: () => controller.abort("shutdown"),
  });

  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "PROCESS_ABORTED");
    assert.equal(error.diagnostic.timedOut, false);
    return true;
  });
  assert.deepEqual(child.killedWith, ["SIGTERM"]);
});

test("abort uses the injected process-tree terminator with cancellation metadata", async () => {
  const controller = new AbortController();
  const child = createFakeChild();
  const terminationCalls = [];
  const promise = runStartupProcess("python", ["server.py"], {
    signal: controller.signal,
    killSignal: "SIGKILL",
    spawnImpl: () => child,
    terminateProcess: async (...args) => terminationCalls.push(args),
    onSpawn: () => controller.abort("shutdown"),
  });

  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "PROCESS_ABORTED");
    assert.match(error.diagnostic.reason, /shutdown/u);
    return true;
  });
  assert.deepEqual(terminationCalls, [
    [child, { reason: "abort", killSignal: "SIGKILL" }],
  ]);
  assert.deepEqual(child.killedWith, []);
});

test("observer exceptions do not alter process completion", async () => {
  const child = createFakeChild();
  const callbackErrors = [];
  const promise = runStartupProcess("command", [], {
    spawnImpl: () => {
      queueMicrotask(() => {
        child.stdout.write("output");
        child.emit("close", 3010, null);
      });
      return child;
    },
    successExitCodes: 3010,
    onStdout: () => {
      throw new Error("observer failed");
    },
    onCallbackError: (error, metadata) => callbackErrors.push([error.message, metadata.stream]),
  });

  const result = await promise;
  assert.equal(result.exitCode, 3010);
  assert.deepEqual(callbackErrors, [["observer failed", "stdout"]]);
});
