import {
  TakoformV2Error,
  type V2Backend,
  type V2BackendResult,
  type V2Execution,
  type V2Form,
} from "../types.ts";
import {
  EDGE_KV_NAMESPACE_FORM_URL,
  EDGE_KV_NAMESPACE_LIMITS,
  EdgeKVNamespaceValidationError,
  parseEdgeKVNamespaceSpec,
  validateEdgeKVNamespaceUpdate,
} from "./edge-kv-namespace.ts";

export const EDGE_KV_NAMESPACE_BACKEND_ID = "selfhost-v2-edge-kv-namespace-sqlite-v1";

export interface EdgeKVNamespaceIdentity {
  readonly targetKey: string;
  readonly principal: string;
  readonly space: string;
  readonly resourceUid: string;
}

export interface EdgeKVNamespaceStore {
  create(input: {
    readonly identity: EdgeKVNamespaceIdentity;
    readonly operationId: string;
  }): Promise<"ready" | "absent" | "conflict" | "unknown">;
  reconcileCreate(input: {
    readonly identity: EdgeKVNamespaceIdentity;
    readonly operationId: string;
  }): Promise<"ready" | "absent" | "conflict" | "unknown">;
  observe(identity: EdgeKVNamespaceIdentity): Promise<"ready" | "absent" | "conflict" | "unknown">;
  delete(input: {
    readonly identity: EdgeKVNamespaceIdentity;
    readonly operationId: string;
  }): Promise<"deleted" | "conflict" | "unknown">;
}

const OBSERVED = Object.freeze({
  namespaceExists: true,
  maxKeyBytes: EDGE_KV_NAMESPACE_LIMITS.maxKeyBytes,
  maxValueBytes: EDGE_KV_NAMESPACE_LIMITS.maxValueBytes,
  maxMetadataBytes: EDGE_KV_NAMESPACE_LIMITS.maxMetadataBytes,
  consistency: EDGE_KV_NAMESPACE_LIMITS.consistency,
});

function identity(input: V2Execution, targetKey: string): EdgeKVNamespaceIdentity {
  return {
    targetKey,
    principal: input.principal,
    space: input.space,
    resourceUid: input.resourceUid,
  };
}

function completed(namespaceExists: boolean): V2BackendResult {
  return {
    kind: "complete",
    observed: { ...OBSERVED, namespaceExists },
    output: {},
  };
}

function noEffect(code: string): V2BackendResult {
  return { kind: "no_effect", code, message: code };
}

function unknown(code: string): V2BackendResult {
  return { kind: "unknown", code, message: code };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalComplete(
  result: Extract<V2BackendResult, { kind: "complete" }>,
  action: V2Execution["action"],
): boolean {
  const { observed, output } = result;
  return (
    plainRecord(observed) &&
    Reflect.ownKeys(observed).length === 5 &&
    Object.keys(observed).length === 5 &&
    observed.namespaceExists === (action !== "delete") &&
    observed.maxKeyBytes === EDGE_KV_NAMESPACE_LIMITS.maxKeyBytes &&
    observed.maxValueBytes === EDGE_KV_NAMESPACE_LIMITS.maxValueBytes &&
    observed.maxMetadataBytes === EDGE_KV_NAMESPACE_LIMITS.maxMetadataBytes &&
    observed.consistency === EDGE_KV_NAMESPACE_LIMITS.consistency &&
    plainRecord(output) &&
    Reflect.ownKeys(output).length === 0
  );
}

const EXECUTION_SCOPE_FIELDS = [
  "operationId",
  "leaseToken",
  "backendKey",
  "backendId",
  "targetKey",
  "resourceUid",
  "principal",
  "action",
  "generation",
  "form",
  "space",
  "name",
] as const;

function captureExecutionScope(input: V2Execution) {
  return EXECUTION_SCOPE_FIELDS.map((field) => input[field]);
}

function executionScopeUnchanged(
  input: V2Execution,
  captured: ReturnType<typeof captureExecutionScope>,
): boolean {
  return EXECUTION_SCOPE_FIELDS.every((field, index) => input[field] === captured[index]);
}

export type EdgeKVNamespaceFormOptions =
  | {
      readonly store: EdgeKVNamespaceStore;
      readonly targetKey: string;
      /** Operator-selected private implementation identity; never request-controlled. */
      readonly backendId?: string;
      readonly backend?: never;
    }
  | {
      /** Trusted operator-composed native backend receives the full accepted execution. */
      readonly backend: V2Backend;
      readonly targetKey: string;
      readonly store?: never;
      readonly backendId?: never;
    };

export function createEdgeKVNamespaceForm(options: EdgeKVNamespaceFormOptions): V2Form {
  if (!options || typeof options !== "object") throw new TypeError("Form options are required");
  const hasStore = Object.hasOwn(options, "store");
  const hasBackend = Object.hasOwn(options, "backend");
  if (hasStore === hasBackend || (hasBackend && Object.hasOwn(options, "backendId"))) {
    throw new TypeError("exactly one EdgeKV backend mode is required");
  }
  const { targetKey } = options;
  if (typeof targetKey !== "string" || targetKey.trim().length === 0)
    throw new TypeError("targetKey is required");

  let backendId: string;
  let dispatch: V2Backend["execute"];
  let reconcileDispatch: V2Backend["reconcile"];
  let implementationUnchanged = () => true;
  if (hasStore) {
    const { store } = options as Extract<
      EdgeKVNamespaceFormOptions,
      { store: EdgeKVNamespaceStore }
    >;
    backendId = options.backendId === undefined ? EDGE_KV_NAMESPACE_BACKEND_ID : options.backendId;
    if (
      typeof store !== "object" ||
      store === null ||
      typeof store.create !== "function" ||
      typeof store.reconcileCreate !== "function" ||
      typeof store.observe !== "function" ||
      typeof store.delete !== "function"
    ) {
      throw new TypeError("EdgeKV store is required");
    }
    if (typeof backendId !== "string" || backendId.trim().length === 0)
      throw new TypeError("backendId is required");
    dispatch = async (input) => {
      if (input.action === "create") {
        const result = await store.create({
          identity: identity(input, targetKey),
          operationId: input.operationId,
        });
        if (result === "ready") return completed(true);
        if (result === "conflict") return noEffect("edge_kv_ownership_conflict");
        return unknown("edge_kv_ownership_unavailable");
      }
      if (input.action === "update") {
        const result = await store.observe(identity(input, targetKey));
        if (result === "ready") return completed(true);
        if (result === "absent") return noEffect("edge_kv_namespace_unavailable");
        if (result === "conflict") return noEffect("edge_kv_ownership_conflict");
        return unknown("edge_kv_ownership_unavailable");
      }
      const result = await store.delete({
        identity: identity(input, targetKey),
        operationId: input.operationId,
      });
      if (result === "deleted") return completed(false);
      if (result === "conflict") return noEffect("edge_kv_ownership_conflict");
      return unknown("edge_kv_delete_unavailable");
    };
    reconcileDispatch = async (input) => {
      if (input.action === "create") {
        const result = await store.reconcileCreate({
          identity: identity(input, targetKey),
          operationId: input.operationId,
        });
        if (result === "ready") return completed(true);
        if (result === "absent") return noEffect("edge_kv_create_not_recorded");
        if (result === "conflict") return noEffect("edge_kv_ownership_conflict");
        return unknown("edge_kv_ownership_unavailable");
      }
      return await dispatch(input);
    };
  } else {
    const { backend } = options as Extract<EdgeKVNamespaceFormOptions, { backend: V2Backend }>;
    if (
      !backend ||
      typeof backend !== "object" ||
      typeof backend.id !== "string" ||
      backend.id.trim().length === 0 ||
      backend.targetKey !== targetKey ||
      typeof backend.execute !== "function" ||
      typeof backend.reconcile !== "function"
    ) {
      throw new TypeError("invalid EdgeKV native backend");
    }
    backendId = backend.id;
    const originalExecute = backend.execute;
    const originalReconcile = backend.reconcile;
    implementationUnchanged = () =>
      backend.id === backendId &&
      backend.targetKey === targetKey &&
      backend.execute === originalExecute &&
      backend.reconcile === originalReconcile;
    dispatch = (input) => originalExecute.call(backend, input);
    reconcileDispatch = (input) => originalReconcile.call(backend, input);
  }

  const permitted = (input: V2Execution) =>
    input.backendId === backendId &&
    input.form === EDGE_KV_NAMESPACE_FORM_URL &&
    input.targetKey === targetKey &&
    implementationUnchanged();

  const invoke = async (
    input: V2Execution,
    method: V2Backend["execute"],
  ): Promise<V2BackendResult> => {
    if (!permitted(input)) return unknown("ownership_uncertain");
    const scope = captureExecutionScope(input);
    const action = input.action;
    try {
      const result = await method(input);
      if (!permitted(input) || !executionScopeUnchanged(input, scope))
        return unknown("ownership_uncertain");
      if (result.kind === "complete" && !canonicalComplete(result, action))
        return unknown("edge_kv_invalid_complete");
      return result;
    } catch {
      return unknown("edge_kv_backend_unavailable");
    }
  };

  const execute = (input: V2Execution) => invoke(input, dispatch);
  const reconcile = (input: V2Execution) => invoke(input, reconcileDispatch);

  return {
    validateCreate(spec) {
      try {
        parseEdgeKVNamespaceSpec(spec);
      } catch (error) {
        if (error instanceof EdgeKVNamespaceValidationError)
          throw new TakoformV2Error("invalid_spec", 422);
        throw error;
      }
    },
    validateUpdate(previousSpec, spec) {
      try {
        validateEdgeKVNamespaceUpdate(previousSpec, spec);
      } catch (error) {
        if (error instanceof EdgeKVNamespaceValidationError)
          throw new TakoformV2Error("invalid_spec", 422);
        throw error;
      }
    },
    rejectDeleteWhileReferenced: true,
    backend: { id: backendId, targetKey, execute, reconcile },
  };
}
