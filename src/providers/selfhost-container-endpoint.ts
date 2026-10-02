import {
  type ApplyInput,
  failed,
  type ProviderRelation,
  type ProviderTicket,
  type ResourceIdentity,
  succeeded,
} from "../provider-port.ts";
import { derivedProviderResourceIncarnationName } from "../provider-worker-endpoint-origin.ts";
import {
  type SelfhostContainerRuntimeHandle,
  selfhostContainerNativeIdentity,
} from "./selfhost-container-lifecycle.ts";

const LOCAL_CONTAINER_FORM = {
  apiVersion: "edge.forms.takoform.com",
  kind: "ContainerService",
  definitionVersion: "0.1.0",
  schemaDigest: "sha256:114d452395562573f46d9a879efa889ab42a3e43348d7db244e22df7d6e330e2",
} as const;

/** Exact reviewed local candidate, unpublished and never projected into the released 17 Forms. */
export const LOCAL_CONTAINER_ENDPOINT_FORM = {
  apiVersion: "edge.forms.takoform.com",
  kind: "ContainerEndpoint",
  definitionVersion: "0.1.0",
  schemaDigest: "sha256:c32e716d9185026fce7ae105d14035d75fa64ec7322483122126b95db902b336",
} as const;
export const LOCAL_CONTAINER_ENDPOINT_PACKAGE_DIGEST =
  "sha256:c5ee452369ddafc1ba15d76adcdcc1611ff558d2e385a3f1f6379a4cce86b288";

/** Shared type marker; only the listener owner can establish live qualification. */
export const SELFHOST_CONTAINER_ENDPOINT_HTTPS_INGRESS_BRAND: unique symbol = Symbol(
  "selfhost-container-endpoint-https-ingress",
);

/** Supplied only after the owning entry has qualified the actual HTTPS 443 ingress and suffix. */
export interface SelfhostContainerEndpointHttpsIngressPort {
  readonly [SELFHOST_CONTAINER_ENDPOINT_HTTPS_INGRESS_BRAND]: true;
  readonly configuredSuffix: string;
  readonly publicOrigin: `https://${string}`;
  readonly port: 443;
  /** Listener-owned live qualification. The entry owns TLS/SNI proof and revocation. */
  assertServing(): void;
}

/** The concrete runtime is shared with the service provider; this is not a second route ledger. */
export interface SelfhostContainerEndpointIngressCapability {
  readonly runtime: SelfhostContainerRuntimeHandle;
  readonly qualification: SelfhostContainerEndpointHttpsIngressPort;
}

const dnsName =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

/** Shape check only. The caller must independently prove the owned suffix and live TLS listener. */
export function validateSelfhostContainerEndpointIngressPort(
  value: SelfhostContainerEndpointHttpsIngressPort,
): void {
  value.assertServing();
  const suffix = value.configuredSuffix;
  if (
    value[SELFHOST_CONTAINER_ENDPOINT_HTTPS_INGRESS_BRAND] !== true ||
    value.port !== 443 ||
    value.publicOrigin !== `https://${suffix}` ||
    suffix !== suffix.toLowerCase() ||
    suffix.length < 3 ||
    suffix.length > 208 ||
    !dnsName.test(suffix)
  )
    throw new TypeError("ContainerEndpoint HTTPS ingress qualification is invalid");
}

/** Immutable per Endpoint UID, including a same-name replacement and service generation cutover. */
export async function selfhostContainerEndpointAddress(
  identity: Pick<ResourceIdentity, "tenantRef" | "space" | "name"> & { readonly uid: string },
  qualification: SelfhostContainerEndpointHttpsIngressPort,
): Promise<{ readonly hostname: string; readonly url: string }> {
  validateSelfhostContainerEndpointIngressPort(qualification);
  const label = await derivedProviderResourceIncarnationName("ce", identity);
  const hostname = `${label}.${qualification.configuredSuffix}`;
  const url = `https://${hostname}/`;
  if (hostname.length > 253 || url.length > 262 || !dnsName.test(hostname))
    throw new TypeError("ContainerEndpoint hostname cannot be published");
  return { hostname, url };
}

const nativePrefix = "selfhost-container-endpoint:";

export function selfhostContainerEndpointNativeId(uid: string, hostname: string): string {
  return `${nativePrefix}${Buffer.from(JSON.stringify([uid, hostname])).toString("base64url")}`;
}

export function parseSelfhostContainerEndpointNativeId(
  value: string,
): { uid: string; hostname: string } | null {
  if (!value.startsWith(nativePrefix) || value.length > 1024) return null;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value.slice(nativePrefix.length), "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== "string" ||
      typeof decoded[1] !== "string"
    )
      return null;
    const [uid, hostname] = decoded as [string, string];
    if (!uid || uid.length > 256 || !dnsName.test(hostname)) return null;
    return selfhostContainerEndpointNativeId(uid, hostname) === value ? { uid, hostname } : null;
  } catch {
    return null;
  }
}

function exactServiceRelation(
  relations: readonly ProviderRelation[] | undefined,
):
  | (ProviderRelation & { readonly deployment: NonNullable<ProviderRelation["deployment"]> })
  | null {
  const matching = relations?.filter((relation) => relation.pointer === "/service") ?? [];
  if (matching.length !== 1) return null;
  const relation = matching[0];
  if (
    !relation ||
    relation.targetUid !== relation.resource.metadata.uid ||
    relation.resource.apiVersion !== LOCAL_CONTAINER_FORM.apiVersion ||
    relation.resource.kind !== LOCAL_CONTAINER_FORM.kind ||
    relation.resource.form.formRef.apiVersion !== LOCAL_CONTAINER_FORM.apiVersion ||
    relation.resource.form.formRef.kind !== LOCAL_CONTAINER_FORM.kind ||
    relation.resource.form.formRef.definitionVersion !== LOCAL_CONTAINER_FORM.definitionVersion ||
    relation.resource.form.formRef.schemaDigest !== LOCAL_CONTAINER_FORM.schemaDigest ||
    relation.deployment?.state !== "active" ||
    relation.deployment.resourceUid !== relation.targetUid
  )
    return null;
  const native = selfhostContainerNativeIdentity(relation.deployment.nativeId);
  return native &&
    native.resourceUid === relation.targetUid &&
    native.incarnationId === relation.deployment.id
    ? { ...relation, deployment: relation.deployment }
    : null;
}

/** Provider has no endpoint route object: the committed Host attachment is the sole routing authority. */
export function createSelfhostContainerEndpointLifecycle(
  capability: SelfhostContainerEndpointIngressCapability,
) {
  const { runtime, qualification } = capability;
  const answer = async (
    identity: ResourceIdentity,
    relations: readonly ProviderRelation[] | undefined,
    expectedNativeId?: string,
  ): Promise<ProviderTicket> => {
    if (!identity.uid)
      return failed("invalid_spec", "the Container endpoint requires a Resource UID");
    const relation = exactServiceRelation(relations);
    if (!relation)
      return failed("invalid_spec", "the Container endpoint service relation is unavailable");
    const address = await selfhostContainerEndpointAddress(
      { ...identity, uid: identity.uid },
      qualification,
    );
    const nativeId = selfhostContainerEndpointNativeId(identity.uid, address.hostname);
    if (expectedNativeId && expectedNativeId !== nativeId)
      return failed("conflict", "the Container endpoint identity changed");
    const servingGeneration = Number(relation.resource.metadata.generation);
    if (!Number.isSafeInteger(servingGeneration) || servingGeneration < 1)
      return failed("invalid_spec", "the Container service generation is invalid");
    try {
      const observed = await runtime.observe({
        resourceUid: relation.targetUid,
        incarnationId: relation.deployment.id,
      });
      if (
        (observed.state !== "ready" && observed.state !== "updating") ||
        observed.servingGeneration !== servingGeneration
      )
        return failed(
          "unavailable",
          "the Container service is not healthy for this endpoint",
          true,
        );
    } catch {
      return failed("unavailable", "the Container service runtime is unavailable", true);
    }
    return succeeded({
      nativeId,
      observed: { ready: true, serviceUid: relation.targetUid },
      outputs: address,
    });
  };
  return {
    apply(input: ApplyInput): Promise<ProviderTicket> {
      return answer(input.identity, input.relations, input.previous?.nativeId);
    },
    observe(input: {
      readonly identity: ResourceIdentity;
      readonly nativeId: string;
      readonly relations?: readonly ProviderRelation[];
    }): Promise<ProviderTicket> {
      return answer(input.identity, input.relations, input.nativeId);
    },
    async delete(input: {
      readonly identity: ResourceIdentity;
      readonly nativeId: string;
    }): Promise<ProviderTicket> {
      const native = parseSelfhostContainerEndpointNativeId(input.nativeId);
      return native && native.uid === input.identity.uid
        ? succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} })
        : failed("conflict", "the Container endpoint identity changed");
    },
  };
}
