import assert from "node:assert/strict";
import test from "node:test";
import { buildFitFunctionalDefinition, formatFitFunctionalDefinition } from "../generate-definition.js";
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

test("buildFitFunctionalDefinition maps an all-tests guided run", () => {
  assert.deepEqual(
    buildFitFunctionalDefinition(sdk, cluster, buildDefaultFitTestSelection()),
    {
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
