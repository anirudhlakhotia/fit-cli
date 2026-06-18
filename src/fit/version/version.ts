import { execSync } from "node:child_process";
import { basename } from "node:path";
import { isFitBinary } from "../../util/non-fit/fit-cli-log.js";

// Injected by `bun build --define` at compile time; throws ReferenceError in dev.
declare const __FIT_GIT_SHA: string;
declare const __FIT_BUILD_TIME: string;

function resolvedGitSha(): string {
  try {
    return __FIT_GIT_SHA;
  } catch {
    try {
      return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
  }
}

function resolvedBuildTime(): string {
  try {
    return __FIT_BUILD_TIME;
  } catch {
    return new Date().toISOString();
  }
}

export function printVersion(): void {
  console.log(`sha:      ${resolvedGitSha()}`);
  console.log(`built:    ${resolvedBuildTime()}`);
  console.log(`bin:      ${process.execPath}`);
  // Debug: isFitBinary decides whether re-run hints show `fit X` vs `bun run X`.
  // It keys off basename(process.execPath); process.argv[0] is unreliable (it is
  // the literal "bun" in a Bun standalone executable).
  console.log(
    `fit-bin:  ${isFitBinary()} (execPath basename "${basename(process.execPath)}")`,
  );
}
