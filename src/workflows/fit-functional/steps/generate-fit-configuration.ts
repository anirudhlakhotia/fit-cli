/**
 * Step: turn a selected cluster into a FITConfiguration.json — build the config
 * and write it (backing up any existing hand-written config first).
 *
 * Cluster selection itself lives in the reusable src/workflows/cluster-select
 * workflow; this step only deals with FIT configuration.
 *
 * Run on its own (this picks a cluster via the cluster-select workflow, then
 * generates its config; add --root <dir> to point elsewhere):
 *   npx tsx src/workflows/fit-functional/steps/generate-fit-configuration.ts
 */
import { isMain, runCli } from "../../../lib/cli.js";
import { rootDirFromArgv } from "../../../lib/root.js";
import { selectCluster, type SelectedCluster } from "../../cluster-select/index.js";
import { buildFitConfiguration } from "./build-fit-configuration.js";
import {
  fitConfigDocPath,
  fitConfigPath,
  writeFitConfiguration,
} from "./write-fit-configuration.js";

/** Build and write a FITConfiguration.json for an already-selected cluster. */
export function generateFitConfiguration(cluster: SelectedCluster, rootDir: string): void {
  const config = buildFitConfiguration(cluster);

  console.log(
    `\nGenerating a FITConfiguration.json for you. You can also produce this by hand by ` +
      `following ${fitConfigDocPath(rootDir)}.`,
  );
  console.log(`\nWriting ${fitConfigPath(rootDir)}:\n`);
  console.log(JSON.stringify(config, null, 2));

  const { backupPath } = writeFitConfiguration(config, rootDir);
  if (backupPath) {
    console.log(`\nYour previous config was not auto-generated, so it was backed up to:\n${backupPath}`);
  }
  console.log(`\n✓ Wrote ${fitConfigPath(rootDir)}`);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    const selection = await selectCluster();
    if (selection.mode === "create") {
      console.log("\nCreating a new cluster is not wired up yet.");
      return;
    }
    generateFitConfiguration(selection.cluster, rootDir);
  });
}
