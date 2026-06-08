/**
 * Unit tests for the fit definition parser/validator.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InvalidDefinitionError,
  UnsupportedDefinitionVersionError,
  parseDefinition,
} from "../parse-definition.js";
import { CURRENT_FIT_DEFINITION_VERSION } from "../types.js";

const MINIMAL = `
version: 1
type: fit
setup:
  cluster:
    connection:
      connectionString: couchbase://localhost
      username: Administrator
      password: password
      tls: null
iterations:
  - type: functional
    setup:
      performer:
        sdk: java
    runtime:
      tests: all
`;

test("parses a minimal valid definition", () => {
  const def = parseDefinition(MINIMAL);
  assert.equal(def.version, CURRENT_FIT_DEFINITION_VERSION);
  assert.equal(def.type, "fit");
  assert.deepEqual(def.setup?.cluster?.connection, {
    connectionString: "couchbase://localhost",
    username: "Administrator",
    password: "password",
    tls: null,
  });
  assert.equal(def.iterations[0].fitConfig, undefined);
  assert.equal(def.iterations.length, 1);
  const [iteration] = def.iterations;
  assert.equal(iteration.type, "functional");
  assert.equal(iteration.setup.performer.sdk, "java");
  assert.equal(iteration.runtime.tests, "all");
});

test("supports multiple iterations sharing the top-level cluster", () => {
  const def = parseDefinition(`
version: 1
type: fit
setup:
  cluster:
    connection:
      connectionString: couchbases://cb.example.com
      username: u
      password: p
      tls:
        certPath: /tmp/cb.pem
iterations:
  - type: functional
    setup:
      performer:
        sdk: java
    runtime:
      tests: all
  - type: functional
    setup:
      performer:
        sdk: python
    runtime:
      tests:
        - com.couchbase.SanityTest
`);
  assert.equal(def.iterations.length, 2);
  assert.equal(def.iterations[0].setup.performer.sdk, "java");
  assert.deepEqual(def.iterations[1].runtime.tests, ["com.couchbase.SanityTest"]);
});

test("matches the sample file shape: shared cbdinocluster + performer port", () => {
  const def = parseDefinition(`
version: 1
type: fit
setup:
  cluster:
    cbdinocluster:
      init:
        config:
          version: 6
          docker:
            enabled: "true"
            network: fit
      config:
        nodes:
          - count: 1
            version: '8.1.0-2188'
            services: [ kv, n1ql, index ]
iterations:
  - type: functional
    setup:
      performer:
        sdk: java
        port: 8060
    runtime:
      tests:
        - com.couchbase.client.kv.SanityTest
`);
  assert.deepEqual(def.setup?.cluster?.cbdinocluster, {
    init: {
      config: {
        version: 6,
        docker: {
          enabled: "true",
          network: "fit",
        },
      },
    },
    config: { nodes: [{ count: 1, version: "8.1.0-2188", services: ["kv", "n1ql", "index"] }] },
  });
  assert.equal(def.iterations[0].setup.performer.port, 8060);
});

test("an omitted shared setup is allowed", () => {
  const def = parseDefinition(`
version: 1
type: fit
iterations:
  - type: functional
    setup:
      performer:
        sdk: java
    runtime:
      tests: all
`);
  assert.equal(def.setup, undefined);
});

test("a missing runtime.tests defaults to all", () => {
  const def = parseDefinition(`
version: 1
type: fit
iterations:
  - type: functional
    setup:
      performer:
        sdk: java
    runtime: {}
`);
  assert.equal(def.iterations[0].runtime.tests, "all");
});

test("tls insecure and certPath are accepted", () => {
  const insecure = parseDefinition(MINIMAL.replace("tls: null", "tls:\n        insecure: true"));
  assert.deepEqual((insecure.setup?.cluster?.connection as { tls?: unknown }).tls, { insecure: true });

  const cert = parseDefinition(MINIMAL.replace("tls: null", "tls:\n        certPath: /tmp/cb.pem"));
  assert.deepEqual((cert.setup?.cluster?.connection as { tls?: unknown }).tls, { certPath: "/tmp/cb.pem" });
});

test("performer version, repo Gerrit ref, and excludedGroups round-trip when present", () => {
  const def = parseDefinition(`
version: 1
type: fit
setup:
  repos:
    transactions-fit-performer:
      gerritRef: "refs/changes/29/246329/1"
iterations:
  - type: functional
    setup:
      performer:
        sdk: java
        version: "1.2.3"
    runtime:
      tests: all
      excludedGroups:
        - situational
        - openshift
`);
  assert.equal(def.iterations[0].setup.performer.version, "1.2.3");
  assert.equal(def.setup?.repos?.["transactions-fit-performer"]?.gerritRef, "refs/changes/29/246329/1");
  assert.deepEqual(def.iterations[0].runtime.excludedGroups, ["situational", "openshift"]);
});

test("performer onPortInUse round-trips when valid", () => {
  for (const policy of ["fail", "restart", "reuse"]) {
    const def = parseDefinition(
      MINIMAL.replace("        sdk: java\n", `        sdk: java\n        onPortInUse: ${policy}\n`),
    );
    assert.equal(def.iterations[0].setup.performer.onPortInUse, policy);
  }
});

test("rejects a cbdinocluster init block without config", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
setup:
  cluster:
    cbdinocluster:
      init: {}
      config:
        nodes:
          - count: 1
            version: "8.1.0"
            services: [kv]
iterations:
  - type: functional
    setup:
      performer:
        sdk: java
    runtime:
      tests: all
`),
    (err: unknown) => err instanceof InvalidDefinitionError && /cbdinocluster\.init\.config/.test(err.message),
  );
});

test("legacy useExisting remains accepted", () => {
  const def = parseDefinition(MINIMAL.replace(
    `    connection:
      connectionString: couchbase://localhost
      username: Administrator
      password: password
      tls: null`,
    "    useExisting: {}",
  ));
  assert.deepEqual(def.setup?.cluster?.useExisting, {});
});

test("rejects the wrong type", () => {
  assert.throws(
    () => parseDefinition(MINIMAL.replace("fit", "something-else")),
    InvalidDefinitionError,
  );
});

test("rejects a missing iteration type", () => {
  assert.throws(
    () => parseDefinition(MINIMAL.replace("  - type: functional\n", "  -\n")),
    (err: unknown) => err instanceof InvalidDefinitionError && /iterations\[\]\.type/.test(err.message),
  );
});

test("rejects an unsupported iteration type", () => {
  assert.throws(
    () => parseDefinition(MINIMAL.replace("type: functional", "type: perf")),
    (err: unknown) => err instanceof InvalidDefinitionError && /iterations\[\]\.type/.test(err.message),
  );
});

test("rejects a future version with an upgrade hint", () => {
  assert.throws(
    () => parseDefinition(MINIMAL.replace("version: 1", "version: 99")),
    (err: unknown) => err instanceof UnsupportedDefinitionVersionError && /update fit-cli/i.test(err.message),
  );
});

test("rejects an older version", () => {
  assert.throws(
    () => parseDefinition(MINIMAL.replace("version: 1", "version: 0")),
    (err: unknown) => err instanceof UnsupportedDefinitionVersionError && /no longer supported/i.test(err.message),
  );
});

test("rejects a missing iterations list", () => {
  assert.throws(
    () => parseDefinition("version: 1\ntype: fit\n"),
    (err: unknown) => err instanceof InvalidDefinitionError && /iterations/.test(err.message),
  );
});

test("rejects an empty iterations list", () => {
  assert.throws(
    () => parseDefinition("version: 1\ntype: fit\niterations: []\n"),
    (err: unknown) => err instanceof InvalidDefinitionError && /at least one/.test(err.message),
  );
});

test("rejects a missing performer sdk", () => {
  assert.throws(
    () => parseDefinition(MINIMAL.replace("        sdk: java\n", '        version: "1.0"\n')),
    (err: unknown) => err instanceof InvalidDefinitionError && /setup\.performer\.sdk/.test(err.message),
  );
});

test("rejects a non-integer performer port", () => {
  assert.throws(
    () => parseDefinition(MINIMAL.replace("        sdk: java\n", "        sdk: java\n        port: nope\n")),
    (err: unknown) => err instanceof InvalidDefinitionError && /setup\.performer\.port/.test(err.message),
  );
});

test("rejects a non-empty useExisting block", () => {
  assert.throws(
    () =>
      parseDefinition(
        MINIMAL.replace(
          `    connection:
      connectionString: couchbase://localhost
      username: Administrator
      password: password
      tls: null`,
          "    useExisting:\n      foo: bar",
        ),
      ),
    (err: unknown) => err instanceof InvalidDefinitionError && /useExisting/.test(err.message),
  );
});

test("rejects multiple cluster setup modes", () => {
  assert.throws(
    () =>
      parseDefinition(
        `${MINIMAL.replace("tls: null", "tls: null\n    useExisting: {}")}`,
      ),
    (err: unknown) => err instanceof InvalidDefinitionError && /setup\.cluster/.test(err.message),
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
