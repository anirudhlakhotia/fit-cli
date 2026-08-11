/**
 * Unit tests for parseInstance(s).
 *
 * Run on their own:
 *   node --import tsx --test src/cloud/util/gcp/tests/parse-instance.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInstance, parseInstances } from "../parse-instance.js";

test("flattens an instance with external and internal IPs", () => {
  const raw = {
    name: "fit-cli-gcp-spike",
    status: "RUNNING",
    networkInterfaces: [{ networkIP: "10.0.0.5", accessConfigs: [{ natIP: "34.1.2.3" }] }],
    machineType: "https://www.googleapis.com/compute/v1/projects/p/zones/us-west1-a/machineTypes/n2-standard-8",
    labels: { "fit-cli": "owned" },
  };
  assert.deepEqual(parseInstance(raw), {
    name: "fit-cli-gcp-spike",
    status: "RUNNING",
    externalIp: "34.1.2.3",
    internalIp: "10.0.0.5",
    labels: { "fit-cli": "owned" },
    machineTypeUrl: "https://www.googleapis.com/compute/v1/projects/p/zones/us-west1-a/machineTypes/n2-standard-8",
  });
});

test("omits external IP when the instance has no access config (no public IP)", () => {
  const raw = { name: "internal-only", status: "RUNNING", networkInterfaces: [{ networkIP: "10.0.0.9" }] };
  const parsed = parseInstance(raw);
  assert.equal(parsed?.internalIp, "10.0.0.9");
  assert.equal(parsed?.externalIp, undefined);
});

test("returns null for an instance with no name", () => {
  assert.equal(parseInstance({ status: "RUNNING" }), null);
});

test("parseInstances drops nameless entries and preserves order", () => {
  const raw = [
    { name: "a", status: "RUNNING" },
    { status: "PROVISIONING" },
    { name: "b", status: "TERMINATED" },
  ];
  assert.deepEqual(parseInstances(raw).map((i) => i.name), ["a", "b"]);
});
