import { parseActorAbiRef } from "./actor-abi-ref.ts";
import type { TakoformBindingRef, TakoformInterfaceRef } from "./interface-ref.ts";
import { canonicalJson, isJsonObject } from "./json.ts";
import type { RuntimeBindingMaterializer, RuntimeBindingMaterialRoute } from "./provider-pack.ts";
import { SELFHOST_ACTOR_BINDING_REF } from "./providers/selfhost.ts";
import {
  SELFHOST_EDGE_OBJECTS_BINDING_REF,
  SELFHOST_EDGE_OBJECTS_MATERIAL_KIND,
  SELFHOST_OBJECT_BUCKET_ID,
  type SelfhostEdgeObjectsMaterial,
  selfhostObjectBucketNativeId,
} from "./providers/selfhost-runtime-bindings.ts";
import {
  isOwnedSelfhostActorPublicRuntime,
  type SelfhostActorPublicRuntime,
} from "./selfhost-actor-public-runtime.ts";
import { forwardTakoformCandidates } from "./takoform/forward-candidates.ts";
import type { InstalledTakoformBinding } from "./takoform/types.ts";

const EXPORTED_BUCKET = Symbol("selfhost-object-bucket-runtime-binding-export");
const EXPORTED_ACTOR = Symbol("selfhost-actor-runtime-binding-export");
export const SELFHOST_ACTOR_MATERIAL_KIND = "takoserver.selfhost.worker-actor@v1" as const;

interface ExportedSelfhostActorBinding {
  readonly [EXPORTED_ACTOR]: true;
  readonly providerPackRef: string;
  readonly tenantId: string;
  readonly namespaceResourceUid: string;
  readonly workerResourceUid: string;
  readonly className: string;
  readonly bindingRef: TakoformBindingRef;
  readonly runtimeClassRef?: TakoformInterfaceRef;
}

interface ExportedSelfhostBucketBinding {
  readonly [EXPORTED_BUCKET]: true;
  readonly providerPackRef: string;
  readonly bucketId: string;
}

const SELFHOST_OBJECTS_ROUTE = Object.freeze({
  bindingRef: SELFHOST_EDGE_OBJECTS_BINDING_REF,
  materialKind: SELFHOST_EDGE_OBJECTS_MATERIAL_KIND,
}) satisfies RuntimeBindingMaterialRoute;
const SELFHOST_ACTOR_ROUTE = Object.freeze({
  bindingRef: SELFHOST_ACTOR_BINDING_REF,
  materialKind: SELFHOST_ACTOR_MATERIAL_KIND,
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
  actorRuntime?: SelfhostActorPublicRuntime,
  actorBinding?: InstalledTakoformBinding,
): RuntimeBindingMaterializer {
  const actorSupported = isOwnedSelfhostActorPublicRuntime(actorRuntime);
  const forward = actorBinding ? forwardTakoformCandidates() : undefined;
  const selected = forward?.bindings.filter(
    (binding) => canonicalJson(binding) === canonicalJson(actorBinding),
  );
  const selectedBinding = selected?.length === 1 ? selected[0] : undefined;
  const selectedActor = forward?.forms.find(
    (form) => form.identity.formRef.kind === "ActorNamespace",
  );
  const selectedWorker = forward?.forms.find(
    (form) => form.identity.formRef.kind === "ModuleWorker",
  );
  if (
    actorBinding &&
    (!actorSupported ||
      !selectedBinding ||
      selectedBinding.bindingRef.name !== "module-worker.actor" ||
      parseActorAbiRef(selectedBinding.targetInterface)?.kind !== "v2" ||
      !selectedActor ||
      !selectedWorker ||
      canonicalJson(selectedActor.workerClassRuntime?.runtimeClassRef) !==
        canonicalJson(selectedBinding.targetInterface))
  ) {
    throw new TypeError("self-host Actor runtime Binding closure unavailable");
  }
  const actorRoute: RuntimeBindingMaterialRoute = selectedBinding
    ? Object.freeze({
        bindingRef: Object.freeze(structuredClone(selectedBinding.bindingRef)),
        materialKind: SELFHOST_ACTOR_MATERIAL_KIND,
      })
    : SELFHOST_ACTOR_ROUTE;
  const runtimeClassRef = selectedBinding
    ? Object.freeze(structuredClone(selectedBinding.targetInterface))
    : undefined;
  const sameActorRoute = (route: RuntimeBindingMaterialRoute) =>
    sameBinding(route.bindingRef, actorRoute.bindingRef) &&
    route.materialKind === SELFHOST_ACTOR_MATERIAL_KIND;
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
      routes: actorSupported ? [SELFHOST_OBJECTS_ROUTE, actorRoute] : [SELFHOST_OBJECTS_ROUTE],
      async exportTarget({ tenantId, relation, route }) {
        if (actorSupported && sameActorRoute(route)) {
          const uid = relation.targetUid;
          if (
            relation.relation !== "/actorBindings/*/resource" ||
            !/^\/actorBindings\/(?:0|[1-9][0-9]*)\/resource$/u.test(relation.pointer) ||
            relation.deployment.state !== "active" ||
            relation.deployment.offeringId !== "compute.actor.stable-v1.standard" ||
            relation.deployment.providerPackRef !== providerPackRef ||
            relation.deployment.tenantId !== tenantId ||
            relation.deployment.resourceUid !== uid ||
            relation.deployment.nativeId !== `selfhost-actor:${uid}` ||
            relation.resource.apiVersion !== "edge.forms.takoform.com" ||
            relation.resource.kind !== "ActorNamespace" ||
            relation.resource.metadata.uid !== uid ||
            !relation.bindingRef ||
            !sameBinding(relation.bindingRef, actorRoute.bindingRef) ||
            (selectedActor &&
              canonicalJson(relation.resource.form.formRef) !==
                canonicalJson(selectedActor.identity.formRef))
          )
            return null;
          const scope = { tenantId, namespaceResourceUid: uid };
          const graph = await actorRuntime.actorNamespace.readCurrentGraph(
            scope,
            AbortSignal.timeout(30_000),
          );
          if (
            !graph ||
            graph.tenantId !== tenantId ||
            graph.namespace.uid !== uid ||
            graph.namespace.address.space !== relation.resource.metadata.space ||
            graph.namespace.address.name !== relation.resource.metadata.name ||
            graph.namespace.className !== relation.resource.spec.className ||
            !isJsonObject(relation.resource.spec.worker) ||
            graph.worker.address.apiVersion !== relation.resource.spec.worker.apiVersion ||
            graph.worker.address.kind !== relation.resource.spec.worker.kind ||
            graph.worker.address.name !== relation.resource.spec.worker.name ||
            (runtimeClassRef &&
              (canonicalJson(graph.runtimeClassRef) !== canonicalJson(runtimeClassRef) ||
                canonicalJson(graph.worker.formRef) !==
                  canonicalJson(selectedWorker?.identity.formRef) ||
                canonicalJson(graph.namespace.formRef) !==
                  canonicalJson(relation.resource.form.formRef) ||
                graph.namespace.generation !== relation.resource.metadata.generation ||
                graph.namespace.revision !== relation.resource.metadata.revision ||
                graph.worker.address.space !== relation.resource.metadata.space)) ||
            !(await actorRuntime.actorNamespace.hasNamespace(scope))
          )
            return null;
          return Object.freeze({
            [EXPORTED_ACTOR]: true as const,
            providerPackRef,
            tenantId,
            namespaceResourceUid: uid,
            workerResourceUid: graph.worker.uid,
            className: graph.namespace.className,
            bindingRef: actorRoute.bindingRef,
            ...(runtimeClassRef ? { runtimeClassRef } : {}),
          }) satisfies ExportedSelfhostActorBinding;
        }
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
      routes: actorSupported ? [SELFHOST_OBJECTS_ROUTE, actorRoute] : [SELFHOST_OBJECTS_ROUTE],
      async importBinding({ tenantId, source, relation, route, exported: capability }) {
        if (actorSupported && sameActorRoute(route)) {
          const value = capability.material;
          if (
            !value ||
            typeof value !== "object" ||
            (value as Partial<ExportedSelfhostActorBinding>)[EXPORTED_ACTOR] !== true ||
            capability.providerPackRef !== providerPackRef ||
            capability.materialKind !== SELFHOST_ACTOR_MATERIAL_KIND ||
            (value as ExportedSelfhostActorBinding).providerPackRef !== providerPackRef ||
            (value as ExportedSelfhostActorBinding).tenantId !== tenantId ||
            (value as ExportedSelfhostActorBinding).namespaceResourceUid !== relation.targetUid ||
            canonicalJson((value as ExportedSelfhostActorBinding).bindingRef) !==
              canonicalJson(actorRoute.bindingRef) ||
            (runtimeClassRef &&
              (canonicalJson((value as ExportedSelfhostActorBinding).runtimeClassRef) !==
                canonicalJson(runtimeClassRef) ||
                source.tenantRef !== tenantId ||
                source.space !== relation.resource.metadata.space ||
                canonicalJson(relation.bindingRef) !== canonicalJson(actorRoute.bindingRef)))
          )
            return null;
          const actor = value as ExportedSelfhostActorBinding;
          return Object.freeze({
            kind: SELFHOST_ACTOR_MATERIAL_KIND,
            tenantId,
            namespaceResourceUid: actor.namespaceResourceUid,
            workerResourceUid: actor.workerResourceUid,
            className: actor.className,
          });
        }
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
