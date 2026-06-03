/**
 * Step: allocate a cluster with cbdinocluster from a def document. The def is
 * written to a file under /tmp/fit-cli and then handed to
 * `cbdinocluster --verbose allocate --def-file=<file>` (with an optional
 * --deployer override), whose output is streamed to the console.
 *
 * Run on its own (allocates a default single-node cluster — this really does
 * create a cluster, so only run it if you mean to):
 *   npx tsx src/workflows/cluster-create/allocate-cluster.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { input } from "@inquirer/prompts";
import { isMain, runCli } from "../../lib/cli.js";
import { run } from "../../lib/proc.js";
import { buildClusterDef } from "./build-cluster-def.js";
import { ensureCbdinocluster } from "./ensure-cbdinocluster.js";

/** Directory under /tmp where the generated def files are written. */
const DEF_DIR = "/tmp/fit-cli";

/** A filesystem-safe timestamp like 2026-06-03T12-34-56-789Z. */
function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Write the cbdinocluster def to a fresh file under /tmp/fit-cli and return its
 * absolute path. Timestamped so consecutive runs don't clobber each other.
 */
export function writeClusterDef(def: string): string {
  mkdirSync(DEF_DIR, { recursive: true });
  const path = join(DEF_DIR, `cbdinocluster-${timestamp()}.yaml`);
  writeFileSync(path, def);
  return path;
}

/**
 * Ask whether to override the cbdinocluster deployer, returning the override
 * string or undefined for "use the default". Empty input means no override.
 */
export async function askDeployer(): Promise<string | undefined> {
  const deployer = (
    await input({
      message: "Override the cbdinocluster deployer? (leave blank for the default)",
    })
  ).trim();
  return deployer === "" ? undefined : deployer;
}

/**
 * Allocate a cluster: write `def` to a file and run
 * `cbdinocluster --verbose allocate [--deployer=<deployer>] --def-file=<file>`.
 * Output is streamed; resolves when allocation succeeds and rejects if it fails.
 */
export async function allocateCluster(
  cbdinocluster: string,
  def: string,
  deployer?: string,
): Promise<void> {
  const defFile = writeClusterDef(def);
  console.log(`Wrote cbdinocluster def to ${defFile}:\n\n${def}`);

  const args = ["--verbose", "allocate"];
  if (deployer) {
    args.push(`--deployer=${deployer}`);
  }
  args.push(`--def-file=${defFile}`);

  console.log(`Running: ${cbdinocluster} ${args.join(" ")}\n`);
  await run(cbdinocluster, args);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const cbdinocluster = await ensureCbdinocluster();
    if (!cbdinocluster) {
      process.exit(1);
    }
    const def = buildClusterDef({
      nodeCount: 1,
      version: "8.1.0",
      services: ["kv", "n1ql", "index", "fts"],
      cng: false,
    });
    await allocateCluster(cbdinocluster, def, await askDeployer());
  });
}
