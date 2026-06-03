/**
 * Unit tests for classifyConnectionString.
 *
 * Run on their own:
 *   npm test
 *   node --import tsx --test src/workflows/cluster-select/tests/classify-connection-string.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyConnectionString } from "../classify-connection-string.js";

test("couchbase:// localhost is a supported, non-TLS, self-managed cluster", () => {
  assert.deepEqual(classifyConnectionString("couchbase://localhost"), {
    kind: "supported",
    scheme: "couchbase",
    tls: false,
    flavour: "self-managed",
    defaultHostname: "localhost",
  });
});

test("couchbases:// implies TLS", () => {
  const c = classifyConnectionString("couchbases://localhost");
  assert.equal(c.kind, "supported");
  assert.equal(c.kind === "supported" && c.tls, true);
});

test("nonprod-project-avengers marks an internal Capella cluster", () => {
  const c = classifyConnectionString("couchbases://cb.abc.nonprod-project-avengers.com");
  assert.equal(c.kind === "supported" && c.flavour, "internal-capella");
});

test("cloud.couchbase.com marks a production Capella cluster", () => {
  const c = classifyConnectionString("couchbases://cb.abc.cloud.couchbase.com");
  assert.equal(c.kind === "supported" && c.flavour, "production-capella");
});

test("http(s):// is detected as Enterprise Analytics", () => {
  assert.equal(classifyConnectionString("http://localhost:8095").kind, "analytics");
  assert.equal(classifyConnectionString("https://analytics.example.com").kind, "analytics");
});

test("couchbase2:// is detected as Protostellar/CNG", () => {
  assert.equal(classifyConnectionString("couchbase2://localhost").kind, "protostellar");
});

test("an unknown scheme is unsupported", () => {
  assert.equal(classifyConnectionString("mysql://localhost").kind, "unsupported");
  assert.equal(classifyConnectionString("localhost").kind, "unsupported");
});

test("scheme detection is case-insensitive", () => {
  assert.equal(classifyConnectionString("COUCHBASE://localhost").kind, "supported");
});

test("the hostname strips scheme, path and query but keeps a port", () => {
  assert.equal(
    classifyConnectionString("couchbase://host.example.com:11210/foo?x=1").kind === "supported" &&
      (classifyConnectionString("couchbase://host.example.com:11210/foo?x=1") as { defaultHostname: string })
        .defaultHostname,
    "host.example.com:11210",
  );
});

test("surrounding whitespace is ignored", () => {
  const c = classifyConnectionString("  couchbase://localhost  ");
  assert.equal(c.kind === "supported" && c.defaultHostname, "localhost");
});
