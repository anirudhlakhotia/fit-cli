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
 *   npx tsx src/cluster/cluster-create/build-cluster-def.ts
 *
 * Prints a sample def.
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";

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

export interface CbdinoclusterDockerDef {
  "kv-memory"?: number;
  "index-memory"?: number;
  "fts-memory"?: number;
  "cbas-memory"?: number;
  "eventing-memory"?: number;
}

/**
 * Default per-service RAM quota (MB) we emit for the docker deployer. cbdinocluster's
 * own defaults are small — too small for FIT tests that create large buckets (e.g.
 * TenThousandCollectionsTest asks for a 2048 MB/node bucket, which on a 3-node
 * cluster fails the default quota). Matches the value fit-app-deployment uses on CI.
 */
export const DOCKER_SERVICE_MEMORY_MB = 4096;

/**
 * The docker RAM-quota block for a service list. Only kv and fts get a quota —
 * those are the services FIT's large-bucket tests exercise and the ones the CI
 * definitions raise; everything else keeps cbdinocluster's defaults. Returns
 * undefined when the cluster runs neither, so we don't emit an empty `docker`.
 */
function dockerMemoryForServices(services: string[]): CbdinoclusterDockerDef | undefined {
  const docker: CbdinoclusterDockerDef = {};
  if (services.includes("kv")) docker["kv-memory"] = DOCKER_SERVICE_MEMORY_MB;
  if (services.includes("fts")) docker["fts-memory"] = DOCKER_SERVICE_MEMORY_MB;
  return Object.keys(docker).length > 0 ? docker : undefined;
}

/** The cbdinocluster definition as a structured object (what goes under `config`). */
export interface CbdinoclusterDef {
  nodes: { count: number; version: string; services: string[] }[];
  /** Present only when CNG/Protostellar support is wanted. */
  cao?: { "operator-version": string; "gateway-version": string };
  /** Per-service RAM quotas for the docker deployer; omitted for other deployers. */
  docker?: CbdinoclusterDockerDef;
}

/**
 * Build the cbdinocluster definition as a structured object, rather than the YAML
 * string {@link buildClusterDef} produces. Used when the def is embedded in a
 * larger document (e.g. a fit definition file's
 * `setup.cluster.cbdinocluster.config`) rather than written out on its own.
 *
 * For the docker deployer (everything but CNG, which uses cao) we also emit
 * sensible per-service RAM quotas so generated definitions don't hit "RAM quota
 * specified is too large to be provisioned into this cluster" on large-bucket
 * tests. Hand-edit the `docker` block to tune them.
 */
export function buildClusterDefObject(def: ClusterDef): CbdinoclusterDef {
  const docker = def.cng ? undefined : dockerMemoryForServices(def.services);
  return {
    nodes: [{ count: def.nodeCount, version: def.version, services: def.services }],
    ...(def.cng
      ? { cao: { "operator-version": CAO_OPERATOR_VERSION, "gateway-version": CAO_GATEWAY_VERSION } }
      : {}),
    ...(docker ? { docker } : {}),
  };
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
