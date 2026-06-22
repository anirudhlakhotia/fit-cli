/**
 * Build the situational FITConfiguration object.
 *
 * Unlike the functional config, situational testing lets cbdino create and
 * manage its own clusters, so the clusterAccess block is just a placeholder (the
 * FIT docs say it's ignored for situational-only runs). What matters is the
 * `situational.cbdino` block (which cluster version cbdino should build) and the
 * `situational.database` block (where the timeseries results land).
 *
 * The config is assembled from config-pieces, so a shared base piece is layered
 * with the situational-specific piece — the artifact-pieces idea from the README.
 * An optional definition `fitConfig` piece is layered last so a definition file
 * can override or extend any field.
 *
 * Pure logic — no file IO — so it's easy to unit test (see
 * tests/build-situational-configuration.test.ts).
 *
 * Run on its own (prints a sample situational config as JSON):
 *   bun src/fit/situational/configuration/build-situational-configuration.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { mergeConfigPieces, type ConfigPiece, type PieceData } from "../../../util/non-fit/config-pieces.js";
import { DEFAULT_PERFORMER_PORT } from "../../performers/util/performer-port.js";
import { type ResultsDatabase } from "../../shared/util/results-database.js";
import { AUTO_GENERATED_MARKER } from "../../shared/fit-configuration/write-fit-configuration.js";

/**
 * Default Couchbase Server version for situational runs that create Capella
 * clusters. Capella currently supports 7.6 here; keep this separate from the
 * self-managed cbdinocluster default so functional cluster-create changes do not
 * silently break SIT/FIT cloud provisioning.
 */
export const DEFAULT_CAPELLA_CLUSTER_VERSION = "7.6";

/** How cbdino should build the cluster the situational tests run against. */
export interface CbdinoSettings {
  /** Couchbase Server version cbdino should deploy, e.g. "8.0-stable" or a pinned build like "8.0.2-5322". */
  version: string;
  /** Name (or path) of the cbdinocluster binary the driver should invoke. */
  cbDinoClusterAppPath: string;
  enablePrivateEndpoint: boolean;
}

export const DEFAULT_CBDINO_SETTINGS: CbdinoSettings = {
  version: DEFAULT_CAPELLA_CLUSTER_VERSION,
  cbDinoClusterAppPath: "cbdinocluster",
  enablePrivateEndpoint: false,
};

/**
 * The base, flavour-agnostic part of the config: the auto-generated marker, a
 * placeholder clusterAccess (unused for situational), and the performer port.
 */
function baseConfigPiece(performerPort: number): ConfigPiece {
  return {
    label: "base",
    data: {
      "//": AUTO_GENERATED_MARKER,
      clusterAccess: {
        "//": "Ignored for situational-only runs — cbdino creates and manages the cluster. Required anyway: FITConfigRaw.convertClusterAccess throws if absent.",
        defaultHostname: "localhost",
        username: "Administrator",
        password: "password",
      },
      performerPorts: [performerPort],
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

/**
 * Build the merged situational FITConfiguration object (pure — no IO).
 * `fitConfigPiece` is the optional definition-supplied artifact piece, layered
 * last so a definition file can override or extend any generated field.
 */
export function buildSituationalConfiguration(
  database: ResultsDatabase,
  cbdino: CbdinoSettings = DEFAULT_CBDINO_SETTINGS,
  performerPort: number = DEFAULT_PERFORMER_PORT,
  fitConfigPiece?: PieceData,
): Record<string, unknown> {
  return mergeConfigPieces([
    baseConfigPiece(performerPort),
    situationalConfigPiece(database, cbdino),
    ...(fitConfigPiece ? [{ label: "definition fitConfig piece", data: fitConfigPiece }] : []),
  ]);
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const sample = buildSituationalConfiguration({
      jdbc: "jdbc:postgresql://faas.couchbase.com:5432/perf",
      username: "postgres",
      password: "***",
    });
    console.log(JSON.stringify(sample, null, 2));
    return Promise.resolve();
  });
}
