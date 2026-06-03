/**
 * Step: run jenkins-sdk's Gradle task to build a FIT performer.
 *
 * Run on its own (add --root <dir> to point at another workspace):
 *   npx tsx src/workflows/performers/build-performer/build-performer.ts java
 *   npx tsx src/workflows/performers/build-performer/build-performer.ts java main --root /some/workspace
 */
import { isMain, runCli } from "../../../lib/cli.js";
import { run } from "../../../lib/proc.js";
import { JENKINS_SDK, repoPath } from "../../../lib/repos.js";
import { rootDirFromArgv } from "../../../lib/root.js";
import { SDKS, sdkByValue, type Sdk } from "../../../lib/sdks.js";

/** Normalize arbitrary text into something safe for a Docker image component. */
export function dockerImageComponent(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "") || "main";
}

/** Build the Docker image name passed to jenkins-sdk. */
export function buildPerformerImageName(sdk: Sdk, version?: string): string {
  return `performer-${sdk.value}-${dockerImageComponent(version ?? "main")}`;
}

/** Build the Gradle args for jenkins-sdk's buildPerformer task. */
export function buildPerformerArgs(rootDir: string, sdk: Sdk, version?: string): string[] {
  const commandArgs = ["-d", rootDir, "-s", sdk.value];
  if (version) {
    commandArgs.push("-v", version);
  }
  commandArgs.push("-i", buildPerformerImageName(sdk, version));
  return ["buildPerformer", `--args=${commandArgs.join(" ")}`];
}

/** Describe the build command that will be run for this performer image. */
export function describeBuildPerformerCommand(rootDir: string, sdk: Sdk, version?: string): string {
  return (
    `cd ${repoPath(JENKINS_SDK, rootDir)} && ` +
    `./gradlew buildPerformer --args="-d ${rootDir} -s ${sdk.value}` +
    `${version ? ` -v ${version}` : ""} -i ${buildPerformerImageName(sdk, version)}"`
  );
}

/** Build a FIT performer for `sdk`, optionally at a specific version. */
export function buildPerformer(rootDir: string, sdk: Sdk, version?: string): Promise<void> {
  return run("./gradlew", buildPerformerArgs(rootDir, sdk, version), repoPath(JENKINS_SDK, rootDir));
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const { rootDir, positionals } = rootDirFromArgv(process.argv.slice(2));
    const value = positionals[0];
    const sdk = value ? sdkByValue(value) : undefined;
    const version = positionals[1];
    if (!sdk) {
      const values = SDKS.map((s) => s.value).join(" | ");
      console.error(
        `Usage: tsx src/workflows/performers/build-performer/build-performer.ts <${values}> [version] [--root <dir>]`,
      );
      process.exit(2);
    }
    await buildPerformer(rootDir, sdk, version);
  });
}
