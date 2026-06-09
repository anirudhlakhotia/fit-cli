import assert from "node:assert/strict";
import { test } from "node:test";
import { sdkByValue } from "../../../../util/sdk/sdks.js";
import { performerImageInspectArgs, performerPath } from "../check-performer.js";

test("jvm performer path is undefined (JVM uses prebuilt GHCR containers)", () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  assert.equal(performerPath(sdk, "/workspace"), undefined);
});

test("non-jvm performer paths come from transactions-fit-performer", () => {
  const sdk = sdkByValue("node");
  assert.ok(sdk);
  assert.equal(
    performerPath(sdk, "/workspace"),
    "/workspace/transactions-fit-performer/performers/node",
  );
});

test("docker inspect checks for a specific local image", () => {
  assert.deepEqual(performerImageInspectArgs("performer-node-main"), [
    "image",
    "inspect",
    "--format={{.Id}}",
    "performer-node-main",
  ]);
});
