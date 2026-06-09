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
instances:
  - aws:
      instanceType: c5.4xlarge
    clusters:
      - connection:
          connectionString: couchbase://localhost
          username: Administrator
          password: password
          tls: null
        sessions:
          - performer:
              sdk: java
            runs:
              - type: functional
                tests:
                  run: all
`;

test("parses a minimal nested functional definition", () => {
  const def = parseDefinition(FUNCTIONAL);
  assert.equal(def.version, CURRENT_FIT_DEFINITION_VERSION);
  assert.equal(def.type, "fit");
  assert.equal(def.setup?.repos?.["transactions-fit-performer"]?.gerritRef, "refs/changes/29/246329/1");
  assert.equal(def.instances.length, 1);
  assert.ok(def.instances[0] && "aws" in def.instances[0]);
  assert.deepEqual(def.instances[0].aws, { instanceType: "c5.4xlarge" });
  assert.equal(def.instances[0]?.clusters[0]?.sessions[0]?.performer.sdk, "java");
  assert.equal(def.instances[0]?.clusters[0]?.sessions[0]?.runs[0]?.type, "functional");
});

test("parses clusterless situational sessions", () => {
  const def = parseDefinition(`
version: 1
type: fit
instances:
  - localhost: {}
    clusters: []
    cbdinocluster:
      init:
        config:
          version: 6
    clusterlessSessions:
      - performer:
          sdk: python
        runs:
          - type: situational
            situational:
              database:
                mode: hosted
            tests:
              run: all
`);
  assert.equal(def.instances[0]?.clusterlessSessions?.[0]?.runs[0]?.type, "situational");
});

test("rejects missing instances in the new schema", () => {
  assert.throws(
    () => parseDefinition("version: 1\ntype: fit\n"),
    (err: unknown) => err instanceof InvalidDefinitionError && /instances/.test(err.message),
  );
});

test("rejects empty instances", () => {
  assert.throws(
    () => parseDefinition("version: 1\ntype: fit\ninstances: []\n"),
    InvalidDefinitionError,
  );
});

test("rejects legacy cycles", () => {
  assert.throws(
    () => parseDefinition("version: 1\ntype: fit\ncycles: []\n"),
    (err: unknown) => err instanceof InvalidDefinitionError && /cycles/.test(err.message),
  );
});

test("rejects legacy iterations", () => {
  assert.throws(
    () => parseDefinition("version: 1\ntype: fit\niterations: []\n"),
    (err: unknown) => err instanceof InvalidDefinitionError && /iterations/.test(err.message),
  );
});

test("rejects a clusterless functional run", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
instances:
  - localhost: {}
    clusters: []
    cbdinocluster:
      init:
        config: {}
    clusterlessSessions:
      - performer:
          sdk: java
        runs:
          - type: functional
            tests:
              run: all
`),
    InvalidDefinitionError,
  );
});

test("rejects clusterless sessions without cbdinocluster init", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
instances:
  - localhost: {}
    clusters: []
    clusterlessSessions:
      - performer:
          sdk: java
        runs:
          - type: situational
            situational:
              database:
                mode: local
            tests:
              run: all
`),
    InvalidDefinitionError,
  );
});

test("rejects unsupported future versions", () => {
  assert.throws(
    () => parseDefinition(`version: ${CURRENT_FIT_DEFINITION_VERSION + 1}\ntype: fit\ninstances: []\n`),
    UnsupportedDefinitionVersionError,
  );
});
