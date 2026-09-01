import type { TakoformBindingRef } from "./interface-ref.ts";
import type { RuntimeBindingMaterializer, RuntimeBindingMaterialRoute } from "./provider-pack.ts";
import {
  CLOUDFLARE_R2_EDGE_OBJECTS_MATERIAL_KIND,
  EDGE_OBJECTS_BINDING_REF,
} from "./providers/cloudflare-runtime-bindings.ts";

const EXPORTED_R2 = Symbol("cloudflare-r2-runtime-binding-export");

interface ExportedCloudflareR2Binding {
  readonly [EXPORTED_R2]: true;
  readonly providerPackRef: string;
  readonly bucketName: string;
}

const CLOUDFLARE_R2_EXPORT_ROUTE = Object.freeze({
  bindingRef: EDGE_OBJECTS_BINDING_REF,
  materialKind: CLOUDFLARE_R2_EDGE_OBJECTS_MATERIAL_KIND,
}) satisfies RuntimeBindingMaterialRoute;

/**
 * Target-side R2 export for an edge.objects Binding.
 *
 * There is intentionally no consumer import route yet. The current managed
 * Worker wrapper keeps multipart validation receipts in isolate memory, so it
 * cannot honestly claim a restart-safe ObjectBucket runtime. A future WfP
 * importer must first compose a provider-private durable receipt backend; an
 * ordinary Worker adapter must not consume this export at all.
 */
export function createCloudflareRuntimeBindingMaterializer(
  providerPackRef: string,
): RuntimeBindingMaterializer {
  return {
    id: `${providerPackRef}-runtime-bindings`,
    exporter: {
      routes: [CLOUDFLARE_R2_EXPORT_ROUTE],
      async exportTarget({ relation, route }) {
        const bucketName = relation.deployment.outputs.bucketName;
        if (
          relation.deployment.providerPackRef !== providerPackRef ||
          !sameBinding(route.bindingRef, EDGE_OBJECTS_BINDING_REF) ||
          route.materialKind !== CLOUDFLARE_R2_EDGE_OBJECTS_MATERIAL_KIND ||
          typeof bucketName !== "string" ||
          !/^ts-[0-9a-f]{40}$/u.test(bucketName) ||
          relation.deployment.nativeId !== `r2:${bucketName}`
        ) {
          return null;
        }
        return Object.freeze({
          [EXPORTED_R2]: true as const,
          providerPackRef,
          bucketName,
        }) satisfies ExportedCloudflareR2Binding;
      },
    },
  };
}

function sameBinding(left: TakoformBindingRef, right: TakoformBindingRef): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.name === right.name &&
    left.version === right.version &&
    left.schemaDigest === right.schemaDigest
  );
}
