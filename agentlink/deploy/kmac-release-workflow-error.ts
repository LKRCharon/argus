import type { FailureStage } from "./kmac-release-workflow-types";

export class WorkflowError extends Error {
  constructor(
    readonly stage: FailureStage,
    readonly code: string,
  ) {
    super(code);
    this.name = "WorkflowError";
  }
}

export function fail(stage: FailureStage, code: string): never {
  throw new WorkflowError(stage, code);
}

export function failureFrom(error: unknown): { stage: FailureStage; code: string } {
  if (error instanceof WorkflowError) return { stage: error.stage, code: error.code };
  return { stage: "operation_state", code: "workflow_failed" };
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
