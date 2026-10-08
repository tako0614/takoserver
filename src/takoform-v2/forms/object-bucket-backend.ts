import { TakoformV2Error, type V2BackendResult, type V2Execution, type V2Form } from "../types.ts";
import {
  OBJECT_BUCKET_LIMITS,
  ObjectBucketValidationError,
  parseObjectBucketSpec,
  validateObjectBucketUpdate,
} from "./object-bucket.ts";

export const OBJECT_BUCKET_BACKEND_ID = "selfhost-v2-object-bucket-filesystem-v1";
const BACKEND_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

/** Select one trusted implementation identity before any Resource effect. */
export function resolveObjectBucketBackendId(backendId: unknown, supplied: boolean): string {
  if (!supplied) return OBJECT_BUCKET_BACKEND_ID;
  if (typeof backendId !== "string" || !BACKEND_ID.test(backendId)) {
    throw new TypeError("ObjectBucket backendId must be an exact nonempty identifier");
  }
  return backendId;
}

interface ObjectBucketIdentity {
  readonly targetKey: string;
  readonly principal: string;
  readonly space: string;
  readonly resourceUid: string;
}

/** Narrow Form-to-store port; the provider implementation is injected by composition. */
export interface ObjectBucketStore {
  create(input: {
    readonly identity: ObjectBucketIdentity;
    readonly operationId: string;
  }): Promise<"ready" | "absent" | "conflict" | "unknown">;
  reconcileCreate(input: {
    readonly identity: ObjectBucketIdentity;
    readonly operationId: string;
  }): Promise<"ready" | "absent" | "conflict" | "unknown">;
  observe(identity: ObjectBucketIdentity): Promise<"ready" | "absent" | "conflict" | "unknown">;
  delete(input: {
    readonly identity: ObjectBucketIdentity;
    readonly operationId: string;
  }): Promise<"deleted" | "conflict" | "unknown">;
}

const COMPLETE_OBSERVATION = Object.freeze({
  maxKeyBytes: OBJECT_BUCKET_LIMITS.maxKeyBytes,
  maxObjectBytes: OBJECT_BUCKET_LIMITS.maxObjectBytes,
  maxSinglePutBytes: OBJECT_BUCKET_LIMITS.maxSinglePutBytes,
  maxMultipartParts: OBJECT_BUCKET_LIMITS.maxMultipartParts,
  consistency: OBJECT_BUCKET_LIMITS.consistency,
});

function identity(input: V2Execution, targetKey: string): ObjectBucketIdentity {
  return {
    targetKey,
    principal: input.principal,
    space: input.space,
    resourceUid: input.resourceUid,
  };
}

function completed(bucketExists: boolean): V2BackendResult {
  return {
    kind: "complete",
    observed: { bucketExists, ...COMPLETE_OBSERVATION },
    output: {},
  };
}

function noEffect(code: string): V2BackendResult {
  return { kind: "no_effect", code, message: code };
}

function unknown(code: string): V2BackendResult {
  return { kind: "unknown", code, message: code };
}

function invalidSpec(error: unknown): never {
  if (error instanceof ObjectBucketValidationError) {
    throw new TakoformV2Error(error.code, 422);
  }
  throw error;
}

export function createObjectBucketForm(options: {
  readonly store: ObjectBucketStore;
  readonly targetKey: string;
  /** Trusted operator-selected implementation; absent keeps existing filesystem identity. */
  readonly backendId?: string;
}): V2Form {
  if (!options.targetKey) throw new TypeError("targetKey is required");
  const { store, targetKey } = options;
  const backendId = resolveObjectBucketBackendId(
    options.backendId,
    Object.hasOwn(options, "backendId"),
  );

  const execute = async (input: V2Execution): Promise<V2BackendResult> => {
    try {
      if (input.action === "create") {
        const state = await store.create({
          identity: identity(input, targetKey),
          operationId: input.operationId,
        });
        if (state === "ready") return completed(true);
        if (state === "conflict") return noEffect("object_bucket_ownership_conflict");
        return unknown("object_bucket_ownership_unavailable");
      }
      if (input.action === "update") {
        const state = await store.observe(identity(input, targetKey));
        if (state === "ready") return completed(true);
        if (state === "conflict") return noEffect("object_bucket_ownership_conflict");
        if (state === "absent") return noEffect("object_bucket_unavailable");
        return unknown("object_bucket_ownership_unavailable");
      }
      const result = await store.delete({
        identity: identity(input, targetKey),
        operationId: input.operationId,
      });
      if (result === "deleted") return completed(false);
      if (result === "conflict") return noEffect("object_bucket_ownership_conflict");
      return unknown("object_bucket_delete_unavailable");
    } catch {
      return unknown("object_bucket_backend_unavailable");
    }
  };

  const reconcile = async (input: V2Execution): Promise<V2BackendResult> => {
    try {
      if (input.action === "create") {
        const state = await store.reconcileCreate({
          identity: identity(input, targetKey),
          operationId: input.operationId,
        });
        if (state === "ready") return completed(true);
        if (state === "absent") return noEffect("object_bucket_create_not_recorded");
        if (state === "conflict") return noEffect("object_bucket_ownership_conflict");
        return unknown("object_bucket_ownership_unavailable");
      }
      if (input.action === "update") {
        const state = await store.observe(identity(input, targetKey));
        if (state === "ready") return completed(true);
        if (state === "absent") return noEffect("object_bucket_unavailable");
        if (state === "conflict") return noEffect("object_bucket_ownership_conflict");
        return unknown("object_bucket_ownership_unavailable");
      }
      const result = await store.delete({
        identity: identity(input, targetKey),
        operationId: input.operationId,
      });
      if (result === "deleted") return completed(false);
      if (result === "conflict") return noEffect("object_bucket_ownership_conflict");
      return unknown("object_bucket_delete_unavailable");
    } catch {
      return unknown("object_bucket_backend_unavailable");
    }
  };

  return {
    validateCreate(spec) {
      try {
        parseObjectBucketSpec(spec);
      } catch (error) {
        invalidSpec(error);
      }
    },
    validateUpdate(previousSpec, spec) {
      try {
        validateObjectBucketUpdate(previousSpec, spec);
      } catch (error) {
        invalidSpec(error);
      }
    },
    rejectDeleteWhileReferenced: true,
    backend: {
      id: backendId,
      targetKey,
      execute,
      reconcile,
    },
  };
}
