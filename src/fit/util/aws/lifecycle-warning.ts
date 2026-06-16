import { type InstanceInfo } from "../../../cloud/util/aws/parse-instance.js";
import { AWS_REGION } from "../../../cloud/util/aws/aws-target.js";

export function formatBanner(title: string, lines: string[]): string {
  const content = [title, ...lines];
  const width = Math.max(...content.map((line) => line.length), 24) + 4;
  const border = "=".repeat(width);
  return [
    border,
    ...content.map((line) => `= ${line.padEnd(width - 4)} =`),
    border,
  ].join("\n");
}

export function terminateInstanceCommand(instanceId: string): string {
  return `npx tsx src/cloud/util/aws/terminate-instance.ts --id ${instanceId}`;
}

export function formatEc2DeletionResponsibilityBanner(
  instanceId: string,
  address?: string,
  otherInstances?: InstanceInfo[],
  context?: InstanceListContext,
): string {
  const lines: string[] = [
    `Instance: ${instanceId}${address ? ` (${address})` : ""}`,
    `Region: ${AWS_REGION}`,
  ];
  if (context?.account || context?.creator) {
    const parts: string[] = [];
    if (context.account) parts.push(`account: ${context.account}`);
    if (context.creator) parts.push(`user: ${context.creator}`);
    lines.push(parts.join("  ·  "));
  }
  lines.push(
    `Console: ${awsConsoleInstancesUrl()}`,
    "",
    "This instance keeps incurring AWS charges until it is terminated.",
    "fit-cli will offer to delete it at the end of the run.",
    "If you keep it running, or leave before cleanup, you must delete it yourself.",
    "Terminate it with:",
    `  ${terminateInstanceCommand(instanceId)}`,
    "",
    "Automated cleanup: a scheduled job terminates fit-cli instances older than 24h.",
    "  https://github.com/couchbaselabs/fit-cli/actions/workflows/cleanup-instances.yaml",
  );
  if (otherInstances && otherInstances.length > 0) {
    lines.push(
      "",
      `${otherInstances.length} other fit-cli instance${otherInstances.length === 1 ? "" : "s"} also running in ${AWS_REGION} — each keeps incurring AWS charges:`,
    );
    for (const inst of otherInstances) {
      const addr = inst.publicDns || inst.publicIp || "";
      const creator = inst.creator ? `  created-by: ${inst.creator}` : "";
      lines.push(`  ${inst.instanceId}${addr ? ` (${addr})` : ""}${creator}`);
      lines.push(`    terminate: ${terminateInstanceCommand(inst.instanceId)}`);
    }
    const allIds = [instanceId, ...otherInstances.map((i) => i.instanceId)];
    lines.push(
      "",
      `Delete all ${allIds.length} in one shot with:`,
      `  aws --region ${AWS_REGION} ec2 terminate-instances --instance-ids ${allIds.join(" ")}`,
      "",
      "Or manage them interactively with:",
      `  bun run cloud-instances -- manage`,
    );
  }
  return formatBanner("EC2 LIFECYCLE WARNING", lines);
}

export interface InstanceListContext {
  account?: string;
  creator?: string;
}

/** AWS console URL pre-filtered to the fit-cli tag in the fixed region. */
export function awsConsoleInstancesUrl(): string {
  return (
    `https://${AWS_REGION}.console.aws.amazon.com/ec2/home` +
    `?region=${AWS_REGION}#Instances:v=3;tag:fit-cli=owned`
  );
}

export function formatExistingInstancesBanner(
  instances: InstanceInfo[],
  context?: InstanceListContext,
): string {
  const count = instances.length;
  const lines: string[] = [`Region: ${AWS_REGION}`];
  if (context?.account || context?.creator) {
    const parts: string[] = ["Filter: tag:fit-cli=owned"];
    if (context.account) parts.push(`account: ${context.account}`);
    if (context.creator) parts.push(`user: ${context.creator}`);
    lines.push(parts.join("  ·  "));
  } else {
    lines.push("Filter: tag:fit-cli=owned");
  }
  lines.push(`Console: ${awsConsoleInstancesUrl()}`);
  lines.push("", `${count} instance${count === 1 ? "" : "s"} already running — each keeps incurring AWS charges:`);
  for (const inst of instances) {
    const addr = inst.publicDns || inst.publicIp;
    const creator = inst.creator ? `  created-by: ${inst.creator}` : "";
    lines.push(`  ${inst.instanceId}${addr ? ` (${addr})` : ""}${creator}`);
    lines.push(`    terminate: ${terminateInstanceCommand(inst.instanceId)}`);
  }
  lines.push(
    "",
    `Delete ${count === 1 ? "it" : "them all"} in one shot with:`,
    `  aws --region ${AWS_REGION} ec2 terminate-instances --instance-ids ${instances.map((inst) => inst.instanceId).join(" ")}`,
    "",
    "Or manage them interactively with:",
    `  bun run cloud-instances -- manage`,
  );
  return formatBanner("EXISTING FIT-CLI INSTANCES", lines);
}

export function formatEc2CleanupPromptBanner(instanceId: string, address?: string): string {
  return formatBanner("EC2 CLEANUP DECISION", [
    `Instance: ${instanceId}${address ? ` (${address})` : ""}`,
    `Region: ${AWS_REGION}`,
    "This instance is still running and still billable.",
    "Choose No to terminate it now (recommended, and the default).",
    "Choose Yes only if you want to keep debugging and will delete it yourself.",
    "Terminate later with:",
    `  ${terminateInstanceCommand(instanceId)}`,
  ]);
}
