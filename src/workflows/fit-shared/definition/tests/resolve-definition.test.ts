/**
 * Unit tests for resolving a definition into concrete run inputs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveConnectionCluster,
  resolveCycle,
  resolveDefinition,
  resolveFitConfigCluster,
  resolveFunctionalIteration,
  resolveMavenArgs,
  resolveSituationalIteration,
  resolveSituationalMavenArgs,
} from "../resolve-definition.js";
import {
  DEFAULT_MAVEN_TEST_ARGS,
  SITUATIONAL_MAVEN_TEST_ARGS,
} from "../../../fit-shared/run-test-driver/run-test-driver.js";
import { DEFAULT_PERFORMER_PORT } from "../../../performers/util/performer-port.js";
import type {
  FitDefinition,
  FunctionalCycle,
  FunctionalIteration,
  SituationalCycle,
  SituationalIteration,
} from "../types.js";

const LOCAL_FIT_CONFIG = {
  clusterAccess: {
    connectionString: "couchbase://localhost",
    username: "Administrator",
    password: "password",
    tls: null,
  },
};

function functionalIteration(overrides: {
  sdk?: string;
  port?: number;
  performerVersion?: string;
  onPortInUse?: FunctionalIteration["setup"]["performer"]["onPortInUse"];
  tests?: FunctionalIteration["runtime"]["tests"];
  excludedGroups?: string[];
  maven?: FunctionalIteration["runtime"]["maven"];
  fitConfig?: FunctionalIteration["fitConfig"];
} = {}): FunctionalIteration {
  return {
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
      ...(overrides.maven !== undefined ? { maven: overrides.maven } : {}),
    },
  };
}

function situationalIteration(overrides: {
  sdk?: string;
  mode?: "hosted" | "local";
  excludedGroups?: string[];
  maven?: SituationalIteration["runtime"]["maven"];
} = {}): SituationalIteration {
  return {
    setup: {
      performer: {
        sdk: (overrides.sdk ?? "java") as SituationalIteration["setup"]["performer"]["sdk"],
      },
    },
    situational: {
      database: { mode: overrides.mode ?? "hosted" },
    },
    runtime: {
      tests: "all",
      ...(overrides.excludedGroups !== undefined ? { excludedGroups: overrides.excludedGroups } : {}),
      ...(overrides.maven !== undefined ? { maven: overrides.maven } : {}),
    },
  };
}

function functionalCycle(overrides: Partial<FunctionalCycle> = {}): FunctionalCycle {
  return {
    type: "functional",
    cluster: {
      connection: {
        connectionString: "couchbase://localhost",
        username: "Administrator",
        password: "password",
        tls: null,
      },
    },
    iterations: [functionalIteration({ fitConfig: LOCAL_FIT_CONFIG })],
    ...overrides,
  };
}

function definition(overrides: Partial<FitDefinition> = {}): FitDefinition {
  return {
    version: 1,
    type: "fit",
    cycles: [functionalCycle()],
    ...overrides,
  };
}

test("resolves a cycle.connection cluster", () => {
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

test("resolves a fitConfig clusterAccess block", () => {
  const cluster = resolveFitConfigCluster(LOCAL_FIT_CONFIG);
  assert.equal(cluster?.defaultHostname, "localhost");
});

test("resolves a functional cycle in connection mode and strips redundant clusterAccess", () => {
  const resolved = resolveCycle(
    functionalCycle({
      iterations: [
        functionalIteration({
          fitConfig: {
            clusterAccess: LOCAL_FIT_CONFIG.clusterAccess,
            excludeTests: ["openshift"],
          },
        }),
      ],
    }),
  );
  assert.equal(resolved.type, "functional");
  assert.equal(resolved.clusterMode, "connection");
  assert.deepEqual(resolved.iterations[0]?.fitConfig, { excludeTests: ["openshift"] });
  assert.equal(resolved.iterations[0]?.cluster?.defaultHostname, "localhost");
});

test("resolves a cbdinocluster functional cycle", () => {
  const resolved = resolveCycle(
    functionalCycle({
      cluster: {
        cbdinocluster: {
          config: { nodes: [{ count: 1, version: "8.1.0-2188", services: ["kv"] }] },
        },
      },
    }),
  );
  assert.equal(resolved.type, "functional");
  assert.equal(resolved.clusterMode, "cbdinocluster");
  assert.equal(resolved.cbdinocluster?.onClusterExists, "destroyAndRecreate");
  assert.equal(resolved.iterations[0]?.cluster, undefined);
});

const CBDINOCLUSTER_INIT_CONFIG = { version: 6, docker: { enabled: true, network: "fit" } };

test("resolves a situational cycle and exposes cbdinoclusterInit", () => {
  const resolved = resolveCycle({
    type: "situational",
    cbdinocluster: { init: { config: CBDINOCLUSTER_INIT_CONFIG } },
    iterations: [situationalIteration({ mode: "local" })],
  } satisfies SituationalCycle);
  assert.equal(resolved.type, "situational");
  assert.equal(resolved.iterations[0]?.databaseMode, "local");
  assert.deepEqual(resolved.cbdinoclusterInit, { config: CBDINOCLUSTER_INIT_CONFIG });
});

test("resolveDefinition preserves separate cycles", () => {
  const resolved = resolveDefinition(
    definition({
      setup: {
        repos: {
          "transactions-fit-performer": {
            gerritRef: "refs/changes/29/246329/1",
          },
        },
      },
      cycles: [
        functionalCycle({
          iterations: [
            functionalIteration({ sdk: "java", fitConfig: LOCAL_FIT_CONFIG }),
            functionalIteration({ sdk: "python", fitConfig: LOCAL_FIT_CONFIG }),
          ],
        }),
        {
          type: "situational",
          cbdinocluster: { init: { config: CBDINOCLUSTER_INIT_CONFIG } },
          iterations: [situationalIteration({ sdk: "node" })],
        },
      ],
    }),
  );

  assert.equal(resolved.fitPerformerGerritRef, "refs/changes/29/246329/1");
  assert.deepEqual(resolved.cycles.map((cycle) => cycle.type), ["functional", "situational"]);
  assert.deepEqual(
    resolved.cycles[0]?.type === "functional"
      ? resolved.cycles[0].iterations.map((iteration) => iteration.sdk.value)
      : [],
    ["java", "python"],
  );
});

test("functional iteration defaults the performer port", () => {
  const resolved = resolveFunctionalIteration(functionalIteration());
  assert.equal(resolved.performerPort, DEFAULT_PERFORMER_PORT);
});

test("tests: all produces no Maven test selector", () => {
  assert.equal(resolveFunctionalIteration(functionalIteration()).testSelection.mavenTestSelector, undefined);
});

test("an explicit test list becomes a comma-joined selector", () => {
  const resolved = resolveFunctionalIteration(
    functionalIteration({ tests: ["com.couchbase.StandardTest", "com.couchbase.OtherTest"] }),
  );
  assert.equal(
    resolved.testSelection.mavenTestSelector,
    "com.couchbase.StandardTest,com.couchbase.OtherTest",
  );
});

test("excludedGroups override the default Maven args", () => {
  assert.deepEqual(resolveMavenArgs({ tests: "all", excludedGroups: ["situational", "openshift"] }), [
    "-DexcludedGroups=situational,openshift",
  ]);
});

test("omitting excludedGroups keeps the default Maven args", () => {
  assert.deepEqual(resolveMavenArgs({ tests: "all" }), [...DEFAULT_MAVEN_TEST_ARGS]);
});

test("situational runs use the situational Maven args", () => {
  assert.deepEqual(resolveSituationalIteration(situationalIteration()).extraMavenArgs, [...SITUATIONAL_MAVEN_TEST_ARGS]);
  assert.deepEqual(resolveSituationalMavenArgs({ tests: "all", excludedGroups: ["openshift"] }), [
    "-Dgroups=situational,cbDino",
    "-DexcludedGroups=openshift",
  ]);
});

test("maven.runDisabledTests appends the JUnit DisabledCondition deactivation flag", () => {
  assert.deepEqual(resolveMavenArgs({ tests: "all", maven: { runDisabledTests: true } }), [
    ...DEFAULT_MAVEN_TEST_ARGS,
    "-Djunit.jupiter.conditions.deactivate=org.junit.jupiter.api.condition.DisabledCondition",
  ]);
  assert.deepEqual(resolveSituationalMavenArgs({ tests: "all", maven: { runDisabledTests: true } }), [
    ...SITUATIONAL_MAVEN_TEST_ARGS,
    "-Djunit.jupiter.conditions.deactivate=org.junit.jupiter.api.condition.DisabledCondition",
  ]);
});

test("maven.args are appended verbatim after the base args", () => {
  assert.deepEqual(resolveMavenArgs({ tests: "all", maven: { args: ["-Dsome.flag=true"] } }), [
    ...DEFAULT_MAVEN_TEST_ARGS,
    "-Dsome.flag=true",
  ]);
});

test("maven.runDisabledTests and maven.args combine in order", () => {
  assert.deepEqual(
    resolveMavenArgs({ tests: "all", maven: { runDisabledTests: true, args: ["-Dextra=1"] } }),
    [
      ...DEFAULT_MAVEN_TEST_ARGS,
      "-Djunit.jupiter.conditions.deactivate=org.junit.jupiter.api.condition.DisabledCondition",
      "-Dextra=1",
    ],
  );
});

test("rejects a useExisting cycle without fitConfig clusterAccess", () => {
  assert.throws(
    () =>
      resolveCycle(
        functionalCycle({
          cluster: { useExisting: {} },
          iterations: [functionalIteration()],
        }),
      ),
    /fitConfig\.clusterAccess/,
  );
});

test("defaults a cycle's instance to localhost when execution is absent", () => {
  const resolved = resolveCycle(functionalCycle());
  assert.deepEqual(resolved.instance, { kind: "localhost" });
});

test("resolves an aws execution instance with its options", () => {
  const resolved = resolveCycle(
    functionalCycle({ execution: { instance: { aws: { instanceType: "c5.9xlarge", region: "us-east-1" } } } }),
  );
  assert.deepEqual(resolved.instance, { kind: "aws", instanceType: "c5.9xlarge", region: "us-east-1" });
});

test("resolves an explicit localhost execution instance", () => {
  const resolved = resolveCycle(functionalCycle({ execution: { instance: { localhost: {} } } }));
  assert.deepEqual(resolved.instance, { kind: "localhost" });
});
