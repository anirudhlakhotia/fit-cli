import { isAbsolute, relative } from "node:path";
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

/** Format artifacts as a simple terminal table. */
export function formatArtifactsTable(artifacts: readonly Artifact[]): string | undefined {
  if (artifacts.length === 0) {
    return undefined;
  }

  const filenameHeader = "Filename";
  const explanationHeader = "What it's for";
  const filenameWidth = Math.max(filenameHeader.length, ...artifacts.map((artifact) => artifact.filename.length));

  return [
    `${filenameHeader.padEnd(filenameWidth)} | ${explanationHeader}`,
    `${"-".repeat(filenameWidth)}-+-${"-".repeat(explanationHeader.length)}`,
    ...artifacts.map((artifact) => `${artifact.filename.padEnd(filenameWidth)} | ${artifact.explanation}`),
  ].join("\n");
}

/** Format the full artifact section shown at the end of a user-facing run. */
export function formatArtifactsSection(
  artifactDir: string,
  artifacts: readonly Artifact[],
): string | undefined {
  const table = formatArtifactsTable(artifacts);
  if (!table) {
    return undefined;
  }

  return ["Artifacts:", `  ARTIFACT_DIR: ${artifactDir}`, table].join("\n");
}
