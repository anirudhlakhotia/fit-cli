/**
 * Unit tests for the pure freshness logic of the ensure-fit-grpc step.
 *
 * Run on their own:
 *   npm test
 *   node --import tsx --test src/workflows/fit-functional/steps/tests/ensure-fit-grpc.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isFreshlyBuilt } from "../ensure-fit-grpc.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-06-03T00:00:00Z");

test("a jar built just now is fresh", () => {
  assert.equal(isFreshlyBuilt(new Date(now), now), true);
});

test("a jar built a week ago is still fresh", () => {
  assert.equal(isFreshlyBuilt(new Date(now - 7 * DAY_MS), now), true);
});

test("a jar built exactly 30 days ago is on the boundary and still fresh", () => {
  assert.equal(isFreshlyBuilt(new Date(now - 30 * DAY_MS), now), true);
});

test("a jar built 31 days ago is stale", () => {
  assert.equal(isFreshlyBuilt(new Date(now - 31 * DAY_MS), now), false);
});

test("a jar with a future build time is treated as fresh", () => {
  assert.equal(isFreshlyBuilt(new Date(now + DAY_MS), now), true);
});
