/**
 * The "Run performer" guided flow.
 *
 * Run this flow on its own (skipping the top-level menu; add --root <dir> to
 * point at another workspace):
 *   npx tsx src/workflows/performers/run-performer/index.ts
 */
import { isMain, runCli } from "../../../lib/cli.js";
import { run } from "../../../lib/proc.js";
import { rootDirFromArgv } from "../../../lib/root.js";
import { type Sdk } from "../../../lib/sdks.js";
import { chooseSdk } from "../../../steps/choose-sdk.js";
import { askVersion } from "../build-performer/ask-version.js";
import { buildPerformerImageName } from "../build-performer/build-performer.js";
import { checkAndBuildPerformer } from "../check-and-build-performer/index.js";

/** Run a performer Docker image, building it first if needed. */
export async function runPerformer(rootDir: string, sdk: Sdk, version?: string): Promise<boolean> {
  if (!(await checkAndBuildPerformer(rootDir, sdk, version))) {
    return false;
  }

  const imageName = buildPerformerImageName(sdk, version);
  console.log(`\nRunning performer with:\n  docker run --rm ${imageName}\n`);
  await run("docker", ["run", "--rm", imageName]);
  return true;
}

/** Guided flow for choosing and running a performer Docker image. */
export async function runPerformerWorkflow(rootDir: string): Promise<void> {
  const sdk = await chooseSdk("Which SDK performer do you want to run?");
  const version = await askVersion();
  await runPerformer(rootDir, sdk, version);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    await runPerformerWorkflow(rootDir);
  });
}
