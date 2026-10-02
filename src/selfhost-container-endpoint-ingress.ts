import {
  LOCAL_CONTAINER_ENDPOINT_FORM,
  LOCAL_CONTAINER_ENDPOINT_PACKAGE_DIGEST,
  parseSelfhostContainerEndpointNativeId,
  type SelfhostContainerEndpointIngressCapability,
} from "./providers/selfhost-container-endpoint.ts";
import { selfhostContainerNativeIdentity } from "./providers/selfhost-container-lifecycle.ts";
import type { ResourceDeploymentStore } from "./resource-deployments.ts";
import type { TakoformStore } from "./takoform/store.ts";

const serviceForm = {
  apiVersion: "edge.forms.takoform.com",
  kind: "ContainerService",
  definitionVersion: "0.1.0",
  schemaDigest: "sha256:114d452395562573f46d9a879efa889ab42a3e43348d7db244e22df7d6e330e2",
} as const;
const servicePackage = "sha256:0fb3c53940180e3f661268e079f9dbc6667c4d1fbbc74b4561ebb5ffa2740d33";

function exactForm(
  value: {
    readonly formRef: {
      readonly apiVersion: string;
      readonly kind: string;
      readonly definitionVersion: string;
      readonly schemaDigest: string;
    };
    readonly packageDigest?: string;
  },
  expected: {
    readonly apiVersion: string;
    readonly kind: string;
    readonly definitionVersion: string;
    readonly schemaDigest: string;
  },
  pkg: string,
): boolean {
  const ref = value.formRef;
  return (
    ref.apiVersion === expected.apiVersion &&
    ref.kind === expected.kind &&
    ref.definitionVersion === expected.definitionVersion &&
    ref.schemaDigest === expected.schemaDigest &&
    value.packageDigest === pkg
  );
}

const unavailable = () => new Response(null, { status: 503 });
const notFound = () => new Response(null, { status: 404 });

/** HTTPS application data plane. The committed Host Resource/relation/Deployment is its only route ledger. */
export function createSelfhostContainerEndpointIngress(options: {
  readonly qualification: SelfhostContainerEndpointIngressCapability;
  readonly store: Pick<
    TakoformStore,
    "containerEndpointByHostname" | "resourceWithRelationTargetByUid"
  >;
  readonly deployments: Pick<ResourceDeploymentStore, "active">;
}): (request: Request) => Promise<Response | null> {
  const { qualification: capability, store, deployments } = options;
  const suffix = capability.qualification.configuredSuffix;
  return async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return null;
    }
    const hostname = url.hostname.toLowerCase();
    if (!hostname.endsWith(`.${suffix}`)) return null;
    if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443"))
      return new Response(null, { status: 421 });
    try {
      capability.qualification.assertServing();
      const found = await store.containerEndpointByHostname(hostname);
      if (!found) return notFound();
      const { tenantId, listing } = found;
      const resource = listing.resource;
      if (
        !exactForm(
          resource.form,
          LOCAL_CONTAINER_ENDPOINT_FORM,
          LOCAL_CONTAINER_ENDPOINT_PACKAGE_DIGEST,
        ) ||
        listing.uid !== resource.metadata.uid ||
        resource.status.operationId !== undefined ||
        resource.status.observedGeneration !== resource.metadata.generation ||
        !resource.status.conditions.some(
          (condition) => condition.type === "Ready" && condition.status === "True",
        ) ||
        resource.status.outputs?.hostname !== hostname ||
        resource.status.outputs.url !== `https://${hostname}/`
      )
        return notFound();
      const relation = await store.resourceWithRelationTargetByUid(
        tenantId,
        listing.uid,
        "/service",
      );
      if (
        !relation ||
        relation.source.uid !== listing.uid ||
        relation.source.revision !== listing.revision ||
        relation.relation.pointer !== "/service" ||
        relation.relation.relation !== "/service" ||
        relation.relation.targetUid !== relation.target.uid ||
        !exactForm(relation.target.resource.form, serviceForm, servicePackage)
      )
        return notFound();
      const endpointDeployment = await deployments.active(tenantId, listing.uid);
      const endpointNative =
        endpointDeployment && parseSelfhostContainerEndpointNativeId(endpointDeployment.nativeId);
      if (
        !endpointDeployment ||
        !endpointNative ||
        endpointNative.uid !== listing.uid ||
        endpointNative.hostname !== hostname ||
        endpointDeployment.providerInstallationRef !== "local.primary" ||
        endpointDeployment.outputs.hostname !== hostname ||
        endpointDeployment.outputs.url !== `https://${hostname}/`
      )
        return notFound();
      const targetDeployment = await deployments.active(tenantId, relation.target.uid);
      const targetNative =
        targetDeployment && selfhostContainerNativeIdentity(targetDeployment.nativeId);
      if (
        !targetDeployment ||
        !targetNative ||
        targetNative.resourceUid !== relation.target.uid ||
        targetNative.incarnationId !== targetDeployment.id ||
        targetDeployment.providerInstallationRef !== "local.primary"
      )
        return unavailable();
      const identity = { resourceUid: relation.target.uid, incarnationId: targetDeployment.id };
      const observed = await capability.runtime.observe(identity);
      const generation = Number(relation.target.generation);
      if (
        !Number.isSafeInteger(generation) ||
        generation < 1 ||
        (observed.state !== "ready" && observed.state !== "updating") ||
        observed.servingGeneration !== generation
      )
        return unavailable();
      // One request, one invocation: application HTTP is never replayed after a lost response.
      return await capability.runtime.fetch(identity, request);
    } catch {
      return unavailable();
    }
  };
}
