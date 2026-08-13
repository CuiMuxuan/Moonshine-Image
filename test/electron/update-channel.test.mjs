import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAppUpdateFeedUrl,
  normalizeAppUpdateBaseUrl,
  normalizeAppUpdateChannel,
} from "../../src-electron/updater/update-channel.js";

test("app update channels are limited to test and stable", () => {
  assert.equal(normalizeAppUpdateChannel(), "stable");
  assert.equal(normalizeAppUpdateChannel(" TEST "), "test");
  assert.throws(() => normalizeAppUpdateChannel("beta"), /Unsupported app update channel/);
  assert.throws(() => normalizeAppUpdateChannel("nightly"), /Unsupported app update channel/);
});

test("app update feed URLs preserve the channel below a credential-free base URL", () => {
  assert.equal(
    buildAppUpdateFeedUrl("test", { baseUrl: "https://download.example/app/win-x64/" }),
    "https://download.example/app/win-x64/test/",
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
