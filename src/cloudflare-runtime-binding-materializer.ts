import type { TakoformBindingRef } from "./interface-ref.ts";
import type { RuntimeBindingMaterializer, RuntimeBindingMaterialRoute } from "./provider-pack.ts";
import {
  CLOUDFLARE_R2_EDGE_OBJECTS_MATERIAL_KIND,
  type CloudflareR2EdgeObjectsMaterial,
  EDGE_OBJECTS_BINDING_REF,
} from "./providers/cloudflare-runtime-bindings.ts";

const EXPORTED_R2 = Symbol("cloudflare-r2-runtime-binding-export");

interface ExportedCloudflareR2Binding {
  readonly [EXPORTED_R2]: true;
  readonly providerPackRef: string;
  readonly bucketName: string;
}

const CLOUDFLARE_R2_ROUTE = Object.freeze({
  bindingRef: EDGE_OBJECTS_BINDING_REF,
  materialKind: CLOUDFLARE_R2_EDGE_OBJECTS_MATERIAL_KIND,
}) satisfies RuntimeBindingMaterialRoute;

/**
 * The Cloudflare pack's two-stage materialization of an edge.objects Binding.
 *
 * The exporter reads an already-realized bucket Deployment; the importer turns
 * that opaque capability into the one material the Cloudflare Worker backends
 * accept. Both halves live here because a complete capability exists only where
 * one exporter route and one importer route agree on the exact Binding and
 * material kind — including inside a single Provider Pack.
 *
 * The importer deliberately carries nothing but the derived bucket name. What
 * the Worker then sees is the selected backend's business: the managed backend
 * wraps it in the `edge.objects` facade, and the ordinary-workers backend binds
 * it natively because it uploads the tenant's exact bytes and has nowhere to
 * interpose a wrapper. Native R2 keeps its multipart state provider-side, which
 * is why an ordinary Worker may consume this export while the wrapper's
 * in-isolate receipt ledger is still the managed path's open question
 * (ADR 0007).
 */
export function createCloudflareRuntimeBindingMaterializer(
  providerPackRef: string,
): RuntimeBindingMaterializer {
  const exported = (value: unknown): ExportedCloudflareR2Binding | null => {
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as Partial<ExportedCloudflareR2Binding>;
    return candidate[EXPORTED_R2] === true &&
      candidate.providerPackRef === providerPackRef &&
      typeof candidate.bucketName === "string" &&
      bucketName(candidate.bucketName)
      ? (value as ExportedCloudflareR2Binding)
      : null;
  };
  return {
    id: `${providerPackRef}-runtime-bindings`,
    exporter: {
      routes: [CLOUDFLARE_R2_ROUTE],
      async exportTarget({ relation, route }) {
        const name = relation.deployment.outputs.bucketName;
        if (
          relation.deployment.providerPackRef !== providerPackRef ||
          !sameRoute(route) ||
          typeof name !== "string" ||
          !bucketName(name) ||
          relation.deployment.nativeId !== `r2:${name}`
        ) {
          return null;
        }
        return Object.freeze({
          [EXPORTED_R2]: true as const,
          providerPackRef,
          bucketName: name,
        }) satisfies ExportedCloudflareR2Binding;
      },
    },
    importer: {
      routes: [CLOUDFLARE_R2_ROUTE],
      async importBinding({ route, exported: capability }) {
        // The private symbol is the fence: only this pack's own exporter can
        // produce a value that passes, so a foreign pack cannot hand the
        // Cloudflare Worker a bucket name that merely looks right. The account
        // credential this adapter holds could not reach it anyway.
        const target = exported(capability.material);
        if (
          !sameRoute(route) ||
          capability.providerPackRef !== providerPackRef ||
          capability.materialKind !== CLOUDFLARE_R2_EDGE_OBJECTS_MATERIAL_KIND ||
          !target
        ) {
          return null;
        }
        return Object.freeze({
          kind: CLOUDFLARE_R2_EDGE_OBJECTS_MATERIAL_KIND,
          bucketName: target.bucketName,
        }) satisfies CloudflareR2EdgeObjectsMaterial;
      },
    },
  };
}

function sameRoute(route: RuntimeBindingMaterialRoute): boolean {
  return (
    sameBinding(route.bindingRef, EDGE_OBJECTS_BINDING_REF) &&
    route.materialKind === CLOUDFLARE_R2_EDGE_OBJECTS_MATERIAL_KIND
  );
}

function bucketName(value: string): boolean {
  return /^ts-[0-9a-f]{40}$/u.test(value);
}

function sameBinding(left: TakoformBindingRef, right: TakoformBindingRef): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.name === right.name &&
    left.version === right.version &&
    left.schemaDigest === right.schemaDigest
  );
}
