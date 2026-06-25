/**
 * Generate a compact human-readable description of a FIT definition.
 *
 * Output example:
 *   {AWS:{cbdino(3n@8.1.0):[{Java@latest,functional,SanityTest}]}}
 */
import type { ClusterLifetime, FitDefinition, FitRun, InstanceLifetime, SessionLifetime } from "./types.js";
import { resolveDefinitionRefs } from "./resolve-definition.js";
import { analysePerformerImage } from "../../performers/util/performer-image.js";
import { sdkPerformerImageBasename } from "../../../util/sdk/sdks.js";

function describeClusterSource(cluster: ClusterLifetime): string {
  if (cluster.cbdinocluster) {
    const nodes = cluster.cbdinocluster.config.nodes
      .map((n) => `${n.count}n@${n.version}`)
      .join("+");
    const cng = cluster.cbdinocluster.config.cao ? "+CNG" : "";
    // `columnar: true` allocates a self-managed Enterprise Analytics cluster.
    const ea = cluster.cbdinocluster.config.columnar ? "EA," : "";
    return `cbdino(${ea}${nodes}${cng})`;
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
  const parsed = analysePerformerImage(session.performer.image);
  // Use the performer image basename (e.g. `java`, `analytics-java`, `cxx`) rather than
  // the SDK's friendly name, so the description reads as what's actually run.
  const sdk = "error" in parsed ? session.performer.image : sdkPerformerImageBasename(parsed.sdk);
  const version = "error" in parsed ? "?" : parsed.tag;
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
