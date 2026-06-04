/**
 * Unit tests for the fit-functional definition parser/validator.
 *
 * Run on their own:
 *   npm test
 *   node --import tsx --test src/workflows/fit-functional/definition/tests/parse-definition.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InvalidDefinitionError,
  UnsupportedDefinitionVersionError,
  parseDefinition,
} from "../parse-definition.js";
import { CURRENT_FIT_FUNCTIONAL_VERSION } from "../types.js";

const MINIMAL = `
version: 1
type: fit-functional-tests
sdk: java
cluster:
  connectionString: couchbase://localhost
  username: Administrator
  password: password
  tls: null
tests: all
`;

test("parses a minimal valid definition", () => {
  const def = parseDefinition(MINIMAL);
  assert.equal(def.version, CURRENT_FIT_FUNCTIONAL_VERSION);
  assert.equal(def.type, "fit-functional-tests");
  assert.equal(def.sdk, "java");
  assert.deepEqual(def.cluster, {
    connectionString: "couchbase://localhost",
    username: "Administrator",
    password: "password",
    tls: null,
  });
  assert.equal(def.tests, "all");
  assert.equal(def.performerVersion, undefined);
  assert.equal(def.excludedGroups, undefined);
});

test("a missing tls field defaults to null", () => {
  const def = parseDefinition(`
version: 1
type: fit-functional-tests
sdk: python
cluster:
  connectionString: couchbase://localhost
  username: u
  password: p
tests: all
`);
  assert.equal(def.cluster.tls, null);
});

test("a missing tests field defaults to all", () => {
  const def = parseDefinition(`
version: 1
type: fit-functional-tests
sdk: python
cluster:
  connectionString: couchbase://localhost
  username: u
  password: p
`);
  assert.equal(def.tests, "all");
});

test("an explicit test list is preserved", () => {
  const def = parseDefinition(`
version: 1
type: fit-functional-tests
sdk: java
cluster:
  connectionString: couchbase://localhost
  username: u
  password: p
tests:
  - com.couchbase.StandardTest
  - com.couchbase.OtherTest
`);
  assert.deepEqual(def.tests, ["com.couchbase.StandardTest", "com.couchbase.OtherTest"]);
});

test("tls insecure and certPath are accepted", () => {
  const insecure = parseDefinition(MINIMAL.replace("tls: null", "tls:\n    insecure: true"));
  assert.deepEqual(insecure.cluster.tls, { insecure: true });

  const cert = parseDefinition(MINIMAL.replace("tls: null", "tls:\n    certPath: /tmp/cb.pem"));
  assert.deepEqual(cert.cluster.tls, { certPath: "/tmp/cb.pem" });
});

test("performerVersion and excludedGroups round-trip when present", () => {
  const def = parseDefinition(`
version: 1
type: fit-functional-tests
sdk: java
performerVersion: "1.2.3"
cluster:
  connectionString: couchbase://localhost
  username: u
  password: p
tests: all
excludedGroups:
  - situational
  - openshift
`);
  assert.equal(def.performerVersion, "1.2.3");
  assert.deepEqual(def.excludedGroups, ["situational", "openshift"]);
});

test("rejects the wrong type", () => {
  assert.throws(
    () => parseDefinition(MINIMAL.replace("fit-functional-tests", "something-else")),
    InvalidDefinitionError,
  );
});

test("rejects a future version with an upgrade hint", () => {
  assert.throws(
    () => parseDefinition(MINIMAL.replace("version: 1", "version: 99")),
    (err: unknown) => err instanceof UnsupportedDefinitionVersionError && /update fit-cli/i.test(err.message),
  );
});

test("rejects a missing required field", () => {
  assert.throws(
    () => parseDefinition(MINIMAL.replace("sdk: java\n", "")),
    (err: unknown) => err instanceof InvalidDefinitionError && /sdk/.test(err.message),
  );
});

test("rejects a cluster missing its connection string", () => {
  assert.throws(
    () => parseDefinition(MINIMAL.replace("  connectionString: couchbase://localhost\n", "")),
    (err: unknown) => err instanceof InvalidDefinitionError && /connectionString/.test(err.message),
  );
});

test("rejects an invalid tls shape", () => {
  assert.throws(
    () => parseDefinition(MINIMAL.replace("tls: null", "tls:\n    bogus: true")),
    (err: unknown) => err instanceof InvalidDefinitionError && /tls/.test(err.message),
  );
});

test("rejects an empty tests list", () => {
  assert.throws(
    () => parseDefinition(MINIMAL.replace("tests: all", "tests: []")),
    InvalidDefinitionError,
  );
});

test("rejects non-mapping top-level YAML", () => {
  assert.throws(() => parseDefinition("- just\n- a\n- list\n"), InvalidDefinitionError);
});

test("wraps a YAML syntax error in InvalidDefinitionError", () => {
  assert.throws(() => parseDefinition("version: 1\n  bad: : indent"), InvalidDefinitionError);
});
