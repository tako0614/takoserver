import type { AiGateway } from "./ai-port.ts";
import { createAttachmentService, createAttachmentStore } from "./attachments.ts";
import {
  createAccounts,
  type ExternalIdentityVerifier,
  grants,
  type IdentityProviderDescriptor,
} from "./auth.ts";
import { createCatalog, type Offering } from "./catalog.ts";
import { type Checkout, createControlRoutes } from "./control.ts";
import { createDataAiRoutes } from "./data-ai.ts";
import { createLedger, type FundingSettlementVerifier } from "./ledger.ts";
import { createMetering, type MeteringRates } from "./metering.ts";
import type { Clock, ObjectStore, Sql } from "./ports.ts";
import { createProviderDriver } from "./provider-driver.ts";
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
import type { S3CredentialIssuer } from "./s3-port.ts";
import { createSponsorshipRoutes } from "./sponsorship-api.ts";
import type { TakoformArtifactTransport } from "./takoform/artifacts.ts";
import type { WorkerModuleInspector } from "./takoform/engine.ts";
import { sameFormRef } from "./takoform/forms.ts";
import { createTakoformHost } from "./takoform/host.ts";
import { createTakoformStore } from "./takoform/store.ts";
import type {
  InstalledTakoformBinding,
  InstalledTakoformForm,
  TakoformHost,
  TakoformResourceDriver,
} from "./takoform/types.ts";
import { TakoformHostError } from "./takoform/types.ts";
import { createTokenService, type SigningKey, TokenError } from "./token.ts";

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
  readonly objects: ObjectStore;
  readonly identity: ExternalIdentityVerifier;
  readonly settlement: FundingSettlementVerifier;
  /** Starts a payment, where this deployment can take one. */
  readonly checkout?: Checkout | undefined;
  /** What data costs here. Absent means measured and not charged. */
  readonly meteringRates?: MeteringRates | undefined;
  /** OpenAI-compatible inference backend. Absent keeps the AI route unavailable. */
  readonly ai?: AiGateway;
  /** Short-lived standard S3 credentials for a provisioned ObjectBucket. */
  readonly s3?: S3CredentialIssuer;
  readonly publicOrigin: string;
  /** Where this deployment's console is served, if it has one. */
  readonly consoleOrigin?: string;
  /** Private Hosted-to-Takoserver sponsorship bearer; absent disables the seam. */
  readonly sponsorshipServiceToken?: string;
  readonly forms: readonly InstalledTakoformForm[];
  /** Exact portable BindingDefinitions installed by this Host composition. */
  readonly bindings?: readonly InstalledTakoformBinding[];
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
  readonly clock?: Clock;
  readonly randomId?: () => string;
}

export interface App {
  readonly fetch: Router;
  /** One pass of background settlement. Safe to call concurrently. */
  tick(): Promise<TickReport>;
}

export interface TickReport {
  readonly expiredReservations: number;
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
}

export function buildApp(ports: AppPorts): App {
  const clock = ports.clock ?? (() => new Date());
  const randomId = ports.randomId ?? (() => crypto.randomUUID().replaceAll("-", ""));

  const accounts = createAccounts({ sql: ports.sql, identity: ports.identity, clock, randomId });
  const ledger = createLedger(ports.sql, clock);
  const catalog = createCatalog(ports.offerings);
  const deployments = createResourceDeploymentStore(ports.sql, clock);
  const inventory = createTakoformStore(ports.sql, clock);
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
  });
  const reseller = createReseller({ sql: ports.sql, ledger, catalog, clock, randomId });
  const tokens = createTokenService({
    sql: ports.sql,
    issuer: ports.publicOrigin,
    clock,
    ...(ports.signingKey ? { signingKey: ports.signingKey } : {}),
  });

  const driver =
    ports.driver ??
    createProviderDriver({
      providers: ports.providers ?? [],
      catalog,
      ledger,
      deployments,
    });

  const takoformHost =
    ports.takoformHost ??
    createTakoformHost({
      sql: ports.sql,
      objects: ports.objects,
      // The ordinary organization lane accepts a resources:write API key. A
      // reseller may instead issue a short-lived run token pinned to one paid
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
          return actor.organizationId && grants(actor.scopes, "resources:write")
            ? { tenantId: actor.organizationId, principalId: actor.hostPrincipalId }
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
      forms: ports.forms,
      ...(ports.bindings ? { bindings: ports.bindings } : {}),
      driver,
      ...(ports.artifacts ? { artifacts: ports.artifacts } : {}),
      ...(ports.workerModuleInspector
        ? { workerModuleInspector: ports.workerModuleInspector }
        : {}),
      clock,
      randomId,
      // The redemption lane: a reseller's single-use provision token buys
      // exactly one apply of the offering it names, in the tenant's space.
      provision: { tokens, catalog },
      blockingRelations: attachments.blocksDeletion,
    });

  const sponsorshipLifecycle = ports.sponsorshipServiceToken
    ? createTakoformHost({
        sql: ports.sql,
        objects: ports.objects,
        authenticate: async (request) => {
          if (request.headers.get("authorization") !== "Bearer internal-sponsorship-lifecycle") {
            return null;
          }
          const tenantId = request.headers.get("x-takoserver-sponsorship-organization");
          const expectedResourceUid = request.headers.get("x-takoserver-sponsorship-resource");
          if (!tenantId || !expectedResourceUid) return null;
          const listing = await inventory.resourceByUid(tenantId, expectedResourceUid);
          if (!listing) return null;
          return {
            tenantId,
            principalId: "service:takosumi-hosted-sponsorship",
            scope: {
              space: listing.space,
              formRef: listing.resource.form.formRef,
              resourceName: listing.name,
              mode: "manage",
              expectedResourceUid,
            },
          };
        },
        forms: ports.forms,
        ...(ports.bindings ? { bindings: ports.bindings } : {}),
        driver,
        ...(ports.artifacts ? { artifacts: ports.artifacts } : {}),
        ...(ports.workerModuleInspector
          ? { workerModuleInspector: ports.workerModuleInspector }
          : {}),
        clock,
        randomId,
        blockingRelations: attachments.blocksDeletion,
      })
    : null;

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
    ...(ports.s3 ? { s3: ports.s3 } : {}),
    settlement: ports.settlement,
    clock,
    ...(ports.consoleOrigin === undefined ? {} : { consoleOrigin: ports.consoleOrigin }),
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
  const sponsorship =
    ports.sponsorshipServiceToken && sponsorshipLifecycle
      ? createSponsorshipRoutes({
          sql: ports.sql,
          ledger,
          inventory,
          lifecycle: sponsorshipLifecycle,
          serviceToken: ports.sponsorshipServiceToken,
          publicOrigin: ports.publicOrigin,
          clock,
        })
      : undefined;

  return {
    fetch: createRouter({
      control,
      ...(sponsorship ? { sponsorship } : {}),
      dataAi,
      aiAvailable: ports.ai !== undefined,
      takoformHost,
      publicOrigin: ports.publicOrigin,
      ...(ports.consoleOrigin === undefined ? {} : { consoleOrigin: ports.consoleOrigin }),
    }),
    async tick(): Promise<TickReport> {
      const expiredReservations = await reseller.expireDue(64);
      const store = inventory;
      const installed = ports.forms.map((form) => form.identity.formRef.schemaDigest);
      const orphans = await store.orphanedResources(installed, 32);
      const providerUsage = await providerMetering.reconcile(32);
      const meteredRows = await metering.rollUp(500);
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
        orphanedResources,
        meteredRows,
        providerMeterWindows: providerUsage.windows,
        providerMeterFailures: providerUsage.failures,
      };
    },
  };
}
