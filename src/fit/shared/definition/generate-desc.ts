/**
 * Generate a compact human-readable description of a FIT definition.
 *
 * Output example:
 *   {AWS:{cbdino(3n@8.1.0):[{Java@latest,functional,SanityTest}]}}
 */
import { SDKS } from "../../../util/sdk/sdks.js";
import type { ClusterLifetime, FitDefinition, FitRun, InstanceLifetime, SessionLifetime } from "./types.js";
import { resolveDefinitionRefs } from "./resolve-definition.js";

function sdkDisplayName(value: string): string {
  return SDKS.find((s) => s.value === value)?.name ?? value;
}

function describeClusterSource(cluster: ClusterLifetime): string {
  if (cluster.cbdinocluster) {
    const nodes = cluster.cbdinocluster.config.nodes
      .map((n) => `${n.count}n@${n.version}`)
      .join("+");
    const cng = cluster.cbdinocluster.config.cao ? "+CNG" : "";
    return `cbdino(${nodes}${cng})`;
  }
  if (cluster.connection) {
    return "connection";
  }
  return "useExisting";
}

function describeRunTests(run: FitRun): string {
  const { presets, classes } = run.tests;
  const parts: string[] = [];
  // "all" (and omitting both keys) is the implicit default, so it adds no suffix.
  for (const preset of presets ?? []) {
    if (preset !== "all") parts.push(preset);
  }
  if (classes?.length === 1) {
    parts.push(classes[0].split(".").at(-1) ?? classes[0]);
  } else if (classes && classes.length > 1) {
    parts.push(`${classes.length} tests`);
  }
  return parts.length ? `,${parts.join("+")}` : "";
}

function describeSession(session: SessionLifetime): string {
  const sdk = sdkDisplayName(session.performer.sdk);
  const version = session.performer.version ?? "latest";
  const runTypes = [...new Set(session.runs.map((r) => r.type))].join(",");
  const testSuffix = session.runs.length === 1 ? describeRunTests(session.runs[0]) : "";
  return `{${sdk}@${version},${runTypes}${testSuffix}}`;
}

function describeCluster(cluster: ClusterLifetime): string {
  const source = describeClusterSource(cluster);
  const sessions = cluster.sessions.map(describeSession).join(",");
  return `${source}:[${sessions}]`;
}

function describeInstance(instance: InstanceLifetime): string {
  const mode = "aws" in instance ? "AWS" : "localhost";
  const clusterParts = instance.clusters.map(describeCluster);
  const clusterlessSessions = instance.clusterlessSessions ?? [];
  const clusterlessParts = clusterlessSessions.length > 0
    ? [`clusterless:[${clusterlessSessions.map(describeSession).join(",")}]`]
    : [];
  const body = [...clusterParts, ...clusterlessParts].join(",");
  return `{${mode}:{${body}}}`;
}

export function describeDefinition(definition: FitDefinition): string {
  const resolved = resolveDefinitionRefs(definition);
  const parts = resolved.instances.map(describeInstance);
  return parts.length === 1 ? parts[0] : `[${parts.join(",")}]`;
}
