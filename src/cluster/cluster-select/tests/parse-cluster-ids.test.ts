/**
 * Unit tests for parseClusterIds.
 *
 * Run on their own:
 *   bun test
 *   node --import tsx --test src/workflows/cluster/cluster-select/tests/parse-cluster-ids.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClusterIds } from "../parse-cluster-ids.js";

/** A representative `cbdinocluster ps` capture: log noise, a cluster, a node. */
const PS_OUTPUT = `2026-06-03T13:02:18.157+0100    INFO    logger initialized
2026-06-03T13:02:18.157+0100    INFO    identified available deployers  {"deployers": ["cao", "docker"]}
Clusters:
  df45d6d0-cfbe-4905-bc8c-989a09c03817 [Type: server, State: ready, Timeout: none, Deployer: docker]
    4e9e2165-6fb6-4114-bf44-aba0ed02a25e                          172.18.0.2           f58b3be1...
`;

test("the cluster UUID is parsed out, skipping logs, header and node lines", () => {
  assert.deepEqual(parseClusterIds(PS_OUTPUT), [
    {
      id: "df45d6d0-cfbe-4905-bc8c-989a09c03817",
      details: "Type: server, State: ready, Timeout: none, Deployer: docker",
    },
  ]);
});

test("multiple clusters are returned in order", () => {
  const output = `Clusters:
  df45d6d0-cfbe-4905-bc8c-989a09c03817 [Type: server, State: ready]
    4e9e2165-6fb6-4114-bf44-aba0ed02a25e   172.18.0.2
  aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee [Type: server, State: building]
`;
  assert.deepEqual(
    parseClusterIds(output).map((c) => c.id),
    ["df45d6d0-cfbe-4905-bc8c-989a09c03817", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
  );
});

test("no clusters running yields an empty list", () => {
  const output = `2026-06-03T13:02:18.157+0100    INFO    logger initialized
Clusters:
`;
  assert.deepEqual(parseClusterIds(output), []);
});

test("a node line on its own (UUID with no bracketed summary) is not a cluster", () => {
  const output = "    4e9e2165-6fb6-4114-bf44-aba0ed02a25e   172.18.0.2   f58b3be1...";
  assert.deepEqual(parseClusterIds(output), []);
});

test("empty output yields an empty list", () => {
  assert.deepEqual(parseClusterIds(""), []);
});
