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

test("buildFitDefinition remains round-trippable through the parser", () => {
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

  assert.deepEqual(parseDefinition(formatFitDefinition(definition)), definition);
});

test("formatFitDefinition includes the nested instances key and fitConfigs comment", () => {
  const rendered = formatFitDefinition(
    buildFitFunctionalDefinitionFrom({
      cluster: { kind: "connection", cluster },
      sdk,
      selection: buildDefaultFitTestSelection(),
    }),
  );

  assert.match(rendered, /instances:/);
  assert.match(rendered, /# Each fitConfig is used as a base when generating FITConfiguration\.json/);
});
