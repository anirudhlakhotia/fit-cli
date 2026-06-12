/**
 * How a failing process (non-zero exit) affects the current definition run. The
 * names mirror the definition-file hierarchy: an instance holds clusters, a
 * cluster holds sessions, and a session holds runs.
 *
 * FatalToAll      – stops the entire definition run immediately.
 * FatalToInstance – this instance cannot continue (e.g. the box couldn't be
 *                   acquired or set up), but the next instance is allowed to run.
 * FatalToCluster  – this cluster cannot continue (e.g. cluster setup failed), but
 *                   the next cluster on the instance is allowed to run.
 * FatalToSession  – only this session is abandoned; the next session in the same
 *                   cluster is allowed to run.
 * FatalToRun      – only this run is abandoned (e.g. a failing test, or no JUnit
 *                   report produced); the next run in the same session may run.
 * NonFatal        – the failure is recorded but the current run continues.
 */
export type FailureClassification =
  | "FatalToAll"
  | "FatalToInstance"
  | "FatalToCluster"
  | "FatalToSession"
  | "FatalToRun"
  | "NonFatal";

/** A process failure tagged with how the run should react to it. */
export class ClassifiedFailure extends Error {
  constructor(
    message: string,
    public readonly classification: FailureClassification,
  ) {
    super(message);
    this.name = "ClassifiedFailure";
  }
}

export function throwFatalToAll(message: string): never {
  throw new ClassifiedFailure(message, "FatalToAll");
}

export function throwFatalToInstance(message: string): never {
  throw new ClassifiedFailure(message, "FatalToInstance");
}

export function throwFatalToCluster(message: string): never {
  throw new ClassifiedFailure(message, "FatalToCluster");
}

export function throwFatalToSession(message: string): never {
  throw new ClassifiedFailure(message, "FatalToSession");
}

export function throwFatalToRun(message: string): never {
  throw new ClassifiedFailure(message, "FatalToRun");
}
