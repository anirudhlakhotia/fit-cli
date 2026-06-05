/**
 * Step: run jenkins-sdk's Gradle task to build a FIT performer.
 *
 * Run on its own (add --root <dir> to point at another workspace):
 *   npx tsx src/workflows/performers/build-performer/build-performer.ts java
 *   npx tsx src/workflows/performers/build-performer/build-performer.ts java main --root /some/workspace
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { run } from "../../../util/non-fit/proc.js";
import { JENKINS_SDK, repoPath } from "../../../util/fit/repos.js";
import { rootDirFromArgv } from "../../../util/fit/root.js";
import { SDKS, sdkByValue, type Sdk } from "../../../util/sdk/sdks.js";

/** Normalize arbitrary text into something safe for a Docker image component. */
export function dockerImageComponent(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "") || "main";
}

/** Describe the build inputs that distinguish one local performer image from another. */
export function performerBuildIdentity(version?: string, gerritRef?: string): string {
  const parts = [
    version?.trim(),
    gerritRef?.trim() ? `gerrit-${gerritRef.trim()}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.join("-") || "main";
}

/** Build the Docker image name passed to jenkins-sdk. */
export function buildPerformerImageName(sdk: Sdk, version?: string, gerritRef?: string): string {
  return `performer-${sdk.value}-${dockerImageComponent(performerBuildIdentity(version, gerritRef))}`;
}

/** Build the Gradle args for jenkins-sdk's buildPerformer task. */
export function buildPerformerArgs(rootDir: string, sdk: Sdk, version?: string, gerritRef?: string): string[] {
  const commandArgs = ["-d", rootDir, "-s", sdk.value];
  if (version) {
    commandArgs.push("-v", version);
  }
  commandArgs.push("-i", buildPerformerImageName(sdk, version, gerritRef));
  return ["buildPerformer", `--args=${commandArgs.join(" ")}`];
}

/** Describe the build command that will be run for this performer image. */
export function describeBuildPerformerCommand(rootDir: string, sdk: Sdk, version?: string, gerritRef?: string): string {
  return (
    `cd ${repoPath(JENKINS_SDK, rootDir)} && ` +
    `./gradlew buildPerformer --args="-d ${rootDir} -s ${sdk.value}` +
    `${version ? ` -v ${version}` : ""} -i ${buildPerformerImageName(sdk, version, gerritRef)}"`
  );
}

/** Build a FIT performer for `sdk`, optionally at a specific version. */
export function buildPerformer(rootDir: string, sdk: Sdk, version?: string, gerritRef?: string): Promise<void> {
  return run("./gradlew", buildPerformerArgs(rootDir, sdk, version, gerritRef), repoPath(JENKINS_SDK, rootDir));
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
