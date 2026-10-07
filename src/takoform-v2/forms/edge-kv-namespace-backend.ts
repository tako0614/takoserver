import { TakoformV2Error, type V2BackendResult, type V2Execution, type V2Form } from "../types.ts";
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

export function createEdgeKVNamespaceForm(options: {
  readonly store: EdgeKVNamespaceStore;
  readonly targetKey: string;
}): V2Form {
  if (!options.targetKey) throw new TypeError("targetKey is required");
  const { store, targetKey } = options;

  const execute = async (input: V2Execution): Promise<V2BackendResult> => {
    if (input.form !== EDGE_KV_NAMESPACE_FORM_URL || input.targetKey !== targetKey) {
      return unknown("ownership_uncertain");
    }
    try {
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
    } catch {
      return unknown("edge_kv_backend_unavailable");
    }
  };

  const reconcile = async (input: V2Execution): Promise<V2BackendResult> => {
    if (input.form !== EDGE_KV_NAMESPACE_FORM_URL || input.targetKey !== targetKey) {
      return unknown("ownership_uncertain");
    }
    try {
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
      return await execute(input);
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
    backend: { id: EDGE_KV_NAMESPACE_BACKEND_ID, targetKey, execute, reconcile },
  };
}
