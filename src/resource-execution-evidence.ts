import type { TakoformV1Alpha3FormRef } from "./takoform/types.ts";

/** Public, value-free proof that Takoserver committed one Resource lifecycle. */
export const RESOURCE_EXECUTION_EVIDENCE_FORMAT =
  "takoserver.resource-execution-evidence/v1" as const;

export interface ResourceExecutionCommit {
  readonly sequence: number;
  readonly operationId: string;
  readonly action: "create" | "update" | "delete";
  readonly outcome: "committed";
  readonly resourceVersion: {
    readonly generation: string;
    readonly revision: string;
  };
  readonly committedAt: string;
}

export interface ResourceExecutionEvidence {
  readonly format: typeof RESOURCE_EXECUTION_EVIDENCE_FORMAT;
  readonly organizationId: string;
  readonly resource: {
    readonly uid: string;
    readonly address: {
      readonly space: string;
      readonly apiVersion: string;
      readonly kind: string;
      readonly name: string;
    };
    readonly formRef: TakoformV1Alpha3FormRef;
  };
  readonly coverage: "complete" | "partial";
  readonly snapshotFence: number;
  readonly commits: readonly ResourceExecutionCommit[];
}

export interface ResourceExecutionEvidenceResponse {
  readonly executionEvidence: ResourceExecutionEvidence;
  readonly cursor?: string;
}
