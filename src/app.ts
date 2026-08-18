import {
  createAccounts,
  type ExternalIdentityVerifier,
  grants,
  type IdentityProviderDescriptor,
} from "./auth.ts";
import { createCatalog, type Offering } from "./catalog.ts";
import { type Checkout, createControlRoutes } from "./control.ts";
import { createDataObjectRoutes } from "./data-objects.ts";
import { createLedger, type FundingSettlementVerifier } from "./ledger.ts";
import { createMetering, type MeteringRates } from "./metering.ts";
import type { Clock, ObjectStore, Sql } from "./ports.ts";
import { createProviderDriver } from "./provider-driver.ts";
import type { Provider } from "./provider-port.ts";
import { createReseller } from "./reseller.ts";
import { createRouter, type Router } from "./router.ts";
import type { TakoformArtifactTransport } from "./takoform/artifacts.ts";
import { createTakoformHost } from "./takoform/host.ts";
import { createTakoformStore } from "./takoform/store.ts";
import type {
  InstalledTakoformForm,
  TakoformHost,
  TakoformResourceDriver,
} from "./takoform/types.ts";
import { createTokenService, type SigningKey } from "./token.ts";

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
  readonly publicOrigin: string;
  /** Where this deployment's console is served, if it has one. */
  readonly consoleOrigin?: string;
  readonly forms: readonly InstalledTakoformForm[];
  /** How a caller may sign in to this deployment. */
  readonly identityProviders?: readonly IdentityProviderDescriptor[];
  /**
   * Backends this deployment can provision on. When present the Takoform lane
   * is driven by them and applies are billed; `driver` then only serves as an
   * explicit override for tests about the Host itself.
   */
  readonly providers?: readonly Provider[];
  readonly driver?: TakoformResourceDriver;
  readonly offerings: readonly Offering[];
  readonly signingKey?: SigningKey;
  /** Shared with a provider that publishes committed bundles. */
  readonly artifacts?: TakoformArtifactTransport;
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
}

export function buildApp(ports: AppPorts): App {
  const clock = ports.clock ?? (() => new Date());
  const randomId = ports.randomId ?? (() => crypto.randomUUID().replaceAll("-", ""));

  const accounts = createAccounts({ sql: ports.sql, identity: ports.identity, clock, randomId });
  const ledger = createLedger(ports.sql, clock);
  const catalog = createCatalog(ports.offerings);
  const reseller = createReseller({ sql: ports.sql, ledger, catalog, clock, randomId });
  const tokens = createTokenService({
    sql: ports.sql,
    issuer: ports.publicOrigin,
    clock,
    ...(ports.signingKey ? { signingKey: ports.signingKey } : {}),
  });

  const driver =
    ports.driver ?? createProviderDriver({ providers: ports.providers ?? [], catalog, ledger });

  const takoformHost =
    ports.takoformHost ??
    createTakoformHost({
      sql: ports.sql,
      objects: ports.objects,
      // The Takoform lane is entered with an organization API key carrying
      // `resources:write`. A single-use provisioning token is deliberately not
      // accepted here: it authorizes one resource, not a whole lane.
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
        if (!actor) return null;
        if (actor.kind === "api_key") {
          return actor.organizationId && grants(actor.scopes, "resources:write")
            ? { tenantId: actor.organizationId, principalId: actor.principalId }
            : null;
        }
        const organizationId = request.headers.get("takoform-organization");
        if (!organizationId) return null;
        const owned = await accounts
          .requireOwner(actor, organizationId)
          .then(() => true)
          .catch(() => false);
        return owned ? { tenantId: organizationId, principalId: actor.principalId } : null;
      },
      forms: ports.forms,
      driver,
      ...(ports.artifacts ? { artifacts: ports.artifacts } : {}),
      clock,
      randomId,
    });

  // One store instance backs both the exact-pin lanes and the console's read
  // side, so an inventory can never drift from what the lanes actually hold.
  const inventory = createTakoformStore(ports.sql, clock);

  const control = createControlRoutes({
    accounts,
    inventory,
    forms: ports.forms,
    identityProviders: ports.identityProviders ?? [],
    ...(ports.checkout ? { checkout: ports.checkout } : {}),
    ledger,
    catalog,
    reseller,
    tokens,
    settlement: ports.settlement,
    clock,
  });

  const metering = createMetering({
    sql: ports.sql,
    ledger,
    clock,
    randomId,
    ...(ports.meteringRates ? { rates: ports.meteringRates } : {}),
  });
  const dataObjects = createDataObjectRoutes({
    objects: ports.objects,
    tokens,
    record: (usage) => metering.record({ ...usage, requestId: randomId() }),
  });

  return {
    fetch: createRouter({
      control,
      dataObjects,
      takoformHost,
      publicOrigin: ports.publicOrigin,
      ...(ports.consoleOrigin === undefined ? {} : { consoleOrigin: ports.consoleOrigin }),
    }),
    async tick(): Promise<TickReport> {
      const expiredReservations = await reseller.expireDue(64);
      const store = inventory;
      const installed = ports.forms.map((form) => form.identity.formRef.schemaDigest);
      const orphans = await store.orphanedResources(installed, 32);
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
      return { expiredReservations, orphanedResources, meteredRows };
    },
  };
}
