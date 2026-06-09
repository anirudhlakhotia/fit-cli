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

const FUNCTIONAL = `
version: 1
type: fit
setup:
  repos:
    transactions-fit-performer:
      gerritRef: refs/changes/29/246329/1
cycles:
  - type: functional
    cluster:
      connection:
        connectionString: couchbase://localhost
        username: Administrator
        password: password
        tls: null
    iterations:
      - setup:
          performer:
            sdk: java
        runtime:
          tests: all
`;

test("parses a minimal functional cycle", () => {
  const def = parseDefinition(FUNCTIONAL);
  assert.equal(def.version, CURRENT_FIT_DEFINITION_VERSION);
  assert.equal(def.type, "fit");
  assert.equal(def.setup?.repos?.["transactions-fit-performer"]?.gerritRef, "refs/changes/29/246329/1");
  assert.equal(def.cycles.length, 1);
  const [cycle] = def.cycles;
  assert.equal(cycle.type, "functional");
  assert.deepEqual(cycle.cluster.connection, {
    connectionString: "couchbase://localhost",
    username: "Administrator",
    password: "password",
    tls: null,
  });
  assert.equal(cycle.iterations[0]?.setup.performer.sdk, "java");
});

test("supports multiple functional iterations inside one cycle", () => {
  const def = parseDefinition(FUNCTIONAL.replace(
    `        sdk: java
        runtime:
          tests: all`,
    `        sdk: java
        runtime:
          tests: all
      - setup:
          performer:
            sdk: python
        runtime:
          tests:
            - com.couchbase.SanityTest`,
  ));

  const cycle = def.cycles[0];
  assert.equal(cycle?.type, "functional");
  assert.equal(cycle?.iterations.length, 2);
});

const SITUATIONAL_CBDINOCLUSTER = `
    cbdinocluster:
      init:
        config:
          version: 6
          docker:
            enabled: true
`;

test("parses a situational cycle with a database mode", () => {
  const def = parseDefinition(`
version: 1
type: fit
cycles:
  - type: situational
${SITUATIONAL_CBDINOCLUSTER}
    iterations:
      - setup:
          performer:
            sdk: java
        situational:
          database:
            mode: hosted
        runtime:
          tests: all
`);
  const [cycle] = def.cycles;
  assert.equal(cycle.type, "situational");
  assert.equal(cycle.iterations[0]?.situational.database.mode, "hosted");
  assert.deepEqual(cycle.cbdinocluster.init.config, { version: 6, docker: { enabled: true } });
});

test("supports mixed cycles", () => {
  const def = parseDefinition(`
version: 1
type: fit
cycles:
  - type: functional
    cluster:
      useExisting: {}
    iterations:
      - fitConfig:
          clusterAccess:
            connectionString: couchbase://localhost
            username: Administrator
            password: password
            tls: null
        setup:
          performer:
            sdk: java
        runtime:
          tests: all
  - type: situational
${SITUATIONAL_CBDINOCLUSTER}
    iterations:
      - setup:
          performer:
            sdk: python
        situational:
          database:
            mode: local
        runtime:
          tests: all
`);
  assert.deepEqual(def.cycles.map((cycle) => cycle.type), ["functional", "situational"]);
});

test("rejects missing cycles", () => {
  assert.throws(
    () => parseDefinition("version: 1\ntype: fit\n"),
    (err: unknown) => err instanceof InvalidDefinitionError && /cycles/.test(err.message),
  );
});

test("rejects top-level iterations", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
iterations: []
`),
    (err: unknown) => err instanceof InvalidDefinitionError && /iterations.*cycles/i.test(err.message),
  );
});

test("rejects setup.cluster at the top level", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
setup:
  cluster:
    useExisting: {}
cycles:
  - type: situational
${SITUATIONAL_CBDINOCLUSTER}
    iterations:
      - setup:
          performer:
            sdk: java
        situational:
          database:
            mode: hosted
        runtime:
          tests: all
`),
    (err: unknown) => err instanceof InvalidDefinitionError && /setup\.cluster/.test(err.message),
  );
});

test("rejects a functional cycle without a cluster", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
cycles:
  - type: functional
    iterations:
      - setup:
          performer:
            sdk: java
        runtime:
          tests: all
`),
    (err: unknown) => err instanceof InvalidDefinitionError && /cycles\[0\]\.cluster/.test(err.message),
  );
});

test("rejects a situational cycle with a cluster", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
cycles:
  - type: situational
    cluster:
      useExisting: {}
    iterations:
      - setup:
          performer:
            sdk: java
        situational:
          database:
            mode: hosted
        runtime:
          tests: all
`),
    (err: unknown) => err instanceof InvalidDefinitionError && /not allowed on a situational cycle/.test(err.message),
  );
});

test("rejects per-iteration type fields", () => {
  assert.throws(
    () =>
      parseDefinition(FUNCTIONAL.replace("      - setup:", "      - type: functional\n        setup:")),
    (err: unknown) => err instanceof InvalidDefinitionError && /no longer supported.*cycle/i.test(err.message),
  );
});

test("rejects situational.cbdino", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
cycles:
  - type: situational
${SITUATIONAL_CBDINOCLUSTER}
    iterations:
      - setup:
          performer:
            sdk: java
        situational:
          cbdino:
            version: "7.2"
          database:
            mode: hosted
        runtime:
          tests: all
`),
    (err: unknown) => err instanceof InvalidDefinitionError && /situational.*cbdino/.test(err.message),
  );
});

test("rejects a situational cycle without cbdinocluster", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
cycles:
  - type: situational
    iterations:
      - setup:
          performer:
            sdk: java
        situational:
          database:
            mode: hosted
        runtime:
          tests: all
`),
    (err: unknown) =>
      err instanceof InvalidDefinitionError && /cycles\[0\]\.cbdinocluster/.test(err.message),
  );
});

test("parses runtime.maven.runDisabledTests", () => {
  const def = parseDefinition(FUNCTIONAL.replace(
    "          tests: all",
    "          tests: all\n          maven:\n            runDisabledTests: true",
  ));
  assert.equal(def.cycles[0]?.iterations[0]?.runtime.maven?.runDisabledTests, true);
});

test("parses runtime.maven.args", () => {
  const def = parseDefinition(FUNCTIONAL.replace(
    "          tests: all",
    "          tests: all\n          maven:\n            args:\n              - -Dsome.flag=true",
  ));
  assert.deepEqual(def.cycles[0]?.iterations[0]?.runtime.maven?.args, ["-Dsome.flag=true"]);
});

test("rejects runtime.maven.runDisabledTests that is not a boolean", () => {
  assert.throws(
    () =>
      parseDefinition(FUNCTIONAL.replace(
        "          tests: all",
        "          tests: all\n          maven:\n            runDisabledTests: yes-please",
      )),
    (err: unknown) => err instanceof InvalidDefinitionError && /runDisabledTests/.test(err.message),
  );
});

test("rejects runtime.maven.args that is not a list of strings", () => {
  assert.throws(
    () =>
      parseDefinition(FUNCTIONAL.replace(
        "          tests: all",
        "          tests: all\n          maven:\n            args: not-a-list",
      )),
    (err: unknown) => err instanceof InvalidDefinitionError && /maven\.args/.test(err.message),
  );
});

test("rejects a future version", () => {
  assert.throws(
    () => parseDefinition(FUNCTIONAL.replace("version: 1", "version: 99")),
    (err: unknown) => err instanceof UnsupportedDefinitionVersionError && /update fit-cli/i.test(err.message),
  );
});

test("rejects an older version", () => {
  assert.throws(
    () => parseDefinition(FUNCTIONAL.replace("version: 1", "version: 0")),
    (err: unknown) => err instanceof UnsupportedDefinitionVersionError && /no longer supported/i.test(err.message),
  );
});
