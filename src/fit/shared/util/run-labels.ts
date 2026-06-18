import type { DefinitionRunPath } from "../../../util/non-fit/replay.js";

/**
 * Inputs for rendering a run's position as human-readable labels (e.g.
 * `aws1 / cbdino1 / java:main / func`). Every field is optional: callers pass
 * whatever they know at the point of formatting, and each missing piece falls
 * back to an index-based word form (`instance1`, `cbdino1`, `s1`, `r1`) so the
 * label is always complete. The same segment builders feed both the
 * `[HH:MM:SS …]` log prefix and the path summaries, so the conventions stay
 * identical everywhere.
 */
export interface RunLabelParts {
  /** Execution target kind — distinguishes `aws1` from `local`. */
  instanceKind?: "aws" | "localhost";
  /** Cluster provenance — `cbdino1` (allocated) vs `existing1` (connection/useExisting). */
  clusterMode?: "connection" | "useExisting" | "cbdinocluster";
  /** Lowercase SDK value, e.g. `java`. */
  sdkValue?: string;
  /** Performer image version / ref, e.g. `main`. */
  performerVersion?: string;
  type?: "functional" | "situational";
  /** Named test presets for this run; a single preset names the run segment. */
  presets?: readonly string[];
}

/** `local` / `aws1` / (fallback) `instance1`. */
export function instanceLabel(path: DefinitionRunPath, kind?: RunLabelParts["instanceKind"]): string {
  if (kind === "localhost") {
    return "local";
  }
  if (kind === "aws") {
    return `aws${path.instanceIndex + 1}`;
  }
  return `instance${path.instanceIndex + 1}`;
}

/** `cbdino1` / `existing1`, or undefined for a clusterless (situational) session. */
export function clusterLabel(path: DefinitionRunPath, mode?: RunLabelParts["clusterMode"]): string | undefined {
  if (path.clusterlessSession) {
    return undefined;
  }
  const n = (path.clusterIndex ?? 0) + 1;
  return mode === "connection" || mode === "useExisting" ? `existing${n}` : `cbdino${n}`;
}

/** The session, named by its performer: `java:main` (or just `java`), falling back to `s1`. */
export function performerLabel(path: DefinitionRunPath, sdkValue?: string, version?: string): string {
  if (sdkValue) {
    return version ? `${sdkValue}:${version}` : sdkValue;
  }
  return `s${(path.sessionIndex ?? 0) + 1}`;
}

/** The run, named by its single preset, else its type (`func`/`sit`), else `r1`. */
export function runLabel(
  path: DefinitionRunPath,
  type?: RunLabelParts["type"],
  presets?: readonly string[],
): string | undefined {
  if (presets && presets.length === 1) {
    return presets[0];
  }
  if (type) {
    return type === "functional" ? "func" : "sit";
  }
  return path.runIndex !== undefined ? `r${path.runIndex + 1}` : undefined;
}

/** Join the four segments with ` / `, dropping any that don't apply. */
export function formatRunLabel(path: DefinitionRunPath, parts: RunLabelParts = {}): string {
  return [
    instanceLabel(path, parts.instanceKind),
    clusterLabel(path, parts.clusterMode),
    performerLabel(path, parts.sdkValue, parts.performerVersion),
    runLabel(path, parts.type, parts.presets),
  ]
    .filter((segment): segment is string => Boolean(segment))
    .join(" / ");
}
