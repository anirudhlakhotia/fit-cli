import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveConnectionCluster,
  resolveDefinition,
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
                runs: [{ type: "functional", tests: { run: "all" }, fitConfig: { excludeTests: ["openshift"] } }],
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
          tests: { run: "all" },
        },
      ],
    } satisfies SessionLifetime,
    { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0 },
    undefined,
    true,
  );
  assert.equal(resolved.performerPort, DEFAULT_PERFORMER_PORT);
  assert.deepEqual(resolved.runs[0]?.fitConfig, { excludeTests: ["openshift"] });
});

test("resolveDefinition uses cluster-level fitConfig for useExisting clusters", () => {
  const resolved = resolveDefinition({
    version: 1,
    type: "fit",
    instances: [
      {
        localhost: {},
        clusters: [
          {
            useExisting: {},
            fitConfig: LOCAL_FIT_CONFIG,
            sessions: [{ performer: { sdk: "java" }, runs: [{ type: "functional", tests: { run: "all" } }] }],
          },
        ],
      },
    ],
  });
  assert.equal(resolved.instances[0]?.clusters[0]?.clusterMode, "useExisting");
  assert.equal(resolved.instances[0]?.clusters[0]?.cluster?.defaultHostname, "localhost");
});

test("excludedGroups override the default Maven args", () => {
  assert.deepEqual(resolveMavenArgs({ run: "all", excludedGroups: ["situational", "openshift"] }), [
    "-DexcludedGroups=situational,openshift",
  ]);
});

test("omitting excludedGroups keeps the default Maven args", () => {
  assert.deepEqual(resolveMavenArgs({ run: "all" }), [...DEFAULT_MAVEN_TEST_ARGS]);
});

test("situational runs use the situational Maven args", () => {
  assert.deepEqual(resolveSituationalMavenArgs({ run: "all" }), [...SITUATIONAL_MAVEN_TEST_ARGS]);
  assert.deepEqual(resolveSituationalMavenArgs({ run: "all", excludedGroups: ["openshift"] }), [
    "-Dgroups=situational,cbDino",
    "-DexcludedGroups=openshift",
  ]);
});
