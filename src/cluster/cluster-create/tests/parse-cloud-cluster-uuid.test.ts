/**
 * Unit tests for parseCloudClusterUuid.
 *
 * Run on their own:
 *   bun test
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCloudClusterUuid } from "../parse-cloud-cluster-uuid.js";

test("the cloud-id field is parsed out of a real allocate log line", () => {
  const output = `2026-07-01T17:18:26.159Z\tINFO\tcmd/allocate.go:128\tcloud cluster was allocated\t{"cloud-id": "e781cee3-537b-488f-8b44-e89d08aec972"}
4fde37aae57f422aa46e50ec6f836ba2`;
  assert.equal(parseCloudClusterUuid(output), "e781cee3-537b-488f-8b44-e89d08aec972");
});

test("output with no cloud-id field yields null (e.g. docker/cao deployer)", () => {
  const output = `2026-07-01T17:18:26.159Z\tINFO\tcmd/allocate.go:138\tcluster deployed\t{"mgmt": "", "connstr": ""}
df45d6d0-cfbe-4905-bc8c-989a09c03817`;
  assert.equal(parseCloudClusterUuid(output), null);
});

test("empty output yields null", () => {
  assert.equal(parseCloudClusterUuid(""), null);
});
