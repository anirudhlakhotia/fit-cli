/**
 * Unit tests for requiredReposForSdk.
 *
 * Run on their own:
 *   bun test
 *   node --import tsx --test src/util/sdk/tests/ensure-sdk-workspace.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { sdkByValue } from "../sdks.js";
import { requiredReposForSdk } from "../ensure-sdk-workspace.js";

test("JVM SDKs need no extra workspace repos (they use prebuilt GHCR containers)", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.deepEqual(requiredReposForSdk(sdk), []);
});

test("non-JVM SDKs need no extra workspace repos", () => {
  const sdk = sdkByValue("node");
  assert.ok(sdk);
  assert.deepEqual(requiredReposForSdk(sdk), []);
});
