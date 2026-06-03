import assert from "node:assert/strict";
import { test } from "node:test";
import { sdkByValue } from "../../../../util/sdk/sdks.js";
import {
  checkBuildAndRunPerformerArgs,
  DEFAULT_PERFORMER_PORT,
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
