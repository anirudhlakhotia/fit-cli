/**
 * security-group — make sure a named security group exists with the wanted
 * inbound TCP ports open. `ensureSecurityGroup` is idempotent: it reuses an
 * existing group of the same name and tolerates ingress rules that are already
 * present, so it's safe to call on every run.
 *
 * Security-group names are unique per VPC. Pass `vpcId` to create/look up the
 * group in a specific VPC (required in accounts/regions with no default VPC);
 * omit it to use the account's default VPC.
 *
 * Run on its own:
 *   npx tsx src/util/non-fit/aws/security-group.ts --name fit-cli --ports 22 [--vpc vpc-0123]
 *   npx tsx src/util/non-fit/aws/security-group.ts --delete sg-0123456789abcdef0
 */
import { isMain, runCli } from "../cli.js";
import { awsJson, logAwsAction, prepareAwsCli } from "./aws-cli.js";
import { parseSecurityGroupId, type DescribeSecurityGroupsResponse } from "./parse-security-group.js";

/** What to ensure about a security group. */
export interface SecurityGroupSpec {
  /** Group name (unique within the VPC). */
  name: string;
  /** Free-text description, set only when the group is first created. */
  description?: string;
  /** Inbound TCP ports to open to 0.0.0.0/0. */
  ingressPorts: readonly number[];
  /** VPC to create/look up the group in. Defaults to the account's default VPC when omitted. */
  vpcId?: string;
}

/**
 * Build the describe-security-groups filters for a name (optionally scoped to a
 * VPC). Pure so the vpc-id scoping can be unit tested.
 */
export function securityGroupFilters(name: string, vpcId?: string): string[] {
  const filters = [`Name=group-name,Values=${name}`];
  if (vpcId) {
    filters.push(`Name=vpc-id,Values=${vpcId}`);
  }
  return filters;
}

/**
 * Build the `aws ec2 create-security-group` argument list. Pure so the optional
 * `--vpc-id` can be unit tested.
 */
export function createSecurityGroupArgs(spec: SecurityGroupSpec): string[] {
  const args = [
    "ec2",
    "create-security-group",
    "--group-name",
    spec.name,
    "--description",
    spec.description ?? spec.name,
  ];
  if (spec.vpcId) {
    args.push("--vpc-id", spec.vpcId);
  }
  return args;
}

/** Find the id of an existing security group by name, or null if there isn't one. */
async function findSecurityGroup(name: string, vpcId?: string): Promise<string | null> {
  const response = await awsJson<DescribeSecurityGroupsResponse>([
    "ec2",
    "describe-security-groups",
    "--filters",
    ...securityGroupFilters(name, vpcId),
  ]);
  return parseSecurityGroupId(response);
}

/** Open one inbound TCP port to 0.0.0.0/0, ignoring an already-present rule. */
async function authorizeIngress(groupId: string, port: number): Promise<void> {
  try {
    await awsJson([
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
    ]);
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
export async function ensureSecurityGroup(spec: SecurityGroupSpec): Promise<string> {
  let groupId = await findSecurityGroup(spec.name, spec.vpcId);
  if (!groupId) {
    const created = await awsJson<{ GroupId: string }>(createSecurityGroupArgs(spec));
    groupId = created.GroupId;
  }
  for (const port of spec.ingressPorts) {
    await authorizeIngress(groupId, port);
  }
  return groupId;
}

/** Delete a security group by id. */
export async function deleteSecurityGroup(groupId: string): Promise<void> {
  await awsJson(["ec2", "delete-security-group", "--group-id", groupId]);
}

if (isMain(import.meta.url)) {
  runCli(async () => {
    await prepareAwsCli();
    const argv = process.argv.slice(2);
    const flag = (name: string): string | undefined => {
      const index = argv.indexOf(`--${name}`);
      return index !== -1 ? argv[index + 1] : undefined;
    };
    const remove = flag("delete");
    if (remove) {
      logAwsAction("Deleting security group", { groupId: remove });
      await deleteSecurityGroup(remove);
      console.log(`✓ Deleted security group ${remove}`);
      return;
    }
    const name = flag("name");
    if (!name) {
      throw new Error(
        "Usage: security-group.ts --name <name> [--ports 22,8080] [--vpc <vpc-id>] | --delete <sg-id>",
      );
    }
    const ports = (flag("ports") ?? "22").split(",").map((p) => Number(p.trim()));
    const vpcId = flag("vpc");
    logAwsAction("Ensuring security group", { name, ingressPorts: ports, vpcId });
    const id = await ensureSecurityGroup({ name, ingressPorts: ports, vpcId });
    console.log(`✓ Security group ${name} is ${id} with ports ${ports.join(", ")} open to 0.0.0.0/0`);
  });
}
