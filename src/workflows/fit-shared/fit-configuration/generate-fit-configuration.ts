/**
 * Step: turn a selected cluster into a FITConfiguration.json — build the config
 * and write it to a fresh file for passing to test-driver via `-Dfit.config`.
 *
 * Cluster selection itself lives in the reusable src/workflows/cluster-select
 * workflow; this step only deals with FIT configuration.
 *
 * Run on its own (this picks a cluster via the cluster-select workflow, then
 * generates its config; add --root <dir> to point elsewhere):
 *   npx tsx src/workflows/fit-shared/fit-configuration/generate-fit-configuration.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { selectOrCreateCluster } from "../../cluster/cluster-select-or-create/cluster-select-or-create.js";
import { type SelectedCluster } from "../../cluster/cluster-select/cluster-select.js";
import { DEFAULT_PERFORMER_PORT } from "../../performers/util/performer-port.js";
import { buildFitConfiguration } from "../../fit-functional/util/build-fit-configuration.js";
import type { PieceData } from "../../../util/non-fit/config-pieces.js";
import type { DefinitionRunPath } from "../../../util/non-fit/replay.js";
import {
  fitConfigDocPath,
  writeFitConfiguration,
} from "./write-fit-configuration.js";

/**
 * Build and write a FITConfiguration.json for an already-selected cluster.
 * `performerPort` is the host port the performer listens on (goes into
 * `performerPorts`); it defaults to {@link DEFAULT_PERFORMER_PORT}. When
 * `fitConfigPiece` is provided, it is merged in as an artifact piece before
 * fit-cli overlays the runtime-generated fields.
 */
export function generateFitConfiguration(
  cluster: SelectedCluster,
  rootDir: string,
  path: DefinitionRunPath,
  performerPort: number = DEFAULT_PERFORMER_PORT,
  fitConfigPiece?: PieceData,
): RunOutput & {
  path: string;
} {
  const config = buildFitConfiguration(cluster, performerPort, fitConfigPiece);

  console.log(
    `\nGenerating a FITConfiguration.json for you. You can also produce this by hand by ` +
      `following ${fitConfigDocPath(rootDir)}.`,
  );
  const result = writeFitConfiguration(config, path);

  console.log(`\nWriting ${result.path}:\n`);
  console.log(JSON.stringify(config, null, 2));

  console.log(`\n✓ Wrote ${result.path}`);
  return { path: result.path, artifacts: [result.artifact], details: [] };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    // Select an existing cluster or create a fresh one; a created Capella cluster
    // is classified from its connection string so the FITConfig gets the Capella
    // treatment automatically.
    const outcome = await selectOrCreateCluster();
    if (!outcome.ready) {
      process.exit(1);
    }
    return generateFitConfiguration(outcome.cluster, rootDir, { instanceIndex: 0, clusterIndex: 0, sessionIndex: 0, runIndex: 0 });
  });
}
