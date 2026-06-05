/**
 * Workflow: choose where situational test results are stored. The hosted
 * database on faas.couchbase.com is the recommended default (no local database
 * or results UI to run); the alternative is a local Docker database, which this
 * workflow can set up via ../setup-local-database.
 *
 * The hosted database's readonly password is secret, so it's read from the
 * environment (a `.env` file is loaded automatically) rather than prompted for
 * and logged. Ask on #the-fit-stop for the password — see .env.example.
 *
 * Run on its own (add --root <dir> to point elsewhere):
 *   npx tsx src/workflows/fit-situational/choose-results-database/choose-results-database.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { type RunOutput } from "../../../util/non-fit/artifacts.js";
import { loadDotenv } from "../../../util/non-fit/dotenv.js";
import { fitCliError } from "../../../util/non-fit/fit-cli-log.js";
import { select } from "../../../util/non-fit/prompts.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { type ResultsDatabase } from "../util/situational-config.js";
import { setupLocalDatabase } from "../setup-local-database/setup-local-database.js";

export const HOSTED_RESULTS_DB_HOST = "faas.couchbase.com";
export const HOSTED_RESULTS_DB_JDBC = `jdbc:postgresql://${HOSTED_RESULTS_DB_HOST}:5432/perf`;
export const HOSTED_RESULTS_DB_USERNAME = "postgres";
/** Environment variable holding the hosted results-DB readonly password. */
export const RESULTS_DB_PASSWORD_ENV = "FIT_RESULTS_DB_PASSWORD";

type ResultsDatabaseMode = "hosted" | "local";

/** The outcome of choosing a results database. */
export type ResultsDatabaseOutcome =
  | (RunOutput & { ready: true; database: ResultsDatabase })
  | (RunOutput & { ready: false });

/**
 * Build the hosted database connection from the environment, or `undefined` if
 * the password isn't set. Pure (takes the env in) so it's easy to unit test.
 */
export function hostedDatabaseFromEnv(env: NodeJS.ProcessEnv = process.env): ResultsDatabase | undefined {
  const password = env[RESULTS_DB_PASSWORD_ENV]?.trim();
  if (!password) {
    return undefined;
  }
  return {
    jdbc: HOSTED_RESULTS_DB_JDBC,
    username: env.FIT_RESULTS_DB_USERNAME?.trim() || HOSTED_RESULTS_DB_USERNAME,
    password,
  };
}

async function askResultsDatabaseMode(): Promise<ResultsDatabaseMode> {
  return select<ResultsDatabaseMode>({
    promptId: "situational.database.mode",
    message: "Where should situational test results be stored?",
    default: "hosted",
    choices: [
      {
        name: `Hosted database on ${HOSTED_RESULTS_DB_HOST} (recommended — nothing to run locally)`,
        value: "hosted",
      },
      { name: "A local database in Docker (this tool will set it up)", value: "local" },
    ],
  });
}

/** Resolve the hosted database, explaining how to fix a missing password. */
function resolveHostedDatabase(): ResultsDatabaseOutcome {
  loadDotenv();
  const database = hostedDatabaseFromEnv();
  if (!database) {
    fitCliError(
      `\n✗ The hosted results database needs a readonly password.\n` +
        `  Ask on #the-fit-stop for it, then set ${RESULTS_DB_PASSWORD_ENV} in your .env (see .env.example).\n` +
        `  You must also be on the vpn-public VPN to reach ${HOSTED_RESULTS_DB_HOST}.`,
    );
    return { ready: false, artifacts: [], details: [] };
  }
  console.log(`\n✓ Using the hosted results database at ${HOSTED_RESULTS_DB_HOST}.`);
  return {
    ready: true,
    database,
    artifacts: [],
    details: [{ label: "Results database", value: HOSTED_RESULTS_DB_HOST }],
  };
}

/** Choose a results database: the hosted one, or a freshly set-up local one. */
export async function chooseResultsDatabase(rootDir: string): Promise<ResultsDatabaseOutcome> {
  const mode = await askResultsDatabaseMode();
  if (mode === "hosted") {
    return resolveHostedDatabase();
  }

  const local = await setupLocalDatabase(rootDir);
  if (!local.ready) {
    return { ready: false, artifacts: local.artifacts, details: local.details };
  }
  return { ready: true, database: local.database, artifacts: local.artifacts, details: local.details };
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    const outcome = await chooseResultsDatabase(rootDir);
    if (outcome.ready) {
      console.log(`\nResults database JDBC: ${outcome.database.jdbc}`);
    }
    return { artifacts: outcome.artifacts, details: outcome.details };
  });
}
