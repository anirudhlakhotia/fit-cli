import assert from "node:assert/strict";
import { test } from "node:test";
import { sdkByValue } from "../../../../util/sdk/sdks.js";
import {
  checkBuildAndRunPerformerArgs,
  DEFAULT_PERFORMER_PORT,
  performerLogStem,
} from "../check-build-and-run-performer.js";

test("checkBuildAndRunPerformerArgs runs the prebuilt GHCR image on the default FIT port", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.deepEqual(checkBuildAndRunPerformerArgs(sdk), [
    "run",
    "--detach",
    "--rm",
    "--publish",
    `${DEFAULT_PERFORMER_PORT}:${DEFAULT_PERFORMER_PORT}`,
    "ghcr.io/couchbase/java-fit-performer:main",
  ]);
});

test("checkBuildAndRunPerformerArgs publishes a custom host port for tagged images", () => {
  const sdk = sdkByValue("cpp");
  assert.ok(sdk);
  assert.deepEqual(checkBuildAndRunPerformerArgs(sdk, "4.2.0", 18060), [
    "run",
    "--detach",
    "--rm",
    "--publish",
    "18060:8060",
    "ghcr.io/couchbase/cpp-fit-performer:4.2.0",
  ]);
});

test("checkBuildAndRunPerformerArgs can attach the performer to a Docker network", () => {
  const sdk = sdkByValue("cpp");
  assert.ok(sdk);
  assert.deepEqual(checkBuildAndRunPerformerArgs(sdk, undefined, DEFAULT_PERFORMER_PORT, "fit-net"), [
    "run",
    "--detach",
    "--rm",
    "--network",
    "fit-net",
    "--publish",
    "8060:8060",
    "ghcr.io/couchbase/cpp-fit-performer:main",
  ]);
});

test("performerLogStem puts the normalized tag under the session path", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.equal(
    performerLogStem({ instanceIndex: 0, clusterIndex: 0, sessionIndex: 0 }, sdk, "Release Candidate #1"),
    "instances/0/clusters/0/sessions/0/java-release-candidate-1-performer",
  );
});
