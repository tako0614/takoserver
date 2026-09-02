import type { TakoformBindingRef } from "./interface-ref.ts";
import type { RuntimeBindingMaterializer, RuntimeBindingMaterialRoute } from "./provider-pack.ts";
import {
  SELFHOST_EDGE_OBJECTS_BINDING_REF,
  SELFHOST_EDGE_OBJECTS_MATERIAL_KIND,
  SELFHOST_OBJECT_BUCKET_ID,
  type SelfhostEdgeObjectsMaterial,
  selfhostObjectBucketNativeId,
} from "./providers/selfhost-runtime-bindings.ts";

const EXPORTED_BUCKET = Symbol("selfhost-object-bucket-runtime-binding-export");

interface ExportedSelfhostBucketBinding {
  readonly [EXPORTED_BUCKET]: true;
  readonly providerPackRef: string;
  readonly bucketId: string;
}

const SELFHOST_OBJECTS_ROUTE = Object.freeze({
  bindingRef: SELFHOST_EDGE_OBJECTS_BINDING_REF,
  materialKind: SELFHOST_EDGE_OBJECTS_MATERIAL_KIND,
}) satisfies RuntimeBindingMaterialRoute;

/**
 * The self-host pack's two-stage materialization of an edge.objects Binding.
 *
 * Both halves live here, and both are needed: a complete capability exists only
 * where one exporter route and one importer route agree on the exact Binding
 * and material kind, so a pack that published only an export would advertise a
 * bucket nothing on this machine could ever consume — and
 * `resolveRuntimeBindingMaterialRoute` would answer `null`, which the driver
 * turns into `unsupported_capability` at admission.
 *
 * The Cloudflare materializer ships both halves too, for a different reason:
 * only one of its two Worker backends may consume the import. Here there is one
 * backend and it is a wrapper, so the facade it projects is the exact
 * `edge.objects` one ADR 0005 asks for rather than a provider-native client.
 *
 * The private symbol is the fence. Only this module's exporter can produce a
 * value that passes it, so a foreign pack cannot hand this Host's Worker a
 * bucket id that merely looks right — and a bucket id is the whole of the
 * isolation between two tenants' objects on this machine.
 */
export function createSelfhostRuntimeBindingMaterializer(
  providerPackRef: string,
): RuntimeBindingMaterializer {
  const exported = (value: unknown): ExportedSelfhostBucketBinding | null => {
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as Partial<ExportedSelfhostBucketBinding>;
    return candidate[EXPORTED_BUCKET] === true &&
      candidate.providerPackRef === providerPackRef &&
      typeof candidate.bucketId === "string" &&
      SELFHOST_OBJECT_BUCKET_ID.test(candidate.bucketId)
      ? (value as ExportedSelfhostBucketBinding)
      : null;
  };
  return {
    id: `${providerPackRef}-runtime-bindings`,
    exporter: {
      routes: [SELFHOST_OBJECTS_ROUTE],
      async exportTarget({ relation, route }) {
        const bucketId = relation.deployment.outputs.bucketName;
        if (
          relation.deployment.providerPackRef !== providerPackRef ||
          !sameRoute(route) ||
          typeof bucketId !== "string" ||
          !SELFHOST_OBJECT_BUCKET_ID.test(bucketId) ||
          relation.deployment.nativeId !== selfhostObjectBucketNativeId(bucketId)
        ) {
          return null;
        }
        return Object.freeze({
          [EXPORTED_BUCKET]: true as const,
          providerPackRef,
          bucketId,
        }) satisfies ExportedSelfhostBucketBinding;
      },
    },
    importer: {
      routes: [SELFHOST_OBJECTS_ROUTE],
      async importBinding({ route, exported: capability }) {
        const target = exported(capability.material);
        if (
          !sameRoute(route) ||
          capability.providerPackRef !== providerPackRef ||
          capability.materialKind !== SELFHOST_EDGE_OBJECTS_MATERIAL_KIND ||
          !target
        ) {
          return null;
        }
        return Object.freeze({
          kind: SELFHOST_EDGE_OBJECTS_MATERIAL_KIND,
          bucketId: target.bucketId,
        }) satisfies SelfhostEdgeObjectsMaterial;
      },
    },
  };
}

function sameRoute(route: RuntimeBindingMaterialRoute): boolean {
  return (
    sameBinding(route.bindingRef, SELFHOST_EDGE_OBJECTS_BINDING_REF) &&
    route.materialKind === SELFHOST_EDGE_OBJECTS_MATERIAL_KIND
  );
}

function sameBinding(left: TakoformBindingRef, right: TakoformBindingRef): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.name === right.name &&
    left.version === right.version &&
    left.schemaDigest === right.schemaDigest
  );
}
