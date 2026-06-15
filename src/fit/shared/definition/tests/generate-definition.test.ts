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

test("buildFitFunctionalDefinitionFrom records a cbdinocluster in clusterConfigs and fitConfig in fitConfigs", () => {
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
  assert.equal(definition.instances[0]?.clusters[0]?.sessions[0]?.performer.version, "1.2.3");

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

  // cbdinocluster init is set up once per instance, under instance.setup — not on
  // the cluster config. The docker path carries an editable args string, not config.
  assert.equal((definition.clusterConfigs?.[0]?.cbdinocluster as unknown as { init?: unknown } | undefined)?.init, undefined);
  const init = definition.instances[0]?.setup?.cbdinocluster?.init;
  assert.equal(init?.config, undefined);
  assert.match(init?.args ?? "", /^--auto\b/);
  assert.match(init?.args ?? "", /--docker-network fit/);
  // Credentials are appended at runtime, never baked into the definition.
  assert.doesNotMatch(init?.args ?? "", /--github-token/);

  // Run uses a ref, not an inline fitConfig object
  assert.equal(definition.instances[0]?.clusters[0]?.sessions[0]?.runs[0]?.fitConfig, "fit-config-0");

  // fitConfig details live in fitConfigs
  assert.equal(definition.fitConfigs?.[0]?.id, "fit-config-0");
  const fitConfig = definition.fitConfigs?.[0]?.config as Record<string, unknown> | undefined;
  assert.ok(fitConfig, "cbdinocluster cluster should have a fitConfig template in fitConfigs");
  const access = fitConfig?.clusterAccess as Record<string, unknown>;
  assert.equal(access.connectionString, "couchbase://${defaultHostname}");
  assert.deepEqual(access.rest, { hostname: "${defaultHostname}", resolveDnsSrv: false });
  assert.deepEqual(access.proxy, { hostname: "host.docker.internal" });
  assert.deepEqual(fitConfig.excludeTests, ["situational"]);
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
    fitConfigs: functionalDef.fitConfigs,
  });

  assert.deepEqual(parseDefinition(formatFitDefinition(definition, "json5")), definition);
  assert.deepEqual(parseDefinition(formatFitDefinition(definition, "yaml"), "yaml"), definition);
});

test("formatFitDefinition includes the nested instances key and fitConfigs comment (JSON5)", () => {
  const rendered = formatFitDefinition(
    buildFitFunctionalDefinitionFrom({
      cluster: { kind: "connection", cluster },
      sdk,
      selection: buildDefaultFitTestSelection(),
    }),
    "json5",
  );

  assert.match(rendered, /fitConfigs:/);
  assert.match(rendered, /\/\/ Each fitConfig is used as a base when generating FITConfiguration\.json/);
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

test("formatFitSituationalDefinition comments the clusterless sessions and runtime fields", () => {
  const rendered = formatFitDefinition(
    buildFitSituationalDefinitionFrom({ sdk, databaseMode: "hosted", selection: buildDefaultFitTestSelection() }),
    "json5",
  );
  assert.match(rendered, /\/\/ Sessions not tied to any particular cluster/);
  assert.match(rendered, /\/\/ fit-cli will inject performerPorts at runtime\./);
  assert.match(rendered, /\/\/ Merged onto ~\/\.cbdinocluster after `cbdinocluster init` runs/);
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

test("formatFitDefinition includes the nested instances key and fitConfigs comment (YAML)", () => {
  const rendered = formatFitDefinition(
    buildFitFunctionalDefinitionFrom({
      cluster: { kind: "connection", cluster },
      sdk,
      selection: buildDefaultFitTestSelection(),
    }),
    "yaml",
  );

  assert.match(rendered, /instances:/);
  assert.match(rendered, /# Each fitConfig is used as a base when generating FITConfiguration\.json/);
});
