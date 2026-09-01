import { canonicalJson, isSha256Digest } from "../json.ts";
import type { ObjectStore, Sql } from "../ports.ts";
import { isPublicHostIdentity, type PublicHostIdentityRpc } from "../public-host-identity.ts";
import {
  deriveRuntimeImplementationCatalog,
  parseFormAuthorityCapabilityManifest,
  providerResourceOperationHandlers,
} from "../public-worker-implementation.ts";
import { createAdmissionHandleIssuer } from "./admission.ts";
import { createFormAdmissionStore } from "./admission-store.ts";
import {
  createReleasedCoreFormAuthorityEvidenceVerifier,
  createUnavailableFormAuthorityEvidenceVerifier,
  type FormAuthorityEnvironment,
  type FormAuthorityEvidenceVerifier,
  type FormAuthorityVerificationEvidence,
  type TakoformCoreVerifierContainerNamespace,
} from "./form-authority-verification.ts";
import { createFormPackageStore, type FormPackageInput } from "./form-packages.ts";
import {
  createHostAdmissionCoordinator,
  type FormAuthorityApplyResult,
  type FormAuthorityIdentity,
  type FormAuthorityPackageIdentity,
  type FormAuthorityPackageSource,
  type FormAuthorityPlan,
  type FormAuthorityPlanRequest,
  type FormAuthorityReadback,
  type HostAdmissionCoordinator,
  HostAdmissionCoordinatorError,
} from "./host-admission-coordinator.ts";
import type {
  TakoformImplementationCatalog,
  TakoformLifecycleCapabilityManifest,
} from "./implementation-catalog.ts";
import { loadPublisherSetClosure } from "./publisher-set-closure.ts";

export { parseFormAuthorityCapabilityManifest, providerResourceOperationHandlers };

export interface FormAuthorityEndpointConfiguration {
  readonly environment: FormAuthorityEnvironment;
  readonly hostId: string;
  /** Immutable artifact digest of the customer-facing Takoserver Worker. */
  readonly workerArtifactDigest: `sha256:${string}`;
  /** Exact served public Worker Version checked again before every RPC. */
  readonly publicWorkerVersionId: string;
  /** Digest of the separately sealed handler/provider payload. */
  readonly implementationPayloadDigest: `sha256:${string}`;
  /** Build-derived semantic identity returned by the public identity RPC. */
  readonly implementationDigest: `sha256:${string}`;
  /** Code-owned capability manifest embedded into the public Worker build. */
  readonly capabilities: TakoformLifecycleCapabilityManifest;
  /** Exact Container artifact identity required on every released-Core response. */
  readonly coreVerifierArtifactDigest?: `sha256:${string}`;
}

export interface FormAuthorityEndpointBindings {
  readonly sql: Sql;
  readonly objects: ObjectStore;
  readonly publicHostIdentity: PublicHostIdentityRpc;
  readonly coreVerifier?: TakoformCoreVerifierContainerNamespace;
}

export interface FormAuthorityComposition {
  readonly identity: FormAuthorityIdentity;
  readonly endpoint: HostAdmissionEndpoint;
}

/** RPC-only composition. It deliberately has no fetch handler or route. */
export class HostAdmissionEndpoint {
  constructor(
    private readonly coordinator: HostAdmissionCoordinator,
    private readonly assertCurrentPublicHost: () => Promise<void>,
  ) {}

  async plan(request: FormAuthorityPlanRequest): Promise<FormAuthorityPlan> {
    await this.assertCurrentPublicHost();
    return await this.coordinator.plan(request);
  }

  async apply(plan: FormAuthorityPlan): Promise<FormAuthorityApplyResult> {
    await this.assertCurrentPublicHost();
    return await this.coordinator.apply(plan);
  }

  async readback(request: FormAuthorityPlanRequest): Promise<FormAuthorityReadback> {
    await this.assertCurrentPublicHost();
    return await this.coordinator.readback(request);
  }
}

/**
 * Production binds the embedded exact publisher-set closure as the package
 * set, the package source and the required request evidence, then verifies the
 * raw closure through the released-Core route-less Container before any
 * durable mutation. Host policy remains in this composition and no serialized
 * Core report can mint an admission handle. Without a Container binding the
 * verifier is unavailable and apply fails closed.
 */
export async function createProductionFormAuthorityComposition(input: {
  readonly configuration: FormAuthorityEndpointConfiguration;
  readonly bindings: FormAuthorityEndpointBindings;
}): Promise<FormAuthorityComposition> {
  const closure = await loadPublisherSetClosure();
  const artifactDigest = input.configuration.coreVerifierArtifactDigest;
  const containers = input.bindings.coreVerifier;
  return createComposition({
    ...input,
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
  });
}

export async function createFormAuthorityComposition(input: {
  readonly configuration: FormAuthorityEndpointConfiguration;
  readonly bindings: FormAuthorityEndpointBindings;
  readonly verifier: FormAuthorityEvidenceVerifier;
  readonly packages: FormAuthorityPackageSource;
  readonly packageSet?: readonly FormAuthorityPackageIdentity[];
  readonly expectedEvidence?: FormAuthorityVerificationEvidence;
}): Promise<FormAuthorityComposition> {
  return createComposition(input);
}

export function createExactFormPackageSource(
  packages: readonly FormPackageInput[],
): FormAuthorityPackageSource {
  const exact = new Map(
    packages.map((pkg) => [`${canonicalJson(pkg.formRef)}\0${pkg.packageDigest}`, pkg]),
  );
  if (packages.length === 0 || exact.size !== packages.length) {
    throw new TypeError("Form authority package source must be exact and unique");
  }
  return {
    async load({ formRef, packageDigest }): Promise<FormPackageInput> {
      const pkg = exact.get(`${canonicalJson(formRef)}\0${packageDigest}`);
      if (!pkg) {
        throw new HostAdmissionCoordinatorError(
          "package_unavailable",
          "exact Form authority package is unavailable",
        );
      }
      return clonePackage(pkg);
    },
  };
}

async function createComposition(input: {
  readonly configuration: FormAuthorityEndpointConfiguration;
  readonly bindings: FormAuthorityEndpointBindings;
  readonly verifier: FormAuthorityEvidenceVerifier;
  readonly packages: FormAuthorityPackageSource;
  readonly packageSet?: readonly FormAuthorityPackageIdentity[];
  readonly expectedEvidence?: FormAuthorityVerificationEvidence;
}): Promise<FormAuthorityComposition> {
  const catalog = await deriveRuntimeImplementationCatalog({
    implementationPayloadDigest: input.configuration.implementationPayloadDigest,
    capabilities: input.configuration.capabilities,
  });
  if (catalog.implementationDigest !== input.configuration.implementationDigest) {
    throw new HostAdmissionCoordinatorError(
      "identity_mismatch",
      "implementation catalog differs from the build-derived public identity",
    );
  }
  const identity = formAuthorityIdentity(input.configuration, catalog);
  const assertCurrentPublicHost = async (): Promise<void> => {
    const live = await input.bindings.publicHostIdentity.identity();
    if (
      !isPublicHostIdentity(live) ||
      live.hostId !== identity.hostId ||
      live.workerVersionId !== identity.publicWorkerVersionId ||
      live.workerArtifactDigest !== identity.workerArtifactDigest ||
      live.implementationPayloadDigest !== input.configuration.implementationPayloadDigest ||
      live.capabilityDigest !== catalog.capabilityDigest ||
      live.implementationDigest !== identity.implementationDigest
    ) {
      throw new HostAdmissionCoordinatorError(
        "identity_mismatch",
        "served public Host identity differs from this Form authority Worker",
      );
    }
  };
  const storedPackages = createFormPackageStore(input.bindings.objects);
  const handles = createAdmissionHandleIssuer();
  const admission = createFormAdmissionStore({
    sql: input.bindings.sql,
    packages: storedPackages,
    handles,
  });
  return {
    identity,
    endpoint: new HostAdmissionEndpoint(
      createHostAdmissionCoordinator({
        identity,
        catalog,
        ...(input.packageSet === undefined ? {} : { packageSet: input.packageSet }),
        ...(input.expectedEvidence === undefined
          ? {}
          : { expectedEvidence: input.expectedEvidence }),
        packages: input.packages,
        storedPackages,
        admission,
        handles,
        verifier: input.verifier,
        assertMutationAuthority: assertCurrentPublicHost,
      }),
      assertCurrentPublicHost,
    ),
  };
}

/** Derives the exact identity sealed into operator requests without touching D1/R2. */
export async function deriveFormAuthorityIdentity(
  configuration: FormAuthorityEndpointConfiguration,
): Promise<FormAuthorityIdentity> {
  const catalog = await deriveRuntimeImplementationCatalog({
    implementationPayloadDigest: configuration.implementationPayloadDigest,
    capabilities: configuration.capabilities,
  });
  if (catalog.implementationDigest !== configuration.implementationDigest) {
    throw new HostAdmissionCoordinatorError(
      "identity_mismatch",
      "implementation catalog differs from the build-derived public identity",
    );
  }
  return formAuthorityIdentity(configuration, catalog);
}

function formAuthorityIdentity(
  configuration: FormAuthorityEndpointConfiguration,
  catalog: TakoformImplementationCatalog,
): FormAuthorityIdentity {
  validateConfiguration(configuration);
  return {
    environment: configuration.environment,
    hostId: configuration.hostId,
    workerArtifactDigest: configuration.workerArtifactDigest,
    publicWorkerVersionId: configuration.publicWorkerVersionId,
    capabilityDigest: catalog.capabilityDigest,
    implementationDigest: catalog.implementationDigest,
  };
}

function validateConfiguration(configuration: FormAuthorityEndpointConfiguration): void {
  if (
    !configuration ||
    !["integration", "rehearsal", "production"].includes(configuration.environment) ||
    typeof configuration.hostId !== "string" ||
    configuration.hostId.length === 0 ||
    configuration.hostId.length > 255 ||
    !isSha256Digest(configuration.workerArtifactDigest) ||
    !isSha256Digest(configuration.implementationPayloadDigest) ||
    !isSha256Digest(configuration.implementationDigest) ||
    (configuration.coreVerifierArtifactDigest !== undefined &&
      !isSha256Digest(configuration.coreVerifierArtifactDigest)) ||
    typeof configuration.publicWorkerVersionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      configuration.publicWorkerVersionId,
    )
  ) {
    throw new TypeError("Form authority Worker configuration is invalid");
  }
  parseFormAuthorityCapabilityManifest(JSON.stringify(configuration.capabilities));
}

function clonePackage(pkg: FormPackageInput): FormPackageInput {
  return {
    packageDigest: pkg.packageDigest,
    formRef: structuredClone(pkg.formRef),
    ...(pkg.manifest === undefined ? {} : { manifest: structuredClone(pkg.manifest) }),
    ...(pkg.retentionRef === undefined ? {} : { retentionRef: pkg.retentionRef }),
    ...(pkg.retentionUntil === undefined ? {} : { retentionUntil: pkg.retentionUntil }),
    files: pkg.files.map((file) => {
      if (!(file.bytes instanceof Uint8Array) && !(file.bytes instanceof ArrayBuffer)) {
        throw new HostAdmissionCoordinatorError(
          "package_unavailable",
          "embedded Form authority package source must be bounded in memory",
        );
      }
      const bytes =
        file.bytes instanceof Uint8Array ? new Uint8Array(file.bytes) : file.bytes.slice(0);
      return {
        path: file.path,
        bytes,
        ...(file.digest === undefined ? {} : { digest: file.digest }),
        ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
      };
    }),
  };
}
