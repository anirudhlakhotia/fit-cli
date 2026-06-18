import assert from "node:assert/strict";
import { test } from "node:test";
import { performerImageInspectArgs } from "../check-performer.js";

test("docker inspect checks for a specific local image", () => {
  assert.deepEqual(performerImageInspectArgs("ghcr.io/couchbase/java-fit-performer:main"), [
    "image",
    "inspect",
    "--format={{.Id}}",
    "ghcr.io/couchbase/java-fit-performer:main",
  ]);
});
