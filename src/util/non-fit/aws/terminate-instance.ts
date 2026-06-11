/**
 * terminate-instance — terminate an EC2 instance by id. Pure plumbing over the
 * aws CLI. Terminating an already-terminated instance is a no-op as far as EC2
 * is concerned, so this is safe to call in cleanup paths.
 *
 * Run on its own:
 *   npx tsx src/util/non-fit/aws/terminate-instance.ts --id i-0123456789abcdef0
 */
import { isMain, runCli } from "../cli.js";
import { awsJson, logAwsAction, prepareAwsCli } from "./aws-cli.js";

/** Terminate an instance by id. */
export async function terminateInstance(instanceId: string): Promise<void> {
  await awsJson(["ec2", "terminate-instances", "--instance-ids", instanceId]);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    const idIndex = argv.indexOf("--id");
    const id = idIndex !== -1 ? argv[idIndex + 1] : undefined;
    if (!id) {
      throw new Error("Usage: terminate-instance.ts --id <instance-id>");
    }
    await prepareAwsCli();
    logAwsAction("Terminating EC2 instance", { instanceId: id });
    await terminateInstance(id);
    console.log(`✓ Terminating ${id}`);
  });
}
