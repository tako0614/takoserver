import type { AiGateway } from "./ai-port.ts";
import {
  type ArtifactConsumerProviderReader,
  createArtifactConsumerRepair,
} from "./artifact-consumer-repair.ts";
import { createAttachmentService, createAttachmentStore } from "./attachments.ts";
import {
  createAccounts,
  createApiKeyAdministration,
  type ExternalIdentityVerifier,
  grants,
  type IdentityProviderDescriptor,
} from "./auth.ts";
import { createCatalog, type Offering } from "./catalog.ts";
import { type Checkout, createControlRoutes } from "./control.ts";
import { createDataAiRoutes } from "./data-ai.ts";
import {
  createIntegrationE2eCredentialAuthority,
  type IntegrationE2eCredentialAuthorityConfig,
  resolveIntegrationE2eCredentialAuthorityConfig,
} from "./integration-e2e-credential-authority.ts";
import { createLedger, type FundingSettlementVerifier } from "./ledger.ts";
import { createMetering, type MeteringRates } from "./metering.ts";
import type { Clock, ObjectStoreAccess, Sql } from "./ports.ts";
import { createProviderDriver, createProviderFormAvailability } from "./provider-driver.ts";
import { createProviderMetering } from "./provider-metering.ts";
import type { ProviderPack } from "./provider-pack.ts";
import type { Provider } from "./provider-port.ts";
import { createReseller } from "./reseller.ts";
import { createResourceDeploymentStore } from "./resource-deployments.ts";
import {
  createResourceMigrationService,
  createResourceMigrationStore,
} from "./resource-migrations.ts";
import { createRouter, type Router } from "./router.ts";
import type { RuntimeInputAuthority } from "./runtime-input-preparations.ts";
import {
  type ArtifactReconcileReport,
  type ArtifactReconciler,
  createTakoformArtifactReconciler,
} from "./takoform/artifact-reconciler.ts";
import { createTakoformArtifacts, type TakoformArtifactTransport } from "./takoform/artifacts.ts";
import { installedBindings } from "./takoform/bindings.ts";
import type { WorkerModuleInspector } from "./takoform/engine.ts";
import { createTakoformEngine } from "./takoform/engine.ts";
import { installedForms, sameFormRef } from "./takoform/forms.ts";
import { type CreateTakoformHostOptions, createTakoformHost } from "./takoform/host.ts";
import {
  createTakoformHostAuthority,
  type TakoformHostAuthority,
} from "./takoform/host-authority.ts";
import { createDeferredOperations } from "./takoform/operations.ts";
import { createTakoformRoutes, DEFAULT_TAKOFORM_ROUTES } from "./takoform/routes.ts";
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
import { createTokenService, type SigningKey, TokenError } from "./token.ts";
import {
  createWorkerEndpointOriginReservations,
  type WorkerEndpointOriginReservations,
} from "./worker-endpoint-origin-reservations.ts";

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
  readonly sql: Sql;
  readonly objects: ObjectStoreAccess;
  readonly identity: ExternalIdentityVerifier;
  readonly settlement: FundingSettlementVerifier;
  /** Starts a payment, where this deployment can take one. */
  readonly checkout?: Checkout | undefined;
  /** What data costs here. Absent means measured and not charged. */
  readonly meteringRates?: MeteringRates | undefined;
  /** OpenAI-compatible inference backend. Absent keeps the AI route unavailable. */
  readonly ai?: AiGateway;
  readonly publicOrigin: string;
  /** Current Cloudflare Worker Version, retained only as operation and audit provenance. */
  readonly publicWorkerVersionId?: string;
  /** Current semantic Form implementation identity. */
  readonly formImplementationDigest?: `sha256:${string}`;
  /** Complete integration-only JIT key authority configuration, or no route. */
  readonly integrationE2eCredentialAuthority?: IntegrationE2eCredentialAuthorityConfig;
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
  /** Shared with a provider that publishes committed bundles. */
  readonly artifacts?: TakoformArtifactTransport;
  /** Parses committed worker bytes without executing tenant code. */
  readonly workerModuleInspector?: WorkerModuleInspector;
  /**
   * Replaces the Takoform Host entirely. Used by conformance tests that need to
   * drive the lane with their own authentication; production never sets it.
   */
  readonly takoformHost?: TakoformHost;
  /** Explicit assembly seam for tests; production entries never provide it. */
  readonly takoformHostFactory?: (
    options: Omit<CreateTakoformHostOptions, "authority">,
  ) => TakoformHost;
  readonly clock?: Clock;
  readonly randomId?: () => string;
}

export interface App {
  readonly fetch: Router;
  /** Typed operator seam; no maintenance route is mounted on public HTTP. */
  readonly maintenance: {
    readonly artifacts: ArtifactReconciler;
  };
  /** One pass of background settlement. Safe to call concurrently. */
  tick(): Promise<TickReport>;
}

export interface TickReport {
  readonly expiredReservations: number;
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
  const randomId = ports.randomId ?? (() => crypto.randomUUID().replaceAll("-", ""));
  const artifactReconciler = createTakoformArtifactReconciler({
    sql: ports.sql,
    objects: ports.objects,
    clock,
    randomId,
  });

  const apiKeyAdministration = createApiKeyAdministration({
    sql: ports.sql,
    clock,
    randomId,
  });
  const accounts = createAccounts({
    sql: ports.sql,
    identity: ports.identity,
    clock,
    randomId,
    apiKeyAdministration,
  });
  const integrationE2eCredentialRoute = integrationE2eCredentialAuthority
    ? createIntegrationE2eCredentialAuthority({
        configuration: integrationE2eCredentialAuthority,
        sql: ports.sql,
        clock,
      })
    : null;
  const ledger = createLedger(ports.sql, clock);
  const catalog = createCatalog(ports.offerings);
  const deployments = createResourceDeploymentStore(ports.sql, clock);
  const inventory = createTakoformStore(ports.sql, clock);
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
        })
      : undefined);
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
  });

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

      const bearer = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length)
        : null;
      if (!bearer) return null;
      try {
        try {
          const claims = await tokens.verifyTakoformTenantRunToken(bearer);
          return {
            tenantId: claims.organizationId,
            principalId: `run:${claims.tokenId}`,
            scope: {
              space: claims.spaceRef,
              mode: "tenant-run" as const,
              ...(claims.workerEndpointOriginReservationId
                ? {
                    workerEndpointOriginReservationId: claims.workerEndpointOriginReservationId,
                  }
                : {}),
            },
          };
        } catch {
          // Exact-Resource reservation tokens share the Takoform audience
          // but have a closed, disjoint claim shape.
        }
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
    ...(ports.workerModuleInspector ? { workerModuleInspector: ports.workerModuleInspector } : {}),
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

  const verifyNativeAbsence = driver.verifyNativeAbsence;
  const control = createControlRoutes({
    accounts,
    inventory,
    deployments,
    attachments,
    migrations,
    forms: ports.forms,
    identityProviders: ports.identityProviders ?? [],
    ...(ports.checkout ? { checkout: ports.checkout } : {}),
    ledger,
    catalog,
    reseller,
    tokens,
    settlement: ports.settlement,
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
    ...(driver.runtimeInputPolicy ? { runtimeInputPolicy: driver.runtimeInputPolicy } : {}),
  });

  const metering = createMetering({
    sql: ports.sql,
    ledger,
    clock,
    randomId,
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
    control,
    dataAi,
    aiAvailable: ports.ai !== undefined,
    takoformHost,
    publicOrigin: ports.publicOrigin,
    ...(ports.consoleOrigin === undefined ? {} : { consoleOrigin: ports.consoleOrigin }),
  });
  return {
    fetch: integrationE2eCredentialRoute
      ? async (request) => (await integrationE2eCredentialRoute(request)) ?? (await router(request))
      : router,
    maintenance: { artifacts: artifactReconciler },
    async tick(): Promise<TickReport> {
      const providerRepairs = (await takoformHost.maintenance?.drainProviderRepairs(64)) ?? {
        candidates: 0,
        acquired: 0,
        settled: 0,
        pending: 0,
      };
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
      const expiredRuntimeInputPreparations = await ports.runtimeInputs?.maintenance.expireDue(64);
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
      return {
        expiredReservations,
        expiredRuntimeInputPreparations: expiredRuntimeInputPreparations ?? 0,
        orphanedResources,
        meteredRows,
        providerMeterWindows: providerUsage.windows,
        providerMeterFailures: providerUsage.failures,
        artifactMaintenance,
        providerRepairs,
      };
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
    ...(options.workerModuleInspector
      ? { workerModuleInspector: options.workerModuleInspector }
      : {}),
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
