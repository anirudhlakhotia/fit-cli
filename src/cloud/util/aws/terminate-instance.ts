/**
 * terminate-instance — terminate an EC2 instance by id. Pure plumbing over the
 * EC2 SDK. Terminating an already-terminated instance is a no-op as far as EC2
 * is concerned, so this is safe to call in cleanup paths.
 *
 * Run on its own:
 *   npx tsx src/cloud/util/aws/terminate-instance.ts --id i-0123456789abcdef0
 */
import { TerminateInstancesCommand } from "@aws-sdk/client-ec2";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { logAwsAction, prepareAwsCli } from "./aws-cli.js";
import { ec2Client } from "./aws-clients.js";

/** Terminate an instance by id. */
export async function terminateInstance(instanceId: string): Promise<void> {
  await ec2Client.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
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
