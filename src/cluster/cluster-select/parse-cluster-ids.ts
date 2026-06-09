/**
 * parseClusterIds — pull the cluster UUIDs out of `cbdinocluster ps` output.
 * Pure string logic, so it can be unit tested (see tests/parse-cluster-ids.test.ts).
 *
 * The output looks like:
 *
 *   Clusters:
 *     df45d6d0-cfbe-4905-bc8c-989a09c03817 [Type: server, State: ready, ...]
 *       4e9e2165-6fb6-4114-bf44-aba0ed02a25e   172.18.0.2   f58b3be1...
 *
 * The first UUID on each cluster line is followed by a `[...]` summary; the more
 * deeply indented lines are that cluster's nodes (UUID then an IP, no brackets).
 * We want the cluster UUIDs, which is exactly the lines carrying the brackets.
 */

/** A cluster cbdinocluster currently has running. */
export interface CbdinoCluster {
  /** The cluster's UUID, as passed to other cbdinocluster commands. */
  id: string;
  /** The bracketed summary, e.g. "Type: server, State: ready, Deployer: docker". */
  details: string;
}

const CLUSTER_LINE =
  /^\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+\[(.+)\]\s*$/i;

/**
 * Extract the running clusters from `cbdinocluster ps` output, in the order they
 * appear. Node lines and the surrounding log/header noise are ignored.
 */
export function parseClusterIds(psOutput: string): CbdinoCluster[] {
  const clusters: CbdinoCluster[] = [];
  for (const line of psOutput.split("\n")) {
    const match = CLUSTER_LINE.exec(line);
    if (match) {
      clusters.push({ id: match[1], details: match[2].trim() });
    }
  }
  return clusters;
}
