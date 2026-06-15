import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactUploadEnabled, uploadRunArtifacts } from "../upload-run-artifacts.js";

test("artifactUploadEnabled is on only inside GitHub Actions (GITHUB_ACTIONS=true)", () => {
  assert.equal(artifactUploadEnabled({}), false);
  assert.equal(artifactUploadEnabled({ GITHUB_ACTIONS: "false" }), false);
  assert.equal(artifactUploadEnabled({ GITHUB_ACTIONS: "true" }), true);
});

test("uploadRunArtifacts skips (returns null, no aws call) outside GitHub Actions", async () => {
  // Not in CI — must short-circuit before touching the filesystem or aws.
  assert.equal(await uploadRunArtifacts("/tmp/whatever", {}), null);
});

test("uploadRunArtifacts skips when the run directory does not exist", async () => {
  assert.equal(
    await uploadRunArtifacts("/tmp/fit-cli-does-not-exist-zzz", { GITHUB_ACTIONS: "true" }),
    null,
  );
});
