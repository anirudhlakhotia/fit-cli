import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildExecutionGroups,
  resolveConnectionCluster,
  resolveDefinition,
  resolveDefinitionRefs,
  resolveFitConfigCluster,
  resolveMavenArgs,
  resolveInstancePlan,
  resolveSession,
  resolveSituationalMavenArgs,
} from "../resolve-definition.js";
import {
  DEFAULT_MAVEN_TEST_ARGS,
  SITUATIONAL_MAVEN_TEST_ARGS,
} from "../../run-test-driver/run-test-driver.js";
import { DEFAULT_PERFORMER_PORT } from "../../../performers/util/performer-port.js";
import type { FitDefinition, InstanceLifetime, SessionLifetime } from "../types.js";

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
                performer: { image: "java-fit-performer:main" },
                runs: [{ type: "functional", tests: {}, fitConfig: { config: { excludeTests: ["openshift"] } } }],
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
  const cluster = resolveFitConfigCluster({ config: LOCAL_FIT_CONFIG });
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
      performer: { image: "java-fit-performer:main" },
      runs: [
        {
          type: "functional",
          fitConfig: {
            config: {
              clusterAccess: LOCAL_FIT_CONFIG.clusterAccess,
              excludeTests: ["openshift"],
            },
          },
          tests: {},
        },
      ],
    } satisfies SessionLifetime,
    { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0 },
    true,
  );
  assert.equal(resolved.performerPort, DEFAULT_PERFORMER_PORT);
  assert.deepEqual(resolved.runs[0]?.fitConfig, { config: { excludeTests: ["openshift"] } });
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
            sessions: [{ performer: { image: "java-fit-performer:main" }, runs: [{ type: "functional", tests: {}, fitConfig: { config: LOCAL_FIT_CONFIG } }] }],
          },
        ],
      },
    ],
  });
  assert.equal(resolved.instances[0]?.clusters[0]?.clusterMode, "useExisting");
  assert.equal(resolved.instances[0]?.clusters[0]?.cluster?.defaultHostname, "localhost");
});

test("packages are expanded to Maven wildcard selectors", () => {
  const resolved = resolveDefinition({
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
                performer: { image: "java-fit-performer:main" },
                runs: [{ type: "functional", tests: { packages: ["com.couchbase.client.kv", "com.couchbase.transactions"] } }],
              },
            ],
          },
        ],
      },
    ],
  });
  const testSelection = resolved.instances[0]?.clusters[0]?.sessions[0]?.runs[0]?.testSelection;
  assert.equal(testSelection?.mavenTestSelector, "com.couchbase.client.kv.*,com.couchbase.transactions.*");
});

test("packages combined with classes produce a unified selector", () => {
  const resolved = resolveDefinition({
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
                performer: { image: "java-fit-performer:main" },
                runs: [{ type: "functional", tests: { packages: ["com.couchbase.client.kv"], classes: ["com.couchbase.other.ExplicitTest"] } }],
              },
            ],
          },
        ],
      },
    ],
  });
  const testSelection = resolved.instances[0]?.clusters[0]?.sessions[0]?.runs[0]?.testSelection;
  assert.equal(testSelection?.mavenTestSelector, "com.couchbase.other.ExplicitTest,com.couchbase.client.kv.*");
});

test("excludedGroups override the default Maven args", () => {
  assert.deepEqual(resolveMavenArgs({ excludedGroups: ["situational", "openshift"] }), [
    "-DexcludedGroups=situational,openshift",
  ]);
});

test("omitting excludedGroups keeps the default Maven args", () => {
  assert.deepEqual(resolveMavenArgs({}), [...DEFAULT_MAVEN_TEST_ARGS]);
});

test("addToDefaultExcludedGroups appends to the default functional exclusions", () => {
  assert.deepEqual(resolveMavenArgs({ addToDefaultExcludedGroups: ["protostellarWillWorkLater"] }), [
    "-DexcludedGroups=situational,openshift,syncgateway,protostellarWillWorkLater",
  ]);
});

test("addToDefaultExcludedGroups appends to the default situational exclusions", () => {
  assert.deepEqual(resolveSituationalMavenArgs({ addToDefaultExcludedGroups: ["protostellarWillWorkLater"] }), [
    "-Dgroups=situational,cbDino",
    "-DexcludedGroups=openshift,capella,protostellarWillWorkLater",
  ]);
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
            sessions: [{ performer: { image: "java-fit-performer:main" }, runs: [{ type: "functional", tests: {} }] }],
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
            sessions: [{ performer: { image: "java-fit-performer:main" }, runs: [{ type: "functional", fitConfig: "fit-config-0", tests: {} }] }],
          },
        ],
      },
    ],
    fitConfigs: [{ id: "fit-config-0", config: fitConfigData }],
  });
  const run = def.instances[0]?.clusters[0]?.sessions[0]?.runs[0];
  assert.deepEqual(run?.fitConfig, { config: fitConfigData });
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
                sessions: [{ performer: { image: "java-fit-performer:main" }, runs: [{ type: "functional", tests: {} }] }],
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
                sessions: [{ performer: { image: "java-fit-performer:main" }, runs: [{ type: "functional", fitConfig: "nonexistent", tests: {} }] }],
              },
            ],
          },
        ],
      }),
    /nonexistent/,
  );
});

test("dirSegments are populated through instance → cluster → session → run", () => {
  const instance: InstanceLifetime = {
    aws: {},
    clusters: [
      {
        cbdinocluster: { config: { nodes: [{ version: "8.0-stable", count: 1, services: ["kv"] }] } },
        sessions: [
          {
            performer: { image: "java-fit-performer:main" },
            runs: [{ type: "functional", tests: { presets: ["standard-qe"] } }],
          },
        ],
      },
    ],
  };
  const plan = resolveInstancePlan(instance, 0);
  const groups = buildExecutionGroups([plan]);
  const group = groups[0];
  assert.ok(group);
  assert.equal(group.path.dirSegments?.instance, "aws1");
  assert.equal(group.path.dirSegments?.cluster, "8.0-stable");
  const run = group.runs[0];
  assert.ok(run);
  assert.equal(run.path.dirSegments?.instance, "aws1");
  assert.equal(run.path.dirSegments?.cluster, "8.0-stable");
  assert.equal(run.path.dirSegments?.session, "java:main");
  assert.equal(run.path.dirSegments?.run, "func:standard-qe");
});
