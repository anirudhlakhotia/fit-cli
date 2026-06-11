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
    setup:
      cbdinocluster:
        init:
          config:
            version: 6
    clusters: []
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

const FUNCTIONAL_WITH_INIT_ARGS = `
version: 1
type: fit
instances:
  - aws: {}
    setup:
      cbdinocluster:
        init:
          args: "--auto --disable-k8s --docker-network fit"
    clusters:
      - cbdinocluster:
          config:
            nodes:
              - count: 1
                version: "8.1.0"
                services: [kv]
        sessions:
          - performer:
              sdk: java
            runs:
              - type: functional
                tests:
                  run: all
`;

test("parses a per-instance cbdinocluster init args string", () => {
  const def = parseDefinition(FUNCTIONAL_WITH_INIT_ARGS);
  assert.equal(
    def.instances[0]?.setup?.cbdinocluster?.init?.args,
    "--auto --disable-k8s --docker-network fit",
  );
  assert.equal(def.instances[0]?.setup?.cbdinocluster?.init?.config, undefined);
});

test("rejects a cbdinocluster init with both args and config", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
instances:
  - aws: {}
    setup:
      cbdinocluster:
        init:
          args: "--auto"
          config:
            version: 6
    clusters:
      - cbdinocluster:
          config:
            nodes:
              - count: 1
                version: "8.1.0"
                services: [kv]
        sessions:
          - performer:
              sdk: java
            runs:
              - type: functional
                tests:
                  run: all
`),
    (err: unknown) => err instanceof InvalidDefinitionError && /exactly one of "args" or "config"/.test(err.message),
  );
});

test("rejects a cbdinocluster init with neither args nor config", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
instances:
  - aws: {}
    setup:
      cbdinocluster:
        init: {}
    clusters:
      - cbdinocluster:
          config:
            nodes:
              - count: 1
                version: "8.1.0"
                services: [kv]
        sessions:
          - performer:
              sdk: java
            runs:
              - type: functional
                tests:
                  run: all
`),
    (err: unknown) => err instanceof InvalidDefinitionError && /args/.test(err.message),
  );
});

test("rejects cbdinocluster init left on a cluster config (moved to instance.setup)", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
instances:
  - aws: {}
    clusters:
      - cbdinocluster:
          init:
            args: "--auto"
          config:
            nodes:
              - count: 1
                version: "8.1.0"
                services: [kv]
        sessions:
          - performer:
              sdk: java
            runs:
              - type: functional
                tests:
                  run: all
`),
    (err: unknown) => err instanceof InvalidDefinitionError && /setup\.cbdinocluster\.init/.test(err.message),
  );
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
    setup:
      cbdinocluster:
        init:
          config: {}
    clusters: []
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

test("parses clusterConfig string ref and fitConfig string ref at run level", () => {
  const def = parseDefinition(`
version: 1
type: fit
instances:
  - localhost: {}
    clusters:
      - clusterConfig: "cluster-0"
        sessions:
          - performer:
              sdk: java
            runs:
              - type: functional
                fitConfig: "fit-config-0"
                tests:
                  run: all
clusterConfigs:
  - id: "cluster-0"
    cbdinocluster:
      config:
        nodes:
          - count: 1
            version: 8.1.0-2188
            services: [kv]
fitConfigs:
  - id: "fit-config-0"
    config:
      clusterAccess:
        connectionString: couchbase://\${defaultHostname}
        username: Administrator
        password: password
        tls: null
`);
  assert.equal(def.instances[0]?.clusters[0]?.clusterConfig, "cluster-0");
  assert.equal(def.instances[0]?.clusters[0]?.sessions[0]?.runs[0]?.fitConfig, "fit-config-0");
  assert.equal(def.clusterConfigs?.[0]?.id, "cluster-0");
  assert.equal(def.fitConfigs?.[0]?.id, "fit-config-0");
});

test("rejects clusterConfig mixed with inline cluster fields", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
instances:
  - localhost: {}
    clusters:
      - clusterConfig: "cluster-0"
        cbdinocluster:
          config:
            nodes:
              - count: 1
                version: 8.1.0-2188
                services: [kv]
        sessions:
          - performer:
              sdk: java
            runs:
              - type: functional
                tests:
                  run: all
clusterConfigs: []
`),
    (err: unknown) => err instanceof InvalidDefinitionError && /mix/.test(err.message),
  );
});

test("rejects duplicate clusterConfigs ids", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
instances:
  - localhost: {}
    clusters:
      - clusterConfig: "cluster-0"
        sessions:
          - performer:
              sdk: java
            runs:
              - type: functional
                tests:
                  run: all
clusterConfigs:
  - id: "cluster-0"
    cbdinocluster:
      config:
        nodes:
          - count: 1
            version: 8.1.0-2188
            services: [kv]
  - id: "cluster-0"
    cbdinocluster:
      config:
        nodes:
          - count: 1
            version: 8.1.0-2188
            services: [kv]
`),
    (err: unknown) => err instanceof InvalidDefinitionError && /[Dd]uplicate/.test(err.message),
  );
});

test("rejects duplicate fitConfigs ids", () => {
  assert.throws(
    () =>
      parseDefinition(`
version: 1
type: fit
instances:
  - localhost: {}
    clusters:
      - connection:
          connectionString: couchbase://localhost
          username: Administrator
          password: password
        sessions:
          - performer:
              sdk: java
            runs:
              - type: functional
                tests:
                  run: all
fitConfigs:
  - id: "fit-config-0"
    config:
      key: value
  - id: "fit-config-0"
    config:
      key: other
`),
    (err: unknown) => err instanceof InvalidDefinitionError && /[Dd]uplicate/.test(err.message),
  );
});
