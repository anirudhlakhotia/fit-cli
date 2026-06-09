/**
 * The "Check and pull performer" guided flow.
 *
 * Run this flow on its own:
 *   npx tsx src/workflows/performers/check-and-pull-performer/check-and-pull-performer.ts
 */
import { rmSync, writeFileSync } from "node:fs";
import { fitCliError } from "../../../util/non-fit/fit-cli-log.js";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { posixQuote } from "../../../util/non-fit/remote-target.js";
import { createRunFilePath } from "../../../util/non-fit/replay.js";
import { resolveGithubToken } from "../../../util/fit/config.js";
import { chooseSdk } from "../../../util/sdk/choose-sdk.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { type Sdk } from "../../../util/sdk/sdks.js";
import { createLocalFitExecutionContext, type FitExecutionContext } from "../../fit-shared/util/remote-fit-run.js";
import { choosePerformerVersion } from "../list-docker-containers/list-docker-containers.js";
import { GHCR_REGISTRY, performerImageName } from "../util/performer-image.js";
import { performerImageInspectArgs, performerStatus } from "../check-performer/check-performer.js";

/** Build the `docker login` args used for GHCR. */
export function dockerLoginArgs(registry: string = GHCR_REGISTRY): string[] {
  return ["login", registry, "--username", "x-access-token", "--password-stdin"];
}

/** Build the `docker pull` args used to fetch a performer image. */
export function dockerPullArgs(imageName: string): string[] {
  return ["pull", imageName];
}

/** Build the shell command that logs Docker into GHCR without exposing the token on argv. */
export function dockerLoginCommand(dockerCommand: string, tokenPath: string): string {
  const docker = [dockerCommand, ...dockerLoginArgs()].map(posixQuote).join(" ");
  return `cat ${posixQuote(tokenPath)} | ${docker}`;
}

async function loginToGhcr(execution: FitExecutionContext, token: string): Promise<void> {
  const localTokenPath = createRunFilePath("ghcr-token");
  writeFileSync(localTokenPath, `${token}\n`, { mode: 0o600 });

  let targetTokenPath: string | undefined;
  try {
    targetTokenPath = await execution.stageFile(localTokenPath);
    await execution.run("sh", ["-lc", dockerLoginCommand(execution.dockerCommand, targetTokenPath)]);
  } finally {
    if (targetTokenPath) {
      await execution.removeTree(targetTokenPath);
    }
    rmSync(localTokenPath, { force: true });
  }
}

async function ghcrImageExists(execution: FitExecutionContext, imageName: string): Promise<boolean> {
  try {
    await execution.capture(execution.dockerCommand, performerImageInspectArgs(imageName));
    return true;
  } catch {
    return false;
  }
}

/** Check for a performer image and pull it from GHCR if it is missing locally. */
export async function checkAndPullPerformer(
  execution: FitExecutionContext,
  sdk: Sdk,
  version?: string,
): Promise<boolean> {
  const status = await performerStatus(execution, sdk, version);
  const imageName = performerImageName(sdk, version);

  if (!status.dockerAvailable) {
    fitCliError("Could not find docker on your PATH");
    return false;
  }

  if (await ghcrImageExists(execution, imageName)) {
    console.log(`✓ Found the ${sdk.name} performer Docker image ${imageName}`);
    return true;
  }

  const githubToken = resolveGithubToken();
  console.log(`\nPulling performer with:\n  docker ${dockerPullArgs(imageName).join(" ")}\n`);

  try {
    if (githubToken) {
      console.log("Authenticating Docker to GHCR...");
      await loginToGhcr(execution, githubToken);
    }
    console.log("\nPulling performer container...\n");
    await execution.run(execution.dockerCommand, dockerPullArgs(imageName));
  } catch (err) {
    fitCliError(
      `\nFailed to pull the ${sdk.name} performer image ${imageName}: ${(err as Error).message}` +
        (githubToken
          ? ""
          : "\nAdd a GitHub token with read:packages scope via `npm run init`, GITHUB_TOKEN, or GH_TOKEN, then try again."),
    );
    return false;
  }

  if (!(await ghcrImageExists(execution, imageName))) {
    fitCliError(`\nPulled the ${sdk.name} performer, but ${imageName} is still missing`);
    return false;
  }

  console.log(`\n✓ Pulled the ${sdk.name} performer Docker image ${imageName}`);
  return true;
}

/** Guided flow for choosing a performer and pulling it locally. */
export async function runCheckAndPullPerformer(rootDir: string): Promise<void> {
  const sdk = await chooseSdk("Which SDK performer do you want to check?");
  const version = await choosePerformerVersion(sdk);
  await checkAndPullPerformer(createLocalFitExecutionContext(rootDir), sdk, version);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    await runCheckAndPullPerformer(rootDir);
  });
}
