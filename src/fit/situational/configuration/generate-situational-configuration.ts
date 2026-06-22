/**
 * Step: turn a results database + cbdino settings into a situational
 * FITConfiguration.json — build the config and write it to a fresh per-iteration
 * file for passing to test-driver via `-Dfit.config`.
 *
 * The situational counterpart to generate-fit-configuration.ts. The config
 * itself is built by build-situational-configuration.ts (pure); this step does
 * the IO and masks the secret results-DB password in the echoed output.
 *
 * Run on its own (prints where a config would be written):
 *   bun src/fit/situational/configuration/generate-situational-configuration.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { type PieceData } from "../../../util/non-fit/config-pieces.js";
import { printFileContent } from "../../../util/non-fit/fit-cli-log.js";
import type { DefinitionRunPath } from "../../../util/non-fit/replay.js";
import { DEFAULT_PERFORMER_PORT } from "../../performers/util/performer-port.js";
import { type ResultsDatabase } from "../../shared/util/results-database.js";
import {
  buildSituationalConfiguration,
  DEFAULT_CBDINO_SETTINGS,
  type CbdinoSettings,
} from "./build-situational-configuration.js";
import { fitConfigDocPath, writeFitConfiguration } from "../../shared/fit-configuration/write-fit-configuration.js";

/** Build and write a situational FITConfiguration.json to the run directory. */
export function generateSituationalConfiguration(
  database: ResultsDatabase,
  cbdino: CbdinoSettings = DEFAULT_CBDINO_SETTINGS,
  fitPerformerDir: string,
  path: DefinitionRunPath,
  performerPort: number = DEFAULT_PERFORMER_PORT,
  fitConfigPiece?: PieceData,
): RunOutput & { path: string } {
  const config = buildSituationalConfiguration(database, cbdino, performerPort, fitConfigPiece);

  console.log(
    `\nGenerating a situational FITConfiguration.json for you. You can also produce this by hand by ` +
      `following ${fitConfigDocPath(fitPerformerDir)} and the situational notes in SITUATIONAL_TESTING.md.`,
  );
  // The results-DB password is secret, so don't echo the config verbatim; show
  // it with the password masked while writing the real value to the file.
  const result = writeFitConfiguration(config, path);
  console.log(`\nWriting ${result.path}:\n`);
  printFileContent(JSON.stringify(maskDatabasePassword(config), null, 2));
  console.log(`\n✓ Wrote ${result.path}`);

  return { path: result.path, artifacts: [result.artifact], details: [] };
}

/** Return a shallow clone of the config with the results-DB password masked. */
export function maskDatabasePassword(config: Record<string, unknown>): Record<string, unknown> {
  const situational = config.situational as { database?: { password?: unknown } } | undefined;
  if (!situational?.database) {
    return config;
  }
  return {
    ...config,
    situational: {
      ...situational,
      database: { ...situational.database, password: "***" },
    },
  };
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const sample = buildSituationalConfiguration({
      jdbc: "jdbc:postgresql://faas.couchbase.com:5432/perf",
      username: "postgres",
      password: "***",
    });
    console.log(JSON.stringify(maskDatabasePassword(sample), null, 2));
    return Promise.resolve();
  });
}
