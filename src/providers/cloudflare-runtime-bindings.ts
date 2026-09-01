import type { TakoformBindingRef } from "../interface-ref.ts";

export const EDGE_OBJECTS_BINDING_REF = Object.freeze({
  apiVersion: "bindings.takoform.com/v1alpha2",
  name: "module-worker.object-bucket",
  version: "1.1.0",
  schemaDigest: "sha256:ff8661459b73a8d229e0915c698afad2aa297b5db90fe5e1693d346a7ae3adfb",
}) satisfies TakoformBindingRef;

export const CLOUDFLARE_R2_EDGE_OBJECTS_MATERIAL_KIND =
  "takoserver.cloudflare-r2.edge-objects@v1" as const;

export interface CloudflareR2EdgeObjectsMaterial {
  readonly kind: typeof CLOUDFLARE_R2_EDGE_OBJECTS_MATERIAL_KIND;
  readonly bucketName: string;
}

export function cloudflareR2EdgeObjectsMaterial(
  value: unknown,
): CloudflareR2EdgeObjectsMaterial | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== 2
  ) {
    return null;
  }
  const record = value as Record<PropertyKey, unknown>;
  return record.kind === CLOUDFLARE_R2_EDGE_OBJECTS_MATERIAL_KIND &&
    typeof record.bucketName === "string" &&
    /^ts-[0-9a-f]{40}$/u.test(record.bucketName)
    ? (value as CloudflareR2EdgeObjectsMaterial)
    : null;
}
