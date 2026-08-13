import assert from "node:assert/strict";
import test from "node:test";

import {
  assertEditionChannel,
  resolveAppEdition,
} from "../../src-electron/updater/edition.js";

test("test prereleases use a separate product identity and test channel", () => {
  const identity = resolveAppEdition("1.3.3-test.1");
  assert.equal(identity.edition, "test");
  assert.equal(identity.channel, "test");
  assert.equal(identity.appId, "com.moonshine.image.test");
  assert.equal(identity.productName, "Moonshine-Image-Test");
  assert.equal(identity.userDataName, "Moonshine-Image-Test");
  assert.equal(identity.packageName, "moonshine-image-test");
  assert.equal(identity.artifactName, "Moonshine-Image-Test-Setup-${version}.${ext}");
});

test("official releases retain the stable identity", () => {
  const identity = resolveAppEdition("1.3.3");
  assert.equal(identity.edition, "official");
  assert.equal(identity.channel, "stable");
  assert.equal(identity.appId, "com.moonshine.image");
  assert.equal(identity.userDataName, "Moonshine-Image");
  assert.equal(identity.packageName, "moonshine-image");
});

test("edition channel assertions reject cross-channel releases", () => {
  assert.equal(assertEditionChannel("1.3.3-test.1", "test").edition, "test");
  assert.equal(assertEditionChannel("1.3.3", "stable").edition, "official");
  assert.throws(() => assertEditionChannel("1.3.3-test.1", "stable"), /locked to the test channel/);
  assert.throws(() => assertEditionChannel("1.3.3", "test"), /locked to the stable channel/);
  assert.throws(() => resolveAppEdition("1.3.3-beta.1"), /Unsupported application edition/);
});
