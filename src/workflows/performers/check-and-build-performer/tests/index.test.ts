import assert from "node:assert/strict";
import { test } from "node:test";
import type { FitExecutionContext } from "../../../fit-shared/remote-fit-run.js";
import { sdkByValue } from "../../../../util/sdk/sdks.js";
import { checkAndBuildPerformer, performerBuildLogStem } from "../index.js";

test("performerBuildLogStem puts the normalized version under the iteration directory", () => {
  const sdk = sdkByValue("node");
  assert.ok(sdk);
  assert.equal(performerBuildLogStem(0, sdk, "Release Candidate #1"), "it0/node-release-candidate-1-performer-build");
});

test("checkAndBuildPerformer treats a missing local image as informational before building", async () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);

  let built = false;
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.error = (...args: unknown[]) => errors.push(args.join(" "));

  const execution: FitExecutionContext = {
    kind: "local",
    description: "local machine",
    target: {} as FitExecutionContext["target"],
    rootDir: "/tmp/root",
    fitPerformerDir: "/tmp/root/transactions-fit-performer",
    jenkinsDir: "/tmp/root/jenkins-sdk",
    dockerCommand: "docker",
    artifacts: [],
    details: [],
    ensureWorkspace: () => Promise.resolve(true),
    ensureBuildWorkspace: () => Promise.resolve(true),
    run: () => Promise.resolve(),
    capture: (_command, args) => {
      if (args[0] === "image" && args[1] === "inspect" && !built) {
        return Promise.reject(new Error("missing"));
      }
      return Promise.resolve("sha256:test");
    },
    runToFile: () => {
      built = true;
      return Promise.resolve();
    },
    targetFilePath: (localPath) => localPath,
    stageFile: (localPath) => Promise.resolve(localPath),
    collectFile: () => Promise.resolve(),
    removeTree: () => Promise.resolve(),
    collectJunitArtifacts: () => Promise.resolve([]),
    pathExists: () => Promise.resolve(true),
    commandAvailable: () => Promise.resolve(true),
    performerRunArgs: () => [],
  };

  try {
    const success = await checkAndBuildPerformer(execution, sdk);
    assert.equal(success, true);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(errors.length, 0);
  assert.ok(
    logs.some((line) => line.includes("is not present locally, so fit-cli will build it now.")),
  );
});
