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
): string {
  return formatBanner("EC2 LIFECYCLE WARNING", [
    `Instance: ${instanceId}${address ? ` (${address})` : ""}`,
    `Region: ${region}`,
    "This instance keeps incurring AWS charges until it is terminated.",
    "fit-cli will offer to delete it at the end of the run.",
    "If you keep it running, or leave before cleanup, you must delete it yourself.",
    "Terminate it with:",
    `  ${terminateInstanceCommand(instanceId, region)}`,
  ]);
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
