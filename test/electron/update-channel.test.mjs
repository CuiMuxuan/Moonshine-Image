import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAppUpdateFeedUrl,
  normalizeAppUpdateBaseUrl,
  normalizeAppUpdateChannel,
} from "../../src-electron/updater/update-channel.js";

test("app update channels are limited to test, beta, and stable", () => {
  assert.equal(normalizeAppUpdateChannel(), "stable");
  assert.equal(normalizeAppUpdateChannel(" BETA "), "beta");
  assert.throws(() => normalizeAppUpdateChannel("nightly"), /Unsupported app update channel/);
});

test("app update feed URLs preserve the channel below a credential-free base URL", () => {
  assert.equal(
    buildAppUpdateFeedUrl("beta", { baseUrl: "https://download.example/app/win-x64/" }),
    "https://download.example/app/win-x64/beta/",
  );
  assert.equal(
    normalizeAppUpdateBaseUrl("https://download.example/app/win-x64///"),
    "https://download.example/app/win-x64",
  );
  assert.throws(
    () => buildAppUpdateFeedUrl("stable", { baseUrl: "https://token@example.com/app" }),
    /credential-free/,
  );
});
