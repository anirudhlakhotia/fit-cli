/**
 * Step: build the cbdinocluster definition (a small YAML document) from the
 * answers gathered by ask-cluster-def. Pure logic — no file IO and no
 * prompting — so it's easy to unit test (see tests/build-cluster-def.test.ts).
 *
 * The shape produced is, for example:
 *
 *   nodes:
 *     - count: 1
 *       version: '8.1.0'
 *       services: [kv, n1ql, index, fts]
 *
 * and, when CNG/Protostellar support is wanted, additionally:
 *
 *   cao:
 *     operator-version: "2.8.0"
 *     gateway-version: "1.1.0-135"
 *
 * Run on its own:
 *   npx tsx src/workflows/cluster-create/build-cluster-def.ts
 *
 * Prints a sample def.
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";

/** The Couchbase Autonomous Operator versions used for CNG/Protostellar support. */
export const CAO_OPERATOR_VERSION = "2.8.0";
export const CAO_GATEWAY_VERSION = "1.1.0-135";

/** The answers that describe the cluster to allocate. */
export interface ClusterDef {
  /** Number of nodes in the cluster. */
  nodeCount: number;
  /** Couchbase Server version, e.g. "8.1.0". */
  version: string;
  /** Services to run on the node(s), e.g. ["kv", "n1ql", "index", "fts"]. */
  services: string[];
  /** Whether to add CNG/Protostellar (Cloud Native Gateway) support. */
  cng: boolean;
}

/** Render `def` as the cbdinocluster YAML definition document. */
export function buildClusterDef(def: ClusterDef): string {
  const lines = [
    "nodes:",
    `  - count: ${def.nodeCount}`,
    `    version: '${def.version}'`,
    `    services: [${def.services.join(", ")}]`,
  ];

  if (def.cng) {
    lines.push(
      "cao:",
      `  operator-version: "${CAO_OPERATOR_VERSION}"`,
      `  gateway-version: "${CAO_GATEWAY_VERSION}"`,
    );
  }

  return lines.join("\n") + "\n";
}

if (isMain(import.meta.url)) {
  runCli(() => {
    console.log(
      buildClusterDef({
        nodeCount: 1,
        version: "8.1.0",
        services: ["kv", "n1ql", "index", "fts"],
        cng: true,
      }),
    );
    return Promise.resolve();
  });
}
