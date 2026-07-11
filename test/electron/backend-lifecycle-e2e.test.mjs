import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";

import { BackendProcessSupervisor } from "../../src-electron/backend-process-supervisor.js";

async function reservePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function probeHealth(port) {
  return await new Promise((resolve) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: `/api/v1/health?_=${Date.now()}`,
        headers: { "Cache-Control": "no-cache, no-store" },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(
              response.statusCode >= 200 &&
                response.statusCode < 300 &&
                JSON.parse(body).status === "ok"
            );
          } catch {
            resolve(false);
          }
        });
      }
    );
    request.setTimeout(250, () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

test("controlled backend process reaches health readiness and stops on real close", async () => {
  const port = await reservePort();
  const states = [];
  const childScript = `
    const http = require("node:http");
    const port = Number(process.argv[1]);
    setTimeout(() => {
      const server = http.createServer((request, response) => {
        if (request.url.startsWith("/api/v1/health")) {
          response.writeHead(200, {"Content-Type": "application/json", "Cache-Control": "no-store"});
          response.end(JSON.stringify({status: "ok"}));
          return;
        }
        response.writeHead(404);
        response.end();
      });
      server.listen(port, "127.0.0.1", () => process.stdout.write("ready\\n"));
    }, 100);
  `;
  const supervisor = new BackendProcessSupervisor({
    spawnImpl: spawn,
    probeReady: probeHealth,
    readinessTimeoutMs: 5000,
    pollIntervalMs: 50,
    onState: (payload) => states.push(payload.state),
  });

  try {
    const startResult = await supervisor.start({
      command: process.execPath,
      args: ["-e", childScript, String(port)],
      cwd: process.cwd(),
      port,
      requestedPort: port,
      spawnOptions: { windowsHide: true },
    });
    assert.equal(startResult.success, true);
    assert.equal(startResult.ready, true);
    assert.equal(supervisor.getStatus().running, true);

    const stopResult = await supervisor.stop();
    assert.equal(stopResult.success, true);
    assert.equal(supervisor.getStatus().state, "stopped");
    assert.deepEqual(states.slice(0, 2), ["starting", "running"]);
    assert.equal(states.at(-1), "stopped");
  } finally {
    await supervisor.stop();
  }
});
