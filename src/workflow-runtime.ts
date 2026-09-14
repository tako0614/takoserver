/**
 * Host-neutral durable Workflow runtime surface.
 *
 * This entrypoint is deliberately narrower than the package root and the
 * provider extension.  It exposes the existing coordinator and its ports for
 * an operator composition without publishing helper Promise machinery,
 * codecs, transport controllers, or a concrete host implementation.
 */

export type {
  Clock,
  JsonObject,
  JsonValue,
  Row,
  Sql,
  SqlAccess,
  SqlParam,
  SqlStatement,
  SqlWrite,
} from "./ports.ts";
export { SqlError } from "./ports.ts";

export type {
  WorkflowApplicationOutcome,
  WorkflowDriver,
  WorkflowStepError,
} from "./workflow-driver.ts";
export {
  isWorkflowCallInputError,
  isWorkflowCallInputTypeError,
  isWorkflowRuntimeError,
  isWorkflowStepError,
  WorkflowCallInputError,
  WorkflowRuntimeError,
} from "./workflow-driver.ts";
export type {
  WorkflowExecutionHost,
  WorkflowPausedSession,
  WorkflowRunIdentity,
  WorkflowRunOutcome,
  WorkflowRuntime,
  WorkflowRuntimeOptions,
  WorkflowStopReason,
} from "./workflow-execution.ts";
export { createWorkflowRuntime } from "./workflow-execution.ts";

export type {
  WorkflowCreateInput,
  WorkflowCreateResult,
  WorkflowErrorReason,
  WorkflowEventInput,
  WorkflowInstanceErrorCode,
  WorkflowInstanceHandle,
  WorkflowInstanceStatus,
  WorkflowInstanceStatusError,
  WorkflowInstanceStatusResult,
  WorkflowInstances,
  WorkflowScope,
  WorkflowSweepOptions,
} from "./workflow-instances.ts";
export { WorkflowInstanceError } from "./workflow-instances.ts";
