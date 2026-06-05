import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFitFunctionalDefinition,
  buildFitFunctionalDefinitionFrom,
  formatFitFunctionalDefinition,
} from "../generate-definition.js";
import { parseDefinition } from "../parse-definition.js";
import { buildDefaultFitTestSelection, buildFitTestSelectionFromClassNames } from "../../../fit-shared/select-fit-tests/index.js";
import type { SelectedCluster } from "../../../cluster/cluster-select/index.js";
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
      type: "fit-mix",
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
      iterations: [
        {
          type: "functional",
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
  assert.match(rendered, /type: fit-mix/);
  assert.match(rendered, /- type: functional/);
  assert.match(rendered, /connection:/);
  assert.match(rendered, /already-running cluster/i);
});

test("buildFitFunctionalDefinitionFrom emits a cbdinocluster block and pins the version", () => {
  const definition = buildFitFunctionalDefinitionFrom({
    cluster: {
      kind: "cbdinocluster",
      def: { nodeCount: 2, version: "8.1.0-2188", services: ["kv", "n1ql", "index"], cng: false },
    },
    sdk,
    version: "1.2.3",
    selection: buildDefaultFitTestSelection(),
  });

  assert.deepEqual(definition, {
    version: 1,
    type: "fit-mix",
    setup: {
      cluster: {
        cbdinocluster: {
          config: {
            nodes: [{ count: 2, version: "8.1.0-2188", services: ["kv", "n1ql", "index"] }],
          },
        },
      },
    },
    iterations: [
      {
        type: "functional",
        setup: { performer: { sdk: "java", version: "1.2.3" } },
        runtime: { tests: "all" },
      },
    ],
  });

  // The cbdinocluster block survives a round-trip through the parser.
  assert.deepEqual(parseDefinition(formatFitFunctionalDefinition(definition)), definition);
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
    config: {
      nodes: [{ count: 1, version: "8.1.0-2188", services: ["kv"] }],
      cao: { "operator-version": "2.8.0", "gateway-version": "1.1.0-135" },
    },
  });
});
