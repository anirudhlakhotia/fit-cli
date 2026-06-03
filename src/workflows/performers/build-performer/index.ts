/**
 * The "Build performer" guided flow.
 *
 * Run this flow on its own (skipping the top-level menu; add --root <dir> to
 * point at another workspace):
 *   npx tsx src/workflows/performers/build-performer/index.ts
 */
import { isMain, runCli } from "../../../lib/cli.js";
import { JENKINS_SDK } from "../../../lib/repos.js";
import { rootDirFromArgv } from "../../../lib/root.js";
import { chooseSdk } from "../../../steps/choose-sdk.js";
import { ensureRepo } from "../../../steps/ensure-repo.js";
import { ensureSdkWorkspace } from "../../../steps/ensure-sdk-workspace.js";
import { askVersion } from "./ask-version.js";
import {
  buildPerformer,
  buildPerformerImageName,
  describeBuildPerformerCommand,
} from "./build-performer.js";

/** Walk through everything needed to build one FIT performer. */
export async function runBuildPerformer(rootDir: string): Promise<void> {
  console.log(
    "jenkins-sdk is a CLI tool that can, among other things, build FIT performers.",
  );

  if (!(await ensureRepo(JENKINS_SDK, rootDir))) {
    console.log("\nOnce jenkins-sdk is in place, run fit-cli again.");
    return;
  }

  const sdk = await chooseSdk("Which SDK do you want to build?");
  if (!(await ensureSdkWorkspace(sdk, rootDir))) {
    console.log("\nOnce the SDK workspace repos are in place, run fit-cli again.");
    return;
  }

  const version = await askVersion();
  const imageName = buildPerformerImageName(sdk, version);

  console.log(`\nBuilding performer with:\n  ${describeBuildPerformerCommand(rootDir, sdk, version)}\n`);

  await buildPerformer(rootDir, sdk, version);
  console.log(`\n✓ Built the ${sdk.name} FIT performer${version ? ` at ${version}` : " from main"} as ${imageName}`);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir } = rootDirFromArgv(process.argv.slice(2));
    await runBuildPerformer(rootDir);
  });
}
