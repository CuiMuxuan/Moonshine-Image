import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

const root = new URL("../", import.meta.url);
const motion = readFileSync(new URL("motion.js", root), "utf8");

test("documentation links and anchors resolve, without external font dependencies", () => {
  for (const name of ["index", "user", "developer", "mcp"]) {
    const file = new URL(`docs/${name}.html`, root);
    const html = readFileSync(file, "utf8");
    assert.doesNotMatch(html, /fonts\.googleapis/);
    assert.match(html, /lucide\.min\.js" defer/);
    assert.match(html, /docs\.js" defer/);
    assert.equal([...html.matchAll(/<h1[ >]/g)].length, 1);
    for (const [, href] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^https?:|^mailto:/.test(href)) continue;
      const target = new URL(href, file);
      if (target.pathname.endsWith("/")) target.pathname += "index.html";
      const pathname = fileURLToPath(target);
      assert.ok(existsSync(pathname), `${name}: ${href}`);
      if (target.hash)
        assert.ok(
          readFileSync(pathname, "utf8").includes(
            `id="${target.hash.slice(1)}"`,
          ),
          `${name}: ${href}`,
        );
    }
  }
});

function harness({ reduced = false, hash = "", supported = true } = {}) {
  const callbacks = {};
  const observed = new Set();
  const records = [];
  const preference = {
    matches: reduced,
    addEventListener: (name, fn) => {
      callbacks.preference = fn;
    },
  };
  const node = {
    getBoundingClientRect: () => ({ top: 1000 }),
    contains: () => false,
    matches: () => true,
    animate: (frames, options) => {
      const record = {
        frames,
        options,
        cancelled: false,
        finished: new Promise(() => {}),
        cancel() {
          this.cancelled = true;
        },
      };
      records.push(record);
      return record;
    },
  };
  node.parentElement = { children: [node] };
  class Observer {
    constructor(fn) {
      callbacks.intersect = fn;
    }
    observe(element) {
      observed.add(element);
    }
    unobserve(element) {
      observed.delete(element);
    }
    disconnect() {
      observed.clear();
    }
  }
  const window = {
    matchMedia: () => preference,
    location: { hash },
    innerHeight: 900,
    addEventListener: (name, fn) => {
      callbacks[name] = fn;
    },
  };
  if (supported) window.IntersectionObserver = Observer;
  const document = {
    documentElement: {},
    activeElement: null,
    querySelectorAll: () => [node],
    addEventListener: (name, fn) => {
      callbacks[name] = fn;
    },
  };
  vm.runInNewContext(motion, {
    window,
    document,
    Element: { prototype: { animate() {} } },
    IntersectionObserver: Observer,
    getComputedStyle: () => ({
      getPropertyValue: (name) =>
        name === "--motion-enter" ? "500" : "cubic-bezier(0.23, 1, 0.32, 1)",
    }),
  });
  return { callbacks, observed, records, node, preference };
}

test("motion is optional for reduced motion, deep links, and older browsers", () => {
  for (const options of [
    { reduced: true },
    { hash: "#features" },
    { supported: false },
  ]) {
    const state = harness(options);
    assert.equal(state.observed.size, 0);
    assert.equal(state.records.length, 0);
  }
});

test("scroll entrance uses only opacity and transform and unobserves the target", () => {
  const state = harness();
  assert.equal(state.records.length, 0);
  state.callbacks.intersect([{ target: state.node, isIntersecting: true }]);
  assert.equal(state.observed.size, 0);
  assert.equal(state.records[0].options.duration, 500);
  assert.deepEqual(Object.keys(state.records[0].frames[0]), [
    "opacity",
    "transform",
  ]);
});

test("keyboard, anchor and preference changes cancel motion immediately", () => {
  for (const action of ["keyboard", "hash", "preference"]) {
    const state = harness();
    state.callbacks.intersect([{ target: state.node, isIntersecting: true }]);
    if (action === "keyboard") state.callbacks.keydown({ key: "Tab" });
    if (action === "hash") state.callbacks.hashchange();
    if (action === "preference") {
      state.preference.matches = true;
      state.callbacks.preference();
    }
    assert.ok(state.records[0].cancelled);
    assert.equal(state.observed.size, 0);
  }
});
