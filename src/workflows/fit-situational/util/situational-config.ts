/**
 * Build the situational FITConfiguration.json.
 *
 * Unlike the functional config, situational testing lets cbdino create and
 * manage its own clusters, so the clusterAccess block is just a placeholder (the
 * FIT docs say it's ignored for situational-only runs). What matters is the
 * `situational.cbdino` block (which cluster version cbdino should build) and the
 * `situational.database` block (where the timeseries results land).
 *
 * The config is assembled from config-pieces, so a shared base piece is layered
 * with the situational-specific piece — the artifact-pieces idea from the README.
 *
 * Run on its own (prints a sample situational config as JSON):
 *   npx tsx src/workflows/fit-situational/util/situational-config.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { mergeConfigPieces, type ConfigPiece } from "../../../util/non-fit/config-pieces.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { type ResultsDatabase } from "../../fit-shared/util/results-database.js";
import {
  AUTO_GENERATED_MARKER,
  fitConfigDocPath,
  writeFitConfiguration,
} from "../../fit-shared/fit-configuration/write-fit-configuration.js";

/** How cbdino should build the cluster the situational tests run against. */
export interface CbdinoSettings {
  /** Couchbase Server version cbdino should deploy, e.g. "7.6". */
  version: string;
  /** Name (or path) of the cbdinocluster binary the driver should invoke. */
  cbDinoClusterAppPath: string;
  enablePrivateEndpoint: boolean;
}

export const DEFAULT_CBDINO_SETTINGS: CbdinoSettings = {
  version: "7.6",
  cbDinoClusterAppPath: "cbdinocluster",
  enablePrivateEndpoint: false,
};

/**
 * The base, flavour-agnostic part of the config: the auto-generated marker, a
 * placeholder clusterAccess (unused for situational), and the performer port.
 */
function baseConfigPiece(): ConfigPiece {
  return {
    label: "base",
    data: {
      "//": AUTO_GENERATED_MARKER,
      clusterAccess: {
        "//": "Ignored for situational-only runs — cbdino creates and manages the cluster.",
        defaultHostname: "localhost",
        username: "Administrator",
        password: "password",
      },
      performerPorts: [8060],
    },
  };
}

/** The situational-specific part: don't exclude situational tests, add cbdino + database. */
export function situationalConfigPiece(database: ResultsDatabase, cbdino: CbdinoSettings): ConfigPiece {
  return {
    label: "situational",
    data: {
      excludeTests: [],
      situational: {
        cbdino: {
          version: cbdino.version,
          cbDinoClusterAppPath: cbdino.cbDinoClusterAppPath,
          enablePrivateEndpoint: cbdino.enablePrivateEndpoint,
        },
        database: {
          jdbc: database.jdbc,
          username: database.username,
          password: database.password,
        },
      },
    },
  };
}

/** Build the merged situational FITConfiguration object (pure — no IO). */
export function buildSituationalConfiguration(
  database: ResultsDatabase,
  cbdino: CbdinoSettings = DEFAULT_CBDINO_SETTINGS,
): Record<string, unknown> {
  return mergeConfigPieces([baseConfigPiece(), situationalConfigPiece(database, cbdino)]);
}

/** Build and write a situational FITConfiguration.json to the run directory. */
export function generateSituationalConfiguration(
  database: ResultsDatabase,
  rootDir: string,
  cbdino: CbdinoSettings = DEFAULT_CBDINO_SETTINGS,
): RunOutput & { path: string } {
  const config = buildSituationalConfiguration(database, cbdino);

  console.log(
    `\nGenerating a situational FITConfiguration.json for you. You can also produce this by hand by ` +
      `following ${fitConfigDocPath(rootDir)} and the situational notes in SITUATIONAL_TESTING.md.`,
  );
  // The results-DB password is secret, so don't echo the config verbatim; show
  // it with the password masked while writing the real value to the file.
  const result = writeFitConfiguration(config);
  console.log(`\nWriting ${result.path}:\n`);
  console.log(JSON.stringify(maskDatabasePassword(config), null, 2));
  console.log(`\n✓ Wrote ${result.path}`);

  return { path: result.path, artifacts: [result.artifact], details: [] };
}

/** Return a shallow clone of the config with the results-DB password masked. */
function maskDatabasePassword(config: Record<string, unknown>): Record<string, unknown> {
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
    rootDirFromArgv(process.argv.slice(2));
    const sample = buildSituationalConfiguration({
      jdbc: "jdbc:postgresql://faas.couchbase.com:5432/perf",
      username: "postgres",
      password: "***",
    });
    console.log(JSON.stringify(sample, null, 2));
    return Promise.resolve();
  });
}
