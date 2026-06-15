import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveConnectionCluster,
  resolveDefinition,
  resolveDefinitionRefs,
  resolveFitConfigCluster,
  resolveMavenArgs,
  resolveSession,
  resolveSituationalMavenArgs,
} from "../resolve-definition.js";
import {
  DEFAULT_MAVEN_TEST_ARGS,
  SITUATIONAL_MAVEN_TEST_ARGS,
} from "../../run-test-driver/run-test-driver.js";
import { DEFAULT_PERFORMER_PORT } from "../../../performers/util/performer-port.js";
import type { FitDefinition, SessionLifetime } from "../types.js";

const LOCAL_FIT_CONFIG = {
  clusterAccess: {
    connectionString: "couchbase://localhost",
    username: "Administrator",
    password: "password",
    tls: null,
  },
};

function definition(): FitDefinition {
  return {
    version: 1,
    type: "fit",
    instances: [
      {
        localhost: {},
        clusters: [
          {
            connection: {
              connectionString: "couchbase://localhost",
              username: "Administrator",
              password: "password",
              tls: null,
            },
            sessions: [
              {
                performer: { sdk: "java" },
                runs: [{ type: "functional", tests: {}, fitConfig: { excludeTests: ["openshift"] } }],
              },
            ],
          },
        ],
      },
    ],
  };
}

test("resolves a cluster.connection cluster", () => {
  const cluster = resolveConnectionCluster({
    connectionString: "couchbase://localhost",
    username: "Administrator",
    password: "password",
    tls: null,
  });
  assert.deepEqual(cluster, {
    scheme: "couchbase",
    defaultHostname: "localhost",
    flavour: "self-managed",
    credentials: { username: "Administrator", password: "password" },
    tls: null,
  });
});

test("resolves a cluster fitConfig clusterAccess block", () => {
  const cluster = resolveFitConfigCluster(LOCAL_FIT_CONFIG);
  assert.equal(cluster?.defaultHostname, "localhost");
});

test("resolveDefinition preserves instance, cluster, session, and run nesting", () => {
  const resolved = resolveDefinition(definition());
  assert.equal(resolved.instances.length, 1);
  assert.equal(resolved.instances[0]?.clusters.length, 1);
  assert.equal(resolved.instances[0]?.clusters[0]?.sessions.length, 1);
  assert.equal(resolved.instances[0]?.clusters[0]?.sessions[0]?.runs.length, 1);
});

test("resolveSession applies performer defaults and strips redundant clusterAccess for connection mode", () => {
  const resolved = resolveSession(
    {
      performer: { sdk: "java" },
      runs: [
        {
          type: "functional",
          fitConfig: {
            clusterAccess: LOCAL_FIT_CONFIG.clusterAccess,
            excludeTests: ["openshift"],
          },
          tests: {},
        },
      ],
    } satisfies SessionLifetime,
    { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0 },
    true,
  );
  assert.equal(resolved.performerPort, DEFAULT_PERFORMER_PORT);
  assert.deepEqual(resolved.runs[0]?.fitConfig, { excludeTests: ["openshift"] });
});

test("resolveDefinition uses run-level fitConfig for useExisting clusters", () => {
  const resolved = resolveDefinition({
    version: 1,
    type: "fit",
    instances: [
      {
        localhost: {},
        clusters: [
          {
            useExisting: {},
            sessions: [{ performer: { sdk: "java" }, runs: [{ type: "functional", tests: {}, fitConfig: LOCAL_FIT_CONFIG }] }],
          },
        ],
      },
    ],
  });
  assert.equal(resolved.instances[0]?.clusters[0]?.clusterMode, "useExisting");
  assert.equal(resolved.instances[0]?.clusters[0]?.cluster?.defaultHostname, "localhost");
});

test("excludedGroups override the default Maven args", () => {
  assert.deepEqual(resolveMavenArgs({ excludedGroups: ["situational", "openshift"] }), [
    "-DexcludedGroups=situational,openshift",
  ]);
});

test("omitting excludedGroups keeps the default Maven args", () => {
  assert.deepEqual(resolveMavenArgs({}), [...DEFAULT_MAVEN_TEST_ARGS]);
});

test("situational runs use the situational Maven args", () => {
  assert.deepEqual(resolveSituationalMavenArgs({}), [...SITUATIONAL_MAVEN_TEST_ARGS]);
  assert.deepEqual(resolveSituationalMavenArgs({ excludedGroups: ["openshift"] }), [
    "-Dgroups=situational,cbDino",
    "-DexcludedGroups=openshift",
  ]);
});

test("resolveDefinitionRefs replaces clusterConfig string ref with inline fields", () => {
  const def = resolveDefinitionRefs({
    version: 1,
    type: "fit",
    instances: [
      {
        localhost: {},
        clusters: [
          {
            clusterConfig: "cluster-0",
            sessions: [{ performer: { sdk: "java" }, runs: [{ type: "functional", tests: {} }] }],
          },
        ],
      },
    ],
    clusterConfigs: [
      {
        id: "cluster-0",
        cbdinocluster: {
          config: { nodes: [{ count: 1, version: "8.1.0-2188", services: ["kv"] }] },
        },
      },
    ],
  });
  const cluster = def.instances[0]?.clusters[0];
  assert.ok(cluster?.cbdinocluster, "ref should be replaced with inline cbdinocluster");
  assert.equal(cluster?.clusterConfig, undefined);
  assert.equal(def.clusterConfigs, undefined);
});

test("resolveDefinitionRefs replaces fitConfig string ref with inline config", () => {
  const fitConfigData = { clusterAccess: { connectionString: "couchbase://localhost", username: "Administrator", password: "password", tls: null } };
  const def = resolveDefinitionRefs({
    version: 1,
    type: "fit",
    instances: [
      {
        localhost: {},
        clusters: [
          {
            connection: { connectionString: "couchbase://localhost", username: "Administrator", password: "password", tls: null },
            sessions: [{ performer: { sdk: "java" }, runs: [{ type: "functional", fitConfig: "fit-config-0", tests: {} }] }],
          },
        ],
      },
    ],
    fitConfigs: [{ id: "fit-config-0", config: fitConfigData }],
  });
  const run = def.instances[0]?.clusters[0]?.sessions[0]?.runs[0];
  assert.deepEqual(run?.fitConfig, fitConfigData);
  assert.equal(def.fitConfigs, undefined);
});

test("resolveDefinitionRefs throws on unknown clusterConfig ref", () => {
  assert.throws(
    () =>
      resolveDefinitionRefs({
        version: 1,
        type: "fit",
        instances: [
          {
            localhost: {},
            clusters: [
              {
                clusterConfig: "nonexistent",
                sessions: [{ performer: { sdk: "java" }, runs: [{ type: "functional", tests: {} }] }],
              },
            ],
          },
        ],
      }),
    /nonexistent/,
  );
});

test("resolveDefinitionRefs throws on unknown fitConfig ref", () => {
  assert.throws(
    () =>
      resolveDefinitionRefs({
        version: 1,
        type: "fit",
        instances: [
          {
            localhost: {},
            clusters: [
              {
                connection: { connectionString: "couchbase://localhost", username: "Administrator", password: "password", tls: null },
                sessions: [{ performer: { sdk: "java" }, runs: [{ type: "functional", fitConfig: "nonexistent", tests: {} }] }],
              },
            ],
          },
        ],
      }),
    /nonexistent/,
  );
});
