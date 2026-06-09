/**
 * Unit tests for the pure pieces of the FIT definition builder.
 *
 * Run on their own:
 *   npm test
 *   node --import tsx --test src/workflows/fit-shared/create-definition/tests/create-definition.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { functionalCycleConnectivity } from "../create-definition.js";
import type { FunctionalCycle } from "../../definition/types.js";

const NODES = [{ count: 1, version: "8.1.0-2188", services: ["kv"] }];

test("a cbdinocluster cycle with a cao block is CNG", () => {
  const cycle: FunctionalCycle = {
    type: "functional",
    cluster: {
      cbdinocluster: {
        config: { nodes: NODES, cao: { "operator-version": "2.8.0", "gateway-version": "1.1.0-135" } },
      },
    },
    iterations: [],
  };
  assert.equal(functionalCycleConnectivity(cycle), "cng");
});

test("a cbdinocluster cycle without a cao block is operational", () => {
  const cycle: FunctionalCycle = {
    type: "functional",
    cluster: { cbdinocluster: { config: { nodes: NODES } } },
    iterations: [],
  };
  assert.equal(functionalCycleConnectivity(cycle), "operational");
});

test("a useExisting cycle is operational", () => {
  const cycle: FunctionalCycle = {
    type: "functional",
    cluster: { useExisting: {} },
    iterations: [],
  };
  assert.equal(functionalCycleConnectivity(cycle), "operational");
});
