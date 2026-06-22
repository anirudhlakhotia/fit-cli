/**
 * aws-cli — shared helpers for the rest of cloud/util/aws. Provides config
 * preparation (so AWS_PROFILE / credentials are in place before SDK calls) and
 * console logging conventions.
 *
 * Run on its own (checks the AWS config is ready):
 *   bun src/cloud/util/aws/aws-cli.ts
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { loadFitCliConfigEnv } from "../../../fit/util/config.js";
import { AWS_REGION } from "./aws-target.js";

/** Apply fit-cli config to env (sets AWS_PROFILE if configured) before SDK calls. */
export async function prepareAwsCli(): Promise<void> {
  loadFitCliConfigEnv();
}

function formatAwsDetail(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") {
    return value.description ? `Symbol(${value.description})` : "Symbol()";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return typeof value;
}

/** Print a short, consistent summary of the AWS action about to be run. */
export function logAwsAction(action: string, details: Record<string, unknown> = {}): void {
  console.log(`${action} (region: ${AWS_REGION})`);
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      console.log(`  ${key}: ${value.join(", ")}`);
      continue;
    }
    console.log(`  ${key}: ${formatAwsDetail(value)}`);
  }
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    await prepareAwsCli();
    console.log(`✓ AWS config ready (region: ${AWS_REGION})`);
  });
}
