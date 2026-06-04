/**
 * key-pair — create and delete EC2 key pairs. `createKeyPair` asks EC2 to mint a
 * fresh key pair and writes the (only-returned-once) private key to disk with
 * 0600 permissions, ready to pass to ssh as `-i`. Nothing here is FIT-specific;
 * callers choose the name and where the key lands.
 *
 * Run on its own:
 *   npx tsx src/util/non-fit/aws/key-pair.ts --create my-key --out /tmp/my-key.pem [--region eu-west-1]
 *   npx tsx src/util/non-fit/aws/key-pair.ts --delete my-key [--region eu-west-1]
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isMain, runCli } from "../cli.js";
import { awsText, logAwsAction, prepareAwsCli, type AwsOptions } from "./aws-cli.js";

/**
 * Create an EC2 key pair named `name` and write its private key to `outPath`
 * (0600). Returns `outPath`. EC2 only returns the private key at creation time,
 * so this is the one chance to save it.
 */
export async function createKeyPair(name: string, outPath: string, options: AwsOptions = {}): Promise<string> {
  const keyMaterial = await awsText(
    ["ec2", "create-key-pair", "--key-name", name, "--query", "KeyMaterial"],
    options,
  );
  mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
  writeFileSync(outPath, `${keyMaterial}\n`, { mode: 0o600 });
  chmodSync(outPath, 0o600);
  return outPath;
}

/**
 * Delete the EC2 key pair named `name`. Idempotent enough for cleanup: deleting
 * a key pair that doesn't exist is a no-op as far as EC2 is concerned.
 */
export async function deleteKeyPair(name: string, options: AwsOptions = {}): Promise<void> {
  await awsText(["ec2", "delete-key-pair", "--key-name", name], options);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    const awsOptions = prepareAwsCli(argv);
    const flag = (name: string): string | undefined => {
      const index = argv.indexOf(`--${name}`);
      return index !== -1 ? argv[index + 1] : undefined;
    };
    const create = flag("create");
    const remove = flag("delete");
    if (create) {
      const out = flag("out") ?? `/tmp/${create}.pem`;
      logAwsAction("Creating EC2 key pair", awsOptions, { keyName: create, outPath: out });
      console.log(`✓ Created key pair ${create}, private key at ${await createKeyPair(create, out, awsOptions)}`);
    } else if (remove) {
      logAwsAction("Deleting EC2 key pair", awsOptions, { keyName: remove });
      await deleteKeyPair(remove, awsOptions);
      console.log(`✓ Deleted key pair ${remove}`);
    } else {
      throw new Error("Usage: key-pair.ts --create <name> [--out <path>] [--region <aws-region>] | --delete <name> [--region <aws-region>]");
    }
  });
}
