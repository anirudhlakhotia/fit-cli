import type { FailureClassification } from "./failure-classification.js";
import type { RecordedFailure } from "../../util/non-fit/artifacts.js";

const SEVERITY: Record<FailureClassification, number> = {
  NonFatal: 0,
  FatalToIteration: 1,
  FatalToCycle: 2,
  FatalToAll: 3,
};

export interface FailureContext {
  instanceIndex: number;
  cycleIndex: number;
  iterationIndex?: number;
}

export class RunFailureTracker {
  private worstFailure?: RecordedFailure;
  private count = 0;

  record(classification: FailureClassification, message: string, context: FailureContext): void {
    this.count++;
    if (!this.worstFailure || SEVERITY[classification] > SEVERITY[this.worstFailure.classification as FailureClassification]) {
      this.worstFailure = { classification, message, context };
    }
  }

  get worst(): RecordedFailure | undefined {
    return this.worstFailure;
  }

  get failureCount(): number {
    return this.count;
  }

  shouldExitNonZero(): boolean {
    return (
      !!this.worstFailure && SEVERITY[this.worstFailure.classification as FailureClassification] >= SEVERITY.FatalToIteration
    );
  }
}
