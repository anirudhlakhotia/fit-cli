import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFitDefinition,
  buildFitFunctionalDefinition,
  buildFitFunctionalDefinitionFrom,
  buildFunctionalCycleFrom,
  buildFunctionalIterationFrom,
  buildSituationalCycleFrom,
  buildSituationalIterationFrom,
  formatFitDefinition,
} from "../generate-definition.js";
import { parseDefinition } from "../parse-definition.js";
import {
  buildDefaultFitTestSelection,
  buildFitTestSelectionFromClassNames,
} from "../../../fit-shared/select-fit-tests/select-fit-tests.js";
import type { SelectedCluster } from "../../../cluster/cluster-select/cluster-select.js";
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

test("buildFitFunctionalDefinition wraps the iteration in one functional cycle", () => {
  assert.deepEqual(
    buildFitFunctionalDefinition(sdk, cluster, buildDefaultFitTestSelection()),
    {
      version: 1,
      type: "fit",
      cycles: [
        {
          type: "functional",
          cluster: {
            useExisting: {},
          },
          iterations: [
            {
              fitConfig: {
                clusterAccess: {
                  connectionString: "couchbase://localhost",
                  username: "Administrator",
                  password: "password",
                  tls: null,
                },
              },
              setup: {
                performer: { sdk: "java" },
              },
              runtime: { tests: "all" },
            },
          ],
        },
      ],
    },
  );
});

test("buildFitFunctionalDefinitionFrom records a cbdinocluster on the cycle", () => {
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
  assert.equal(definition.cycles[0]?.type, "functional");
  assert.equal(definition.cycles[0]?.cluster.cbdinocluster?.config.nodes[0]?.count, 2);
  assert.equal(definition.cycles[0]?.iterations[0]?.setup.performer.version, "1.2.3");
});

test("buildSituationalIterationFrom omits any cbdino block", () => {
  assert.deepEqual(
    buildSituationalIterationFrom({
      sdk,
      onPortInUse: "reuse",
      databaseMode: "hosted",
      selection: buildDefaultFitTestSelection(),
    }),
    {
      setup: {
        performer: {
          sdk: "java",
          onPortInUse: "reuse",
        },
      },
      situational: {
        database: { mode: "hosted" },
      },
      runtime: { tests: "all" },
    },
  );
});

test("buildFitDefinition supports separate functional and situational cycles", () => {
  const definition = buildFitDefinition({
    gerritRef: "refs/changes/29/246329/1",
    cycles: [
      buildFunctionalCycleFrom({
        cluster: { kind: "connection", cluster },
        sdk,
        selection: buildDefaultFitTestSelection(),
      }),
      buildSituationalCycleFrom({
        sdk,
        version: "1.2.3",
        databaseMode: "local",
        selection: buildFitTestSelectionFromClassNames([
          "com.couchbase.situational.tests.VolumeTest#steadyStateKvGets",
        ]),
      }),
    ],
  });

  assert.deepEqual(parseDefinition(formatFitDefinition(definition)), definition);
});

test("formatFitDefinition annotates fitConfig and cbdinocluster init blocks", () => {
  const rendered = formatFitDefinition(
    buildFitDefinition({
      cycles: [
        buildFunctionalCycleFrom({
          cluster: {
            kind: "cbdinocluster",
            def: { nodeCount: 1, version: "8.1.0-2188", services: ["kv"], cng: false },
          },
          sdk,
          selection: buildDefaultFitTestSelection(),
          iterations: [
            buildFunctionalIterationFrom({
              cluster: { kind: "connection", cluster },
              sdk,
              selection: buildDefaultFitTestSelection(),
            }),
          ],
        }),
      ],
    }),
  );

  assert.match(rendered, /cycles:/);
  assert.match(rendered, /# This will be used as a base when generating FITConfiguration\.json/);
  assert.match(rendered, /# This file will be uploaded verbatim into clean environments as ~\/\.cbdinocluster/);
});
