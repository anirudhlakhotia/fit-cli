import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFitFunctionalDefinition,
  buildFitFunctionalDefinitionFrom,
  formatFitFunctionalDefinition,
} from "../generate-definition.js";
import { parseDefinition } from "../parse-definition.js";
import { buildDefaultFitTestSelection, buildFitTestSelectionFromClassNames } from "../../../fit-shared/select-fit-tests/select-fit-tests.js";
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

test("buildFitFunctionalDefinition maps an all-tests guided run to one iteration", () => {
  assert.deepEqual(
    buildFitFunctionalDefinition(sdk, cluster, buildDefaultFitTestSelection()),
    {
      version: 1,
      type: "fit",
      setup: {
        cluster: {
          useExisting: {},
        },
      },
      iterations: [
        {
          type: "functional",
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
  );
});

test("formatFitFunctionalDefinition round-trips an explicit test selection", () => {
  const definition = buildFitFunctionalDefinition(
    sdk,
    {
      ...cluster,
      scheme: "couchbases",
      defaultHostname: "cb.example.com",
      flavour: "internal-capella",
      tls: { certPath: "/tmp/cb.pem" },
    },
    buildFitTestSelectionFromClassNames([
      "com.couchbase.StandardTest",
      "com.couchbase.OtherTest",
    ]),
  );

  assert.deepEqual(parseDefinition(formatFitFunctionalDefinition(definition)), definition);
});

test("formatFitFunctionalDefinition annotates shared cluster connection details", () => {
  const rendered = formatFitFunctionalDefinition(
    buildFitFunctionalDefinition(sdk, cluster, buildDefaultFitTestSelection()),
  );
  assert.match(rendered, /type: fit/);
  assert.match(rendered, /- type: functional/);
  assert.match(rendered, /useExisting: \{\}/);
  assert.match(
    rendered,
    /# This will be used as a base when generating FITConfiguration\.json\. {2}Anything here will be copied into the config \(unless overwritten by fit-cli\)\n\s+fitConfig:/,
  );
  assert.match(rendered, /clusterAccess:/);
  assert.doesNotMatch(rendered, /\$1#/);
  assert.doesNotMatch(rendered, /\$1fitConfig:/);
});

test("buildFitFunctionalDefinitionFrom emits a cbdinocluster block and top-level repo Gerrit ref", () => {
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

  assert.deepEqual(definition, {
    version: 1,
    type: "fit",
    setup: {
      cluster: {
        cbdinocluster: {
          init: {
            config: {
              version: 6,
              docker: {
                enabled: true,
                network: "fit",
              },
            },
          },
          config: {
            nodes: [{ count: 2, version: "8.1.0-2188", services: ["kv", "n1ql", "index"] }],
          },
        },
      },
      repos: {
        "transactions-fit-performer": {
          gerritRef: "refs/changes/29/246329/1",
        },
      },
    },
    iterations: [
      {
        type: "functional",
        setup: {
          performer: {
            sdk: "java",
            version: "1.2.3",
          },
        },
        runtime: { tests: "all" },
      },
    ],
  });

  // The cbdinocluster block survives a round-trip through the parser.
  assert.deepEqual(parseDefinition(formatFitFunctionalDefinition(definition)), definition);
});

test("buildFitFunctionalDefinitionFrom records the cluster- and port-exists policies when given", () => {
  const definition = buildFitFunctionalDefinitionFrom({
    cluster: {
      kind: "cbdinocluster",
      def: { nodeCount: 1, version: "8.1.0-2188", services: ["kv"], cng: false },
    },
    sdk,
    onClusterExists: "useExisting",
    onPortInUse: "reuse",
    selection: buildDefaultFitTestSelection(),
  });

  assert.equal(definition.setup?.cluster?.cbdinocluster?.onClusterExists, "useExisting");
  assert.equal(definition.iterations[0]?.setup.performer.onPortInUse, "reuse");

  const rendered = formatFitFunctionalDefinition(definition);
  assert.match(rendered, /onClusterExists: useExisting/);
  assert.match(rendered, /onPortInUse: reuse/);
  // The policies survive a round-trip through the parser.
  assert.deepEqual(parseDefinition(rendered), definition);
});

test("buildFitFunctionalDefinitionFrom omits onClusterExists for a useExisting (connection) cluster", () => {
  const definition = buildFitFunctionalDefinitionFrom({
    cluster: { kind: "connection", cluster },
    sdk,
    onClusterExists: "destroyAndRecreate",
    selection: buildDefaultFitTestSelection(),
  });

  assert.equal(definition.setup?.cluster?.cbdinocluster, undefined);
  assert.equal(definition.setup?.cluster?.useExisting !== undefined, true);
});

test("buildFitFunctionalDefinitionFrom adds a cao block for CNG clusters", () => {
  const definition = buildFitFunctionalDefinitionFrom({
    cluster: {
      kind: "cbdinocluster",
      def: { nodeCount: 1, version: "8.1.0-2188", services: ["kv"], cng: true },
    },
    sdk,
    selection: buildDefaultFitTestSelection(),
  });

  assert.deepEqual(definition.setup?.cluster?.cbdinocluster, {
    init: {
      config: {
        version: 6,
        docker: {
          enabled: true,
          network: "fit",
        },
      },
    },
    config: {
      nodes: [{ count: 1, version: "8.1.0-2188", services: ["kv"] }],
      cao: { "operator-version": "2.8.0", "gateway-version": "1.1.0-135" },
    },
  });
});

test("formatFitFunctionalDefinition annotates cbdinocluster init config uploads", () => {
  const rendered = formatFitFunctionalDefinition(
    buildFitFunctionalDefinitionFrom({
      cluster: {
        kind: "cbdinocluster",
        def: { nodeCount: 1, version: "8.1.0-2188", services: ["kv"], cng: false },
      },
      sdk,
      selection: buildDefaultFitTestSelection(),
    }),
  );

  assert.match(
    rendered,
    /# This file will be uploaded verbatim into clean environments as ~\/\.cbdinocluster\n\s+config:/,
  );
});
