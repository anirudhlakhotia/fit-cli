/**
 * Unit tests for clusterDiagUrl.
 *
 * Run on their own:
 *   npm test
 *   node --import tsx --test src/workflows/cluster-diag/tests/index.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { clusterDiagUrl } from "../index.js";
import type { SelectedCluster } from "../../cluster-select/index.js";

function cluster(overrides: Partial<SelectedCluster>): SelectedCluster {
  return {
    scheme: "couchbase",
    defaultHostname: "127.0.0.1",
    flavour: "self-managed",
    credentials: { username: "Administrator", password: "password" },
    tls: null,
    ...overrides,
  };
}

test("couchbase clusters use the insecure management endpoint", () => {
  assert.equal(clusterDiagUrl(cluster({})), "http://127.0.0.1:8091/pools/default");
});

test("couchbases clusters use the secure management endpoint", () => {
  assert.equal(
    clusterDiagUrl(cluster({ scheme: "couchbases", defaultHostname: "cb.example.com" })),
    "https://cb.example.com:18091/pools/default",
  );
});

test("an existing KV port is replaced by the management port", () => {
  assert.equal(
    clusterDiagUrl(cluster({ defaultHostname: "10.1.2.3:11210" })),
    "http://10.1.2.3:8091/pools/default",
  );
});

test("only the first host from a multi-host connection string is used", () => {
  assert.equal(
    clusterDiagUrl(cluster({ defaultHostname: "10.1.2.3,10.1.2.4" })),
    "http://10.1.2.3:8091/pools/default",
  );
});
