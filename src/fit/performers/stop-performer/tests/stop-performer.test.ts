import assert from "node:assert/strict";
import test from "node:test";
import { sdkByValue } from "../../../../util/sdk/sdks.js";
import { createLocalFitExecutionContext } from "../../../shared/util/remote-fit-run.js";
import {
  stopPerformer,
  type StopPerformerDeps,
} from "../stop-performer.js";

test("stopPerformer stops all running containers for the matching image", async () => {
  const sdk = sdkByValue("cpp");
  assert.ok(sdk);

  const stoppedIds: string[][] = [];
  const deps: StopPerformerDeps = {
    runningContainersForImage(_execution, imageName) {
      assert.equal(imageName, "ghcr.io/couchbase/cxx-fit-performer:main");
      return Promise.resolve([
        { id: "abc123", image: imageName, name: "fit-node-1", ports: "" },
        { id: "def456", image: imageName, name: "fit-node-2", ports: "" },
      ]);
    },
    stopPerformerContainers(_execution, containerIds) {
      stoppedIds.push(containerIds);
      return Promise.resolve(true);
    },
  };

  assert.equal(await stopPerformer(createLocalFitExecutionContext(), sdk, undefined, deps), true);
  assert.deepEqual(stoppedIds, [["abc123", "def456"]]);
});

test("stopPerformer succeeds without stopping anything when no containers are running", async () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);

  let stopCalled = false;
  const deps: StopPerformerDeps = {
    runningContainersForImage(_execution, imageName) {
      assert.equal(imageName, "ghcr.io/couchbase/java-fit-performer:main");
      return Promise.resolve([]);
    },
    stopPerformerContainers() {
      stopCalled = true;
      return Promise.resolve(true);
    },
  };

  assert.equal(await stopPerformer(createLocalFitExecutionContext(), sdk, undefined, deps), true);
  assert.equal(stopCalled, false);
});
