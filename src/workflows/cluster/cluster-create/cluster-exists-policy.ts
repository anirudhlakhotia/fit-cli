/**
 * What to do when cbdinocluster already has a cluster running as a
 * definition-driven (non-interactive) run reaches its setup-cluster step. This
 * is the cluster-side counterpart to the performer's port-in-use policy
 * (see ../../performers/performer-port.ts): the file decides up front instead of
 * the tool prompting.
 *
 * Like the performer, setup-cluster does *not* check that an existing cluster
 * matches the definition's desired spec — `useExisting` simply trusts that the
 * cluster already there is the one to test against.
 */

/**
 * - `fail`               — stop the run rather than touch an existing cluster.
 * - `useExisting`        — trust the cluster already running is the right one and
 *                          test against it, leaving it alone.
 * - `destroyAndRecreate` — remove any existing cluster(s) and allocate a fresh
 *                          one. The default: a clean, repeatable cluster each run.
 */
export const CLUSTER_EXISTS_POLICIES = ["fail", "useExisting", "destroyAndRecreate"] as const;
export type ClusterExistsPolicy = (typeof CLUSTER_EXISTS_POLICIES)[number];

/** The policy applied when a definition's cbdinocluster block doesn't specify one. */
export const DEFAULT_CLUSTER_EXISTS_POLICY: ClusterExistsPolicy = "destroyAndRecreate";
