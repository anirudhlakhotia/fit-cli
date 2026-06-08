/**
 * Resume points for a definition-driven run. Standing up a cluster and building
 * a performer are slow; when a run is told to "leave everything up" at teardown
 * (see run-from-definition.ts), it records what it stood up so a later
 * invocation can `--resume-at` a point and pick those up instead of redoing the
 * work — handy while developing, after a manual fix.
 *
 *   npm run definition -- --resume-at=after-cluster-creation /tmp/fit-cli/<run>/fit.yaml
 *
 * Pure logic — no IO — so the parsing is easy to unit test (see tests/).
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";

/**
 * The points a run can resume from, each naming the slow work it skips by
 * reusing what a previous run left up:
 *   after-cluster-creation - reuse the cluster; rebuild the performer, run tests.
 *   after-performer         - reuse the cluster and performer; just run tests.
 */
export const RESUME_POINTS = ["after-cluster-creation", "after-performer"] as const;

export type ResumePoint = (typeof RESUME_POINTS)[number];

/**
 * Which up-front phases a run executes. The test run itself always executes;
 * a resume point turns off the earlier phases whose output is loaded from the
 * saved run state instead.
 */
export interface RunPhases {
  /** Allocate (or resolve) the shared cluster. */
  readonly setupCluster: boolean;
  /** Build and start each iteration's performer. */
  readonly setupPerformer: boolean;
}

/** Map a resume point (or none, for a full run) to the phases to execute. */
export function phasesForResumePoint(point?: ResumePoint): RunPhases {
  switch (point) {
    case "after-cluster-creation":
      return { setupCluster: false, setupPerformer: true };
    case "after-performer":
      return { setupCluster: false, setupPerformer: false };
    default:
      return { setupCluster: true, setupPerformer: true };
  }
}

export function isResumePoint(value: string): value is ResumePoint {
  return (RESUME_POINTS as readonly string[]).includes(value);
}

/** Parse a `--resume-at` value, throwing on an unknown point. */
export function parseResumePoint(value: string | undefined): ResumePoint | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isResumePoint(value)) {
    return value;
  }
  throw new Error(`Unknown --resume-at point "${value}". Valid points: ${RESUME_POINTS.join(", ")}.`);
}

/**
 * Pull `--resume-at=<point>` (or `--resume-at <point>`) out of an argv list,
 * returning the value and the remaining positionals.
 */
export function extractResumeAt(argv: readonly string[]): { resumeAt?: string; positionals: string[] } {
  const positionals: string[] = [];
  let resumeAt: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--resume-at") {
      resumeAt = argv[i + 1];
      i++;
    } else if (arg.startsWith("--resume-at=")) {
      resumeAt = arg.slice("--resume-at=".length);
    } else {
      positionals.push(arg);
    }
  }
  return { ...(resumeAt !== undefined ? { resumeAt } : {}), positionals };
}

if (isMain(import.meta.url)) {
  runCli(() => {
    console.log(JSON.stringify(phasesForResumePoint(parseResumePoint(process.argv[2]))));
    return Promise.resolve();
  });
}
