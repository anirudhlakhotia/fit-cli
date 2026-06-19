/**
 * Regenerate fit-tests-cache.json5 from the transactions-fit-performer checkout.
 *
 * Usage:
 *   bunx tsx src/fit/shared/select-fit-tests/generate-fit-tests-cache.ts --root /path/to/transactions-fit-performer
 */
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { captureValueSync } from "../../../util/non-fit/proc.js";
import { isMain } from "../../../util/non-fit/cli.js";

const CACHE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fit-tests-cache.json5");

const HEADER = `// FIT test-driver test file paths, relative to test-driver/src/test in transactions-fit-performer.
// To regenerate:
//   bun run generate-fit-tests-cache --root /path/to/transactions-fit-performer\n`;

function discoverTestPaths(performerDir: string): string[] {
  const testRoot = join(performerDir, "test-driver", "src", "test");
  if (!existsSync(testRoot)) {
    throw new Error(`test-driver/src/test not found under ${performerDir}`);
  }
  const output = captureValueSync("find", [
    testRoot,
    "-type", "f",
    "(", "-name", "*Test.java", "-o", "-name", "*Test.scala", ")",
    "-printf", "%P\n",
  ], { quiet: true });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

export function generateFitTestsCache(performerDir: string): void {
  const paths = discoverTestPaths(performerDir);
  if (paths.length === 0) {
    throw new Error("No test files found — check the performer directory path.");
  }
  const body = paths.map((p) => `  "${p}",`).join("\n");
  writeFileSync(CACHE_PATH, `${HEADER}[\n${body}\n]\n`, "utf8");
  console.log(`Wrote ${paths.length} test paths to ${CACHE_PATH}`);
}

if (isMain(import.meta.url)) {
  const rootArg = process.argv.find((_, i, arr) => arr[i - 1] === "--root");
  if (!rootArg) {
    console.error("Usage: bunx tsx generate-fit-tests-cache.ts --root /path/to/transactions-fit-performer");
    process.exit(1);
  }
  generateFitTestsCache(rootArg);
}
