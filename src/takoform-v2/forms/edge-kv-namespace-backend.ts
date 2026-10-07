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

  const execute = async (input: V2Execution): Promise<V2BackendResult> => {
    if (!permitted(input)) return unknown("ownership_uncertain");
    try {
      return await dispatch(input);
    } catch {
      return unknown("edge_kv_backend_unavailable");
    }
  };

  const reconcile = async (input: V2Execution): Promise<V2BackendResult> => {
    if (!permitted(input)) return unknown("ownership_uncertain");
    try {
      return await reconcileDispatch(input);
    } catch {
      return unknown("edge_kv_backend_unavailable");
    }
  };

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
