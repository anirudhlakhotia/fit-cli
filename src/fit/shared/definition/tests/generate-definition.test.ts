import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFitDefinition,
  buildFitFunctionalDefinition,
  buildFitFunctionalDefinitionFrom,
  buildFitSituationalDefinitionFrom,
  formatFitDefinition,
} from "../generate-definition.js";
import { parseDefinition } from "../parse-definition.js";
import {
  buildDefaultFitTestSelection,
  buildFitTestSelectionFromClassNames,
} from "../../select-fit-tests/select-fit-tests.js";
import type { SelectedCluster } from "../../../../cluster/cluster-select/cluster-select.js";
import { sdkByValue } from "../../../../util/sdk/sdks.js";

const sdk = sdkByValue("java");
if (!sdk) {
  throw new Error("Expected the java SDK to exist.");
}

const cluster: SelectedCluster = {
  scheme: "couchbase",
  defaultHostname: "localhost",
  flavour: "self-managed",
  credentials: { username: "Administrator", password: "password" },
  tls: null,
};

test("buildFitFunctionalDefinition emits one instance with one cluster, session, and run", () => {
  const definition = buildFitFunctionalDefinition(sdk, cluster, buildDefaultFitTestSelection());
  assert.equal(definition.instances.length, 1);
  assert.equal(definition.instances[0]?.clusters.length, 1);
  assert.equal(definition.instances[0]?.clusters[0]?.sessions.length, 1);
  assert.equal(definition.instances[0]?.clusters[0]?.sessions[0]?.runs[0]?.type, "functional");
});

test("buildFitFunctionalDefinitionFrom records a cbdinocluster in clusterConfigs (no fitConfig blob)", () => {
  const definition = buildFitFunctionalDefinitionFrom({
    cluster: {
      kind: "cbdinocluster",
      def: { nodeCount: 2, version: "8.1.0-2188", services: ["kv", "n1ql", "index"], cng: false },
    },
    sdk,
    version: "1.2.3",
    gerritRef: "refs/changes/29/246329/1",
    selection: buildDefaultFitTestSelection(),
  });

  assert.equal(definition.setup?.repos?.["transactions-fit-performer"]?.gerritRef, "refs/changes/29/246329/1");
  assert.equal(definition.instances[0]?.clusters[0]?.sessions[0]?.performer.image, "java-fit-performer:1.2.3");

  // Cluster uses a ref, not inline fields
  assert.equal(definition.instances[0]?.clusters[0]?.clusterConfig, "cluster-0");
  assert.equal(definition.instances[0]?.clusters[0]?.cbdinocluster, undefined);

  // cbdinocluster details live in clusterConfigs
  assert.equal(definition.clusterConfigs?.[0]?.id, "cluster-0");
  assert.equal(definition.clusterConfigs?.[0]?.cbdinocluster?.config.nodes[0]?.count, 2);

  // The docker deployer gets a per-service RAM quota emitted automatically (kv
  // here; fts would be added too if selected) so generated definitions don't hit
  // "RAM quota specified is too large" on large-bucket tests.
  assert.deepEqual(definition.clusterConfigs?.[0]?.cbdinocluster?.config.docker, { "kv-memory": 4096 });

  // cbdinocluster init is NOT emitted for non-CNG clusters — args are generated at runtime.
  assert.equal(definition.instances[0]?.setup, undefined);

  // No fitConfig ref on the run — the FIT config is fully generated at runtime.
  assert.equal(definition.instances[0]?.clusters[0]?.sessions[0]?.runs[0]?.fitConfig, undefined);
  assert.equal(definition.fitConfigs, undefined);
});

test("buildFitSituationalDefinitionFrom emits clusterless sessions", () => {
  const definition = buildFitSituationalDefinitionFrom({
    sdk,
    onPortInUse: "reuse",
    databaseMode: "hosted",
    selection: buildDefaultFitTestSelection(),
  });
  assert.equal(definition.instances[0]?.clusterlessSessions?.[0]?.performer.onPortInUse, "reuse");
  assert.equal(definition.instances[0]?.clusterlessSessions?.[0]?.runs[0]?.type, "situational");
});

test("buildFitDefinition remains round-trippable through the parser (JSON5)", () => {
  const functionalDef = buildFitFunctionalDefinitionFrom({
    cluster: { kind: "connection", cluster },
    sdk,
    selection: buildDefaultFitTestSelection(),
  });
  const functionalInstance = functionalDef.instances[0];
  const situationalInstance = buildFitSituationalDefinitionFrom({
    sdk,
    version: "1.2.3",
    databaseMode: "local",
    selection: buildFitTestSelectionFromClassNames([
      "com.couchbase.situational.tests.VolumeTest#steadyStateKvGets",
    ]),
  }).instances[0];
  if (!functionalInstance || !situationalInstance) {
    throw new Error("Expected generated definitions to contain one instance.");
  }
  const definition = buildFitDefinition({
    gerritRef: "refs/changes/29/246329/1",
    instances: [functionalInstance, situationalInstance],
    clusterConfigs: functionalDef.clusterConfigs,
  });

  assert.deepEqual(parseDefinition(formatFitDefinition(definition, "json5")), definition);
  assert.deepEqual(parseDefinition(formatFitDefinition(definition, "yaml"), "yaml"), definition);
});

test("formatFitDefinition includes the nested instances key (JSON5)", () => {
  const rendered = formatFitDefinition(
    buildFitFunctionalDefinitionFrom({
      cluster: { kind: "connection", cluster },
      sdk,
      selection: buildDefaultFitTestSelection(),
    }),
    "json5",
  );

  assert.match(rendered, /instances:/);
  assert.doesNotMatch(rendered, /fitConfigs:/);
});

test("formatFitDefinition never leaks comment markers into the output", () => {
  const functional = buildFitFunctionalDefinitionFrom({
    cluster: { kind: "cbdinocluster", def: { cng: false, nodeCount: 1, version: "7.6.0", services: ["kv"] } },
    sdk,
    githubUser: "octocat",
    selection: buildDefaultFitTestSelection(),
  });
  const situational = buildFitSituationalDefinitionFrom({
    sdk,
    databaseMode: "hosted",
    selection: buildDefaultFitTestSelection(),
  });
  for (const definition of [functional, situational]) {
    for (const format of ["json5", "yaml"] as const) {
      const rendered = formatFitDefinition(definition, format);
      assert.doesNotMatch(rendered, /\/\/[0-9a-z]{6}/, `${format} output should not contain marker keys`);
    }
  }
});

test("formatFitSituationalDefinition comments the clusterless sessions", () => {
  const rendered = formatFitDefinition(
    buildFitSituationalDefinitionFrom({ sdk, databaseMode: "hosted", selection: buildDefaultFitTestSelection() }),
    "json5",
  );
  assert.match(rendered, /\/\/ Sessions not tied to any particular cluster/);
  // cbdinocluster init args are no longer in the definition file
  assert.doesNotMatch(rendered, /--aws-region /);
});

test("buildFitFunctionalDefinition emits a preset placeholder when the selection has presets", () => {
  const allNonTransactions: Parameters<typeof buildFitFunctionalDefinition>[2] = {
    allTests: [],
    selectedTests: [],
    mavenTestSelector: "com.couchbase.client.kv.SanityTest",
    presets: ["all-non-transactions"],
  };
  const definition = buildFitFunctionalDefinition(sdk, cluster, allNonTransactions);
  const run = definition.instances[0]?.clusters[0]?.sessions[0]?.runs[0];
  assert.deepEqual(run?.tests.presets, ["all-non-transactions"]);

  const allTransactions: Parameters<typeof buildFitFunctionalDefinition>[2] = {
    allTests: [],
    selectedTests: [],
    mavenTestSelector: "com.couchbase.transactions.FooTest",
    presets: ["all-transactions"],
  };
  const defTxn = buildFitFunctionalDefinition(sdk, cluster, allTransactions);
  const runTxn = defTxn.instances[0]?.clusters[0]?.sessions[0]?.runs[0];
  assert.deepEqual(runTxn?.tests.presets, ["all-transactions"]);

  // round-trip: the placeholder parses cleanly
  assert.deepEqual(parseDefinition(formatFitDefinition(definition, "json5")), definition);
  assert.deepEqual(parseDefinition(formatFitDefinition(defTxn, "yaml"), "yaml"), defTxn);
});

test("formatFitDefinition includes the nested instances key (YAML)", () => {
  const rendered = formatFitDefinition(
    buildFitFunctionalDefinitionFrom({
      cluster: { kind: "connection", cluster },
      sdk,
      selection: buildDefaultFitTestSelection(),
    }),
    "yaml",
  );

  assert.match(rendered, /instances:/);
  assert.doesNotMatch(rendered, /fitConfigs:/);
});
