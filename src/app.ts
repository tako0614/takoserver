import type { AiGateway } from "./ai-port.ts";
import {
  type ArtifactConsumerProviderReader,
  createArtifactConsumerRepair,
} from "./artifact-consumer-repair.ts";
import { createAttachmentService, createAttachmentStore } from "./attachments.ts";
import {
  createAccounts,
  createApiKeyAdministration,
  createSingleUseCredentials,
  type ExternalIdentityVerifier,
  grants,
  type IdentityProviderDescriptor,
} from "./auth.ts";
import type { BillingConfig } from "./billing-config.ts";
import { createCatalog, type Offering } from "./catalog.ts";
import { CONTAINER_CONTRACT } from "./container-contract.ts";
import { type Checkout, createControlRoutes } from "./control.ts";
import { createDataAiRoutes } from "./data-ai.ts";
import {
  assertHostedBillingComposition,
  type HostedBillingComposition,
  type HostedBillingStatus,
} from "./hosted-billing-composition.ts";
import {
  createIntegrationE2eCredentialAuthority,
  type IntegrationE2eCredentialAuthorityConfig,
  resolveIntegrationE2eCredentialAuthorityConfig,
} from "./integration-e2e-credential-authority.ts";
import {
  createIntegrationOrganizationBootstrap,
  type IntegrationOrganizationBootstrapConfig,
  resolveIntegrationOrganizationBootstrapConfig,
} from "./integration-organization-bootstrap.ts";
import {
  createLedger,
  type FundingSettlementVerifier,
  stripeRefundSource,
  type UsageWarningPreparer,
} from "./ledger.ts";
import { createMetering, type MeteringRates } from "./metering.ts";
import type { OperatorPaymentsReconcileVerifier } from "./operator-credentials.ts";
import { createOrgBilling, type OrgBilling } from "./org-billing.ts";
import { orgUsageSummaryReadStatement } from "./org-usage-summary.ts";
import {
  createFundingCredit,
  type FundingReconcileReport,
  type PaymentEventContext,
  type PaymentEvents,
} from "./payment-events.ts";
import type { Clock, ObjectStoreAccess, Sql } from "./ports.ts";
import { createProviderDriver, createProviderFormAvailability } from "./provider-driver.ts";
import { createProviderMetering } from "./provider-metering.ts";
import type { ProviderPack } from "./provider-pack.ts";
import type { Provider } from "./provider-port.ts";
import { createReseller } from "./reseller.ts";
import type { ResourceDeploymentStore } from "./resource-deployments.ts";
import { createResourceDeploymentStore } from "./resource-deployments.ts";
import {
  createResourceMigrationService,
  createResourceMigrationStore,
} from "./resource-migrations.ts";
import { createRouter, type Router } from "./router.ts";
import type { RuntimeInputAuthority } from "./runtime-input-preparations.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "./shared-auth-oidc-client.ts";
import {
  type ArtifactReconcileReport,
  type ArtifactReconciler,
  createTakoformArtifactReconciler,
} from "./takoform/artifact-reconciler.ts";
import { createTakoformArtifacts, type TakoformArtifactTransport } from "./takoform/artifacts.ts";
import { installedBindings } from "./takoform/bindings.ts";
import { createTakoformEngine } from "./takoform/engine.ts";
import { installedForms, sameFormRef } from "./takoform/forms.ts";
import { type CreateTakoformHostOptions, createTakoformHost } from "./takoform/host.ts";
import {
  createTakoformHostAuthority,
  type TakoformHostAuthority,
} from "./takoform/host-authority.ts";
import { createDeferredOperations } from "./takoform/operations.ts";
import { createTakoformRoutes, DEFAULT_TAKOFORM_ROUTES } from "./takoform/routes.ts";
import type { TakoformStore } from "./takoform/store.ts";
import { createTakoformStore } from "./takoform/store.ts";
import type {
  InstalledTakoformBinding,
  InstalledTakoformForm,
  TakoformFormAvailabilityResolver,
  TakoformHost,
  TakoformHostResourceScope,
  TakoformResourceDriver,
  TakoformStandardServiceResolver,
} from "./takoform/types.ts";
import { TakoformHostError } from "./takoform/types.ts";
import {
  createTakoformV2Application,
  type V2OperatorArtifactSourceFactory,
  type V2OperatorFormFactory,
  type V2OperatorFormSelectionFactory,
} from "./takoform-v2/application.ts";
import type { V2ApplicationConfig } from "./takoform-v2/config.ts";
import type {
  V2HostAcceptance,
  V2HostAcceptanceContext,
  V2HostAcceptanceScope,
  V2HostDeleteAcceptanceContext,
} from "./takoform-v2/host-acceptance.ts";
import type { V2PrivateInputCustody } from "./takoform-v2/private-inputs.ts";
import type { V2Operation } from "./takoform-v2/types.ts";
import { tenantRunPrincipalId } from "./tenant-run-principal.ts";
import {
  createTokenService,
  type SigningKey,
  type TakoformTenantRunTokenClaims,
  type TenantRunCredentialAdmission,
  type TenantRunCredentialIssuance,
  TokenError,
} from "./token.ts";
import {
  assertSharedOriginCarrier,
  createWorkerEndpointOriginReservations,
  type WorkerEndpointOriginReservations,
} from "./worker-endpoint-origin-reservations.ts";
import {
  createWorkerEndpointOriginV2Acceptance,
  createWorkerEndpointOriginV2FormRouteAcceptance,
} from "./worker-endpoint-origin-v2-acceptance.ts";
import {
  createWorkerRequestConsumers,
  readWorkerRequestConsumers,
  readWorkerRequestFinancialInputs,
  type WorkerRequestAppInputs,
  type WorkerRequestConsumers,
} from "./worker-request-composition.ts";

/**
 * The composition root.
 *
 * This is the only module that knows which concrete pieces the product is made
 * of. Everything below it receives ports; everything above it is an entry that
 * supplies storage and calls `fetch`. Keeping assembly in one place is what
 * lets the same code serve a Cloudflare Worker and a self-hosted server without
 * either of them leaking into the other.
 */

export interface AppPorts {
  /** Entry-owned fresh primary request composition; absent preserves ordinary construction. */
  readonly workerRequest?: WorkerRequestAppInputs & {
    /** Original graph opt-in; matching objects and alternate construction inputs are refused. */
    readonly originalConsumers?: WorkerRequestConsumers;
  };
  /** The exact inventory/deployment stores precomposed for native startup. */
  readonly resourceStores?: AppResourceStoreBundle;
  /** Host-only optional data-plane factory, built against these same canonical ledgers. */
  readonly selfhostEndpointIngressFactory?: (context: {
    readonly store: TakoformStore;
    readonly deployments: ResourceDeploymentStore;
  }) => (request: Request) => Promise<Response | null>;
  readonly sql: Sql;
  readonly objects: ObjectStoreAccess;
  readonly identity: ExternalIdentityVerifier;
  readonly settlement: FundingSettlementVerifier;
  /** Frozen operator tariff; absent keeps the Organization billing API disabled. */
  readonly billingConfig?: BillingConfig;
  /** Set only by an entry with validated Hosted pricing and Stripe schema. */
  readonly hostedPaidFreeExclusion?: boolean;
  /** Prequalified local Hosted wallet policy; its missing payment authority is explicit. */
  readonly hostedBilling?: HostedBillingComposition;
  /** Starts a payment, where this deployment can take one. */
  readonly checkout?: Checkout | undefined;
  /**
   * Payments learned without the payer returning: the processor's webhook and
   * the reconcile pass. Built here because only this composition owns the
   * ledger and the organizations they credit.
   */
  readonly paymentEvents?: ((context: PaymentEventContext) => PaymentEvents) | undefined;
  /**
   * Verifies the operator's single-use request to run the reconcile pass now.
   * The route is served only together with `paymentEvents`; either absent, it
   * is not served.
   */
  readonly operatorPaymentsReconcile?: OperatorPaymentsReconcileVerifier | undefined;
  /**
   * Lets concurrent callers join one in-flight reconcile pass. Only a
   * long-lived process whose pending I/O outlives the request that started it
   * may set this (the Bun Host). A Worker leaves it unset, so no invocation
   * ever awaits I/O begun in another request's context.
   */
  readonly shareReconcilePass?: boolean | undefined;
  /** What data costs here. Absent means measured and not charged. */
  readonly meteringRates?: MeteringRates | undefined;
  /** OpenAI-compatible inference backend. Absent keeps the AI route unavailable. */
  readonly ai?: AiGateway;
  readonly publicOrigin: string;
  /** Required, explicit v2 wire identity and supported Form composition. */
  readonly v2: V2ApplicationConfig;
  /** Code-selected complete and retained-only v2 backends on one Host authority. */
  readonly v2FormFactory?: V2OperatorFormFactory;
  /** Code-selected full and retained-only maps; exclusive with v2FormFactory. */
  readonly v2FormSelectionFactory?: V2OperatorFormSelectionFactory;
  /** Code-only fixed staging/direct-Organization compiler selection; omission retains scalar. */
  readonly v2WorkerEndpointOrigin?:
    | (Omit<Parameters<typeof createWorkerEndpointOriginV2Acceptance>[0], "sql"> & {
        readonly kind?: undefined;
      })
    | (Omit<Parameters<typeof createWorkerEndpointOriginV2FormRouteAcceptance>[0], "sql"> & {
        readonly kind: "form-v2@1";
      });
  /** Trusted operator-code Container issuer, bound to this exact Sql before construction. */
  readonly v2ContainerHostAcceptance?: V2HostAcceptance;
  /** Code-selected fresh CREATE/UPDATE policy; absent preserves normal admission. */
  readonly v2AllowFreshCreateAndUpdate?: boolean;
  /** Code-selected source for configured v2 artifact Forms; absent remains held-only. */
  readonly v2ArtifactSourceFactory?: V2OperatorArtifactSourceFactory;
  /** Explicit operator-private v2 keyring; absent disables privateInputs. */
  readonly v2PrivateInputCustody?: V2PrivateInputCustody;
  /** Current Cloudflare Worker Version, retained only as operation and audit provenance. */
  readonly publicWorkerVersionId?: string;
  /** Current semantic Form implementation identity. */
  readonly formImplementationDigest?: `sha256:${string}`;
  /** Complete integration-only JIT key authority configuration, or no route. */
  readonly integrationE2eCredentialAuthority?: IntegrationE2eCredentialAuthorityConfig;
  /** Existing-key, integration-only fixed organization bootstrap, or no route. */
  readonly integrationOrganizationBootstrap?: IntegrationOrganizationBootstrapConfig;
  /** One Host-owned service shared by control, provider, and scheduled lifecycle cleanup. */
  readonly runtimeInputs?: RuntimeInputAuthority;
  /** Optional precomposed authority used to close the runtime-input/provider assembly cycle. */
  readonly originReservations?: WorkerEndpointOriginReservations;
  /** Where this deployment's console is served, if it has one. */
  readonly consoleOrigin?: string;
  readonly forms: readonly InstalledTakoformForm[];
  /** Exact portable BindingDefinitions installed by this Host composition. */
  readonly bindings?: readonly InstalledTakoformBinding[];
  /** Literal stable-v1 public Host catalog, distinct from historical product/provider Forms. */
  readonly hostForms: readonly InstalledTakoformForm[];
  readonly hostBindings?: readonly InstalledTakoformBinding[];
  /** Host-owned exact stable standard-service integrations. */
  readonly standardServiceResolver?: TakoformStandardServiceResolver;
  /** How a caller may sign in to this deployment. */
  readonly identityProviders?: readonly IdentityProviderDescriptor[];
  /**
   * Backends this deployment can provision on. When present the Takoform lane
   * is driven by them and applies are billed; `driver` then only serves as an
   * explicit override for tests about the Host itself.
   */
  readonly providers?: readonly Provider[];
  /** Capability bundles used for attachments and explicit cross-provider migration. */
  readonly providerPacks?: readonly ProviderPack[];
  readonly driver?: TakoformResourceDriver;
  /** Explicit lifecycle readback override for tests and non-default compositions. */
  readonly artifactConsumerProvider?: ArtifactConsumerProviderReader;
  /** Explicit Host availability policy; production derives one from its provider composition. */
  readonly availability?: TakoformFormAvailabilityResolver;
  /** Explicit authority override for conformance tests; production derives D1/R2 authority here. */
  readonly hostAuthority?: TakoformHostAuthority;
  readonly offerings: readonly Offering[];
  readonly signingKey?: SigningKey;
  /**
   * Host-specific authority factory. Only the Bun entry supplies it; the
   * public Worker graph retains sponsorship-ledger admission and no signer.
   */
  readonly selfhostTenantRunCredentialAuthority?: (
    originReservations: Pick<WorkerEndpointOriginReservations, "read">,
  ) => TenantRunCredentialAdmission & TenantRunCredentialIssuance;
  /** Shared with a provider that publishes committed bundles. */
  readonly artifacts?: TakoformArtifactTransport;
  /**
   * Replaces the Takoform Host entirely. Used by conformance tests that need to
   * drive the lane with their own authentication; production never sets it.
   */
  readonly takoformHost?: TakoformHost;
  /** Explicit assembly seam for tests; production entries never provide it. */
  readonly takoformHostFactory?: (
    options: Omit<CreateTakoformHostOptions, "authority">,
  ) => TakoformHost;
  /** Test-only observer of the exact legacy Host selected for private repair. Never routed. */
  readonly captureLegacyHostForTests?: (host: TakoformHost) => void;
  readonly clock?: Clock;
  readonly randomId?: () => string;
}

export interface AppResourceStoreBundle {
  readonly inventory: TakoformStore;
  readonly deployments: ResourceDeploymentStore;
}

const resourceStoreOrigins = new WeakMap<AppResourceStoreBundle, { sql: Sql; clock: Clock }>();

/** Constructs the one canonical resource ledger pair for an entry and this app. */
export function createAppResourceStoreBundle(sql: Sql, clock: Clock): AppResourceStoreBundle {
  const bundle = Object.freeze({
    inventory: createTakoformStore(sql, clock),
    deployments: createResourceDeploymentStore(sql, clock),
  });
  resourceStoreOrigins.set(bundle, { sql, clock });
  return bundle;
}

export interface App {
  readonly fetch: Router;
  /** Optional lifecycle service for the Organization wallet and usage receipts. */
  readonly orgBilling?: OrgBilling;
  /** Startup callers must surface this declared degradation before offering payments. */
  readonly hostedBilling?: HostedBillingStatus;
  /** Typed operator seam; no maintenance route is mounted on public HTTP. */
  readonly maintenance: {
    readonly artifacts: ArtifactReconciler;
    /** Bounded outbox dispatch; an unavailable transport refuses before claiming delivery. */
    readonly billingWarnings?: Pick<HostedBillingComposition, "dispatchWarnings">;
  };
  /** One pass of background settlement. Safe to call concurrently. */
  tick(): Promise<TickReport>;
  /** Independently scheduled v2 executor; one Operation at most per call. */
  tickTakoformV2(): Promise<V2Operation | null>;
  /**
   * Credits recently settled payments nobody presented; null where payment is
   * off. With `shareReconcilePass`, a concurrent caller joins the pass in flight.
   */
  reconcilePayments(): Promise<FundingReconcileReport | null>;
}

export interface TickReport {
  readonly expiredReservations: number;
  readonly expiredWalletHolds: number;
  readonly expiredRuntimeInputPreparations: number;
  /**
   * Declarations pointing at a Form this deployment no longer installs. Any
   * number above zero means somebody's resource is unmanageable, so it is
   * surfaced rather than left to be met one 404 at a time.
   */
  readonly orphanedResources: readonly string[];
  /** Usage rows folded into ledger entries this tick. */
  readonly meteredRows: number;
  /** Provider observation windows made durable before this tick's rollup. */
  readonly providerMeterWindows: number;
  /** Deployment ids whose upstream usage could not be settled this pass. */
  readonly providerMeterFailures: readonly string[];
  /** Bounded SQL-only repair; external artifact deletion is always operator-explicit. */
  readonly artifactMaintenance: ArtifactReconcileReport;
  /** Dispatched Host provider commands automatically resumed under exact leases. */
  readonly providerRepairs: {
    readonly candidates: number;
    readonly acquired: number;
    readonly settled: number;
    readonly pending: number;
  };
}

function captureContainerHostAcceptance(
  value: V2HostAcceptance | undefined,
  sql: Sql,
): V2HostAcceptance | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null)
    throw new TypeError("invalid internal Container Host acceptance construction");
  const ownMethod = (name: "assertSql" | "initialOutput" | "prepare" | "prepareDelete") => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "function"
    )
      throw new TypeError(`Container Host acceptance requires own ${name} method`);
    return descriptor.value.bind(value);
  };
  const assertSql = ownMethod("assertSql") as V2HostAcceptance["assertSql"];
  const initialOutput = ownMethod("initialOutput") as V2HostAcceptance["initialOutput"];
  const prepare = ownMethod("prepare") as V2HostAcceptance["prepare"];
  const prepareDelete = ownMethod("prepareDelete") as NonNullable<
    V2HostAcceptance["prepareDelete"]
  >;
  assertSql(sql);
  return Object.freeze({ assertSql, initialOutput, prepare, prepareDelete });
}

function composeV2HostAcceptances(
  container: V2HostAcceptance | undefined,
  endpoint: V2HostAcceptance | undefined,
): V2HostAcceptance {
  const attempt = <T>(
    read: () => T,
  ): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown } => {
    try {
      return { ok: true, value: read() };
    } catch (error) {
      return { ok: false, error };
    }
  };
  const overlap = () => new TypeError("multiple v2 Host acceptances claimed one operation");

  return Object.freeze({
    assertSql(sql: Sql) {
      const containerCheck = attempt(() => container?.assertSql(sql));
      const endpointCheck = attempt(() => endpoint?.assertSql(sql));
      if (!containerCheck.ok) throw containerCheck.error;
      if (!endpointCheck.ok) throw endpointCheck.error;
    },
    initialOutput(scope: V2HostAcceptanceScope) {
      if (container === undefined) return endpoint?.initialOutput(scope);
      if (endpoint === undefined) return container.initialOutput(scope);
      const containerOutput = attempt(() => container.initialOutput(scope));
      const endpointOutput = attempt(() => endpoint.initialOutput(scope));
      if (!containerOutput.ok) throw containerOutput.error;
      if (!endpointOutput.ok) throw endpointOutput.error;
      if (containerOutput.value !== undefined && endpointOutput.value !== undefined)
        throw overlap();
      return containerOutput.value !== undefined ? containerOutput.value : endpointOutput.value;
    },
    prepare(context: V2HostAcceptanceContext) {
      if (container === undefined) return endpoint?.prepare(context);
      if (endpoint === undefined) return container.prepare(context);
      // A true omission stays synchronous: the Store uses it to choose the
      // ordinary batch. When either issuer participates, settle both before
      // returning the original branded preparation to the Store.
      const containerStart = attempt(() => container.prepare(context));
      const endpointStart = attempt(() => endpoint.prepare(context));
      const containerPreparing = containerStart.ok ? containerStart.value : undefined;
      const endpointPreparing = endpointStart.ok ? endpointStart.value : undefined;
      if (containerPreparing === undefined && endpointPreparing === undefined) {
        if (!containerStart.ok) throw containerStart.error;
        if (!endpointStart.ok) throw endpointStart.error;
        return undefined;
      }
      return Promise.allSettled([containerPreparing, endpointPreparing] as const).then(
        ([containerResult, endpointResult]) => {
          if (
            containerResult.status === "fulfilled" &&
            endpointResult.status === "fulfilled" &&
            containerResult.value !== undefined &&
            endpointResult.value !== undefined
          )
            throw overlap();
          if (!containerStart.ok) throw containerStart.error;
          if (!endpointStart.ok) throw endpointStart.error;
          if (containerResult.status === "rejected") throw containerResult.reason;
          if (endpointResult.status === "rejected") throw endpointResult.reason;
          const selected =
            containerResult.value !== undefined ? containerResult.value : endpointResult.value;
          if (selected === undefined)
            throw new TypeError("v2 Host acceptance preparation resolved without a claim");
          return selected;
        },
      );
    },
    prepareDelete(context: V2HostDeleteAcceptanceContext) {
      const canonicalContainer = context.form === CONTAINER_CONTRACT.formUrl;
      if (canonicalContainer && container === undefined)
        throw new TypeError("canonical Container DELETE requires its Host issuer");
      // Only an explicit DELETE method participates. Endpoint's generic
      // prepare compiles non-CREATE as UPDATE and must never receive DELETE.
      const containerStart = attempt(() => container?.prepareDelete?.(context));
      const endpointStart = attempt(() => endpoint?.prepareDelete?.(context));
      const containerPreparing = containerStart.ok ? containerStart.value : undefined;
      const endpointPreparing = endpointStart.ok ? endpointStart.value : undefined;
      if (containerPreparing === undefined && endpointPreparing === undefined) {
        if (!containerStart.ok) throw containerStart.error;
        if (!endpointStart.ok) throw endpointStart.error;
        if (canonicalContainer)
          throw new TypeError("canonical Container DELETE requires its own preparation");
        return undefined;
      }
      return Promise.allSettled([containerPreparing, endpointPreparing] as const).then(
        ([containerResult, endpointResult]) => {
          if (
            containerResult.status === "fulfilled" &&
            endpointResult.status === "fulfilled" &&
            containerResult.value !== undefined &&
            endpointResult.value !== undefined
          )
            throw overlap();
          if (!containerStart.ok) throw containerStart.error;
          if (!endpointStart.ok) throw endpointStart.error;
          if (containerResult.status === "rejected") throw containerResult.reason;
          if (endpointResult.status === "rejected") throw endpointResult.reason;
          if (canonicalContainer && containerResult.value === undefined)
            throw new TypeError("canonical Container DELETE requires its own preparation");
          const selected =
            containerResult.value !== undefined ? containerResult.value : endpointResult.value;
          if (selected === undefined)
            throw new TypeError("v2 Host DELETE preparation resolved without a claim");
          return selected;
        },
      );
    },
  });
}

export function buildApp(ports: AppPorts): App {
  // Configuration is validated before any storage capability is constructed or
  // used. Undefined means the route is intentionally absent; partial is fatal.
  const integrationE2eCredentialAuthority = resolveIntegrationE2eCredentialAuthorityConfig(
    ports.integrationE2eCredentialAuthority,
  );
  if (
    integrationE2eCredentialAuthority &&
    ports.publicWorkerVersionId !== integrationE2eCredentialAuthority.publicWorkerVersionId
  ) {
    throw new TypeError(
      "integration E2E credential authority does not match the active Worker Version",
    );
  }
  const integrationOrganizationBootstrap = resolveIntegrationOrganizationBootstrapConfig(
    ports.integrationOrganizationBootstrap,
  );
  if (
    integrationOrganizationBootstrap &&
    (ports.publicOrigin !== integrationOrganizationBootstrap.hostId ||
      ports.publicWorkerVersionId !== integrationOrganizationBootstrap.publicWorkerVersionId)
  ) {
    throw new TypeError("integration organization bootstrap does not match this Host identity");
  }
  // The runtime-input `canonicalPublicOrigin` is an anti-misdirection fence:
  // it is the origin a caller must have addressed for its values to be sealed
  // here. An authority configured against any other origin fences nothing, so
  // the two independent inputs are proved equal at composition rather than
  // assumed equal by convention.
  if (ports.runtimeInputs && ports.runtimeInputs.canonicalPublicOrigin !== ports.publicOrigin) {
    throw new TypeError(
      "runtime input authority origin does not match this deployment's public origin",
    );
  }
  const clock = ports.clock ?? (() => new Date());
  const selectedWorkerEndpointOrigin = ports.v2WorkerEndpointOrigin;
  const workerEndpointOriginConstruction =
    selectedWorkerEndpointOrigin === undefined
      ? undefined
      : (() => {
          const sql = ports.sql;
          const { kind, formUrl, backendId, targetKey, ledger } = selectedWorkerEndpointOrigin;
          if (kind !== undefined && kind !== "form-v2@1")
            throw new TypeError("unsupported Worker Endpoint origin construction kind");
          const inputs = { sql, formUrl, backendId, targetKey, ledger };
          return Object.freeze({
            sql,
            shared: kind === "form-v2@1" ? Object.freeze({ kind, ledger }) : undefined,
            acceptance:
              kind === "form-v2@1"
                ? createWorkerEndpointOriginV2FormRouteAcceptance(inputs)
                : createWorkerEndpointOriginV2Acceptance(inputs),
          });
        })();
  if (ports.hostedBilling) {
    assertHostedBillingComposition(ports.hostedBilling, {
      sql: ports.sql,
      clock,
      ...(ports.billingConfig === undefined ? {} : { billingConfig: ports.billingConfig }),
    });
    if (ports.checkout !== undefined || ports.paymentEvents !== undefined) {
      throw new TypeError(
        "Hosted financial capabilities require the canonical custody and settlement adapter",
      );
    }
  }
  const origin = ports.resourceStores && resourceStoreOrigins.get(ports.resourceStores);
  if (
    ports.resourceStores &&
    (!origin || origin.sql !== ports.sql || origin.clock !== ports.clock)
  ) {
    throw new TypeError("precomposed resource stores do not belong to this app SQL and clock");
  }
  const resourceStores = ports.resourceStores ?? createAppResourceStoreBundle(ports.sql, clock);
  const randomId = ports.randomId ?? (() => crypto.randomUUID().replaceAll("-", ""));
  const artifactReconciler = createTakoformArtifactReconciler({
    sql: ports.sql,
    objects: ports.objects,
    clock,
    randomId,
  });

  const workerRequest = (() => {
    const selectionSlot = Object.getOwnPropertyDescriptor(ports, "workerRequest");
    if (selectionSlot === undefined) return undefined;
    if (!("value" in selectionSlot))
      throw new TypeError("Worker request selection must be an own data property");
    const selected: AppPorts["workerRequest"] = selectionSlot.value;
    if (selected === undefined) return undefined;
    const originalSlot = Object.getOwnPropertyDescriptor(selected, "originalConsumers");
    if (originalSlot !== undefined && !("value" in originalSlot))
      throw new TypeError("original Worker request graph must be an own data property");
    if (originalSlot === undefined || originalSlot.value === undefined)
      return createWorkerRequestConsumers({
        ...selected,
        sql: ports.sql,
        identity: ports.identity,
        clock,
        randomId,
        publicOrigin: ports.publicOrigin,
        consoleOrigin: ports.consoleOrigin,
      });
    const connectionSlot = Object.getOwnPropertyDescriptor(selected, "connection");
    const clientSlot = Object.getOwnPropertyDescriptor(selected, "client");
    const realmSlot = Object.getOwnPropertyDescriptor(selected, "realm");
    const sqlSlot = Object.getOwnPropertyDescriptor(ports, "sql");
    const clockSlot = Object.getOwnPropertyDescriptor(ports, "clock");
    const publicOriginSlot = Object.getOwnPropertyDescriptor(ports, "publicOrigin");
    const consoleOriginSlot = Object.getOwnPropertyDescriptor(ports, "consoleOrigin");
    if (
      !connectionSlot ||
      !("value" in connectionSlot) ||
      !clientSlot ||
      !("value" in clientSlot) ||
      !realmSlot ||
      !("value" in realmSlot) ||
      !sqlSlot ||
      !("value" in sqlSlot) ||
      !clockSlot ||
      !("value" in clockSlot) ||
      !publicOriginSlot ||
      !("value" in publicOriginSlot) ||
      !consoleOriginSlot ||
      !("value" in consoleOriginSlot)
    )
      throw new TypeError("original Worker request inputs must be own data properties");
    const connection: WorkerRequestAppInputs["connection"] = connectionSlot.value;
    const client: WorkerRequestAppInputs["client"] = clientSlot.value;
    const realm: WorkerRequestAppInputs["realm"] = realmSlot.value;
    const sql: AppPorts["sql"] = sqlSlot.value;
    const originalConsumers: WorkerRequestConsumers = originalSlot.value;
    const original = readWorkerRequestConsumers(connection);
    const inputs = readWorkerRequestFinancialInputs(connection);
    if (
      originalConsumers !== original ||
      original.sql !== sql ||
      original.client !== client ||
      original.realm !== realm ||
      inputs.sql !== sql ||
      inputs.client !== client ||
      inputs.realm !== realm ||
      inputs.clock !== clock ||
      clockSlot.value !== clock ||
      publicOriginSlot.value !== SHARED_AUTH_STAGING_PROFILE.publicOrigin ||
      consoleOriginSlot.value !== SHARED_AUTH_STAGING_PROFILE.consoleOrigin
    )
      throw new TypeError("original Worker request graph differs from this App");
    return original;
  })();
  const apiKeyAdministration =
    workerRequest?.apiKeyAdministration ??
    createApiKeyAdministration({
      sql: ports.sql,
      clock,
      randomId,
    });
  const accounts =
    workerRequest?.accounts ??
    createAccounts({
      sql: ports.sql,
      identity: ports.identity,
      clock,
      randomId,
      apiKeyAdministration,
    });
  const v2AllowFreshCreateAndUpdate = ports.v2AllowFreshCreateAndUpdate;
  const v2ApplicationOptions = {
    sql: workerEndpointOriginConstruction?.sql ?? ports.sql,
    objects: ports.objects,
    accounts,
    publicOrigin: ports.publicOrigin,
    ...(ports.consoleOrigin === undefined ? {} : { consoleOrigin: ports.consoleOrigin }),
    config: ports.v2,
    clock,
    ...(v2AllowFreshCreateAndUpdate === undefined
      ? {}
      : { allowFreshCreateAndUpdate: v2AllowFreshCreateAndUpdate }),
    ...(ports.v2FormFactory === undefined ? {} : { formFactory: ports.v2FormFactory }),
    ...(ports.v2FormSelectionFactory === undefined
      ? {}
      : { formSelectionFactory: ports.v2FormSelectionFactory }),
    ...(ports.v2ArtifactSourceFactory === undefined
      ? {}
      : { artifactSourceFactory: ports.v2ArtifactSourceFactory }),
    ...(ports.v2PrivateInputCustody === undefined
      ? {}
      : { privateInputCustody: ports.v2PrivateInputCustody }),
  };
  const v2HostAcceptance = composeV2HostAcceptances(
    captureContainerHostAcceptance(ports.v2ContainerHostAcceptance, ports.sql),
    workerEndpointOriginConstruction?.acceptance,
  );
  const takoformV2Host = createTakoformV2Application(v2ApplicationOptions, v2HostAcceptance);
  const integrationE2eCredentialRoute = integrationE2eCredentialAuthority
    ? createIntegrationE2eCredentialAuthority({
        configuration: integrationE2eCredentialAuthority,
        sql: ports.sql,
        clock,
      })
    : null;
  const integrationOrganizationBootstrapRoute = integrationOrganizationBootstrap
    ? createIntegrationOrganizationBootstrap({
        configuration: integrationOrganizationBootstrap,
        sql: ports.sql,
        clock,
      })
    : null;
  const prepareAdmission = ports.hostedBilling?.limitPolicy.prepareAdmission.bind(
    ports.hostedBilling.limitPolicy,
  );
  const allocationAdmissionResolver = prepareAdmission
    ? async (organizationId: string) => {
        if (!orgBilling) throw new TypeError("Hosted wallet lifecycle is unavailable");
        // The same lifecycle mints eligible monthly allowance before the first
        // internal data-plane debit. Ledger.wallet does not resolve admission,
        // and capture/replay retain their original allocations and witnesses.
        await orgBilling.wallet(organizationId);
        return await prepareAdmission(organizationId);
      }
    : undefined;
  const warningPolicy = ports.hostedBilling?.limitPolicy;
  const warningSql = ports.sql;
  const dispatchWarnings =
    ports.hostedBilling?.status.warningDelivery === "configured"
      ? ports.hostedBilling.dispatchWarnings.bind(ports.hostedBilling)
      : undefined;
  const usageWarnings: UsageWarningPreparer | undefined = warningPolicy
    ? async ({ organizationId, instant }) =>
        warningPolicy.warningStatements({
          organizationId,
          instant,
          summaryRead: orgUsageSummaryReadStatement({
            organizationId,
            instant,
            hostedPaidFreeExclusion: true,
            hostedCreditProvenance: true,
            refundSource: await stripeRefundSource(warningSql),
          }),
        })
    : undefined;
  const ledger = createLedger(ports.sql, clock, {
    hostedPaidFreeExclusion:
      ports.hostedBilling !== undefined || ports.hostedPaidFreeExclusion === true,
    ...(allocationAdmissionResolver ? { allocationAdmissionResolver } : {}),
    ...(usageWarnings ? { usageWarnings } : {}),
  });
  const orgBilling = ports.billingConfig
    ? createOrgBilling({
        sql: ports.sql,
        clock,
        ledger,
        config: ports.billingConfig,
        hostedPaidFreeExclusion:
          ports.hostedBilling !== undefined || ports.hostedPaidFreeExclusion === true,
        ...(ports.hostedBilling
          ? { limitPolicy: ports.hostedBilling.limitPolicy, requireWorkspaceAttribution: true }
          : {}),
        ...(ports.hostedBilling?.onDemand
          ? { admissionFunding: ports.hostedBilling.onDemand }
          : {}),
      })
    : undefined;
  const paymentContext: PaymentEventContext = {
    sql: ports.sql,
    clock,
    credit: createFundingCredit({
      ledger,
      organizationExists: async (organizationId) =>
        (await accounts.organization(organizationId)) !== null,
    }),
    creditedFunding: (fundings) => ledger.fundedReferences(fundings),
  };
  const hostedPayments = ports.hostedBilling?.paymentActivation
    ? ports.hostedBilling.createPayments(paymentContext)
    : undefined;
  const paymentEvents = hostedPayments?.events ?? ports.paymentEvents?.(paymentContext);
  // Where the composition allows it (the Bun Host), one pass at a time: the
  // timer and the operator route share it, and a caller arriving mid-pass
  // joins the pass already reading the processor instead of starting a
  // second. A Worker never shares, because I/O started in one request's
  // context may never settle once that request is canceled, and a later
  // invocation that joined it would hang with it. Unshared or concurrent
  // passes stay harmless, because each funding reference credits once.
  let reconcileInFlight: Promise<FundingReconcileReport> | null = null;
  const reconcilePayments = async (): Promise<FundingReconcileReport | null> => {
    if (!paymentEvents) return null;
    if (!ports.shareReconcilePass) return await paymentEvents.reconcile();
    if (!reconcileInFlight) {
      const pass: Promise<FundingReconcileReport> = paymentEvents.reconcile().finally(() => {
        if (reconcileInFlight === pass) reconcileInFlight = null;
      });
      reconcileInFlight = pass;
    }
    return await reconcileInFlight;
  };
  const singleUseCredentials = createSingleUseCredentials(ports.sql, clock);
  const operatorReconcileVerifier = ports.operatorPaymentsReconcile;
  const operatorPaymentsReconcile =
    paymentEvents && operatorReconcileVerifier
      ? async (assertion: string): Promise<FundingReconcileReport> => {
          const credential = await operatorReconcileVerifier.verify(assertion);
          // Spent before the pass: a replay runs nothing, and a pass that fails
          // burns the assertion rather than leaving it usable twice.
          await singleUseCredentials.spend(credential);
          const report = await reconcilePayments();
          if (!report) throw new Error("payment reconcile is not configured");
          return report;
        }
      : undefined;
  const catalog = createCatalog(ports.offerings);
  const { deployments, inventory } = resourceStores;
  const originReservations =
    ports.originReservations ??
    ((ports.providers?.length ?? 0) > 0
      ? createWorkerEndpointOriginReservations({
          sql: ports.sql,
          clock,
          catalog,
          providers: ports.providers ?? [],
          resources: inventory,
          deployments,
          ...(workerEndpointOriginConstruction?.shared === undefined
            ? {}
            : { shared: workerEndpointOriginConstruction.shared }),
        })
      : undefined);
  if (workerEndpointOriginConstruction?.shared !== undefined && originReservations !== undefined) {
    assertSharedOriginCarrier(
      originReservations,
      ports.sql,
      workerEndpointOriginConstruction.shared.ledger,
    );
  }
  if (ports.selfhostTenantRunCredentialAuthority && !originReservations) {
    throw new TypeError(
      "self-host tenant-run credentials require an endpoint reservation authority",
    );
  }
  const selfhostTenantRunCredentials =
    ports.selfhostTenantRunCredentialAuthority && originReservations
      ? ports.selfhostTenantRunCredentialAuthority(originReservations)
      : undefined;
  const attachments = createAttachmentService({
    store: createAttachmentStore(ports.sql, clock),
    deployments,
    factories: (ports.providerPacks ?? []).flatMap((pack) => pack.attachmentFactories),
    clock,
    resource: async (tenantId, uid) => {
      const listing = await inventory.resourceByUid(tenantId, uid);
      if (!listing) return null;
      const installed = ports.forms.find((form) =>
        sameFormRef(form.identity.formRef, listing.resource.form.formRef),
      );
      return installed ? { uid, providedInterfaces: installed.providedInterfaces ?? [] } : null;
    },
  });
  const migrations = createResourceMigrationService({
    store: createResourceMigrationStore(ports.sql, clock),
    deployments,
    catalog,
    packs: ports.providerPacks ?? [],
    resource: async (tenantId, uid) => {
      const listing = await inventory.resourceByUid(tenantId, uid);
      return listing
        ? {
            uid,
            form: listing.resource.form.formRef,
            space: listing.space,
            name: listing.name,
            spec: listing.resource.spec,
          }
        : null;
    },
    attachments,
    clock,
    effects: inventory,
  });
  const reseller = createReseller({ sql: ports.sql, ledger, catalog, clock, randomId });
  const tokens = createTokenService({
    sql: ports.sql,
    issuer: ports.publicOrigin,
    clock,
    ...(ports.signingKey ? { signingKey: ports.signingKey } : {}),
    ...(selfhostTenantRunCredentials
      ? { tenantRunCredentialAdmission: selfhostTenantRunCredentials }
      : {}),
  });
  const authenticateTenantRunCredential = async (
    authorization: string | null,
  ): Promise<{
    readonly claims: TakoformTenantRunTokenClaims;
    readonly principal: {
      readonly tenantId: string;
      readonly principalId: string;
      readonly scope: {
        readonly space: string;
        readonly mode: "tenant-run";
        readonly workerEndpointOriginReservationId?: string;
      };
    };
  } | null> => {
    const bearer = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : null;
    if (!bearer) return null;
    try {
      const claims = await tokens.verifyTakoformTenantRunToken(bearer);
      return {
        claims,
        principal: {
          tenantId: claims.organizationId,
          // A Hosted logical principal can survive a fresh Run credential so
          // the same owner can resume its principal-bound Host operation.
          // Legacy credentials retain their original per-token identity.
          principalId: await tenantRunPrincipalId(claims),
          scope: {
            space: claims.spaceRef,
            mode: "tenant-run",
            ...(claims.workerEndpointOriginReservationId
              ? {
                  workerEndpointOriginReservationId: claims.workerEndpointOriginReservationId,
                }
              : {}),
          },
        },
      };
    } catch {
      return null;
    }
  };

  const defaultProviderDriver =
    ports.driver === undefined
      ? createProviderDriver({
          providers: ports.providers ?? [],
          providerPacks: ports.providerPacks ?? [],
          catalog,
          ledger,
          deployments,
          deletions: inventory,
          ...(originReservations ? { originReservations } : {}),
        })
      : undefined;
  const driver = ports.driver ?? defaultProviderDriver;
  if (!driver) throw new Error("Takoform provider driver is unavailable");
  const artifactConsumerProvider =
    ports.artifactConsumerProvider ?? defaultProviderDriver?.artifactConsumerRepair;
  const artifactConsumerRepair = artifactConsumerProvider
    ? createArtifactConsumerRepair({
        sql: ports.sql,
        provider: artifactConsumerProvider,
        clock,
        randomId,
      })
    : undefined;
  const availability =
    ports.availability ??
    (ports.driver === undefined
      ? createProviderFormAvailability(ports.providers ?? [])
      : undefined);
  const hostAuthority =
    ports.hostAuthority ??
    (ports.takoformHostFactory
      ? undefined
      : createTakoformHostAuthority({
          sql: ports.sql,
          objects: ports.objects,
          hostId: ports.publicOrigin,
          ...(ports.publicWorkerVersionId
            ? { publicWorkerVersionId: ports.publicWorkerVersionId }
            : {}),
          ...(ports.formImplementationDigest
            ? { implementationDigest: ports.formImplementationDigest }
            : {}),
          candidates: ports.hostForms,
          ...(driver.workerClassRuntime ? { workerClassRuntime: driver.workerClassRuntime } : {}),
          bindings: ports.hostBindings ?? [],
          technicalAvailability: availability ?? {
            async resolve() {
              return { executable: false, activated: false, availableToPrincipal: false };
            },
          },
        }));
  const hostOptions: Omit<CreateTakoformHostOptions, "authority"> = {
    sql: ports.sql,
    objects: ports.objects,
    // The ordinary organization lane accepts an API key carrying
    // resources:read or resources:write (a writer retains read compatibility).
    // A reseller may instead issue a short-lived run token pinned to one paid
    // reservation and one exact Resource address. The latter is useful to a
    // hosted runner because it never receives the reseller's organization
    // key and cannot cross into another opaque tenant space.
    //
    // A signed-in person may enter it too, and must say which organization
    // they are acting for. A key names one organization by existing; a
    // session names a person, who may own several, and guessing which of
    // somebody's organizations to bill is not a guess worth making. The
    // header is ignored for a key, whose organization is not up for
    // discussion.
    authenticate: async (request) => {
      const authorization = request.headers.get("authorization");
      const actor = await accounts.authenticate(authorization);
      if (actor?.kind === "api_key") {
        const resourceScopes = actor.scopes.filter(
          (scope): scope is TakoformHostResourceScope =>
            scope === "resources:read" || scope === "resources:write",
        );
        return actor.organizationId && grants(actor.scopes, "resources:read")
          ? {
              tenantId: actor.organizationId,
              principalId: actor.hostPrincipalId,
              scopes: resourceScopes,
            }
          : null;
      }
      if (actor?.kind === "session") {
        const organizationId = request.headers.get("takoform-organization");
        if (!organizationId) return null;
        const owned = await accounts
          .requireOwner(actor, organizationId)
          .then(() => true)
          .catch(() => false);
        return owned ? { tenantId: organizationId, principalId: actor.hostPrincipalId } : null;
      }

      const tenantRun = await authenticateTenantRunCredential(authorization);
      if (tenantRun) return tenantRun.principal;
      const bearer = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : null;
      if (!bearer) return null;
      try {
        // Exact-Resource reservation tokens share the Takoform audience with
        // the tenant-run credential above but have a closed, disjoint shape.
        const claims = await tokens.verifyTakoformRunToken(bearer);
        const reservation = await reseller.reservation({
          organizationId: claims.organizationId,
          tenantRef: claims.tenantRef,
          reservationId: claims.reservationId,
        });
        if (
          reservation.offeringId !== claims.offeringId ||
          reservation.offeringDigest !== claims.offeringDigest ||
          (claims.mode === "provision"
            ? reservation.status !== "active"
            : reservation.status !== "captured")
        ) {
          return null;
        }
        return {
          tenantId: claims.organizationId,
          principalId: `run:${claims.tokenId}`,
          scope: {
            space: claims.tenantRef,
            formRef: claims.formRef,
            resourceName: claims.resourceName,
            mode: claims.mode,
            ...(claims.resourceUid === undefined
              ? {}
              : { expectedResourceUid: claims.resourceUid }),
            commercialAuthority: {
              reservationId: claims.reservationId,
              offeringId: claims.offeringId,
              offeringDigest: claims.offeringDigest,
            },
            ...(claims.mode === "provision"
              ? {
                  claimCreate: async () => {
                    try {
                      await tokens.claimTakoformRunTokenForCreate(bearer);
                    } catch (error) {
                      if (error instanceof TokenError && error.code === "token_replayed") {
                        throw new TakoformHostError("resource_busy", 409);
                      }
                      if (error instanceof TokenError && error.code === "state_unavailable") {
                        throw new TakoformHostError("unavailable", 503);
                      }
                      throw new TakoformHostError("unauthenticated", 401);
                    }
                  },
                }
              : {}),
          },
        };
      } catch {
        return null;
      }
    },
    forms: ports.hostForms,
    ...(ports.hostBindings ? { bindings: ports.hostBindings } : {}),
    driver,
    ...(ports.artifacts ? { artifacts: ports.artifacts } : {}),
    ...(ports.standardServiceResolver
      ? { standardServiceResolver: ports.standardServiceResolver }
      : {}),
    ...(availability ? { availability } : {}),
    clock,
    randomId,
    ...(ports.providers && ports.providers.length > 0
      ? {
          deferredOperations: {
            // Provider-backed mutations are external sagas. Their public
            // operation record is the durable command a scheduled drain can
            // reconstruct after a Worker process disappears.
            shouldDefer: () => true,
            pollsBeforeCommit: 1,
            // Preserve the stable synchronous Resource response when the
            // provider and the final durable commit settle in this request.
            // Only an indeterminate command remains for automatic drainage.
            executeOnAccept: true,
            // Provider transports stop awaiting response headers at 30s, so
            // an inline attempt that cannot settle inside that window is
            // answered with the deferred contract instead of an HTTP timeout;
            // the durable saga resumes on the client's own polls.
            inlineExecuteMilliseconds: 15_000,
          },
        }
      : {}),
    // The redemption lane: a reseller's single-use provision token buys
    // exactly one apply of the offering it names, in the tenant's space.
    provision: { tokens, catalog },
    blockingRelations: attachments.blocksDeletion,
  };
  const createDerivedTakoformHost = (
    options: Omit<CreateTakoformHostOptions, "authority">,
  ): TakoformHost => {
    if (!hostAuthority) throw new Error("Takoform Host authority is unavailable");
    return createTakoformHost({ ...options, authority: hostAuthority });
  };
  const takoformHost =
    ports.takoformHost ??
    (ports.takoformHostFactory
      ? ports.takoformHostFactory(hostOptions)
      : createDerivedTakoformHost(hostOptions));
  ports.captureLegacyHostForTests?.(takoformHost);

  const verifyNativeAbsence = driver.verifyNativeAbsence;
  const control = createControlRoutes({
    publicOrigin: ports.publicOrigin,
    accounts,
    inventory,
    deployments,
    attachments,
    migrations,
    forms: ports.forms,
    ...(availability?.catalogue ? { formAvailability: availability } : {}),
    identityProviders: ports.identityProviders ?? [],
    ...(ports.hostedBilling?.paymentActivation
      ? { checkout: ports.hostedBilling.checkout }
      : ports.checkout
        ? { checkout: ports.checkout }
        : {}),
    ...(paymentEvents?.receive ? { paymentNotifications: paymentEvents.receive } : {}),
    ...(operatorPaymentsReconcile ? { operatorPaymentsReconcile } : {}),
    ...(hostedPayments
      ? {
          subscriptionCustody: hostedPayments.subscriptionCustody,
          subscriptionPlans: hostedPayments.subscriptionPlans,
          subscriptionCommandReceipts: hostedPayments.subscriptionCommandReceipts,
        }
      : paymentEvents?.subscriptions
        ? { subscriptions: paymentEvents.subscriptions }
        : {}),
    ...(paymentEvents?.creditFunding ? { creditFunding: paymentEvents.creditFunding } : {}),
    ledger,
    ...(orgBilling ? { billing: orgBilling } : {}),
    ...(ports.hostedBilling
      ? {
          hostedBilling: true,
          limitPolicy: ports.hostedBilling.limitPolicy,
          billingCapabilities: {
            contractVersion: "hosted-billing-v1",
            topUps: ports.hostedBilling.status.topUps,
            subscriptionStart: ports.hostedBilling.status.subscriptionStart,
            subscriptionCancellation: ports.hostedBilling.status.subscriptionCancellation,
            subscriptionPlanChange: ports.hostedBilling.status.subscriptionPlanChange,
          },
          ...(ports.hostedBilling.onDemand ? { onDemand: ports.hostedBilling.onDemand } : {}),
          ...(ports.hostedBilling.cardSetup ? { cardSetup: ports.hostedBilling.cardSetup } : {}),
          ...(ports.hostedBilling.setupDisclosureRevision === undefined
            ? {}
            : { setupDisclosureRevision: ports.hostedBilling.setupDisclosureRevision }),
        }
      : {}),
    catalog,
    reseller,
    tokens,
    authenticateTenantRunCredential: async (authorization) =>
      (await authenticateTenantRunCredential(authorization))?.claims ?? null,
    settlement: ports.hostedBilling?.paymentActivation
      ? ports.hostedBilling.settlement
      : ports.settlement,
    clock,
    ...(ports.consoleOrigin === undefined ? {} : { consoleOrigin: ports.consoleOrigin }),
    ...(verifyNativeAbsence
      ? {
          nativeResidual: {
            verify: async (input) => await verifyNativeAbsence(input),
          },
        }
      : {}),
    ...(artifactConsumerRepair ? { artifactConsumerRepair } : {}),
    ...(ports.runtimeInputs ? { runtimeInputs: ports.runtimeInputs.preparations } : {}),
    ...(originReservations ? { originReservations } : {}),
    ...(selfhostTenantRunCredentials ? { selfhostTenantRunCredentials } : {}),
    ...(driver.runtimeInputPolicy ? { runtimeInputPolicy: driver.runtimeInputPolicy } : {}),
  });

  const metering = createMetering({
    sql: ports.sql,
    ledger,
    clock,
    randomId,
    hostedPaidFreeExclusion:
      ports.hostedBilling !== undefined || ports.hostedPaidFreeExclusion === true,
    ...(allocationAdmissionResolver ? { allocationAdmissionResolver } : {}),
    ...(usageWarnings ? { usageWarnings } : {}),
    ...(ports.meteringRates ? { rates: ports.meteringRates } : {}),
  });
  const providerMetering = createProviderMetering({
    sql: ports.sql,
    deployments,
    catalog,
    packs: ports.providerPacks ?? [],
    metering,
    clock,
    randomId,
  });
  const dataAi = createDataAiRoutes({
    accounts,
    ...(ports.ai ? { gateway: ports.ai } : {}),
    ledger,
    sql: ports.sql,
    record: (usage) => metering.recordAi(usage),
    clock,
    randomId,
  });
  const router = createRouter({
    ...(ports.selfhostEndpointIngressFactory
      ? {
          containerEndpointIngress: ports.selfhostEndpointIngressFactory({
            store: inventory,
            deployments,
          }),
        }
      : {}),
    control,
    dataAi,
    ...(workerRequest === undefined ? {} : { sharedAuth: workerRequest.sharedAuth }),
    aiAvailable: ports.ai !== undefined,
    takoformV2Host,
    publicOrigin: ports.publicOrigin,
    ...(ports.consoleOrigin === undefined ? {} : { consoleOrigin: ports.consoleOrigin }),
  });
  return {
    ...(orgBilling ? { orgBilling } : {}),
    ...(ports.hostedBilling ? { hostedBilling: ports.hostedBilling.status } : {}),
    fetch:
      integrationOrganizationBootstrapRoute || integrationE2eCredentialRoute
        ? async (request, lifetime) =>
            (await integrationOrganizationBootstrapRoute?.(request)) ??
            (await integrationE2eCredentialRoute?.(request)) ??
            (await router(request, lifetime))
        : router,
    maintenance: {
      artifacts: artifactReconciler,
      ...(ports.hostedBilling ? { billingWarnings: ports.hostedBilling } : {}),
    },
    tickTakoformV2: () => takoformV2Host.runNext(),
    reconcilePayments,
    async tick(): Promise<TickReport> {
      // Legacy recovery remains independent of potentially slow v2 effects.
      let drainFailed = false;
      let drainFailure: unknown;
      let providerRepairs = {
        candidates: 0,
        acquired: 0,
        settled: 0,
        pending: 0,
      };
      try {
        providerRepairs =
          (await takoformHost.maintenance?.drainProviderRepairs(64)) ?? providerRepairs;
      } catch (error) {
        drainFailed = true;
        drainFailure = error;
      }
      // Deliver retained warnings before later money work can fail. A transport
      // failure stays visible while other maintenance and custody can proceed.
      let warningFailed = false;
      let warningFailure: unknown;
      try {
        if (dispatchWarnings) await dispatchWarnings();
      } catch (error) {
        warningFailed = true;
        warningFailure = error;
      }
      let report: TickReport;
      try {
        await reseller.reconcileDue(64, async (intent) => {
          if (!intent.authorityRef) return "ready";
          const migration = await migrations.read(intent.organizationId, intent.authorityRef);
          if (!migration) return "pending";
          if (migration.state === "completed") return "ready";
          if (migration.state === "failed" || migration.state === "rolled_back") {
            return "cancelled";
          }
          return "pending";
        });
        const expiredReservations = await reseller.expireDue(64);
        const expiredWalletHolds = await orgBilling?.expireDue(64);
        const expiredRuntimeInputPreparations =
          await ports.runtimeInputs?.maintenance.expireDue(64);
        const store = inventory;
        const installed = ports.forms.map((form) => form.identity.formRef.schemaDigest);
        const orphans = await store.orphanedResources(installed, 32);
        const providerUsage = await providerMetering.reconcile(32);
        const meteredRows = await metering.rollUp(500);
        const artifactMaintenance = await artifactReconciler.reconcile({
          limit: 32,
          deleteObjects: false,
        });
        const orphanedResources = orphans.map(
          (orphan) => `${orphan.space}/${orphan.kind}/${orphan.name}`,
        );
        if (orphanedResources.length > 0) {
          console.warn(
            JSON.stringify({
              event: "takoserver.resources.orphaned",
              count: orphanedResources.length,
              resources: orphanedResources,
              hint: "a Form schema changed without a new definitionVersion",
            }),
          );
        }
        report = {
          expiredReservations,
          expiredWalletHolds: expiredWalletHolds ?? 0,
          expiredRuntimeInputPreparations: expiredRuntimeInputPreparations ?? 0,
          orphanedResources,
          meteredRows,
          providerMeterWindows: providerUsage.windows,
          providerMeterFailures: providerUsage.failures,
          artifactMaintenance,
          providerRepairs,
        };
      } catch (error) {
        if (drainFailed || warningFailed)
          throw new AggregateError(
            [
              ...(drainFailed ? [drainFailure] : []),
              ...(warningFailed ? [warningFailure] : []),
              error,
            ],
            "app maintenance failed",
          );
        throw error;
      }
      if (drainFailed)
        throw new AggregateError(
          warningFailed ? [drainFailure, warningFailure] : [drainFailure],
          "legacy Takoform repair drain failed",
        );
      if (warningFailed)
        throw new AggregateError([warningFailure], "billing warning delivery failed");
      return report;
    },
  };
}

/**
 * Static stable-lane assembly for disposable conformance/local-provider
 * fixtures. It is intentionally kept in the composition root rather than the
 * Takoform domain modules, and is not part of the package's public exports.
 */
export function createStaticTestTakoformHost(
  options: Omit<CreateTakoformHostOptions, "authority">,
): TakoformHost {
  const clock = options.clock ?? (() => new Date());
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const routes = DEFAULT_TAKOFORM_ROUTES;
  const forms = installedForms(options.forms, routes.hostApiVersion);
  const bindings = installedBindings(options.bindings ?? []);
  const store = createTakoformStore(options.sql, clock);
  const artifacts =
    options.artifacts ??
    createTakoformArtifacts({
      sql: options.sql,
      objects: options.objects,
      clock,
      randomId,
    });
  const engine = createTakoformEngine({
    store,
    forms,
    bindings,
    driver: options.driver,
    artifacts,
    allowBodyGenerationFence: true,
    allowReviewSpecDigest: true,
    stableReviewConstraintPhases: true,
    clock,
    randomId,
    ...(options.blockingRelations ? { blockingRelations: options.blockingRelations } : {}),
    ...(options.standardServiceResolver
      ? { standardServiceResolver: options.standardServiceResolver }
      : {}),
    ...(options.availability ? { availability: options.availability } : {}),
  });
  const deferredOperations = options.deferredOperations
    ? createDeferredOperations({
        configuration: options.deferredOperations,
        engine,
        store,
        forms,
        clock,
        randomId,
        omitObservedStatus: true,
      })
    : undefined;
  return createTakoformRoutes({
    authenticate: options.authenticate,
    engine,
    store,
    forms,
    bindings,
    artifacts,
    ...(deferredOperations ? { deferredOperations } : {}),
    ...(options.standardServiceResolver
      ? { standardServiceResolver: options.standardServiceResolver }
      : {}),
    ...(options.availability ? { availability: options.availability } : {}),
    ...(options.driver.runtimeInputPolicy
      ? { runtimeInputPolicy: options.driver.runtimeInputPolicy }
      : {}),
    ...(options.provision ? { provision: options.provision } : {}),
  });
}
