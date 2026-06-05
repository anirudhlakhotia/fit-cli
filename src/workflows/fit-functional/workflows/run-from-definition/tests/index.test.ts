import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sdkByValue } from "../../../../../util/sdk/sdks.js";
import type { ClusterCommandExecutor } from "../../../../cluster/cluster-create/allocate-cluster.js";
import type { ResolvedDefinition } from "../../../definition/resolve-definition.js";
import { setupCluster, finalizeRunFromDefinition } from "../index.js";

function definition(): ResolvedDefinition {
  const sdk = sdkByValue("java");
  assert.ok(sdk);
  return {
    clusterMode: "cbdinocluster",
    cbdinocluster: {
      config: { nodes: [{ count: 1, version: "8.1.0-2188", services: ["kv"] }] },
      onClusterExists: "destroyAndRecreate",
    },
    iterations: [
      {
        type: "functional",
        sdk,
        performerPort: 8060,
        testSelection: { allTests: [], selectedTests: [] },
        onPortInUse: "restart",
        extraMavenArgs: [],
      },
      {
        type: "functional",
        sdk,
        performerPort: 8061,
        testSelection: { allTests: [], selectedTests: [] },
        onPortInUse: "restart",
        extraMavenArgs: [],
      },
    ],
  };
}

function executor(): ClusterCommandExecutor {
  return {
    description: "test target",
    run: () => Promise.resolve(),
    capture: () => Promise.resolve(""),
    runToFile: () => Promise.resolve(),
    targetFilePath: (path) => path,
    stageFile: (path) => Promise.resolve(path),
    collectFile: () => Promise.resolve(),
    commandAvailable: () => Promise.resolve(true),
  };
}

test("setupCluster applies the allocated cbdinocluster to every iteration", async () => {
  const cluster = {
    scheme: "couchbase" as const,
    defaultHostname: "localhost",
    flavour: "self-managed" as const,
    credentials: { username: "Administrator", password: "password" },
    tls: null,
  };

  const result = await setupCluster(definition(), executor(), () =>
    Promise.resolve({
      allocated: true,
      clusterId: "cluster-id",
      cbdinocluster: "cbdinocluster",
      cluster,
      artifacts: [],
      details: [],
    }),
  );

  assert.deepEqual(
    result.resolved.iterations.map((iteration) => iteration.cluster),
    [cluster, cluster],
  );
});

test("setupCluster leaves the iterations unchanged when allocation fails", async () => {
  const result = await setupCluster(definition(), executor(), () =>
    Promise.resolve({
      allocated: false,
      artifacts: [],
      details: [],
    }),
  );

  assert.deepEqual(
    result.resolved.iterations.map((iteration) => iteration.cluster),
    [undefined, undefined],
  );
});

test("finalizeRunFromDefinition writes AGENTS.md and includes it in artifacts", () => {
  const runDir = mkdtempSync(join(tmpdir(), "fit-cli-run-from-definition-"));
  const result = finalizeRunFromDefinition([
    { filename: "it0/driver.log", explanation: "FIT test-driver stdout/stderr captured for this run" },
  ], [], runDir);

  assert.deepEqual(result.artifacts.map((artifact) => artifact.filename), ["it0/driver.log", "AGENTS.md"]);
  const written = readFileSync(join(runDir, "AGENTS.md"), "utf8");
  assert.match(written, /it0\/driver\.log/);
});
