import assert from "node:assert/strict";
import { test } from "node:test";
import { sdkByValue } from "../../../../util/sdk/sdks.js";
import {
  checkBuildAndRunPerformerArgs,
  DEFAULT_PERFORMER_PORT,
  performerLogStem,
} from "../index.js";

test("checkBuildAndRunPerformerArgs runs the main image on the default FIT port", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.deepEqual(checkBuildAndRunPerformerArgs(sdk), [
    "run",
    "--detach",
    "--rm",
    "--publish",
    `${DEFAULT_PERFORMER_PORT}:${DEFAULT_PERFORMER_PORT}`,
    "performer-java-main",
  ]);
});

test("checkBuildAndRunPerformerArgs publishes a custom host port for versioned images", () => {
  const sdk = sdkByValue("node");
  assert.ok(sdk);
  assert.deepEqual(checkBuildAndRunPerformerArgs(sdk, "4.2.0", 18060), [
    "run",
    "--detach",
    "--rm",
    "--publish",
    "18060:8060",
    "performer-node-4.2.0",
  ]);
});

test("checkBuildAndRunPerformerArgs can attach the performer to a Docker network", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.deepEqual(checkBuildAndRunPerformerArgs(sdk, undefined, DEFAULT_PERFORMER_PORT, "fit-net"), [
    "run",
    "--detach",
    "--rm",
    "--network",
    "fit-net",
    "--publish",
    "8060:8060",
    "performer-java-main",
  ]);
});

test("performerLogStem includes the iteration, sdk, and normalized version", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.equal(performerLogStem(0, sdk, "Release Candidate #1"), "0-java-release-candidate-1-performer");
});
