/**
 * Unit tests for the pure bits of manage-instances (the menu line builder).
 * The interactive loop itself is exercised by hand / via replay.
 *
 * Run on their own:
 *   node --import tsx --test src/util/non-fit/aws/tests/manage-instances.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeInstanceLine } from "../manage-instances.js";

test("describeInstanceLine includes id and state, dropping absent fields", () => {
  assert.equal(describeInstanceLine({ instanceId: "i-aaa", state: "running" }), "i-aaa  ·  running");
});

test("describeInstanceLine appends name, type and public IP when present", () => {
  assert.equal(
    describeInstanceLine({
      instanceId: "i-bbb",
      state: "running",
      name: "fit-runner",
      instanceType: "t3.medium",
      publicIp: "1.2.3.4",
    }),
    "i-bbb  ·  running  ·  fit-runner  ·  t3.medium  ·  1.2.3.4",
  );
});
