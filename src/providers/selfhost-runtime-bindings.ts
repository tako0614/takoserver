import type { TakoformBindingRef } from "../interface-ref.ts";
import { EDGE_OBJECTS_BINDING_REF } from "./cloudflare-runtime-bindings.ts";

/**
 * The material a self-host Provider Pack hands its own Worker backend for one
 * `module-worker.object-bucket` Binding.
 *
 * It carries the bucket incarnation this Host derived and nothing else. The
 * Worker never sees it: the generated entrypoint addresses `env.MEDIA` by name
 * and the object plane resolves that name through the Version's own record, so
 * a bucket id is a fact about this machine rather than something a tenant is
 * given.
 *
 * The Binding identity itself is the portable one every Host shares, so it is
 * imported rather than restated — two spellings of one Binding is how a route
 * comes to match on one side and not the other.
 */
export const SELFHOST_EDGE_OBJECTS_MATERIAL_KIND = "takoserver.selfhost.edge-objects@v1" as const;

export const SELFHOST_EDGE_OBJECTS_BINDING_REF: TakoformBindingRef = EDGE_OBJECTS_BINDING_REF;

/** The `tsb-` incarnation names this Host derives, and nothing else. */
export const SELFHOST_OBJECT_BUCKET_ID = /^tsb-[0-9a-f]{40}$/u;

export interface SelfhostEdgeObjectsMaterial {
  readonly kind: typeof SELFHOST_EDGE_OBJECTS_MATERIAL_KIND;
  readonly bucketId: string;
}

export function selfhostEdgeObjectsMaterial(value: unknown): SelfhostEdgeObjectsMaterial | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 2
  ) {
    return null;
  }
  const record = value as Record<PropertyKey, unknown>;
  return record.kind === SELFHOST_EDGE_OBJECTS_MATERIAL_KIND &&
    typeof record.bucketId === "string" &&
    SELFHOST_OBJECT_BUCKET_ID.test(record.bucketId)
    ? (value as SelfhostEdgeObjectsMaterial)
    : null;
}

/** The native id this provider mints for one current ObjectBucket. */
export function selfhostObjectBucketNativeId(bucketId: string): string {
  return `selfhost-bucket:${bucketId}`;
}
