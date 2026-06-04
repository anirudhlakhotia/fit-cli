/**
 * Turn a validated {@link FitFunctionalDefinition} into the concrete inputs the
 * functional-test workflow needs: the SDK, a SelectedCluster, the FIT test
 * selection and the Maven args. Pure logic — no IO, no prompting — so the
 * mapping is easy to unit test (see tests/resolve-definition.test.ts).
 *
 * This is where the semantic checks live (is the SDK known? is the connection
 * string one we support?), as opposed to the structural checks in
 * parse-definition.ts.
 *
 * Run on its own (resolve a file and print the result as JSON):
 *   npx tsx src/workflows/fit-functional/definition/resolve-definition.ts <file.yaml>
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { classifyConnectionString } from "../../cluster/cluster-select/classify-connection-string.js";
import type { SelectedCluster } from "../../cluster/cluster-select/index.js";
import { SDKS, sdkByValue, type Sdk } from "../../../util/sdk/sdks.js";
import { DEFAULT_MAVEN_TEST_ARGS } from "../../fit-shared/run-test-driver/index.js";
import {
  buildDefaultFitTestSelection,
  buildFitTestSelectionFromClassNames,
  type FitTestSelection,
} from "../../fit-shared/select-fit-tests/index.js";
import { loadDefinition } from "./parse-definition.js";
import type { FitFunctionalDefinition } from "./types.js";

/** Everything a definition file resolves to, ready to drive the workflow. */
export interface ResolvedDefinition {
  sdk: Sdk;
  cluster: SelectedCluster;
  testSelection: FitTestSelection;
  /** Performer image version, if the file pinned one. */
  performerVersion?: string;
  /** Extra `./mvnw` args (the excludedGroups flag). */
  extraMavenArgs: string[];
}

/** Map the definition's `tests` field to a {@link FitTestSelection}. */
function resolveTestSelection(definition: FitFunctionalDefinition): FitTestSelection {
  return definition.tests === "all"
    ? buildDefaultFitTestSelection()
    : buildFitTestSelectionFromClassNames(definition.tests);
}

/** Turn the definition's optional excludedGroups into `./mvnw` args. */
export function resolveMavenArgs(definition: FitFunctionalDefinition): string[] {
  if (definition.excludedGroups === undefined) {
    return [...DEFAULT_MAVEN_TEST_ARGS];
  }
  return [`-DexcludedGroups=${definition.excludedGroups.join(",")}`];
}

/** Resolve a validated definition into the concrete run inputs. */
export function resolveDefinition(definition: FitFunctionalDefinition): ResolvedDefinition {
  const sdk = sdkByValue(definition.sdk);
  if (!sdk) {
    throw new Error(
      `Unknown sdk "${definition.sdk}". Valid values: ${SDKS.map((s) => s.value).join(", ")}.`,
    );
  }

  const classification = classifyConnectionString(definition.cluster.connectionString);
  if (classification.kind !== "supported") {
    throw new Error(
      `cluster.connectionString "${definition.cluster.connectionString}" is not one fit-cli can use ` +
        `(${classification.kind}). Use a couchbase:// or couchbases:// connection string.`,
    );
  }

  const cluster: SelectedCluster = {
    scheme: classification.scheme,
    defaultHostname: classification.defaultHostname,
    flavour: classification.flavour,
    credentials: { username: definition.cluster.username, password: definition.cluster.password },
    tls: definition.cluster.tls,
  };

  return {
    sdk,
    cluster,
    testSelection: resolveTestSelection(definition),
    ...(definition.performerVersion !== undefined ? { performerVersion: definition.performerVersion } : {}),
    extraMavenArgs: resolveMavenArgs(definition),
  };
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const path = process.argv[2];
    if (!path) {
      console.error("Usage: tsx src/workflows/fit-functional/definition/resolve-definition.ts <file.yaml>");
      process.exit(2);
    }
    const resolved = resolveDefinition(loadDefinition(path));
    console.log(JSON.stringify(resolved, null, 2));
    return Promise.resolve();
  });
}
