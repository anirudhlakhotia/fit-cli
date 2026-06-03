/**
 * Unit tests for requiredReposForSdk.
 *
 * Run on their own:
 *   npm test
 *   node --import tsx --test src/steps/tests/ensure-sdk-workspace.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { JVM_CLIENTS } from "../../lib/repos.js";
import { sdkByValue } from "../../lib/sdks.js";
import { requiredReposForSdk } from "../ensure-sdk-workspace.js";

test("JVM SDKs require couchbase-jvm-clients", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.deepEqual(requiredReposForSdk(sdk), [JVM_CLIENTS]);
});

test("non-JVM SDKs need no extra workspace repos", () => {
  const sdk = sdkByValue("node");
  assert.ok(sdk);
  assert.deepEqual(requiredReposForSdk(sdk), []);
});
