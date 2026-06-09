export const DEFAULT_PERFORMER_PORT = 8060;

/**
 * What to do when the performer port is already in use as a run starts:
 * - `fail`    — stop the run rather than touch whatever is there.
 * - `restart` — stop the existing process/container, then bring up a fresh
 *               performer. The default: the safest behaviour for CI.
 * - `reuse`   — assume a performer is already running and test against it,
 *               leaving it alone (convenient for local development).
 */
export const PORT_IN_USE_POLICIES = ["fail", "restart", "reuse"] as const;
export type PortInUsePolicy = (typeof PORT_IN_USE_POLICIES)[number];

/** The policy applied when a definition doesn't specify one. */
export const DEFAULT_PORT_IN_USE_POLICY: PortInUsePolicy = "reuse";
