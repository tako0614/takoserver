import { canonicalJson } from "./json.ts";
import type { Provider } from "./provider-port.ts";
import { deriveRuntimeImplementationCatalog } from "./public-worker-implementation.ts";
import {
  isOwnedSelfhostActorPublicRuntime,
  type SelfhostActorPublicRuntime,
} from "./selfhost-actor-public-runtime.ts";
import { SELFHOST_IDENTITY_CAPABILITY_KINDS } from "./selfhost-composition.ts";
import {
  createReleasedCoreFormAuthorityEvidenceVerifier,
  createUnavailableFormAuthorityEvidenceVerifier,
} from "./takoform/form-authority-verification.ts";
import {
  type FormAuthorityActivationPolicy,
  HostAdmissionCoordinatorError,
} from "./takoform/host-admission-coordinator.ts";
import {
  createSelectedFormAuthorityComposition,
  type FormAuthorityComposition,
  type FormAuthorityEndpointBindings,
  type FormAuthorityEndpointConfiguration,
} from "./takoform/host-admission-endpoint.ts";
import {
  selfhostLifecycleCapabilityManifest,
  type TakoformImplementationCatalog,
  type TakoformLifecycleCapabilityManifest,
} from "./takoform/implementation-catalog.ts";
import { loadPublisherSetClosure } from "./takoform/publisher-set-closure.ts";
import type { InstalledTakoformBinding, InstalledTakoformForm } from "./takoform/types.ts";

export interface SelfhostFormAuthoritySource {
  readonly provider: Provider;
  readonly stableForms: readonly InstalledTakoformForm[];
  readonly stableBindings: readonly InstalledTakoformBinding[];
  readonly actorRuntime?: SelfhostActorPublicRuntime;
}

/**
 * Derive the published self-host catalog from the implementation surface.
 * Restored Actor management custody remains useful for retained resources, but
 * it is not an executable Actor ABI registration and cannot widen support.
 */
export async function deriveSelfhostFormAuthorityCatalog(input: {
  readonly implementationPayloadDigest: `sha256:${string}`;
  readonly capabilities: TakoformLifecycleCapabilityManifest;
  readonly source: SelfhostFormAuthoritySource;
}): Promise<TakoformImplementationCatalog> {
  const actorRuntime = input.source.actorRuntime;
  if (
    actorRuntime &&
    (!isOwnedSelfhostActorPublicRuntime(actorRuntime) || !actorRuntime.isRestored())
  ) {
    throw new HostAdmissionCoordinatorError(
      "production_not_ready",
      "self-host Actor owner has not restored",
    );
  }
  const expected = selfhostLifecycleCapabilityManifest(SELFHOST_IDENTITY_CAPABILITY_KINDS);
  if (canonicalJson(expected) !== canonicalJson(input.capabilities)) {
    throw new HostAdmissionCoordinatorError(
      "identity_mismatch",
      "self-host capability manifest differs from composed owner",
    );
  }
  return deriveRuntimeImplementationCatalog({
    capabilities: input.capabilities,
    implementationPayloadDigest: input.implementationPayloadDigest,
    handlerSurface: input.source.provider as unknown as Readonly<Record<string, unknown>>,
  });
}

/** Production self-host path; Hosted/public Worker catalog selection is unchanged. */
export async function createSelfhostProductionFormAuthorityComposition(input: {
  readonly configuration: FormAuthorityEndpointConfiguration;
  readonly bindings: FormAuthorityEndpointBindings;
  readonly source: SelfhostFormAuthoritySource;
  readonly activationPolicy?: FormAuthorityActivationPolicy;
}): Promise<FormAuthorityComposition> {
  const catalog = await deriveSelfhostFormAuthorityCatalog({
    implementationPayloadDigest: input.configuration.implementationPayloadDigest,
    capabilities: input.configuration.capabilities,
    source: input.source,
  });
  const closure = await loadPublisherSetClosure();
  const artifactDigest = input.configuration.coreVerifierArtifactDigest;
  const containers = input.bindings.coreVerifier;
  return createSelectedFormAuthorityComposition(
    {
      configuration: input.configuration,
      bindings: input.bindings,
      ...(input.activationPolicy ? { activationPolicy: input.activationPolicy } : {}),
      verifier:
        artifactDigest && containers
          ? createReleasedCoreFormAuthorityEvidenceVerifier({
              containers,
              containerName: `${input.configuration.environment}:${input.configuration.hostId}`,
              artifactDigest,
            })
          : createUnavailableFormAuthorityEvidenceVerifier(),
      packages: closure.packages,
      packageSet: closure.packageSet,
      expectedEvidence: closure.evidence,
    },
    catalog,
  );
}
