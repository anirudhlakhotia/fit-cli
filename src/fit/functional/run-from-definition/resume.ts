/**
 * Resume points for a definition-driven run. Provisioning an instance, preparing
 * its workspace, standing up a cluster and building a performer are all slow;
 * when a run is told to "leave everything up" at teardown (see
 * run-from-definition.ts), it records what it stood up so a later invocation can
 * `--resume-at` a point and pick those up instead of redoing the work — handy
 * while developing, after a manual fix.
 *
 *   bun run definition -- --resume-at=after-cluster-creation /tmp/fit-cli/<run>/fit.yaml
 *
 * Pure logic — no IO — so the parsing is easy to unit test (see tests/).
 */
import { isMain, runCli } from "../../../util/non-fit/cli.js";

/**
 * The points a run can resume from, in the order the work happens. Each names
 * the work it reuses from a previous run, skipping everything up to and
 * including it:
 *   after-instance-creation  - reconnect to the instance; re-prepare its
 *                              workspace, set up the cluster and performer.
 *   after-remote-preparation - reuse the prepared workspace; set up the cluster
 *                              and performer.
 *   after-cluster-creation   - reuse the cluster; rebuild the performer.
 *   after-performer          - reuse the cluster and performer; just run tests.
 */
export const RESUME_POINTS = [
  "after-instance-creation",
  "after-remote-preparation",
  "after-cluster-creation",
  "after-performer",
] as const;

export type ResumePoint = (typeof RESUME_POINTS)[number];

export interface ResumeSelector {
  instance?: number;
  cluster?: number;
  clusterlessSession?: number;
  session?: number;
  run?: number;
}

/**
 * Which up-front phases a run executes. The test run itself always executes;
 * a resume point turns off the earlier phases whose output is loaded from the
 * saved run state (or the already-prepared remote box) instead.
 */
export interface RunPhases {
  /** Install deps and clone repos on the remote box (vs. reuse a prepared one). */
  readonly prepareRemote: boolean;
  /** Allocate (or resolve) the shared cluster. */
  readonly setupCluster: boolean;
  /** Build and start each iteration's performer. */
  readonly setupPerformer: boolean;
}

/** Map a resume point (or none, for a full run) to the phases to execute. */
export function phasesForResumePoint(point?: ResumePoint): RunPhases {
  switch (point) {
    case "after-instance-creation":
      return { prepareRemote: true, setupCluster: true, setupPerformer: true };
    case "after-remote-preparation":
      return { prepareRemote: false, setupCluster: true, setupPerformer: true };
    case "after-cluster-creation":
      return { prepareRemote: false, setupCluster: false, setupPerformer: true };
    case "after-performer":
      return { prepareRemote: false, setupCluster: false, setupPerformer: false };
    default:
      return { prepareRemote: true, setupCluster: true, setupPerformer: true };
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

function parsePositiveIntFlag(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
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

/**
 * Pull resume-path selectors out of argv, returning them and the remaining
 * positionals.
 */
export function extractResumeSelector(argv: readonly string[]): { selector: ResumeSelector; positionals: string[] } {
  const positionals: string[] = [];
  const selector: ResumeSelector = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const readValue = (flag: string): string | undefined => {
      if (arg === flag) {
        i++;
        return argv[i];
      }
      return arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : undefined;
    };

    const instance = readValue("--resume-instance");
    if (instance !== undefined) {
      selector.instance = parsePositiveIntFlag("--resume-instance", instance);
      continue;
    }
    const cluster = readValue("--resume-cluster");
    if (cluster !== undefined) {
      selector.cluster = parsePositiveIntFlag("--resume-cluster", cluster);
      continue;
    }
    const clusterlessSession = readValue("--resume-clusterless-session");
    if (clusterlessSession !== undefined) {
      selector.clusterlessSession = parsePositiveIntFlag("--resume-clusterless-session", clusterlessSession);
      continue;
    }
    const session = readValue("--resume-session");
    if (session !== undefined) {
      selector.session = parsePositiveIntFlag("--resume-session", session);
      continue;
    }
    const run = readValue("--resume-run");
    if (run !== undefined) {
      selector.run = parsePositiveIntFlag("--resume-run", run);
      continue;
    }

    positionals.push(arg);
  }
  return { selector, positionals };
}

if (isMain(import.meta.url)) {
  runCli(() => {
    console.log(JSON.stringify(phasesForResumePoint(parseResumePoint(process.argv[2]))));
    return Promise.resolve();
  });
}
