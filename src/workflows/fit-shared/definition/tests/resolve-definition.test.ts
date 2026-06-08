/**
 * Unit tests for resolving a definition into concrete run inputs.
 *
 * Run on their own:
 *   npm test
 *   node --import tsx --test src/workflows/fit-shared/definition/tests/resolve-definition.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveDefinition,
  resolveConnectionCluster,
  resolveFitConfigCluster,
  resolveIteration,
  resolveMavenArgs,
  resolveSituationalCbdino,
  resolveSituationalMavenArgs,
} from "../resolve-definition.js";
import {
  DEFAULT_MAVEN_TEST_ARGS,
  SITUATIONAL_MAVEN_TEST_ARGS,
} from "../../../fit-shared/run-test-driver/run-test-driver.js";
import { DEFAULT_CBDINO_SETTINGS } from "../../../fit-shared/fit-configuration/build-situational-configuration.js";
import { DEFAULT_PERFORMER_PORT } from "../../../performers/util/performer-port.js";
import type { FitDefinition, FunctionalIteration, SituationalIteration } from "../types.js";

function situationalIteration(overrides: {
  sdk?: string;
  mode?: "hosted" | "local";
  cbdinoVersion?: string;
  excludedGroups?: string[];
} = {}): SituationalIteration {
  return {
    type: "situational",
    setup: {
      performer: {
        sdk: (overrides.sdk ?? "java") as SituationalIteration["setup"]["performer"]["sdk"],
      },
    },
    situational: {
      ...(overrides.cbdinoVersion !== undefined ? { cbdino: { version: overrides.cbdinoVersion } } : {}),
      database: { mode: overrides.mode ?? "hosted" },
    },
    runtime: {
      tests: "all",
      ...(overrides.excludedGroups !== undefined ? { excludedGroups: overrides.excludedGroups } : {}),
    },
  };
}

const LOCAL_FIT_CONFIG = {
  clusterAccess: {
    connectionString: "couchbase://localhost",
    username: "Administrator",
    password: "password",
    tls: null,
  },
};

function iteration(overrides: {
  sdk?: string;
  port?: number;
  performerVersion?: string;
  onPortInUse?: FunctionalIteration["setup"]["performer"]["onPortInUse"];
  tests?: FunctionalIteration["runtime"]["tests"];
  excludedGroups?: string[];
  fitConfig?: FunctionalIteration["fitConfig"];
} = {}): FunctionalIteration {
  return {
    type: "functional",
    ...(overrides.fitConfig !== undefined ? { fitConfig: overrides.fitConfig } : {}),
    setup: {
      performer: {
        sdk: (overrides.sdk ?? "java") as FunctionalIteration["setup"]["performer"]["sdk"],
        ...(overrides.port !== undefined ? { port: overrides.port } : {}),
        ...(overrides.performerVersion !== undefined ? { version: overrides.performerVersion } : {}),
        ...(overrides.onPortInUse !== undefined ? { onPortInUse: overrides.onPortInUse } : {}),
      },
    },
    runtime: {
      tests: overrides.tests ?? "all",
      ...(overrides.excludedGroups !== undefined ? { excludedGroups: overrides.excludedGroups } : {}),
    },
  };
}

function definition(overrides: Partial<FitDefinition> = {}): FitDefinition {
  return {
    version: 1,
    type: "fit",
    setup: {
      cluster: {
        connection: {
          connectionString: "couchbase://localhost",
          username: "Administrator",
          password: "password",
          tls: null,
        },
      },
    },
    iterations: [iteration({ fitConfig: LOCAL_FIT_CONFIG })],
    ...overrides,
  };
}

test("resolves the existing cluster from setup.cluster.connection", () => {
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

test("resolves the legacy existing cluster from fitConfig", () => {
  const cluster = resolveFitConfigCluster(LOCAL_FIT_CONFIG);
  assert.deepEqual(cluster, {
    scheme: "couchbase",
    defaultHostname: "localhost",
    flavour: "self-managed",
    credentials: { username: "Administrator", password: "password" },
    tls: null,
  });
});

test("classifies a Capella connection string and passes tls through", () => {
  const cluster = resolveFitConfigCluster({
    clusterAccess: {
      connectionString: "couchbases://cb.abc.cloud.couchbase.com",
      username: "u",
      password: "p",
      tls: { insecure: true },
    },
  });
  assert.equal(cluster?.scheme, "couchbases");
  assert.equal(cluster?.flavour, "production-capella");
  assert.equal(cluster?.defaultHostname, "cb.abc.cloud.couchbase.com");
  assert.deepEqual(cluster?.tls, { insecure: true });
});

test("a cbdinocluster-only setup keeps the allocation settings", () => {
  const resolved = resolveDefinition(
    definition({
      setup: {
        cluster: {
          cbdinocluster: {
            init: {
              config: {
                version: 6,
                docker: { enabled: "true", network: "fit" },
              },
            },
            config: { nodes: [{ count: 1, version: "8.1.0-2188", services: ["kv"] }] },
          },
        },
      },
    }),
  );
  assert.equal(resolved.clusterMode, "cbdinocluster");
  assert.deepEqual(resolved.cbdinocluster, {
    init: {
      config: {
        version: 6,
        docker: { enabled: "true", network: "fit" },
      },
    },
    config: { nodes: [{ count: 1, version: "8.1.0-2188", services: ["kv"] }] },
    onClusterExists: "destroyAndRecreate",
  });
  const [first] = resolved.iterations;
  assert.equal(first.type === "functional" ? first.cluster : undefined, undefined);
});

test("an omitted shared setup resolves to no cluster mode", () => {
  const resolved = resolveDefinition(definition({ setup: undefined }));
  assert.equal(resolved.clusterMode, undefined);
  assert.equal(resolved.cbdinocluster, undefined);
});

test("the performer port defaults to the standard port", () => {
  assert.equal(resolveIteration(iteration()).type, "functional");
  assert.equal(resolveIteration(iteration()).performerPort, DEFAULT_PERFORMER_PORT);
  assert.equal(resolveIteration(iteration({ port: 9999 })).performerPort, 9999);
});

test("tests: all produces no Maven test selector", () => {
  assert.equal(resolveIteration(iteration()).testSelection.mavenTestSelector, undefined);
});

test("an explicit test list becomes a comma-joined selector", () => {
  const resolved = resolveIteration(
    iteration({ tests: ["com.couchbase.StandardTest", "com.couchbase.OtherTest"] }),
  );
  assert.equal(
    resolved.testSelection.mavenTestSelector,
    "com.couchbase.StandardTest,com.couchbase.OtherTest",
  );
  assert.equal(resolved.testSelection.selectedTests.length, 2);
  assert.equal(resolved.testSelection.selectedTests[0].fileName, "StandardTest");
});

test("excludedGroups override the default Maven args", () => {
  assert.deepEqual(resolveMavenArgs({ tests: "all", excludedGroups: ["situational", "openshift"] }), [
    "-DexcludedGroups=situational,openshift",
  ]);
});

test("omitting excludedGroups keeps the default Maven args", () => {
  assert.deepEqual(resolveMavenArgs({ tests: "all" }), [...DEFAULT_MAVEN_TEST_ARGS]);
});

test("onPortInUse defaults to restart and is carried through when present", () => {
  assert.equal(resolveIteration(iteration()).onPortInUse, "restart");
  assert.equal(resolveIteration(iteration({ onPortInUse: "reuse" })).onPortInUse, "reuse");
  assert.equal(resolveIteration(iteration({ onPortInUse: "fail" })).onPortInUse, "fail");
});

test("performerVersion is carried through when present", () => {
  assert.equal(resolveIteration(iteration({ performerVersion: "1.2.3" })).performerVersion, "1.2.3");
  assert.equal(resolveIteration(iteration()).performerVersion, undefined);
});

test("top-level fit performer Gerrit ref is carried through when present", () => {
  const resolved = resolveDefinition(
    definition({
      setup: {
        cluster: {
          connection: {
            connectionString: "couchbase://localhost",
            username: "Administrator",
            password: "password",
            tls: null,
          },
        },
        repos: {
          "transactions-fit-performer": {
            gerritRef: "refs/changes/29/246329/1",
          },
        },
      },
    }),
  );
  assert.equal(
    resolved.fitPerformerGerritRef,
    "refs/changes/29/246329/1",
  );
  assert.equal(resolveDefinition(definition()).fitPerformerGerritRef, undefined);
});

test("resolveDefinition resolves every iteration", () => {
  const resolved = resolveDefinition(
    definition({
      iterations: [
        iteration({ sdk: "java", fitConfig: LOCAL_FIT_CONFIG }),
        iteration({ sdk: "python", fitConfig: LOCAL_FIT_CONFIG }),
      ],
    }),
  );
  assert.equal(resolved.iterations.length, 2);
  assert.equal(resolved.clusterMode, "connection");
  assert.deepEqual(
    resolved.iterations.map((r) => r.sdk.value),
    ["java", "python"],
  );
  assert.deepEqual(
    resolved.iterations.map((r) => (r.type === "functional" ? r.cluster?.defaultHostname : undefined)),
    ["localhost", "localhost"],
  );
});

test("connection mode strips redundant fitConfig.clusterAccess but keeps other fields", () => {
  const resolved = resolveDefinition(
    definition({
      iterations: [
        iteration({
          fitConfig: {
            clusterAccess: LOCAL_FIT_CONFIG.clusterAccess,
            excludeTests: ["openshift"],
          },
        }),
      ],
    }),
  );
  const [first] = resolved.iterations;
  assert.deepEqual(first.fitConfig, { excludeTests: ["openshift"] });
  assert.equal(first.type === "functional" ? first.cluster?.defaultHostname : undefined, "localhost");
});

test("resolves a situational iteration with cbdino defaults and the situational Maven args", () => {
  const resolved = resolveIteration(situationalIteration());
  assert.equal(resolved.type, "situational");
  assert.ok(resolved.type === "situational");
  assert.deepEqual(resolved.cbdino, DEFAULT_CBDINO_SETTINGS);
  assert.equal(resolved.databaseMode, "hosted");
  assert.deepEqual(resolved.extraMavenArgs, [...SITUATIONAL_MAVEN_TEST_ARGS]);
});

test("a situational iteration carries through its cbdino version and database mode", () => {
  const resolved = resolveIteration(situationalIteration({ cbdinoVersion: "7.2", mode: "local" }));
  assert.ok(resolved.type === "situational");
  assert.equal(resolved.cbdino.version, "7.2");
  assert.equal(resolved.databaseMode, "local");
});

test("resolveSituationalCbdino fills in the defaults for omitted fields", () => {
  assert.deepEqual(resolveSituationalCbdino(undefined), DEFAULT_CBDINO_SETTINGS);
  assert.deepEqual(resolveSituationalCbdino({ version: "8.0" }), {
    ...DEFAULT_CBDINO_SETTINGS,
    version: "8.0",
  });
});

test("situational excludedGroups override the default exclusions but keep the groups filter", () => {
  assert.deepEqual(resolveSituationalMavenArgs({ tests: "all", excludedGroups: ["openshift"] }), [
    "-Dgroups=situational,cbDino",
    "-DexcludedGroups=openshift",
  ]);
});

test("a situational-only definition resolves to no cluster mode and attaches no cluster", () => {
  const resolved = resolveDefinition({
    version: 1,
    type: "fit",
    iterations: [situationalIteration()],
  });
  assert.equal(resolved.clusterMode, undefined);
  const [first] = resolved.iterations;
  assert.equal(first.type, "situational");
  assert.equal("cluster" in first, false);
});

test("a shared connection cluster is not attached to situational iterations in a mixed file", () => {
  const resolved = resolveDefinition(
    definition({
      iterations: [iteration({ fitConfig: LOCAL_FIT_CONFIG }), situationalIteration({ sdk: "python" })],
    }),
  );
  assert.equal(resolved.clusterMode, "connection");
  const [functional, situational] = resolved.iterations;
  assert.equal(functional.type === "functional" ? functional.cluster?.defaultHostname : undefined, "localhost");
  assert.equal("cluster" in situational, false);
});

test("rejects an unknown SDK", () => {
  assert.throws(() => resolveIteration(iteration({ sdk: "cobol" })), /Unknown sdk/);
});

test("rejects a fitConfig connection string fit-cli can't use", () => {
  assert.throws(
    () =>
      resolveFitConfigCluster({
        clusterAccess: {
          connectionString: "couchbase2://localhost",
          username: "u",
          password: "p",
          tls: null,
        },
      }),
    /not one fit-cli\s+can use/,
  );
});

test("rejects a useExisting iteration without fitConfig clusterAccess", () => {
  assert.throws(
    () => resolveDefinition(definition({ setup: { cluster: { useExisting: {} } }, iterations: [iteration()] })),
    /fitConfig\.clusterAccess/,
  );
});
