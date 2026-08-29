import { canonicalJson, isSha256Digest } from "../json.ts";
import type { ObjectStore, Sql } from "../ports.ts";
import { TAKOSERVER_INTRINSIC_HANDLER_KINDS } from "../provider-driver.ts";
import { CLOUDFLARE_TAKOFORM_HANDLER_KINDS, CloudflareProvider } from "../providers/cloudflare.ts";
import { isPublicHostIdentity, type PublicHostIdentityRpc } from "../public-host-identity.ts";
import { createFormAdmissionStore } from "./admission-store.ts";
import {
  type CoreAdmissionAdapter,
  createUnavailableCoreAdmissionAdapter,
  createUnavailableSignedTrustEvidenceAdapter,
  type FormAuthorityEnvironment,
  type SignedTrustEvidenceAdapter,
} from "./core-admission-adapter.ts";
import { currentTakoformCandidates } from "./current-candidates.ts";
import { createFormPackageStore, type FormPackageInput } from "./form-packages.ts";
import {
  deriveImplementationCatalog,
  type TakoformHandlerManifest,
  type TakoformImplementationCatalog,
  type TakoformLifecycleCapabilityManifest,
  YURUCOMMU_FORM_VERSIONS,
  yurucommuFormCandidates,
} from "./implementation-catalog.ts";
import {
  createFormAuthorityOperator,
  type FormAuthorityApplyResult,
  type FormAuthorityIdentity,
  type FormAuthorityOperator,
  FormAuthorityOperatorError,
  type FormAuthorityPackageSource,
  type FormAuthorityPlan,
  type FormAuthorityPlanRequest,
  type FormAuthorityReadback,
} from "./operator-authority.ts";
import type { TakoformOperation } from "./types.ts";

const RESOURCE_OPERATION_ORDER = [
  "create",
  "read",
  "update",
  "delete",
  "import",
  "observe",
] as const satisfies readonly TakoformOperation[];

export interface FormAuthorityEndpointConfiguration {
  readonly environment: FormAuthorityEnvironment;
  readonly hostId: string;
  /** Immutable artifact digest of the customer-facing Takoserver Worker. */
  readonly workerArtifactDigest: `sha256:${string}`;
  /** Exact served public Worker Version checked again before every RPC. */
  readonly publicWorkerVersionId: string;
  /** Realized public-Worker capability manifest, supplied by deploy target composition. */
  readonly capabilities: TakoformLifecycleCapabilityManifest;
}

export interface FormAuthorityEndpointBindings {
  readonly sql: Sql;
  readonly objects: ObjectStore;
  readonly publicHostIdentity: PublicHostIdentityRpc;
}

export interface FormAuthorityComposition {
  readonly identity: FormAuthorityIdentity;
  readonly endpoint: FormAuthorityOperatorEndpoint;
}

/** RPC-only composition. It deliberately has no fetch handler or route. */
export class FormAuthorityOperatorEndpoint {
  constructor(
    private readonly operator: FormAuthorityOperator,
    private readonly assertCurrentPublicHost: () => Promise<void>,
  ) {}

  async plan(request: FormAuthorityPlanRequest): Promise<FormAuthorityPlan> {
    await this.assertCurrentPublicHost();
    return await this.operator.plan(request);
  }

  async apply(plan: FormAuthorityPlan): Promise<FormAuthorityApplyResult> {
    await this.assertCurrentPublicHost();
    return await this.operator.apply(plan);
  }

  async readback(request: FormAuthorityPlanRequest): Promise<FormAuthorityReadback> {
    await this.assertCurrentPublicHost();
    return await this.operator.readback(request);
  }
}

/**
 * Production composition is intentionally useful for plan/readback but not
 * apply. Its adapters remain unavailable until released Core admission and
 * signed trust implementations can be injected here.
 */
export async function createProductionFormAuthorityComposition(input: {
  readonly configuration: FormAuthorityEndpointConfiguration;
  readonly bindings: FormAuthorityEndpointBindings;
}): Promise<FormAuthorityComposition> {
  return createComposition({
    ...input,
    core: createUnavailableCoreAdmissionAdapter(),
    trust: createUnavailableSignedTrustEvidenceAdapter(),
    packages: {
      async load(): Promise<never> {
        throw new FormAuthorityOperatorError(
          "package_unavailable",
          "production package source is unavailable without released admission adapters",
        );
      },
    },
  });
}

export async function createFormAuthorityComposition(input: {
  readonly configuration: FormAuthorityEndpointConfiguration;
  readonly bindings: FormAuthorityEndpointBindings;
  readonly core: CoreAdmissionAdapter;
  readonly trust: SignedTrustEvidenceAdapter;
  readonly packages: FormAuthorityPackageSource;
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
        throw new FormAuthorityOperatorError(
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
  readonly core: CoreAdmissionAdapter;
  readonly trust: SignedTrustEvidenceAdapter;
  readonly packages: FormAuthorityPackageSource;
}): Promise<FormAuthorityComposition> {
  const catalog = await deriveRuntimeImplementationCatalog(input.configuration);
  const identity = formAuthorityIdentity(input.configuration, catalog);
  const assertCurrentPublicHost = async (): Promise<void> => {
    const live = await input.bindings.publicHostIdentity.identity();
    if (
      !isPublicHostIdentity(live) ||
      live.hostId !== identity.hostId ||
      live.workerVersionId !== identity.publicWorkerVersionId
    ) {
      throw new FormAuthorityOperatorError(
        "identity_mismatch",
        "served public Host identity differs from this Form authority Worker",
      );
    }
  };
  const storedPackages = createFormPackageStore(input.bindings.objects);
  const admission = createFormAdmissionStore({
    sql: input.bindings.sql,
    packages: storedPackages,
    handles: input.core.handles,
  });
  return {
    identity,
    endpoint: new FormAuthorityOperatorEndpoint(
      createFormAuthorityOperator({
        identity,
        catalog,
        packages: input.packages,
        storedPackages,
        admission,
        core: input.core,
        trust: input.trust,
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
  const catalog = await deriveRuntimeImplementationCatalog(configuration);
  return formAuthorityIdentity(configuration, catalog);
}

async function deriveRuntimeImplementationCatalog(
  configuration: FormAuthorityEndpointConfiguration,
): Promise<TakoformImplementationCatalog> {
  validateConfiguration(configuration);
  const forms = yurucommuFormCandidates(currentTakoformCandidates().forms);
  const providerOperations = providerResourceOperationHandlers(
    CloudflareProvider.prototype as unknown as Readonly<Record<string, unknown>>,
  );
  const intrinsicKinds = new Set<string>(TAKOSERVER_INTRINSIC_HANDLER_KINDS);
  const cloudflareKinds = new Set<string>(CLOUDFLARE_TAKOFORM_HANDLER_KINDS);
  const handlerForms = Object.fromEntries(
    forms.map(({ identity }) => [
      identity.formRef.kind,
      intrinsicKinds.has(identity.formRef.kind)
        ? RESOURCE_OPERATION_ORDER
        : cloudflareKinds.has(identity.formRef.kind)
          ? providerOperations
          : [],
    ]),
  );
  const handlers: TakoformHandlerManifest = {
    apiVersion: "takoserver.form-handlers@v1",
    artifact: configuration.workerArtifactDigest,
    forms: handlerForms,
  };
  return await deriveImplementationCatalog({
    forms,
    capabilities: configuration.capabilities,
    handlers,
  });
}

function formAuthorityIdentity(
  configuration: FormAuthorityEndpointConfiguration,
  catalog: TakoformImplementationCatalog,
): FormAuthorityIdentity {
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
    typeof configuration.publicWorkerVersionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      configuration.publicWorkerVersionId,
    )
  ) {
    throw new TypeError("Form authority Worker configuration is invalid");
  }
  validateCapabilityManifest(configuration.capabilities);
}

export function parseFormAuthorityCapabilityManifest(
  value: string,
): TakoformLifecycleCapabilityManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("Form authority capability manifest is invalid");
  }
  validateCapabilityManifest(parsed);
  return structuredClone(parsed as TakoformLifecycleCapabilityManifest);
}

function validateCapabilityManifest(value: unknown): void {
  if (!isRecord(value)) throw new TypeError("Form authority capability manifest is invalid");
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "apiVersion" ||
    keys[1] !== "forms" ||
    keys[2] !== "implementation" ||
    value.apiVersion !== "takoserver.form-lifecycle-capabilities@v1" ||
    typeof value.implementation !== "string" ||
    value.implementation.length < 1 ||
    value.implementation.length > 255 ||
    !isRecord(value.forms)
  ) {
    throw new TypeError("Form authority capability manifest is invalid");
  }
  for (const [kind, operations] of Object.entries(value.forms)) {
    if (
      !(kind in YURUCOMMU_FORM_VERSIONS) ||
      !Array.isArray(operations) ||
      operations.some((operation) => !RESOURCE_OPERATION_ORDER.includes(operation)) ||
      new Set(operations).size !== operations.length
    ) {
      throw new TypeError("Form authority capability manifest is invalid");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Derives provider-backed operations from concrete runtime method presence. */
export function providerResourceOperationHandlers(
  surface: Readonly<Record<string, unknown>>,
): readonly TakoformOperation[] {
  const has = (method: string): boolean => typeof surface[method] === "function";
  return RESOURCE_OPERATION_ORDER.filter((operation) => {
    switch (operation) {
      case "create":
      case "update":
        return has("apply");
      case "read":
        return true;
      case "delete":
        return has("delete");
      case "import":
        return has("adopt");
      case "observe":
        return has("observe");
    }
    return false;
  });
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
        throw new FormAuthorityOperatorError(
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
