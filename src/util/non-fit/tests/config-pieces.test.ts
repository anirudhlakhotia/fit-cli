/**
 * Unit tests for mergeConfigPieces.
 *
 * Run on their own:
 *   node --import tsx --test src/util/non-fit/tests/config-pieces.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeConfigPieces, REMOVE, type ConfigPiece } from "../config-pieces.js";

function piece(label: string, data: ConfigPiece["data"]): ConfigPiece {
  return { label, data };
}

test("a single piece passes straight through", () => {
  const result = mergeConfigPieces([piece("base", { a: 1, b: "x" })]);
  assert.deepEqual(result, { a: 1, b: "x" });
});

test("later pieces overwrite earlier scalar fields", () => {
  const result = mergeConfigPieces([
    piece("base", { a: 1, b: 2 }),
    piece("override", { b: 3 }),
  ]);
  assert.deepEqual(result, { a: 1, b: 3 });
});

test("objects are deep-merged, not replaced", () => {
  const result = mergeConfigPieces([
    piece("base", { nested: { keep: 1, change: 2 } }),
    piece("override", { nested: { change: 3, added: 4 } }),
  ]);
  assert.deepEqual(result, { nested: { keep: 1, change: 3, added: 4 } });
});

test("REMOVE deletes a key set by an earlier piece", () => {
  const result = mergeConfigPieces([
    piece("base", { excludeTests: ["situational"], keep: true }),
    piece("override", { excludeTests: REMOVE }),
  ]);
  assert.deepEqual(result, { keep: true });
});

test("REMOVE works on nested keys", () => {
  const result = mergeConfigPieces([
    piece("base", { nested: { drop: 1, keep: 2 } }),
    piece("override", { nested: { drop: REMOVE } }),
  ]);
  assert.deepEqual(result, { nested: { keep: 2 } });
});

test("arrays overwrite wholesale rather than concatenating", () => {
  const result = mergeConfigPieces([
    piece("base", { excludeTests: ["situational", "ssh"] }),
    piece("override", { excludeTests: ["openshift", "capella"] }),
  ]);
  assert.deepEqual(result, { excludeTests: ["openshift", "capella"] });
});

test("first-seen key order is preserved", () => {
  const result = mergeConfigPieces([
    piece("base", { "//": "marker", clusterAccess: {}, performerPorts: [8060] }),
    piece("override", { excludeTests: [], clusterAccess: { tls: null } }),
  ]);
  assert.deepEqual(Object.keys(result), ["//", "clusterAccess", "performerPorts", "excludeTests"]);
});

test("the merged result does not alias the input pieces", () => {
  const base = piece("base", { nested: { value: 1 } });
  const result = mergeConfigPieces([base]) as { nested: { value: number } };
  result.nested.value = 99;
  assert.deepEqual(base.data, { nested: { value: 1 } });
});
