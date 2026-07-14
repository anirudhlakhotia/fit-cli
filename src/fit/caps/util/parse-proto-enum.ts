/**
 * Extract an enum's members (and their leading comments) from a .proto file.
 *
 * This is only used by `fit caps sync`, which refreshes caps.json5 from the
 * transactions-fit-performer protos. It is not on the path of a normal `fit caps`
 * run — at run time caps.json5 is the source of truth, so fit-cli never needs a
 * checkout of the protos just to render a table.
 *
 * It's a text scrape, not a proto parser: we want member name, number and the
 * doc-comment above it, and nothing else in the grammar matters for that.
 */

export interface ProtoEnumMember {
  name: string;
  number: number;
  /** The `//` or `/* *\/` comment block immediately above the member, flattened to one line. */
  comment?: string;
}

/** Strip comment markers and collapse a comment block into a single line of prose. */
function flattenComment(lines: readonly string[]): string | undefined {
  const text = lines
    .map((line) =>
      line
        .replace(/^\s*\/\*\*?/, "")
        .replace(/\*\/\s*$/, "")
        .replace(/^\s*\/\//, "")
        .replace(/^\s*\*/, "")
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Parse the members of `enum <enumName> { ... }` out of proto source.
 *
 * Throws if the enum isn't there — a silent empty result would quietly wipe
 * caps.json5.
 */
export function parseProtoEnum(source: string, enumName: string): ProtoEnumMember[] {
  const enumStart = new RegExp(`enum\\s+${enumName}\\s*\\{`).exec(source);
  if (!enumStart) {
    throw new Error(`Could not find "enum ${enumName}" in the proto source`);
  }

  // Walk braces from the enum's opening brace so a nested block can't end it early.
  const bodyStart = enumStart.index + enumStart[0].length;
  let depth = 1;
  let i = bodyStart;
  while (i < source.length && depth > 0) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  }
  if (depth !== 0) {
    throw new Error(`Unterminated "enum ${enumName}" block`);
  }
  const body = source.slice(bodyStart, i - 1);

  const members: ProtoEnumMember[] = [];
  let pendingComment: string[] = [];

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      // A blank line separates a comment from whatever follows it.
      pendingComment = [];
      continue;
    }

    const member = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)\s*(?:\[[^\]]*\])?\s*;/.exec(line);
    if (member) {
      members.push({
        name: member[1],
        number: Number(member[2]),
        comment: flattenComment(pendingComment),
      });
      pendingComment = [];
      continue;
    }

    if (line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) {
      pendingComment.push(line);
      continue;
    }

    // Anything else (e.g. `option allow_alias = true;`) breaks the comment run.
    pendingComment = [];
  }

  if (members.length === 0) {
    throw new Error(`"enum ${enumName}" contains no members — the proto format may have changed`);
  }
  return members;
}
