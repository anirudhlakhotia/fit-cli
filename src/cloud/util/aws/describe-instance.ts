/**
 * describe-instance — look up a single EC2 instance by id, returning the fields
 * we use (state, public address) or null if it isn't found. Pure plumbing over
 * the EC2 SDK; the JSON shaping lives in parse-instance.ts.
 *
 * Run on its own:
 *   npx tsx src/cloud/util/aws/describe-instance.ts --id i-0123456789abcdef0
 */
import { DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { logAwsAction, prepareAwsCli } from "./aws-cli.js";
import { ec2Client } from "./aws-clients.js";
import { parseInstances, type InstanceInfo } from "./parse-instance.js";

/** Describe a single instance, or null if it isn't found. */
export async function describeInstance(instanceId: string): Promise<InstanceInfo | null> {
  const response = await ec2Client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  return parseInstances(response)[0] ?? null;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    const idIndex = argv.indexOf("--id");
    const id = idIndex !== -1 ? argv[idIndex + 1] : undefined;
    if (!id) {
      throw new Error("Usage: describe-instance.ts --id <instance-id>");
    }
    await prepareAwsCli();
    logAwsAction("Describing EC2 instance", { instanceId: id });
    console.log(JSON.stringify(await describeInstance(id), null, 2));
  });
}
