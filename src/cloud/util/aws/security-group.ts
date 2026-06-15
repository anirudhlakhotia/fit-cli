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
 *   npx tsx src/cloud/util/aws/security-group.ts --name fit-cli --ports 22 [--vpc vpc-0123]
 *   npx tsx src/cloud/util/aws/security-group.ts --delete sg-0123456789abcdef0
 */
import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DeleteSecurityGroupCommand,
  DescribeSecurityGroupsCommand,
} from "@aws-sdk/client-ec2";
import { isMain, runCli } from "../../../util/non-fit/cli.js";
import { logAwsAction, prepareAwsCli } from "./aws-cli.js";
import { ec2Client } from "./aws-clients.js";
import { parseSecurityGroupId } from "./parse-security-group.js";

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

/** Find the id of an existing security group by name, or null if there isn't one. */
async function findSecurityGroup(name: string, vpcId?: string): Promise<string | null> {
  const filters = [{ Name: "group-name", Values: [name] }];
  if (vpcId) {
    filters.push({ Name: "vpc-id", Values: [vpcId] });
  }
  const response = await ec2Client.send(new DescribeSecurityGroupsCommand({ Filters: filters }));
  return parseSecurityGroupId(response);
}

/** Open one inbound TCP port to 0.0.0.0/0, ignoring an already-present rule. */
async function authorizeIngress(groupId: string, port: number): Promise<void> {
  try {
    await ec2Client.send(new AuthorizeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: [{
        IpProtocol: "tcp",
        FromPort: port,
        ToPort: port,
        IpRanges: [{ CidrIp: "0.0.0.0/0" }],
      }],
    }));
  } catch (err) {
    // The rule already existing is exactly the state we want — anything else is real.
    if (!(err instanceof Error && err.name === "InvalidPermission.Duplicate")) {
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
    const created = await ec2Client.send(new CreateSecurityGroupCommand({
      GroupName: spec.name,
      Description: spec.description ?? spec.name,
      ...(spec.vpcId ? { VpcId: spec.vpcId } : {}),
    }));
    groupId = created.GroupId ?? "";
  }
  for (const port of spec.ingressPorts) {
    await authorizeIngress(groupId, port);
  }
  return groupId;
}

/** Delete a security group by id. */
export async function deleteSecurityGroup(groupId: string): Promise<void> {
  await ec2Client.send(new DeleteSecurityGroupCommand({ GroupId: groupId }));
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
