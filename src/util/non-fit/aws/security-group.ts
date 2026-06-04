/**
 * security-group — make sure a named security group exists with the wanted
 * inbound TCP ports open. `ensureSecurityGroup` is idempotent: it reuses an
 * existing group of the same name (in the account's default VPC) and tolerates
 * ingress rules that are already present, so it's safe to call on every run.
 *
 * Run on its own:
 *   npx tsx src/util/non-fit/aws/security-group.ts --name fit-cli --ports 22 [--region eu-west-1]
 *   npx tsx src/util/non-fit/aws/security-group.ts --delete sg-0123456789abcdef0 [--region eu-west-1]
 */
import { isMain, runCli } from "../cli.js";
import { awsJson, logAwsAction, prepareAwsCli, type AwsOptions } from "./aws-cli.js";
import { parseSecurityGroupId, type DescribeSecurityGroupsResponse } from "./parse-security-group.js";

/** What to ensure about a security group. */
export interface SecurityGroupSpec {
  /** Group name (unique within the VPC). */
  name: string;
  /** Free-text description, set only when the group is first created. */
  description?: string;
  /** Inbound TCP ports to open to 0.0.0.0/0. */
  ingressPorts: readonly number[];
}

/** Find the id of an existing security group by name, or null if there isn't one. */
async function findSecurityGroup(name: string, options: AwsOptions): Promise<string | null> {
  const response = await awsJson<DescribeSecurityGroupsResponse>(
    ["ec2", "describe-security-groups", "--filters", `Name=group-name,Values=${name}`],
    options,
  );
  return parseSecurityGroupId(response);
}

/** Open one inbound TCP port to 0.0.0.0/0, ignoring an already-present rule. */
async function authorizeIngress(groupId: string, port: number, options: AwsOptions): Promise<void> {
  try {
    await awsJson(
      [
        "ec2",
        "authorize-security-group-ingress",
        "--group-id",
        groupId,
        "--protocol",
        "tcp",
        "--port",
        String(port),
        "--cidr",
        "0.0.0.0/0",
      ],
      options,
    );
  } catch (err) {
    // The rule already existing is exactly the state we want — anything else is real.
    if (!(err instanceof Error && err.message.includes("InvalidPermission.Duplicate"))) {
      throw err;
    }
  }
}

/**
 * Ensure a security group named `spec.name` exists with the requested inbound
 * ports open, returning its id. Creates the group if it's missing, then opens
 * each port (skipping rules that already exist).
 */
export async function ensureSecurityGroup(spec: SecurityGroupSpec, options: AwsOptions = {}): Promise<string> {
  let groupId = await findSecurityGroup(spec.name, options);
  if (!groupId) {
    const created = await awsJson<{ GroupId: string }>(
      [
        "ec2",
        "create-security-group",
        "--group-name",
        spec.name,
        "--description",
        spec.description ?? spec.name,
      ],
      options,
    );
    groupId = created.GroupId;
  }
  for (const port of spec.ingressPorts) {
    await authorizeIngress(groupId, port, options);
  }
  return groupId;
}

/** Delete a security group by id. */
export async function deleteSecurityGroup(groupId: string, options: AwsOptions = {}): Promise<void> {
  await awsJson(["ec2", "delete-security-group", "--group-id", groupId], options);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    const argv = process.argv.slice(2);
    const awsOptions = prepareAwsCli(argv);
    const flag = (name: string): string | undefined => {
      const index = argv.indexOf(`--${name}`);
      return index !== -1 ? argv[index + 1] : undefined;
    };
    const remove = flag("delete");
    if (remove) {
      logAwsAction("Deleting security group", awsOptions, { groupId: remove });
      await deleteSecurityGroup(remove, awsOptions);
      console.log(`✓ Deleted security group ${remove}`);
      return;
    }
    const name = flag("name");
    if (!name) {
      throw new Error(
        "Usage: security-group.ts --name <name> [--ports 22,8080] [--region <aws-region>] | --delete <sg-id> [--region <aws-region>]",
      );
    }
    const ports = (flag("ports") ?? "22").split(",").map((p) => Number(p.trim()));
    logAwsAction("Ensuring security group", awsOptions, { name, ingressPorts: ports });
    const id = await ensureSecurityGroup({ name, ingressPorts: ports }, awsOptions);
    console.log(`✓ Security group ${name} is ${id} with ports ${ports.join(", ")} open to 0.0.0.0/0`);
  });
}
