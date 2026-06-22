/**
 * Step: if cbdinocluster is installed, offer to auto-detect the clusters it
 * already has running, let the user pick one, and resolve its connection string
 * — so they don't have to look up and type a connection string by hand.
 *
 * cbdinocluster is looked for via the fit-cli config (cbdinoclusterPath /
 * CBDINOCLUSTER_PATH env var) and then on the PATH. If it isn't found we simply
 * skip this shortcut. If it is, we run `cbdinocluster ps` to list clusters, then
 * `cbdinocluster connstr <id>` for the one the user picks.
 *
 * Run on its own:
 *   bun src/cluster/cluster-select/detect-cbdinocluster.ts
 *
 * Prints the chosen cluster as JSON, or "(none)".
 */
import { isMain, runCli } from "../../util/non-fit/cli.js";
import { confirm, select } from "../../util/non-fit/prompts.js";
import { capture } from "../../util/non-fit/proc.js";
import { findOnPath } from "../../util/non-fit/which.js";
import { resolveCbdinoclusterPath } from "../../fit/util/config.js";
import { parseClusterIds, type CbdinoCluster } from "./parse-cluster-ids.js";
import { parseConnstr } from "./parse-connstr.js";

/** The bare command name we look for on the PATH. */
const CBDINOCLUSTER = "cbdinocluster";

/** A running cbdinocluster cluster the user picked, ready to connect to. */
export interface DetectedCluster {
  /** The cluster's UUID. */
  id: string;
  /** Its connection string, from `cbdinocluster connstr`, e.g. couchbase://172.18.0.2. */
  connectionString: string;
}

/**
 * Look for cbdinocluster (via config, then PATH) and, if it's found, offer to
 * list the clusters it currently has running, let the user pick one, and resolve
 * its connection string. Returns null if cbdinocluster isn't found, the user
 * declined, there's nothing running, or resolving the connection string failed.
 */
export async function detectCbdinocluster(): Promise<DetectedCluster | null> {
  const cbdinoPath = resolveCbdinoclusterPath() ?? findOnPath(CBDINOCLUSTER);
  if (!cbdinoPath) {
    return null;
  }

  const autodetect = await confirm({
    promptId: "cluster.detect-cbdinocluster.confirm",
    message: "cbdinocluster is installed — look for clusters it already has running?",
  });
  if (!autodetect) {
    return null;
  }

  let clusters: CbdinoCluster[];
  try {
    clusters = parseClusterIds(await capture(cbdinoPath, ["ps"]));
  } catch (err) {
    console.error(`✗ Couldn't list cbdinocluster clusters: ${(err as Error).message}`);
    return null;
  }

  if (clusters.length === 0) {
    console.log("→ cbdinocluster isn't running any clusters.");
    return null;
  }

  const id = await select<string>({
    promptId: "cluster.detect-cbdinocluster.select-cluster",
    message: "Which cbdinocluster cluster do you want to use?",
    choices: clusters.map((cluster) => ({
      name: `${cluster.id}  [${cluster.details}]`,
      value: cluster.id,
    })),
  });

  let connectionString: string | null;
  try {
    connectionString = parseConnstr(await capture(cbdinoPath, ["connstr", id]));
  } catch (err) {
    console.error(`✗ Couldn't get the connection string for ${id}: ${(err as Error).message}`);
    return null;
  }

  if (!connectionString) {
    console.error(`✗ cbdinocluster didn't return a connection string for ${id}.`);
    return null;
  }

  console.log(`→ Using ${connectionString}`);
  return { id, connectionString };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const detected = await detectCbdinocluster();
    console.log(detected ? JSON.stringify(detected, null, 2) : "(none)");
  });
}
