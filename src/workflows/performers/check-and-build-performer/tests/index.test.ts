import assert from "node:assert/strict";
import { test } from "node:test";
import { sdkByValue } from "../../../../util/sdk/sdks.js";
import { performerBuildLogStem } from "../index.js";

test("performerBuildLogStem includes the iteration, sdk, and normalized version", () => {
  const sdk = sdkByValue("node");
  assert.ok(sdk);
  assert.equal(performerBuildLogStem(0, sdk, "Release Candidate #1"), "0-node-release-candidate-1-performer-build");
});
