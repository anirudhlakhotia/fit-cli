/**
 * Persisted state for resuming a definition-driven run. A run that is told to
 * "leave everything up" at teardown writes this file; a later `--resume-at`
 * invocation reads it to reconnect the same execution target and reuse the
 * cluster/performer the earlier run stood up.
 *
 * The file lives next to the definition you pass, under `instances/0/_internal/`, so it
 * is clearly internal bookkeeping rather than a run artifact:
 *   <dir-of-fit.yaml>/instances/0/_internal/run-state.json
 *
 * Reading and writing are the only IO here; deciding what to do with the state
 * (validation, which phases to skip) lives in the resume.ts/run-from-definition
 * logic so it stays testable.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SelectedCluster } from "../../cluster/cluster-select/cluster-select.js";

/** How to reconnect to the execution target a previous run used. */
export interface ResumeTargetState {
  kind: "local" | "remote";
  /** EC2 instance id, for teardown on a later run. */
  instanceId?: string;
  /** Public DNS/IP to SSH back into. */
  address?: string;
  /** AWS region the instance lives in. */
  region?: string;
  /** SSH login user. */
  user?: string;
  /** Path to the SSH private key the earlier run generated. */
  identityFile?: string;
}

/** The shared cluster a previous run stood up (or resolved). */
export interface ResumeClusterState {
  /** The resolved cluster the runs test against. */
  cluster: SelectedCluster;
  /** Whether the earlier run allocated it (and so teardown should remove it). */
  allocated: boolean;
  /** cbdinocluster id, present when {@link allocated}; used to validate/remove it. */
  clusterId?: string;
  /** The cbdinocluster command (path) on the target, for teardown removal. */
  cbdinoclusterCommand?: string;
}

/** A performer a previous run left running, per run. */
export interface ResumePerformerState {
  globalRunIndex: number;
  /** Docker container id, present when fit-cli manages the performer. */
  containerId?: string;
  port: number;
  /** SDK value (e.g. "java") and version, for the log file name. */
  sdk: string;
  version?: string;
  /** Docker network the performer joined, if any. */
  dockerNetwork?: string;
}

/** Everything a `--resume-at` run needs to pick up where a previous run stopped. */
export interface RunState {
  version: 1;
  executionGroupIndex: number;
  /** Within the execution group at executionGroupIndex, the first run to execute. Absent means 0. */
  startRunIndex?: number;
  /** Whether the run forced every execution group onto localhost, ignoring instance settings. */
  forceLocalhost?: boolean;
  target: ResumeTargetState;
  cluster?: ResumeClusterState;
  performers: ResumePerformerState[];
}

/** Where the run-state file lives for the definition at `definitionPath`. */
export function runStatePath(definitionPath: string): string {
  return resolve(dirname(definitionPath), "instances", "0", "_internal", "run-state.json");
}

/** Read the saved run state for a definition, or undefined if none exists. */
export function readRunState(definitionPath: string): RunState | undefined {
  const path = runStatePath(definitionPath);
  if (!existsSync(path)) {
    return undefined;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RunState> & { version?: unknown };
  if (parsed.version !== 1) {
    throw new Error(`Unsupported run-state version in ${path}: ${String(parsed.version)}`);
  }
  return parsed as RunState;
}

/** Write the run state for a definition, creating the `instances/0/_internal` dir. */
export function writeRunState(definitionPath: string, state: RunState): string {
  const path = runStatePath(definitionPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return path;
}
