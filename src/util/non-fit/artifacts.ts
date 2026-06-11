import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { ensureRunDir } from "./replay.js";

/** A file produced during the current fit-cli run, stored under ARTIFACT_DIR. */
export interface Artifact {
  /** File path relative to ARTIFACT_DIR. */
  filename: string;
  /** Short explanation of what the file is for. */
  explanation: string;
}

export interface ArtifactCollection {
  artifacts: Artifact[];
}

/** A copy-pasteable command or fact worth surfacing at the end of a run. */
export interface Detail {
  label: string;
  value: string;
}

export interface DetailCollection {
  details: Detail[];
}

/** A failure that affected a definition run, for exit-code and summary purposes. */
export interface RecordedFailure {
  classification: string;
  message: string;
  context: {
    instanceIndex: number;
    clusterIndex?: number;
    sessionIndex?: number;
    clusterless?: boolean;
  };
}

export interface RunOutput extends ArtifactCollection, DetailCollection {
  worstFailure?: RecordedFailure;
  failureCount?: number;
}

const FAILURE_SEVERITY: Record<string, number> = {
  NonFatal: 0,
  FatalToIteration: 1,
  FatalToCycle: 2,
  FatalToAll: 3,
};

export function worstFailureShouldExitNonZero(failure: RecordedFailure): boolean {
  return (FAILURE_SEVERITY[failure.classification] ?? 0) >= FAILURE_SEVERITY.FatalToIteration;
}

export function formatFailureSummaryLine(failure: RecordedFailure, totalCount: number): string {
  const { classification, message, context } = failure;
  const extra = totalCount > 1 ? ` (+${totalCount - 1} more failure${totalCount > 2 ? "s" : ""})` : "";
  const parts = [
    `instance ${context.instanceIndex + 1}`,
    // Clusterless (situational) sessions aren't tied to a cluster, so they show a
    // session but no cluster; functional runs show both.
    ...(!context.clusterless && context.clusterIndex !== undefined ? [`cluster ${context.clusterIndex + 1}`] : []),
    ...(context.sessionIndex !== undefined ? [`session ${context.sessionIndex + 1}`] : []),
  ];
  return `Returning non-zero due to ${classification} error '${message}' on ${parts.join(", ")}${extra}`;
}

interface ArtifactTableRow extends Artifact {
  size?: string;
}

/** Turn an absolute artifact path into a first-class artifact record. */
export function artifactFromPath(
  path: string,
  explanation: string,
  artifactDir: string = ensureRunDir(),
): Artifact {
  const filename = relative(artifactDir, path);
  if (filename === "" || filename.startsWith("..") || isAbsolute(filename)) {
    throw new Error(`Artifact ${path} is not inside ARTIFACT_DIR ${artifactDir}`);
  }
  return { filename, explanation };
}

/** Merge artifact lists while preserving first-seen order. */
export function combineArtifacts(...groups: ReadonlyArray<readonly Artifact[] | undefined>): Artifact[] {
  const combined: Artifact[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const artifact of group ?? []) {
      const key = `${artifact.filename}\u0000${artifact.explanation}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      combined.push(artifact);
    }
  }

  return combined;
}

/** List every file under `dir`, recursively, as paths relative to `dir`. */
function walkFilesRelative(dir: string, base: string = dir): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFilesRelative(full, base));
    } else if (entry.isFile()) {
      files.push(relative(base, full));
    }
  }
  return files;
}

/**
 * Union the explicitly-registered artifacts with every other file actually found
 * under the run dir, so the end-of-run table never silently omits something that
 * was written. Registered artifacts keep their first-seen order and their
 * human-written "Purpose"; anything else found on disk is appended (sorted) with
 * a generic purpose. Best-effort — if the dir can't be read, the explicit list is
 * returned unchanged.
 */
export function reconcileArtifactsWithDir(artifactDir: string, explicit: readonly Artifact[]): Artifact[] {
  const combined = combineArtifacts(explicit);
  let discovered: string[];
  try {
    discovered = walkFilesRelative(artifactDir);
  } catch {
    return combined;
  }
  const known = new Set(combined.map((artifact) => artifact.filename));
  const extras: Artifact[] = discovered
    .filter((filename) => !known.has(filename))
    .sort()
    .map((filename) => ({ filename, explanation: "(captured during the run)" }));
  return [...combined, ...extras];
}

/** Merge detail lists while preserving first-seen order. */
export function combineDetails(...groups: ReadonlyArray<readonly Detail[] | undefined>): Detail[] {
  const combined: Detail[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    for (const detail of group ?? []) {
      const key = `${detail.label}\u0000${detail.value}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      combined.push(detail);
    }
  }

  return combined;
}

/** Merge run outputs while preserving first-seen order within each output type. */
export function combineRunOutputs(...groups: ReadonlyArray<Partial<RunOutput> | undefined>): RunOutput {
  const worstFailure = groups.find((g) => g?.worstFailure !== undefined)?.worstFailure;
  const failureCount = groups.find((g) => g?.failureCount !== undefined)?.failureCount;
  return {
    artifacts: combineArtifacts(...groups.map((group) => group?.artifacts)),
    details: combineDetails(...groups.map((group) => group?.details)),
    ...(worstFailure !== undefined ? { worstFailure } : {}),
    ...(failureCount !== undefined ? { failureCount } : {}),
  };
}

function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 ** 2) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  if (bytes < 1024 ** 3) {
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  }

  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** Format artifacts as a simple terminal table. */
export function formatArtifactsTable(artifacts: readonly ArtifactTableRow[]): string | undefined {
  if (artifacts.length === 0) {
    return undefined;
  }

  const filenameHeader = "Artifact filename";
  const sizeHeader = "Size";
  const explanationHeader = "Purpose";
  const filenameWidth = Math.max(filenameHeader.length, ...artifacts.map((artifact) => artifact.filename.length));
  const showSize = artifacts.some((artifact) => artifact.size !== undefined);
  const sizeWidth = showSize
    ? Math.max(sizeHeader.length, ...artifacts.map((artifact) => (artifact.size ?? "").length))
    : 0;

  return [
    showSize
      ? `${filenameHeader.padEnd(filenameWidth)} | ${sizeHeader.padEnd(sizeWidth)} | ${explanationHeader}`
      : `${filenameHeader.padEnd(filenameWidth)} | ${explanationHeader}`,
    showSize
      ? `${"-".repeat(filenameWidth)}-+-${"-".repeat(sizeWidth)}-+-${"-".repeat(explanationHeader.length)}`
      : `${"-".repeat(filenameWidth)}-+-${"-".repeat(explanationHeader.length)}`,
    ...artifacts.map((artifact) =>
      showSize
        ? `${artifact.filename.padEnd(filenameWidth)} | ${(artifact.size ?? "").padEnd(sizeWidth)} | ${artifact.explanation}`
        : `${artifact.filename.padEnd(filenameWidth)} | ${artifact.explanation}`,
    ),
  ].join("\n");
}

/** Format details as a simple terminal table. */
export function formatDetailsTable(details: readonly Detail[]): string | undefined {
  if (details.length === 0) {
    return undefined;
  }

  const labelHeader = "Detail";
  const valueHeader = "Value";
  const labelWidth = Math.max(labelHeader.length, ...details.map((detail) => detail.label.length));
  const valueWidth = Math.max(valueHeader.length, ...details.map((detail) => detail.value.length));

  return [
    `${labelHeader.padEnd(labelWidth)} | ${valueHeader}`,
    `${"-".repeat(labelWidth)}-+-${"-".repeat(valueWidth)}`,
    ...details.map((detail) => `${detail.label.padEnd(labelWidth)} | ${detail.value}`),
  ].join("\n");
}

/** Format the full artifact section shown at the end of a user-facing run. */
export function formatArtifactsSection(
  artifactDir: string,
  artifacts: readonly Artifact[],
): string | undefined {
  // Prefix every filename with ARTIFACT_DIR so each row is a copy-pasteable path.
  const fullPaths = artifacts.map((artifact) => ({
    ...artifact,
    filename: join(artifactDir, artifact.filename),
    size: (() => {
      try {
        return formatArtifactSize(statSync(join(artifactDir, artifact.filename)).size);
      } catch {
        return undefined;
      }
    })(),
  }));
  const table = formatArtifactsTable(fullPaths);
  if (!table) {
    return undefined;
  }

  return [table].join("\n");
}

/** Format the full details section shown at the end of a user-facing run. */
export function formatDetailsSection(details: readonly Detail[]): string | undefined {
  const table = formatDetailsTable(details);
  if (!table) {
    return undefined;
  }

  return [table].join("\n");
}
