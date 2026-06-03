/**
 * Step: make sure fit-grpc is available and reasonably fresh in the local Maven
 * repo. If it is missing or over a month old, offer to build FIT, which runs
 * `mvn clean install -Dmaven.test.skip` in transactions-fit-performer and
 * installs fit-grpc into ~/.m2.
 *
 * Run the whole step, or any individual function, on its own (add --root <dir>
 * to point at another workspace):
 *   npx tsx src/workflows/fit-functional/steps/ensure-fit-grpc.ts          # full flow (default)
 *   npx tsx src/workflows/fit-functional/steps/ensure-fit-grpc.ts ensure   # full flow
 *   npx tsx src/workflows/fit-functional/steps/ensure-fit-grpc.ts status   # just inspect the jar (prints JSON, no prompts)
 *   npx tsx src/workflows/fit-functional/steps/ensure-fit-grpc.ts build    # just build FIT (runs mvn directly)
 *
 * For the full flow, exits 0 if fit-grpc is ready, 1 if the user declined the
 * build or it failed.
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import { isMain, runCli } from "../../../lib/cli.js";
import { run } from "../../../lib/proc.js";
import { FIT_PERFORMER, repoPath } from "../../../lib/repos.js";
import { rootDirFromArgv } from "../../../lib/root.js";

/**
 * Location of the fit-grpc artifact in the local Maven repository. Building FIT
 * (mvn clean install) installs the jar here.
 */
const FIT_GRPC_JAR = join(
  homedir(),
  ".m2/repository/com/couchbase/client/fit-grpc/1.0-SNAPSHOT/fit-grpc-1.0-SNAPSHOT.jar",
);

/** How recently fit-grpc must have been built to count as reasonably up-to-date. */
const FIT_GRPC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface FitGrpcStatus {
  /** True if the fit-grpc jar is present in the local Maven repo. */
  present: boolean;
  /** When it was last built, if present. */
  builtAt?: Date;
  /** True if present and built within the last month. */
  upToDate: boolean;
}

/**
 * True if something built at `builtAt` still counts as recent. Pure logic split
 * out from {@link fitGrpcStatus} so it can be unit tested without a real jar
 * (see tests/ensure-fit-grpc.test.ts). `now` is injectable for the same reason.
 */
export function isFreshlyBuilt(builtAt: Date, now: number = Date.now()): boolean {
  return now - builtAt.getTime() <= FIT_GRPC_MAX_AGE_MS;
}

/** Inspect the fit-grpc jar in the local Maven repo. */
export function fitGrpcStatus(): FitGrpcStatus {
  if (!existsSync(FIT_GRPC_JAR)) {
    return { present: false, upToDate: false };
  }
  const builtAt = statSync(FIT_GRPC_JAR).mtime;
  return { present: true, builtAt, upToDate: isFreshlyBuilt(builtAt) };
}

/**
 * Build FIT so fit-grpc lands in the local Maven repo, streaming mvn output to
 * the console. Runs `mvn clean install -Dmaven.test.skip` in transactions-fit-performer.
 */
export function buildFit(rootDir: string): Promise<void> {
  return run("mvn", ["clean", "install", "-Dmaven.test.skip"], repoPath(FIT_PERFORMER, rootDir));
}

/**
 * @returns true if fit-grpc is ready to use, false if the user chose to exit or
 * the build failed.
 */
export async function ensureFitGrpc(rootDir: string): Promise<boolean> {
  const status = fitGrpcStatus();

  if (status.present && status.upToDate) {
    console.log(
      `✓ fit-grpc is in your local Maven repo and recently built (built ${status.builtAt!.toLocaleDateString()})`,
    );
    return true;
  }

  if (status.present) {
    console.log(
      `! fit-grpc is in your local Maven repo but is over a month old (built ${status.builtAt!.toLocaleDateString()})`,
    );
  } else {
    console.log("✗ fit-grpc is not in your local Maven repo");
  }

  console.log(
    "\nBuilding FIT will run:\n" +
      `  cd ${repoPath(FIT_PERFORMER, rootDir)} && mvn clean install -Dmaven.test.skip\n\n` +
      "This builds fit-grpc (the JVM build of the GRPC) and puts it into your local Maven repo.\n" +
      "If the GRPC ever changes, you'll need to rerun that mvn step again.",
  );

  const build = await confirm({ message: "Build FIT now?" });
  if (!build) {
    return false;
  }

  console.log("\nBuilding FIT...\n");
  try {
    await buildFit(rootDir);
    console.log("\n✓ Built FIT — fit-grpc is now in your local Maven repo");
    return true;
  } catch (err) {
    console.error(`\n✗ Failed to build FIT: ${(err as Error).message}`);
    return false;
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir, positionals } = rootDirFromArgv(process.argv.slice(2));
    const command = positionals[0] ?? "ensure";
    switch (command) {
      case "status": {
        // Just the inspection, no prompts — handy for seeing what the full flow sees.
        console.log(JSON.stringify(fitGrpcStatus(), null, 2));
        return;
      }
      case "build": {
        // Just the build, skipping the freshness check and the confirm prompt.
        console.log("Building FIT...\n");
        await buildFit(rootDir);
        console.log("\n✓ Built FIT — fit-grpc is now in your local Maven repo");
        return;
      }
      case "ensure": {
        const ok = await ensureFitGrpc(rootDir);
        process.exit(ok ? 0 : 1);
        break;
      }
      default: {
        console.error(
          "Usage: tsx src/workflows/fit-functional/steps/ensure-fit-grpc.ts [ensure | status | build] [--root <dir>]",
        );
        process.exit(2);
      }
    }
  });
}
