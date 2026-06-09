import { type InstanceInfo } from "../../non-fit/aws/parse-instance.js";

function formatBanner(title: string, lines: string[]): string {
  const content = [title, ...lines];
  const width = Math.max(...content.map((line) => line.length), 24) + 4;
  const border = "=".repeat(width);
  return [
    border,
    ...content.map((line) => `= ${line.padEnd(width - 4)} =`),
    border,
  ].join("\n");
}

export function terminateInstanceCommand(instanceId: string, region: string): string {
  return `npx tsx src/util/non-fit/aws/terminate-instance.ts --id ${instanceId} --region ${region}`;
}

export function formatEc2DeletionResponsibilityBanner(
  instanceId: string,
  region: string,
  address?: string,
  otherInstances?: InstanceInfo[],
  context?: InstanceListContext,
): string {
  const lines: string[] = [
    `Instance: ${instanceId}${address ? ` (${address})` : ""}`,
    `Region: ${region}`,
  ];
  if (context?.account || context?.creator) {
    const parts: string[] = [];
    if (context.account) parts.push(`account: ${context.account}`);
    if (context.creator) parts.push(`user: ${context.creator}`);
    lines.push(parts.join("  ·  "));
  }
  lines.push(
    `Console: ${awsConsoleInstancesUrl(region)}`,
    "",
    "This instance keeps incurring AWS charges until it is terminated.",
    "fit-cli will offer to delete it at the end of the run.",
    "If you keep it running, or leave before cleanup, you must delete it yourself.",
    "Terminate it with:",
    `  ${terminateInstanceCommand(instanceId, region)}`,
  );
  if (otherInstances && otherInstances.length > 0) {
    lines.push(
      "",
      `${otherInstances.length} other fit-cli instance${otherInstances.length === 1 ? "" : "s"} also running in ${region} — each keeps incurring AWS charges:`,
    );
    for (const inst of otherInstances) {
      const addr = inst.publicDns || inst.publicIp || "";
      const creator = inst.creator ? `  created-by: ${inst.creator}` : "";
      lines.push(`  ${inst.instanceId}${addr ? ` (${addr})` : ""}${creator}`);
      lines.push(`    terminate: ${terminateInstanceCommand(inst.instanceId, region)}`);
    }
    const allIds = [instanceId, ...otherInstances.map((i) => i.instanceId)];
    lines.push(
      "",
      `Delete all ${allIds.length} in one shot with:`,
      `  aws --region ${region} ec2 terminate-instances --instance-ids ${allIds.join(" ")}`,
      "",
      "Or manage them interactively with:",
      `  npm run cloud-instances -- manage --region ${region}`,
    );
  }
  return formatBanner("EC2 LIFECYCLE WARNING", lines);
}

export interface InstanceListContext {
  account?: string;
  creator?: string;
}

/** AWS console URL pre-filtered to the fit-cli tag in the given region. */
export function awsConsoleInstancesUrl(region: string): string {
  return (
    `https://${region}.console.aws.amazon.com/ec2/home` +
    `?region=${region}#Instances:v=3;tag:fit-cli=owned`
  );
}

export function formatExistingInstancesBanner(
  instances: InstanceInfo[],
  region: string,
  context?: InstanceListContext,
): string {
  const count = instances.length;
  const lines: string[] = [`Region: ${region}`];
  if (context?.account || context?.creator) {
    const parts: string[] = ["Filter: tag:fit-cli=owned"];
    if (context.account) parts.push(`account: ${context.account}`);
    if (context.creator) parts.push(`user: ${context.creator}`);
    lines.push(parts.join("  ·  "));
  } else {
    lines.push("Filter: tag:fit-cli=owned");
  }
  lines.push(`Console: ${awsConsoleInstancesUrl(region)}`);
  lines.push("", `${count} instance${count === 1 ? "" : "s"} already running — each keeps incurring AWS charges:`);
  for (const inst of instances) {
    const addr = inst.publicDns || inst.publicIp;
    const creator = inst.creator ? `  created-by: ${inst.creator}` : "";
    lines.push(`  ${inst.instanceId}${addr ? ` (${addr})` : ""}${creator}`);
    lines.push(`    terminate: ${terminateInstanceCommand(inst.instanceId, region)}`);
  }
  lines.push(
    "",
    `Delete ${count === 1 ? "it" : "them all"} in one shot with:`,
    `  aws --region ${region} ec2 terminate-instances --instance-ids ${instances.map((inst) => inst.instanceId).join(" ")}`,
    "",
    "Or manage them interactively with:",
    `  npm run cloud-instances -- manage --region ${region}`,
  );
  return formatBanner("EXISTING FIT-CLI INSTANCES", lines);
}

export function formatEc2CleanupPromptBanner(instanceId: string, region: string, address?: string): string {
  return formatBanner("EC2 CLEANUP DECISION", [
    `Instance: ${instanceId}${address ? ` (${address})` : ""}`,
    `Region: ${region}`,
    "This instance is still running and still billable.",
    "Choose No to terminate it now (recommended, and the default).",
    "Choose Yes only if you want to keep debugging and will delete it yourself.",
    "Terminate later with:",
    `  ${terminateInstanceCommand(instanceId, region)}`,
  ]);
}
