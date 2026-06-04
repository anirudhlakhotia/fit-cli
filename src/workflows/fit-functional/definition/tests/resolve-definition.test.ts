/**
 * Unit tests for resolving a definition into concrete run inputs.
 *
 * Run on their own:
 *   npm test
 *   node --import tsx --test src/workflows/fit-functional/definition/tests/resolve-definition.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDefinition, resolveMavenArgs } from "../resolve-definition.js";
import { DEFAULT_MAVEN_TEST_ARGS } from "../../../fit-shared/run-test-driver/index.js";
import type { FitFunctionalDefinition } from "../types.js";

function definition(overrides: Partial<FitFunctionalDefinition> = {}): FitFunctionalDefinition {
  return {
    version: 1,
    type: "fit-functional-tests",
    sdk: "java",
    cluster: {
      connectionString: "couchbase://localhost",
      username: "Administrator",
      password: "password",
      tls: null,
    },
    tests: "all",
    ...overrides,
  };
}

test("resolves the SDK and a self-managed cluster", () => {
  const resolved = resolveDefinition(definition());
  assert.equal(resolved.sdk.value, "java");
  assert.deepEqual(resolved.cluster, {
    scheme: "couchbase",
    defaultHostname: "localhost",
    flavour: "self-managed",
    credentials: { username: "Administrator", password: "password" },
    tls: null,
  });
});

test("classifies a Capella connection string and passes tls through", () => {
  const resolved = resolveDefinition(
    definition({
      cluster: {
        connectionString: "couchbases://cb.abc.cloud.couchbase.com",
        username: "u",
        password: "p",
        tls: { insecure: true },
      },
    }),
  );
  assert.equal(resolved.cluster.scheme, "couchbases");
  assert.equal(resolved.cluster.flavour, "production-capella");
  assert.equal(resolved.cluster.defaultHostname, "cb.abc.cloud.couchbase.com");
  assert.deepEqual(resolved.cluster.tls, { insecure: true });
});

test("tests: all produces no Maven test selector", () => {
  const resolved = resolveDefinition(definition({ tests: "all" }));
  assert.equal(resolved.testSelection.mavenTestSelector, undefined);
});

test("an explicit test list becomes a comma-joined selector", () => {
  const resolved = resolveDefinition(
    definition({ tests: ["com.couchbase.StandardTest", "com.couchbase.OtherTest"] }),
  );
  assert.equal(
    resolved.testSelection.mavenTestSelector,
    "com.couchbase.StandardTest,com.couchbase.OtherTest",
  );
  assert.equal(resolved.testSelection.selectedTests.length, 2);
  assert.equal(resolved.testSelection.selectedTests[0].fileName, "StandardTest");
});

test("excludedGroups override the default Maven args", () => {
  assert.deepEqual(resolveMavenArgs(definition({ excludedGroups: ["situational", "openshift"] })), [
    "-DexcludedGroups=situational,openshift",
  ]);
});

test("omitting excludedGroups keeps the default Maven args", () => {
  assert.deepEqual(resolveMavenArgs(definition()), [...DEFAULT_MAVEN_TEST_ARGS]);
});

test("performerVersion is carried through when present", () => {
  assert.equal(resolveDefinition(definition({ performerVersion: "1.2.3" })).performerVersion, "1.2.3");
  assert.equal(resolveDefinition(definition()).performerVersion, undefined);
});

test("rejects an unknown SDK", () => {
  assert.throws(
    () => resolveDefinition(definition({ sdk: "cobol" as FitFunctionalDefinition["sdk"] })),
    /Unknown sdk/,
  );
});

test("rejects a connection string fit-cli can't use", () => {
  assert.throws(
    () =>
      resolveDefinition(
        definition({
          cluster: {
            connectionString: "couchbase2://localhost",
            username: "u",
            password: "p",
            tls: null,
          },
        }),
      ),
    /not one fit-cli can use/,
  );
});
