/**
 * How a failing process (non-zero exit) affects the current definition run.
 *
 * FatalToAll       – stops the entire definition run immediately.
 * FatalToCycle     – the cycle cannot continue (e.g. cluster or instance setup
 *                    failed), but the next cycle is allowed to run.
 * FatalToIteration – only this iteration is abandoned; the next iteration in
 *                    the same cycle is allowed to run.
 * NonFatal         – the failure is recorded but the current iteration
 *                    continues.
 */
export type FailureClassification = "FatalToAll" | "FatalToCycle" | "FatalToIteration" | "NonFatal";

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

export function throwFatalToCycle(message: string): never {
  throw new ClassifiedFailure(message, "FatalToCycle");
}

export function throwFatalToIteration(message: string): never {
  throw new ClassifiedFailure(message, "FatalToIteration");
}
