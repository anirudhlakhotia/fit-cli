/**
 * Unit tests for buildPerformerArgs.
 *
 * Run on their own:
 *   npm test
 *   node --import tsx --test src/workflows/performers/build-performer/tests/build-performer.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { sdkByValue } from "../../../../util/sdk/sdks.js";
import {
  buildPerformerArgs,
  buildPerformerImageName,
  dockerImageComponent,
  performerBuildIdentity,
} from "../build-performer.js";

test("the default build uses main by omitting -v", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.deepEqual(buildPerformerArgs("/workspace", sdk), [
    "buildPerformer",
    "--args=-d /workspace -s java -i performer-java-main",
  ]);
});

test("a specific version is passed through with -v", () => {
  const sdk = sdkByValue("node");
  assert.ok(sdk);
  assert.deepEqual(buildPerformerArgs("/workspace", sdk, "4.2.0"), [
    "buildPerformer",
    "--args=-d /workspace -s node -v 4.2.0 -i performer-node-4.2.0",
  ]);
});

test("a Gerrit ref changes the local image name without changing Gradle version args", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.deepEqual(buildPerformerArgs("/workspace", sdk, undefined, "refs/changes/29/246329/1"), [
    "buildPerformer",
    "--args=-d /workspace -s java -i performer-java-gerrit-refs-changes-29-246329-1",
  ]);
});

test("image names include the sdk and a sanitized version", () => {
  const sdk = sdkByValue("scala");
  assert.ok(sdk);
  assert.equal(buildPerformerImageName(sdk, "release/1.2.3"), "performer-scala-release-1.2.3");
});

test("performerBuildIdentity includes both version and Gerrit ref when present", () => {
  assert.equal(
    performerBuildIdentity("4.2.0", "refs/changes/29/246329/1"),
    "4.2.0-gerrit-refs/changes/29/246329/1",
  );
});

test("invalid docker image characters are normalized", () => {
  assert.equal(dockerImageComponent(" Release Candidate #1 "), "release-candidate-1");
});
