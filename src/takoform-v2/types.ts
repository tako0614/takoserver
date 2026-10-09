import type { Clock, JsonObject, Sql, SqlParam } from "../ports.ts";
import type { V2ConfiguredPrivateInputs } from "./configured-private-inputs.ts";
import type { V2PrivateInputCustody, V2PrivateInputMap } from "./private-inputs.ts";

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
  inputRequired?: { names: string[]; reason: "expired" | "unavailable" };
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
  /** Available only on a first, proven-unsent dispatch. Never persisted in public state. */
  privateInputs?: V2PrivateInputMap;
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

/** A trusted Form's parameterized acceptance predicate, never request SQL. */
export interface V2AdmissionPredicate {
  /** A boolean SQL expression embedded in the Resource acceptance statement. */
  readonly sql: string;
  readonly params: readonly SqlParam[];
  /** Failure classification for this predicate only; omitted preserves conflict. */
  readonly conflictCode?: "dependency_conflict" | "resource_busy";
}

export interface V2Form {
  validateCreate(spec: JsonObject): void;
  validateUpdate(previousSpec: JsonObject, spec: JsonObject): void;
  /**
   * Read external readiness after authorization/replay, then bind its exact
   * SQL proof to the same atomic Resource/Operation acceptance batch. A null
   * result refuses acceptance without writing a replay key. Trusted Forms
   * alone supply SQL; untrusted request values may only become parameters.
   */
  prepareAdmission?(input: {
    readonly action: "create" | "update";
    readonly principal: string;
    readonly space: string;
    readonly form: string;
    readonly resourceUid: string;
    readonly spec: JsonObject;
  }): Promise<V2AdmissionPredicate | null>;
  /** Exact Form-owned names, requiredness, and omission/update preservation semantics. */
  readonly privateInputs?: {
    /** If no secret-free instance is valid, a Host without custody must not claim support. */
    readonly requiredForEveryInstance?: true;
    validateCreate(spec: JsonObject, inputs: V2PrivateInputMap | undefined): void;
    validateUpdate(
      previousSpec: JsonObject,
      spec: JsonObject,
      inputs: V2PrivateInputMap | undefined,
    ): void;
    /** Pure, Form-owned sealing before the Host's atomic CREATE acceptance. */
    prepareCreate?(input: {
      readonly principal: string;
      readonly space: string;
      readonly name: string;
      readonly form: string;
      readonly resourceUid: string;
      readonly operationId: string;
      readonly generation: number;
      readonly spec: JsonObject;
      readonly privateInputs: V2PrivateInputMap | undefined;
    }): Promise<V2ConfiguredPrivateInputs | null>;
    /** Authorized preaccept policy; omission preserves the existing configured row. */
    prepareUpdate?(input: {
      readonly principal: string;
      readonly space: string;
      readonly name: string;
      readonly form: string;
      readonly resourceUid: string;
      readonly operationId: string;
      readonly generation: number;
      readonly previousSpec: JsonObject;
      readonly spec: JsonObject;
      readonly privateInputs: V2PrivateInputMap | undefined;
      readonly configured: V2ConfiguredPrivateInputs | null;
    }): Promise<void>;
  };
  /** Internal acceptance ordering for a target whose observation reads live referrers. */
  readonly serializeUpdatesWithPendingReferrers?: true;
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
  /**
   * Internal adapters for already accepted Resources/Operations only. These
   * URLs are never public Form support and cannot accept a new CREATE/UPDATE.
   * Keep exact backend identity available for replay, recovery and DELETE.
   */
  retainedForms?: Readonly<Record<string, V2Form>>;
  /** Operator-selected keys; absence keeps the entire optional Host capability disabled. */
  privateInputCustody?: V2PrivateInputCustody;
}

export interface V2CreateInput {
  form: string;
  space: string;
  name: string;
  spec: JsonObject;
  privateInputs?: V2PrivateInputMap;
}

export class TakoformV2Error extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message = code,
    readonly operationId?: string,
  ) {
    super(message);
    this.name = "TakoformV2Error";
  }
}
