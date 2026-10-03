import { canonicalJson } from "./json.ts";
import type { Provider } from "./provider-port.ts";
import {
  CLOUDFLARE_TAKOFORM_HANDLER_KINDS,
  TAKOSERVER_INTRINSIC_HANDLER_KINDS,
} from "./public-form-runtime.ts";
import {
  deriveRuntimeImplementationCatalog,
  providerResourceOperationHandlers,
} from "./public-worker-implementation.ts";
import {
  isOwnedSelfhostActorPublicRuntime,
  type SelfhostActorPublicRuntime,
} from "./selfhost-actor-public-runtime.ts";
import {
  hasExactSelfhostActorClosure,
  SELFHOST_IDENTITY_CAPABILITY_KINDS,
} from "./selfhost-composition.ts";
import { currentTakoformCandidates } from "./takoform/current-candidates.ts";
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
  deriveImplementationCatalog,
  exactPublisherFormCandidates,
  selfhostLifecycleCapabilityManifest,
  type TakoformImplementationCatalog,
  type TakoformLifecycleCapabilityManifest,
} from "./takoform/implementation-catalog.ts";
import { loadPublisherSetClosure } from "./takoform/publisher-set-closure.ts";
import type {
  InstalledTakoformBinding,
  InstalledTakoformForm,
  TakoformOperation,
} from "./takoform/types.ts";

export interface SelfhostFormAuthoritySource {
  readonly provider: Provider;
  readonly stableForms: readonly InstalledTakoformForm[];
  readonly stableBindings: readonly InstalledTakoformBinding[];
  readonly actorRuntime?: SelfhostActorPublicRuntime;
}

/**
 * Derive the self-host catalog from the same composed native owner and exact
 * released closure used by serving. An Actor-shaped manifest or an arbitrary
 * handler surface is not authority to widen support.
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
  const actor = actorRuntime
    ? input.source.stableForms.find((form) => form.identity.formRef.kind === "ActorNamespace")
    : undefined;
  if (actorRuntime && (!actor || !hasExactSelfhostActorClosure(input.source))) {
    throw new HostAdmissionCoordinatorError(
      "production_not_ready",
      "exact self-host Actor closure unavailable",
    );
  }
  const expected = selfhostLifecycleCapabilityManifest(SELFHOST_IDENTITY_CAPABILITY_KINDS, actor);
  if (canonicalJson(expected) !== canonicalJson(input.capabilities)) {
    throw new HostAdmissionCoordinatorError(
      "identity_mismatch",
      "self-host capability manifest differs from composed owner",
    );
  }
  if (!actorRuntime) {
    return deriveRuntimeImplementationCatalog({
      implementationPayloadDigest: input.implementationPayloadDigest,
      capabilities: input.capabilities,
      handlerSurface: input.source.provider as unknown as Readonly<Record<string, unknown>>,
    });
  }
  const actorOffering = input.source.provider.offerings.filter(
    (offering) =>
      canonicalJson(offering.form) === canonicalJson(actor?.identity.formRef) &&
      offering.id === "compute.actor.stable-v1.standard",
  );
  const providerOperations = providerResourceOperationHandlers(
    input.source.provider as unknown as Readonly<Record<string, unknown>>,
  );
  const actorOperations = providerOperations.filter(
    (operation) => operation === "read" || actorOffering[0]?.capabilities.includes(operation),
  );
  if (
    actorOffering.length !== 1 ||
    actorOperations.join(",") !== "create,read,delete,import,observe"
  ) {
    throw new HostAdmissionCoordinatorError(
      "production_not_ready",
      "self-host Actor Provider capability unavailable",
    );
  }
  const forms = exactPublisherFormCandidates(currentTakoformCandidates().forms);
  const intrinsic = new Set<string>(TAKOSERVER_INTRINSIC_HANDLER_KINDS);
  const providerKinds = new Set<string>(CLOUDFLARE_TAKOFORM_HANDLER_KINDS);
  return deriveImplementationCatalog({
    forms,
    capabilities: input.capabilities,
    handlers: {
      apiVersion: "takoserver.form-handlers@v1",
      artifact: input.implementationPayloadDigest,
      forms: Object.fromEntries(
        forms
          .filter((form) => Object.hasOwn(input.capabilities.forms, form.identity.formRef.kind))
          .map((form) => {
            const kind = form.identity.formRef.kind;
            const operations: readonly TakoformOperation[] =
              kind === "ActorNamespace"
                ? actorOperations
                : intrinsic.has(kind)
                  ? ["create", "read", "update", "delete", "import", "observe"]
                  : providerKinds.has(kind)
                    ? providerOperations
                    : [];
            return [kind, operations];
          }),
      ),
    },
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
