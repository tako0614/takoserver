import { createAccounts, type ExternalIdentityVerifier } from "./auth.ts";
import { createCatalog, type Offering } from "./catalog.ts";
import { createControlRoutes } from "./control.ts";
import { createLedger, type FundingSettlementVerifier } from "./ledger.ts";
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
  readonly publicOrigin: string;
  readonly forms: readonly InstalledTakoformForm[];
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
      authenticate: async (authorization) => {
        const actor = await accounts.authorize(authorization, "resources:write");
        return actor?.organizationId
          ? { tenantId: actor.organizationId, principalId: actor.principalId }
          : null;
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
    ledger,
    catalog,
    reseller,
    tokens,
    settlement: ports.settlement,
    clock,
  });

  return {
    fetch: createRouter({ control, takoformHost, publicOrigin: ports.publicOrigin }),
    async tick(): Promise<TickReport> {
      const expiredReservations = await reseller.expireDue(64);
      const store = inventory;
      const installed = ports.forms.map((form) => form.identity.formRef.schemaDigest);
      const orphans = await store.orphanedResources(installed, 32);
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
      return { expiredReservations, orphanedResources };
    },
  };
}
