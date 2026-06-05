/**
 * Which steps of a definition-driven run to execute. `npm run definition <file>`
 * takes an optional CSV of step names so you can run just part of a definition —
 * e.g. stand up the performer once and re-run the tests several times.
 *
 * Pure logic — no IO — so the CSV parsing is easy to unit test (see
 * tests/steps.test.ts).
 *
 * Run on its own (print the expanded step list for a CSV):
 *   npx tsx src/workflows/fit-functional/definition/steps.ts setup,run
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";

/**
 * The individual steps, in the order they must run. "setup" is an alias for the
 * two setup steps; see {@link STEP_ALIASES}.
 */
export const DEFINITION_STEPS = ["setup-cluster", "setup-performer", "run"] as const;

export type DefinitionStep = (typeof DEFINITION_STEPS)[number];

/** Convenience names that expand to several steps. */
export const STEP_ALIASES: Record<string, readonly DefinitionStep[]> = {
  setup: ["setup-cluster", "setup-performer"],
  all: DEFINITION_STEPS,
};

function isStep(value: string): value is DefinitionStep {
  return (DEFINITION_STEPS as readonly string[]).includes(value);
}

/** Sort to canonical run order and drop duplicates. */
function canonicalise(steps: readonly DefinitionStep[]): DefinitionStep[] {
  return DEFINITION_STEPS.filter((step) => steps.includes(step));
}

/**
 * Parse a CSV of step names (and aliases) into the ordered, de-duplicated list
 * of steps to run. An empty/undefined CSV means "run everything". Throws on an
 * unknown step name, listing the valid ones.
 */
export function parseSteps(csv?: string): DefinitionStep[] {
  const tokens = (csv ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return [...DEFINITION_STEPS];
  }

  const steps: DefinitionStep[] = [];
  for (const token of tokens) {
    const alias = STEP_ALIASES[token];
    if (alias) {
      steps.push(...alias);
    } else if (isStep(token)) {
      steps.push(token);
    } else {
      const valid = [...DEFINITION_STEPS, ...Object.keys(STEP_ALIASES)].join(", ");
      throw new Error(`Unknown step "${token}". Valid steps: ${valid}.`);
    }
  }
  return canonicalise(steps);
}

if (isMain(import.meta.url)) {
  runCli(() => {
    console.log(JSON.stringify(parseSteps(process.argv[2])));
    return Promise.resolve();
  });
}
