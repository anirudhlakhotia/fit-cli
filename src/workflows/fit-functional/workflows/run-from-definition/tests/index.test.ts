import assert from "node:assert/strict";
import { test } from "node:test";
import { sdkByValue } from "../../../../../util/sdk/sdks.js";
import type { ResolvedDefinition } from "../../../definition/resolve-definition.js";
import { setupCluster } from "../index.js";

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

test("setupCluster applies the allocated cbdinocluster to every iteration", async () => {
  const cluster = {
    scheme: "couchbase" as const,
    defaultHostname: "localhost",
    flavour: "self-managed" as const,
    credentials: { username: "Administrator", password: "password" },
    tls: null,
  };

  const result = await setupCluster(definition(), () =>
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
  const result = await setupCluster(definition(), () =>
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
