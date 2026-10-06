import type { Clock, JsonObject, Sql } from "../ports.ts";

export type V2Action = "create" | "update" | "delete";
export type V2Effect = "none" | "unknown" | "partial" | "complete";
export type V2Status =
  | "queued"
  | "running"
  | "waiting_input"
  | "reconciling"
  | "succeeded"
  | "failed";

export interface V2Resource {
  uid: string;
  form: string;
  space: string;
  name: string;
  generation: number;
  observedGeneration: number;
  observedAt: string | null;
  phase: "pending" | "idle" | "deleting" | "error";
  spec: JsonObject;
  observed: JsonObject;
  output: JsonObject;
  lastOperation: string;
}

export interface V2Operation {
  id: string;
  resourceUid: string;
  action: V2Action;
  generation: number;
  status: V2Status;
  effect: V2Effect;
  createdAt: string;
  updatedAt: string;
  retainUntil: string;
  error?: { code: string; message: string };
}

export type V2BackendResult =
  | { kind: "complete"; observed: JsonObject; output: JsonObject }
  /**
   * A bounded step and its durable checkpoint finished. All writes must be
   * awaited and fenced; no unacknowledged external effect may use this result.
   * The next scheduled pass reconciles this same Operation with a fresh lease.
   * This is not Resource readiness or permission to repeat the initial send.
   */
  | { kind: "continue" }
  /** code/message are safe public classifications, never raw provider responses. */
  | { kind: "no_effect"; code: string; message: string }
  | { kind: "partial"; code: string; message: string; observed?: JsonObject; output?: JsonObject }
  | { kind: "unknown"; code?: string; message?: string };

export interface V2Execution {
  /** Stable, accepted identity; never mint a different backend resource on retry. */
  operationId: string;
  /** Current SQL claim. A backend with native fencing must reject a stale send. */
  leaseToken: string;
  backendKey: string;
  backendId: string;
  targetKey: string;
  resourceUid: string;
  /** Accepted owner, used only by form-specific authorized input resolution. */
  principal: string;
  action: V2Action;
  generation: number;
  form: string;
  space: string;
  name: string;
  spec: JsonObject;
  previousObserved: JsonObject;
  previousOutput: JsonObject;
}

export interface V2Backend {
  /** Immutable implementation identity and opaque non-secret target selection. */
  id: string;
  targetKey: string;
  /**
   * Dispatch once with the accepted backendKey. An expired SQL lease only fences
   * settlement; external effect fencing requires this backend's own protocol.
   */
  execute(input: V2Execution): Promise<V2BackendResult>;
  /**
   * Use the same accepted backendKey. `no_effect` is valid only if no previous
   * authorized send can arrive later (or native fencing makes it harmless).
   * If that cannot be proven, return `unknown`, never infer absence from timeout.
   */
  reconcile(input: V2Execution): Promise<V2BackendResult>;
}

/** Trusted Form declaration, never caller-supplied policy or SQL. */
export interface V2ReferenceRequirement {
  readonly resourceUid: string;
  readonly formUrl: string;
  /** `observed` permits a confirmed not-ready owner; `ready` requires observed.ready === true. */
  readonly readiness: "observed" | "ready";
  /** One bounded exact target spec string field, e.g. Version.worker.resourceUid. */
  readonly targetSpecMatch?: {
    readonly path: readonly string[];
    readonly equals: string;
  };
}

export interface V2Form {
  validateCreate(spec: JsonObject): void;
  validateUpdate(previousSpec: JsonObject, spec: JsonObject): void;
  /**
   * Pure initial public output, persisted with Resource/Operation acceptance.
   * Must not perform external allocation: a losing acceptance can roll back.
   * Replays and updates retain the stored output instead of calling this again.
   */
  initialOutput?(input: {
    readonly resourceUid: string;
    readonly space: string;
    readonly name: string;
    readonly spec: JsonObject;
  }): JsonObject;
  /** Complete outbound UID set for this accepted spec; evaluated before SQL acceptance. */
  references?(spec: JsonObject): readonly V2ReferenceRequirement[];
  /** Retained for existing adapters; all inbound v2 edges now protect deletion. */
  rejectDeleteWhileReferenced?: true;
  backend: V2Backend;
}

export interface V2EngineOptions {
  sql: Sql;
  now?: Clock;
  replayWindowSeconds: number;
  /** Claim timeout; a reclaimed dispatched operation reconciles, never blindly sends. */
  leaseMilliseconds?: number;
  authorize(principal: string, space: string, access: "read" | "write"): Promise<boolean>;
  /** Only fully implemented, exact Form URLs are entered here. */
  forms: Readonly<Record<string, V2Form>>;
}

export interface V2CreateInput {
  form: string;
  space: string;
  name: string;
  spec: JsonObject;
}

export class TakoformV2Error extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message = code,
  ) {
    super(message);
    this.name = "TakoformV2Error";
  }
}
