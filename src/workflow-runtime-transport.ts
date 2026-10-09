/**
 * Host-adapter-only, ephemeral Workflow frame correlation. This is not a
 * durable step journal, a public wire protocol, or an admission authority.
 * The caller must establish a physical ingress barrier before calling seal().
 */
export {
  WORKFLOW_HTTP_BOOTSTRAP_DIGEST,
  WORKFLOW_HTTP_BOOTSTRAP_SOURCE,
} from "./generated/workflow-http-bootstrap.ts";
export {
  createWorkflowHttpController,
  type WorkflowHttpController,
} from "./workflow-http-controller.ts";
export {
  createWorkflowTransportJournal,
  WORKFLOW_TRANSPORT_MAX_PAYLOAD_BYTES,
  WORKFLOW_TRANSPORT_MAX_PENDING_ENTRIES,
  WORKFLOW_TRANSPORT_SEQUENCE_WINDOW,
  type WorkflowTransportJournal,
  WorkflowTransportJournalError,
  type WorkflowTransportJournalErrorCode,
  type WorkflowTransportJournalOptions,
} from "./workflow-transport-journal.ts";
