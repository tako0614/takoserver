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

export interface V2Form {
  validateCreate(spec: JsonObject): void;
  validateUpdate(previousSpec: JsonObject, spec: JsonObject): void;
  /** Optional generic SQL reference guard, enforced in the same delete acceptance batch. */
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
