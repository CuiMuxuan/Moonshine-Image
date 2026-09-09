import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const html = readFileSync(path.join(root, "index.html"), "utf8");
const script = readFileSync(path.join(root, "release.js"), "utf8");

test("homepage and getting-started guide use identical static download cards", () => {
  const guide = readFileSync(path.join(root, "docs/user.html"), "utf8");
  const cards = (source) =>
    [
      ...source.matchAll(/<article class="download-option[\s\S]*?<\/article>/g),
    ].map((match) => match[0].replace(/\s+/g, " ").replace(/\s+>/g, ">"));
  assert.equal(cards(html).length, 2);
  assert.deepEqual(cards(html), cards(guide));
  assert.doesNotMatch(guide, /入口 [AB]/);
  for (const source of [html, guide]) {
    assert.match(source, /href="(?:\.\.\/)?download\.css"/);
    assert.match(source, /src="(?:\.\.\/)?release\.js" defer/);
  }
});

test("shared release loader resolves metadata under root and project Pages paths", async () => {
  for (const base of [
    "https://example.com/",
    "https://example.com/Moonshine-Image/",
  ]) {
    let requested;
    const context = {
      URL,
      document: {
        currentScript: { src: `${base}release.js` },
        querySelectorAll: () => [],
      },
      fetch: async (url) => {
        requested = String(url);
        throw new Error("offline");
      },
    };
    await vm.runInNewContext(script, context);
    assert.equal(requested, `${base}release/latest.json`);
  }
});

// Isolate the unchanged release contract from browser-only UI initialization.
function releaseContext() {
  const context = vm.createContext({ URL });
  vm.runInContext(
    script.slice(
      script.indexOf("const FALLBACK_RELEASE"),
      script.indexOf("async function loadReleaseMetadata"),
    ),
    context,
  );
  return context;
}

test("all homepage anchors and local assets resolve within the static site", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "duplicate IDs");
  for (const [, target] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^https?:/.test(target)) continue;
    if (target.startsWith("#"))
      assert.ok(ids.includes(target.slice(1)), target);
    else assert.ok(existsSync(path.join(root, target)), target);
  }
});

test("brand, local processing conditions and model licenses remain explicit", () => {
  assert.match(html, /<h1>Moonshine-Image<\/h1>/);
  for (const term of [
    "CC BY-NC 4.0",
    "CUDA",
    "Python / Torch",
    "Moonshine-Output",
  ])
    assert.ok(html.includes(term), term);
  assert.match(
    readFileSync(path.join(root, "styles.css"), "utf8"),
    /--accent: #7758c4/,
  );
});

test("valid stable metadata populates its version and installer", () => {
  const ctx = releaseContext();
  ctx.metadata = JSON.parse(
    readFileSync(path.join(root, "release/latest.json"), "utf8"),
  );
  const release = vm.runInContext("readReleaseMetadata(metadata)", ctx);
  assert.equal(release.version, ctx.metadata.version);
  assert.equal(release.installerUrl, ctx.metadata.installerUrl);
});

test("all no-JavaScript download fallbacks match committed signed metadata", () => {
  const metadata = JSON.parse(
    readFileSync(path.join(root, "release/latest.json"), "utf8"),
  );
  const fallback = vm.runInContext("FALLBACK_RELEASE", releaseContext());
  assert.equal(fallback.version, metadata.version);
  assert.equal(fallback.installerUrl, metadata.installerUrl);
  for (const page of [
    html,
    readFileSync(path.join(root, "docs/user.html"), "utf8"),
  ]) {
    for (const [, version] of page.matchAll(/data-release-version>([^<]+)/g))
      assert.equal(version, metadata.version);
    for (const [, href] of page.matchAll(/href="([^"]+Setup-[^"]+\.exe)"/g))
      assert.equal(href, metadata.installerUrl);
  }
});

test("unsafe installers and malformed versions fail closed", () => {
  const ctx = releaseContext();
  for (const url of [
    "javascript:alert(1)",
    "https://example.com/setup.exe",
    "https://download.moonshine.email/app/win-x64/beta/Moonshine-Image-Setup-1.3.4.exe",
  ]) {
    ctx.metadata = { version: "1.3.4", installerUrl: url };
    assert.throws(() => vm.runInContext("readReleaseMetadata(metadata)", ctx));
  }
  ctx.metadata = {
    version: "latest",
    installerUrl:
      "https://download.moonshine.email/app/win-x64/stable/Moonshine-Image-Setup-1.3.4.exe",
  };
  assert.throws(() => vm.runInContext("readReleaseMetadata(metadata)", ctx));
});

test("metadata failure retains a real fallback and UI is not hidden behind animation", () => {
  assert.match(
    script,
    /applyReleaseMetadata\(FALLBACK_RELEASE, \{ fallback: true \}\)/,
  );
  assert.match(
    html,
    /data-download-link[\s\S]*?href="https:\/\/download\.moonshine\.email/,
  );
  assert.doesNotMatch(html, /class="[^"]*\breveal\b/);
  assert.match(html, /<details open>/);
  assert.match(html, /aria-controls="workspace-panel"/);
});
