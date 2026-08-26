import assert from "node:assert/strict";
import test from "node:test";

import {
  getNextMaskHistoryIndex,
  getPreviousMaskHistoryIndex,
} from "../src/utils/maskHistory.js";

test("mask history walks backward and forward without discarding redo entries", () => {
  const operations = [0, 2, 5];
  assert.equal(getPreviousMaskHistoryIndex(operations, 5), 2);
  assert.equal(getPreviousMaskHistoryIndex(operations, 2), 0);
  assert.equal(getPreviousMaskHistoryIndex(operations, 0), -1);
  assert.equal(getNextMaskHistoryIndex(operations, 0), 2);
  assert.equal(getNextMaskHistoryIndex(operations, 2), 5);
  assert.equal(getNextMaskHistoryIndex(operations, 5), -1);
});

test("mask history normalizes duplicate and unsorted operation indices", () => {
  assert.equal(getPreviousMaskHistoryIndex([5, 0, 2, 2], 5), 2);
  assert.equal(getNextMaskHistoryIndex([5, 0, 2, 2], 0), 2);
});
