/**
 * Refresh caps.json5 from the transactions-fit-performer protos.
 *
 * The protos define which caps exist; caps.json5 adds what they mean and which Jira
 * ticket tracks them. Syncing adds caps the protos have gained and never overwrites
 * a human-written `jira`, `description` or `notes` — so this is safe to re-run.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProtoEnum, type ProtoEnumMember } from "./parse-proto-enum.js";
import { CAP_GROUPS, type CapGroup, type CapMetadata, type CapsFile } from "./caps-metadata.js";

/** Where each cap enum lives, relative to a transactions-fit-performer checkout. */
const CAP_GROUP_PROTOS: Record<CapGroup, { file: string; enumName: string }> = {
  sdk: { file: "gRPC/sdk.caps.proto", enumName: "Caps" },
  transactions: { file: "gRPC/transactions.extensions.proto", enumName: "Caps" },
  performer: { file: "gRPC/performer.caps.proto", enumName: "Caps" },
};

/**
 * Jira keys are often mentioned in the proto comments ("See CBD-5161 for
 * requirements"), so seed `jira` from there to save some hand-typing. It's only a
 * first guess — the comment may cite a ticket that merely relates to the cap — so a
 * human is still expected to check it.
 */
const JIRA_KEY_PATTERN = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;

function jiraFromComment(comment?: string): string {
  return comment ? (JIRA_KEY_PATTERN.exec(comment)?.[1] ?? "") : "";
}

export interface SyncResult {
  capsFile: CapsFile;
  /** Caps the protos have that caps.json5 didn't — these need a Jira ticket. */
  added: string[];
  /** Caps caps.json5 has that the protos no longer define. Left in place, just flagged. */
  removed: string[];
}

/**
 * Merge the caps the protos define into what caps.json5 already says.
 *
 * Split out from the file reading so the rule that matters — human-written fields are
 * never clobbered — is testable on its own.
 */
export function mergeCaps(protoMembers: Record<CapGroup, ProtoEnumMember[]>, existing?: CapsFile): SyncResult {
  const capsFile = {} as CapsFile;
  const added: string[] = [];
  const removed: string[] = [];

  for (const group of CAP_GROUPS) {
    const groupCaps: Record<string, CapMetadata> = {};

    for (const member of [...protoMembers[group]].sort((a, b) => a.number - b.number)) {
      const prior = existing?.[group]?.[member.name];
      if (!prior) added.push(`${group}.${member.name}`);
      groupCaps[member.name] = {
        // The number always comes from the proto — it's the one field that isn't ours.
        number: member.number,
        // Human edits win; the proto comment is only ever a starting point.
        jira: prior?.jira || jiraFromComment(member.comment),
        description: prior?.description || member.comment || "",
        ...(prior?.notes ? { notes: prior.notes } : {}),
      };
    }

    for (const [name, meta] of Object.entries(existing?.[group] ?? {})) {
      if (!(name in groupCaps)) {
        removed.push(`${group}.${name}`);
        // Keep it: a cap dropped from the protos is worth noticing, not silently losing.
        groupCaps[name] = meta;
      }
    }

    capsFile[group] = groupCaps;
  }

  return { capsFile, added, removed };
}

/**
 * Build a new CapsFile from the protos at `performerRepoDir`, carrying over the
 * curated fields of `existing`.
 */
export function syncCapsFile(performerRepoDir: string, existing?: CapsFile): SyncResult {
  const protoMembers = {} as Record<CapGroup, ProtoEnumMember[]>;

  for (const group of CAP_GROUPS) {
    const { file, enumName } = CAP_GROUP_PROTOS[group];
    const path = join(performerRepoDir, file);
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      throw new Error(`Could not read ${path}. Is ${performerRepoDir} a transactions-fit-performer checkout?`);
    }
    protoMembers[group] = parseProtoEnum(source, enumName);
  }

  return mergeCaps(protoMembers, existing);
}

/** Escape a string for a double-quoted JSON5 value. */
function quote(value: string): string {
  return JSON.stringify(value);
}

const HEADER = `// FIT capabilities, as reported by each performer over the performerCapsFetch RPC.
//
// This is fit-cli's source of truth for what each capability *is*: performers report
// bare enum numbers, and this file maps those to names, to the Jira ticket tracking the
// capability, and to a description.
//
// The three groups are separate enums and all number from 0 — a number is only
// meaningful within its own group.
//   sdk           - sdk.Caps           (gRPC/sdk.caps.proto):            SDK features under test.
//   transactions  - transactions.Caps  (gRPC/transactions.extensions.proto): transactions features under test.
//   performer     - performer.Caps     (gRPC/performer.caps.proto):      what the performer harness itself supports.
//
// "number" is generated from the protos — do not hand-edit it.
// "jira", "description" and "notes" are yours: 'fit caps sync' will never overwrite them.
//
// To pick up capabilities newly added to the protos:
//   fit caps sync <path-to-transactions-fit-performer>
//
// See it all in action with:
//   fit caps table
`;

/** Render a CapsFile as JSON5 with a human-facing header. */
export function formatCapsFile(capsFile: CapsFile): string {
  const lines: string[] = [HEADER, "{"];

  CAP_GROUPS.forEach((group, groupIndex) => {
    lines.push(`  ${group}: {`);
    const entries = Object.entries(capsFile[group]).sort((a, b) => a[1].number - b[1].number);

    entries.forEach(([name, meta], index) => {
      lines.push(`    ${name}: {`);
      lines.push(`      number: ${meta.number},`);
      lines.push(`      jira: ${quote(meta.jira ?? "")},`);
      lines.push(`      description: ${quote(meta.description ?? "")},`);
      if (meta.notes) lines.push(`      notes: ${quote(meta.notes)},`);
      lines.push(`    }${index === entries.length - 1 ? "" : ","}`);
    });

    lines.push(`  }${groupIndex === CAP_GROUPS.length - 1 ? "" : ","}`);
  });

  lines.push("}", "");
  return lines.join("\n");
}
