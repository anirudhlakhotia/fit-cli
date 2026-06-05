/**
 * Unit tests for parsing the run-definition step CSV.
 *
 * Run on their own:
 *   npm test
 *   node --import tsx --test src/workflows/fit-functional/definition/tests/steps.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSteps } from "../steps.js";

test("an empty or undefined CSV runs every step in order", () => {
  const all = ["setup-cluster", "setup-performer", "run"];
  assert.deepEqual(parseSteps(), all);
  assert.deepEqual(parseSteps(""), all);
  assert.deepEqual(parseSteps("   "), all);
});

test("the setup alias expands to the two setup steps", () => {
  assert.deepEqual(parseSteps("setup"), ["setup-cluster", "setup-performer"]);
});

test("setup,run expands and stays in canonical order", () => {
  assert.deepEqual(parseSteps("setup,run"), ["setup-cluster", "setup-performer", "run"]);
});

test("individual steps are returned in canonical order regardless of input order", () => {
  assert.deepEqual(parseSteps("run,setup-performer"), ["setup-performer", "run"]);
});

test("duplicates are removed", () => {
  assert.deepEqual(parseSteps("run,run,setup-performer,setup-performer"), ["setup-performer", "run"]);
});

test("whitespace around tokens is ignored", () => {
  assert.deepEqual(parseSteps(" setup-performer , run "), ["setup-performer", "run"]);
});

test("an unknown step throws and lists the valid ones", () => {
  assert.throws(() => parseSteps("teardown"), /Unknown step "teardown".*Valid steps:/s);
});
