/**
 * describe-instance — look up a single EC2 instance by id, returning the fields
 * we use (state, public address) or null if it isn't found. Pure plumbing over
 * the aws CLI; the JSON shaping lives in parse-instance.ts.
 *
 * Run on its own:
 *   npx tsx src/util/non-fit/aws/describe-instance.ts --id i-0123456789abcdef0 [--region eu-west-1]
 */
import { isMain, runCli } from "../cli.js";
import { awsJson, logAwsAction, prepareAwsCli, type AwsOptions } from "./aws-cli.js";
import { parseInstances, type DescribeInstancesResponse, type InstanceInfo } from "./parse-instance.js";

/** Describe a single instance, or null if it isn't found. */
export async function describeInstance(instanceId: string, options: AwsOptions = {}): Promise<InstanceInfo | null> {
  const response = await awsJson<DescribeInstancesResponse>(
    ["ec2", "describe-instances", "--instance-ids", instanceId],
    options,
  );
  return parseInstances(response)[0] ?? null;
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    const idIndex = argv.indexOf("--id");
    const id = idIndex !== -1 ? argv[idIndex + 1] : undefined;
    if (!id) {
      throw new Error("Usage: describe-instance.ts --id <instance-id> [--region <aws-region>]");
    }
    const awsOptions = prepareAwsCli(argv);
    logAwsAction("Describing EC2 instance", awsOptions, { instanceId: id });
    console.log(JSON.stringify(await describeInstance(id, awsOptions), null, 2));
  });
}
