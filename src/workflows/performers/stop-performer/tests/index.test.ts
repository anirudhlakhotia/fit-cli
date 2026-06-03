import assert from "node:assert/strict";
import test from "node:test";
import { sdkByValue } from "../../../../util/sdk/sdks.js";
import {
  stopPerformer,
  type StopPerformerDeps,
} from "../index.js";

test("stopPerformer stops all running containers for the matching image", async () => {
  const sdk = sdkByValue("node");
  assert.ok(sdk);

  const stoppedIds: string[][] = [];
  const deps: StopPerformerDeps = {
    runningContainersForImage(imageName) {
      assert.equal(imageName, "performer-node-main");
      return Promise.resolve([
        { id: "abc123", image: imageName, name: "fit-node-1", ports: "" },
        { id: "def456", image: imageName, name: "fit-node-2", ports: "" },
      ]);
    },
    stopPerformerContainers(containerIds) {
      stoppedIds.push(containerIds);
      return Promise.resolve(true);
    },
  };

  assert.equal(await stopPerformer(sdk, undefined, deps), true);
  assert.deepEqual(stoppedIds, [["abc123", "def456"]]);
});

test("stopPerformer succeeds without stopping anything when no containers are running", async () => {
  const sdk = sdkByValue("java");
  assert.ok(sdk);

  let stopCalled = false;
  const deps: StopPerformerDeps = {
    runningContainersForImage(imageName) {
      assert.equal(imageName, "performer-java-main");
      return Promise.resolve([]);
    },
    stopPerformerContainers() {
      stopCalled = true;
      return Promise.resolve(true);
    },
  };

  assert.equal(await stopPerformer(sdk, undefined, deps), true);
  assert.equal(stopCalled, false);
});
