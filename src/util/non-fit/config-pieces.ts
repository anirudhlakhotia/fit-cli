/**
 * config-pieces — build a JSON/YAML config artifact (e.g. a FITConfiguration)
 * up in ordered "pieces" across multiple steps and workflows, then merge them
 * into one plain object. Pieces are merged in order: a later piece deep-merges
 * onto the accumulated result, can overwrite earlier fields, and can *remove*
 * them with the {@link REMOVE} sentinel. The remove case is why pieces can't be
 * stored as plain JSON internally — REMOVE isn't representable in JSON.
 *
 * Pure logic, no IO, so it's easy to unit test (see tests/config-pieces.test.ts).
 *
 * Run on its own (prints a small worked example):
 *   bun src/util/non-fit/config-pieces.ts
 */
import { isMain, runCli } from "./cli.js";

/**
 * Sentinel used as a value inside a piece to delete a key that an earlier piece
 * set. e.g. `{ excludeTests: REMOVE }` drops `excludeTests` from the result.
 */
export const REMOVE = Symbol("config-piece-remove");
export type Remove = typeof REMOVE;

/** Plain JSON value — what eventually lands in the merged config. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A value inside a piece: plain JSON, a nested piece, or a removal. */
export type PieceValue = JsonValue | PieceData | Remove;

/** The shape of one piece's data: a (possibly nested) record of piece values. */
export interface PieceData {
  [key: string]: PieceValue;
}

/** One contribution to a config artifact. `label` names its source for debugging. */
export interface ConfigPiece {
  /** Where this piece came from, e.g. "base cluster access" — for debugging. */
  label: string;
  /** The fields this piece sets, overwrites, or removes. */
  data: PieceData;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge one piece's data into the accumulating result. Objects are merged
 * recursively; arrays and primitives overwrite wholesale (cloned so the result
 * never aliases a piece's input); REMOVE deletes the key. Keys keep their
 * first-seen insertion order, so the earliest piece establishes field ordering.
 */
function mergeInto(target: Record<string, unknown>, data: PieceData): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === REMOVE) {
      delete target[key];
      continue;
    }
    if (isPlainObject(value)) {
      const existing = target[key];
      const nested = isPlainObject(existing) ? existing : {};
      target[key] = nested;
      mergeInto(nested, value);
      continue;
    }
    target[key] = structuredClone(value);
  }
}

/**
 * Merge `pieces` in order into a single plain object, ready to serialise as
 * JSON. The result contains no REMOVE sentinels.
 */
export function mergeConfigPieces(pieces: readonly ConfigPiece[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const piece of pieces) {
    mergeInto(result, piece.data);
  }
  return result;
}

if (isMain(import.meta.url)) {
  runCli(() => {
    const base: ConfigPiece = {
      label: "base",
      data: { name: "demo", excludeTests: ["situational"], nested: { keep: 1, drop: 2 } },
    };
    const override: ConfigPiece = {
      label: "override",
      data: { excludeTests: REMOVE, nested: { drop: REMOVE, added: 3 } },
    };
    console.log(JSON.stringify(mergeConfigPieces([base, override]), null, 2));
    return Promise.resolve();
  });
}
