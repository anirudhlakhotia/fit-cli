/**
 * Unit tests for buildClusterDef.
 *
 * Run on their own:
 *   npm test
 *   node --import tsx --test src/workflows/cluster-create/tests/build-cluster-def.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAO_GATEWAY_VERSION,
  CAO_OPERATOR_VERSION,
  buildClusterDef,
} from "../build-cluster-def.js";

test("a basic single-node def renders the nodes block", () => {
  const def = buildClusterDef({
    nodeCount: 1,
    version: "8.1.0",
    services: ["kv", "n1ql", "index", "fts"],
    cng: false,
  });
  assert.equal(
    def,
    "nodes:\n  - count: 1\n    version: '8.1.0'\n    services: [kv, n1ql, index, fts]\n",
  );
});

test("the node count and version are passed through", () => {
  const def = buildClusterDef({
    nodeCount: 3,
    version: "7.6.2-3505",
    services: ["kv"],
    cng: false,
  });
  assert.match(def, /- count: 3/);
  assert.match(def, /version: '7.6.2-3505'/);
});

test("CNG support adds the cao block with the operator and gateway versions", () => {
  const def = buildClusterDef({
    nodeCount: 1,
    version: "8.1.0",
    services: ["kv"],
    cng: true,
  });
  assert.match(def, /cao:/);
  assert.match(def, new RegExp(`operator-version: "${CAO_OPERATOR_VERSION}"`));
  assert.match(def, new RegExp(`gateway-version: "${CAO_GATEWAY_VERSION}"`));
});

test("without CNG there is no cao block", () => {
  const def = buildClusterDef({
    nodeCount: 1,
    version: "8.1.0",
    services: ["kv"],
    cng: false,
  });
  assert.doesNotMatch(def, /cao:/);
});

test("the def always ends with a trailing newline", () => {
  const def = buildClusterDef({ nodeCount: 1, version: "8.1.0", services: ["kv"], cng: false });
  assert.ok(def.endsWith("\n"));
});
