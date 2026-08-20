import { AttachmentError, type AttachmentService } from "./attachments.ts";
import {
  type Accounts,
  type Actor,
  API_KEY_SCOPES,
  type ApiKeyScope,
  AuthError,
  grants,
  type IdentityProviderDescriptor,
} from "./auth.ts";
import type { Catalog } from "./catalog.ts";
import { GoogleIdentityError } from "./google-identity.ts";
import { type FundingSettlementVerifier, type Ledger, LedgerError } from "./ledger.ts";
import { OperatorAssertionError } from "./operator-credentials.ts";
import type { Clock } from "./ports.ts";
import { type Reseller, ResellerError } from "./reseller.ts";
import type { ResourceDeploymentStore } from "./resource-deployments.ts";
import { ResourceMigrationError, type ResourceMigrationService } from "./resource-migrations.ts";
import {
  type S3Access,
  S3CredentialError,
  type S3CredentialIssuer,
  validateS3CredentialSet,
} from "./s3-port.ts";
import { parseStrictJson, StrictJsonError } from "./strict-json.ts";
import { formSupportProfile, sameFormRef } from "./takoform/forms.ts";
import { TAKOFORM_EDGE_OBJECTS_INTERFACE } from "./takoform/official-forms.ts";
import type { OperationListing, ResourceListing } from "./takoform/store.ts";
import type { InstalledTakoformForm } from "./takoform/types.ts";
import { TakosIdIdentityError } from "./takos-id-identity.ts";
import { TokenError, type TokenService } from "./token.ts";

/**
 * The direct Console and API-key control plane.
 *
 * Three kinds of caller reach these routes and they are kept distinct on
 * purpose. A **session** proves who a human is and is the only thing that may
 * create organizations or mint keys. An **API key** acts for one organization
 * within its granted scopes. Neither may stand in for the other: a session is
 * never accepted as an organization actor, and a key can never administer the
 * organization that issued it.
 */

const MAX_BODY_BYTES = 64 * 1_024;

/**
 * The read side of what a tenant declared.
 *
 * The exact-pin lanes can only answer about a resource whose full quad the
 * caller already knows. A person opening a console knows none of it — they know
 * they have things and want to see them — so the control plane needs its own
 * way in. This is deliberately narrow: listing, never mutation.
 */
export interface ResourceInventory {
  listResources(
    tenantId: string,
    options: {
      readonly space?: string | undefined;
      readonly limit: number;
      readonly cursor?: string | undefined;
    },
  ): Promise<{ readonly resources: readonly ResourceListing[]; readonly cursor: string | null }>;
  resourceByUid(tenantId: string, uid: string): Promise<ResourceListing | null>;
  listOperations(tenantId: string, limit: number): Promise<readonly OperationListing[]>;
}

/** Starting a payment. Everything about the payment processor stays behind it. */
export interface Checkout {
  begin(input: {
    readonly organizationId: string;
    readonly amountMinor: number;
  }): Promise<{ readonly url: string }>;
  /** Smallest and largest a single payment may be, in minor units. */
  readonly bounds: { readonly minimumMinor: number; readonly maximumMinor: number };
}

export interface CreateControlRoutesOptions {
  readonly accounts: Accounts;
  readonly inventory: ResourceInventory;
  readonly deployments: Pick<ResourceDeploymentStore, "active">;
  readonly attachments: AttachmentService;
  readonly migrations: ResourceMigrationService;
  /** Every Form definition this Host will accept. */
  readonly forms: readonly InstalledTakoformForm[];
  /** How a caller may sign in to this deployment. */
  readonly identityProviders: readonly IdentityProviderDescriptor[];
  readonly ledger: Ledger;
  readonly catalog: Catalog;
  readonly reseller: Reseller;
  readonly tokens: TokenService;
  readonly settlement: FundingSettlementVerifier;
  /**
   * Starts a payment, when this deployment can take one. Absent means funding
   * happens some other way — the operator's signature — and the route that
   * would begin a checkout is simply not served.
   */
  readonly checkout?: Checkout | undefined;
  /** Standard S3 credentials for already-provisioned ObjectBuckets. */
  readonly s3?: S3CredentialIssuer | undefined;
  readonly clock: Clock;
  /** Exact browser console origin allowed to carry the HttpOnly session cookie. */
  readonly consoleOrigin?: string;
}

export type ControlRoutes = (request: Request, url: URL) => Promise<Response | null>;

export function createControlRoutes(options: CreateControlRoutesOptions): ControlRoutes {
  const {
    accounts,
    inventory,
    deployments,
    attachments,
    migrations,
    forms,
    identityProviders,
    ledger,
    catalog,
    reseller,
    tokens,
    settlement,
    s3,
    clock,
    consoleOrigin,
  } = options;

  const authorization = (request: Request): string | null => {
    const header = request.headers.get("authorization");
    if (header) return header;
    if (!consoleOrigin || request.headers.get("origin") !== consoleOrigin) return null;
    const token = cookie(request, "takoserver_session");
    return token ? `Bearer ${token}` : null;
  };

  const owner = async (request: Request, organizationId: string): Promise<Actor> => {
    const actor = await accounts.authenticate(authorization(request));
    if (actor?.kind !== "session") throw new AuthError("unauthenticated");
    await accounts.requireOwner(actor, organizationId);
    return actor;
  };

  /** An API key with the scope, or the owner acting through their session. */
  const scoped = async (
    request: Request,
    organizationId: string,
    scope: ApiKeyScope,
  ): Promise<Actor> => {
    const actor = await accounts.authenticate(authorization(request));
    if (!actor) throw new AuthError("unauthenticated");
    if (actor.kind === "session") {
      await accounts.requireOwner(actor, organizationId);
      return actor;
    }
    if (actor.organizationId !== organizationId || !grants(actor.scopes, scope)) {
      throw new AuthError("permission_denied");
    }
    return actor;
  };

  const resellerActor = async (request: Request): Promise<Actor> => {
    const actor = await accounts.authenticate(authorization(request));
    if (!actor?.organizationId || !grants(actor.scopes, "reseller:write")) {
      throw new AuthError("permission_denied");
    }
    return actor;
  };

  const migrationActor = async (request: Request, organizationId: string): Promise<Actor> => {
    const actor = await scoped(request, organizationId, "resources:write");
    if (actor.kind === "api_key" && !grants(actor.scopes, "reseller:write")) {
      throw new AuthError("permission_denied");
    }
    return actor;
  };

  return async (request, url) => {
    if (!url.pathname.startsWith("/v1/")) return null;
    try {
      return await route(request, url);
    } catch (error) {
      return controlErrorResponse(error);
    }
  };

  async function route(request: Request, url: URL): Promise<Response> {
    // Which Forms exist is a property of the platform, not of a tenant, and it
    // is the first thing anyone integrating needs. The exact-pin lanes can
    // answer this too, but only to an organization key — a person reading the
    // catalogue in a console holds a session, and would otherwise be told they
    // are not authenticated for asking a public question.
    if (request.method === "GET" && url.pathname === "/v1/forms") {
      return Response.json({ profiles: forms.map(formSupportProfile) });
    }

    if (request.method === "GET" && url.pathname === "/v1/identity/providers") {
      // What this deployment can actually do, not what the product could
      // support. A console that offers a button for an unconfigured provider
      // offers a button that fails.
      return Response.json({ providers: identityProviders });
    }

    if (request.method === "POST" && url.pathname === "/v1/sessions") {
      const body = await jsonObject(request);
      // `method` is optional: a caller that knows only one way in should not
      // have to name it, and a deployment that offers only one has nothing to
      // disambiguate.
      exactKeys(body, ["provider", "assertion"], ["method", "nonce"]);
      const { principal, sessionToken } = await accounts.signIn({
        provider: enumValue(body.provider, ["takos-id", "google", "github"]) as
          | "takos-id"
          | "google"
          | "github",
        assertion: bounded(body.assertion, 8 * 1_024),
        ...(body.method === undefined
          ? {}
          : {
              method: enumValue(body.method, ["oidc", "operator-assertion"]) as
                | "oidc"
                | "operator-assertion",
            }),
        ...(body.nonce === undefined ? {} : { nonce: text(body.nonce) }),
      });
      if (consoleOrigin && request.headers.get("origin") === consoleOrigin) {
        return Response.json(
          { principal },
          {
            headers: {
              "set-cookie": sessionCookie(sessionToken, new URL(request.url).protocol === "https:"),
            },
          },
        );
      }
      return Response.json({ principal, sessionToken });
    }

    if (request.method === "DELETE" && url.pathname === "/v1/session") {
      const actor = await accounts.authenticate(authorization(request));
      if (actor?.kind !== "session") throw new AuthError("unauthenticated");
      return new Response(null, {
        status: 204,
        headers: {
          "set-cookie": clearSessionCookie(new URL(request.url).protocol === "https:"),
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/v1/me") {
      const actor = await accounts.authenticate(authorization(request));
      if (actor?.kind !== "session") throw new AuthError("unauthenticated");
      const principal = await accounts.principal(actor.principalId);
      if (!principal) throw new AuthError("unauthenticated");
      return Response.json({
        principal,
        organizations: await accounts.organizations(actor.principalId),
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/organizations") {
      const actor = await accounts.authenticate(authorization(request));
      if (actor?.kind !== "session") throw new AuthError("unauthenticated");
      const body = await jsonObject(request);
      exactKeys(body, ["name"]);
      const organization = await accounts.createOrganization({ actor, name: text(body.name) });
      return Response.json({ organization }, { status: 201 });
    }

    const orgKeys = /^\/v1\/organizations\/([^/]+)\/api-keys$/u.exec(url.pathname);
    if (request.method === "POST" && orgKeys) {
      const organizationId = segment(orgKeys[1]);
      const actor = await owner(request, organizationId);
      const body = await jsonObject(request);
      exactKeys(body, ["name", "scopes", "expiresInSeconds"]);
      const { apiKey, secret } = await accounts.createApiKey({
        actor,
        organizationId,
        name: text(body.name),
        scopes: scopeList(body.scopes),
        expiresInSeconds: integer(body.expiresInSeconds),
      });
      // The secret appears here and nowhere else, ever.
      return Response.json({ apiKey, secret }, { status: 201 });
    }

    if (request.method === "GET" && orgKeys) {
      const organizationId = segment(orgKeys[1]);
      const actor = await owner(request, organizationId);
      return Response.json({ apiKeys: await accounts.apiKeys({ actor, organizationId }) });
    }

    const orgKey = /^\/v1\/organizations\/([^/]+)\/api-keys\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "DELETE" && orgKey) {
      const organizationId = segment(orgKey[1]);
      const actor = await owner(request, organizationId);
      const apiKey = await accounts.revokeApiKey({
        actor,
        organizationId,
        apiKeyId: segment(orgKey[2]),
      });
      return Response.json({ apiKey });
    }

    const wallet = /^\/v1\/organizations\/([^/]+)\/wallet$/u.exec(url.pathname);
    if (request.method === "GET" && wallet) {
      const organizationId = segment(wallet[1]);
      await scoped(request, organizationId, "wallet:read");
      return Response.json({ wallet: await ledger.wallet(organizationId) });
    }

    const funding = /^\/v1\/organizations\/([^/]+)\/wallet\/funding$/u.exec(url.pathname);
    if (request.method === "POST" && funding) {
      const organizationId = segment(funding[1]);
      await owner(request, organizationId);
      const body = await jsonObject(request);
      exactKeys(body, ["settlementProof"]);
      // The caller never states an amount; only the verifier does.
      const settled = await settlement.verify({
        organizationId,
        settlementProof: text(body.settlementProof),
      });
      const credited = await ledger.fund({
        organizationId,
        fundingRef: settled.fundingRef,
        amountMinor: settled.amountMinor,
      });
      return Response.json({ wallet: credited });
    }

    const checkout = /^\/v1\/organizations\/([^/]+)\/wallet\/checkout$/u.exec(url.pathname);
    if (request.method === "POST" && checkout) {
      const organizationId = segment(checkout[1]);
      await owner(request, organizationId);
      if (!options.checkout) {
        // Not configured is not "you may not". Saying `not_found` keeps a
        // console from offering a payment this deployment cannot take.
        controlError("not_found", 404);
      }
      const body = await jsonObject(request);
      exactKeys(body, ["amountMinor"]);
      const amountMinor = integer(body.amountMinor);
      const { minimumMinor, maximumMinor } = options.checkout.bounds;
      if (amountMinor < minimumMinor || amountMinor > maximumMinor) {
        controlError("invalid_argument", 400);
      }
      // Where the payment returns to is configured, not requested. An address
      // taken from the caller is an open redirect wearing a payment's clothes,
      // and there is nothing a caller could usefully say here anyway.
      const started = await options.checkout.begin({ organizationId, amountMinor });
      return Response.json({ checkout: started }, { status: 201 });
    }

    if (request.method === "GET" && url.pathname === "/v1/catalog") {
      const organizationId = requiredQuery(url, "organizationId");
      await scoped(request, organizationId, "catalog:read");
      return Response.json({
        offerings: await Promise.all(
          catalog.list().map(async (offering) => ({
            id: offering.id,
            kind: offering.kind,
            displayName: offering.displayName,
            form: offering.form,
            pricePlan: offering.pricePlan,
            resourceClass: offering.resourceClass,
            deliveryMode: offering.deliveryMode,
            providedInterfaces: offering.providedInterfaces,
            bindingRefs: offering.bindingRefs,
            regions: offering.regions,
            portability: offering.portability,
            isolation: offering.isolation,
            digest: await catalog.digest(offering),
          })),
        ),
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/reseller/quotes") {
      const actor = await resellerActor(request);
      const body = await jsonObject(request);
      exactKeys(body, ["tenantRef", "offeringId", "quantity"]);
      const quote = await reseller.quote({
        organizationId: organizationOf(actor),
        tenantRef: tenantRef(body.tenantRef),
        offeringId: text(body.offeringId),
        quantity: integer(body.quantity),
      });
      return Response.json({ quote }, { status: 201 });
    }

    if (request.method === "POST" && url.pathname === "/v1/reseller/reservations") {
      const actor = await resellerActor(request);
      const body = await jsonObject(request);
      exactKeys(body, ["tenantRef", "quoteId"]);
      const reservation = await reseller.reserve({
        organizationId: organizationOf(actor),
        tenantRef: tenantRef(body.tenantRef),
        quoteId: text(body.quoteId),
      });
      return Response.json({ reservation }, { status: 201 });
    }

    const reservationAction =
      /^\/v1\/reseller\/reservations\/([^/]+)\/(capture|release|provision-tokens|takoform-run-tokens)$/u.exec(
        url.pathname,
      );
    if (request.method === "POST" && reservationAction) {
      const actor = await resellerActor(request);
      const organizationId = organizationOf(actor);
      const reservationId = segment(reservationAction[1]);
      const body = await jsonObject(request);

      if (reservationAction[2] === "capture") {
        exactKeys(body, ["tenantRef", "usage"]);
        const usage = record(body.usage);
        // `meter` is optional: the reservation already knows its meter, and
        // requiring the caller to restate it made capture depend on a catalog
        // read that fails once the offering retires.
        exactKeys(usage, ["quantity"], ["meter"]);
        const statement = await reseller.capture({
          organizationId,
          tenantRef: tenantRef(body.tenantRef),
          reservationId,
          usage: {
            quantity: number(usage.quantity),
            ...(usage.meter === undefined ? {} : { meter: text(usage.meter) }),
          },
        });
        return Response.json({ statement });
      }
      if (reservationAction[2] === "release") {
        exactKeys(body, ["tenantRef"]);
        const reservation = await reseller.release({
          organizationId,
          tenantRef: tenantRef(body.tenantRef),
          reservationId,
        });
        return Response.json({ reservation });
      }

      if (reservationAction[2] === "takoform-run-tokens") {
        exactKeys(body, ["tenantRef", "resourceName", "expiresInSeconds"], ["resourceUid"]);
        const requestedTenant = tenantRef(body.tenantRef);
        const requestedName = resourceName(body.resourceName);
        const reservation = await reseller.reservation({
          organizationId,
          tenantRef: requestedTenant,
          reservationId,
        });
        if (reservation.status !== "active" && reservation.status !== "captured") {
          throw new ResellerError("conflict", 409);
        }
        let resourceUid: string | undefined;
        let formRef: InstalledTakoformForm["identity"]["formRef"];
        if (reservation.status === "captured") {
          resourceUid = segment(text(body.resourceUid));
          const existing = await inventory.resourceByUid(organizationId, resourceUid);
          const deployment = await deployments.active(organizationId, resourceUid);
          if (
            !existing ||
            !deployment ||
            deployment.offeringId !== reservation.offeringId ||
            existing.space !== reservation.tenantRef ||
            existing.name !== requestedName
          ) {
            controlError("not_found", 404);
          }
          formRef = existing.resource.form.formRef;
        } else if (body.resourceUid !== undefined) {
          controlError("invalid_argument", 400);
        } else {
          const offering = catalog.findOffering(reservation.offeringId);
          if (!offering || (await catalog.digest(offering)) !== reservation.offeringDigest) {
            throw new ResellerError("offering_unavailable", 503);
          }
          formRef = offering.form;
        }
        const issued = await tokens.issueTakoformRunToken({
          organizationId,
          tenantRef: reservation.tenantRef,
          reservationId: reservation.id,
          offeringId: reservation.offeringId,
          offeringDigest: reservation.offeringDigest,
          formRef,
          resourceName: requestedName,
          ...(resourceUid === undefined
            ? { mode: "provision" as const }
            : { mode: "manage" as const, resourceUid }),
          ttlSeconds: integer(body.expiresInSeconds),
        });
        return Response.json({ takoformRunToken: issued }, { status: 201 });
      }

      exactKeys(body, ["tenantRef", "expiresInSeconds"]);
      const reservation = await reseller.reservation({
        organizationId,
        tenantRef: tenantRef(body.tenantRef),
        reservationId,
      });
      if (reservation.status !== "active") throw new ResellerError("conflict", 409);
      // A single-use credential that lets an untrusted runtime create exactly
      // the one resource this reservation paid for.
      const issued = await tokens.issueProvisionToken({
        organizationId,
        tenantRef: reservation.tenantRef,
        reservationId: reservation.id,
        offeringId: reservation.offeringId,
        offeringDigest: reservation.offeringDigest,
        ttlSeconds: integer(body.expiresInSeconds),
      });
      return Response.json({ provisionToken: issued }, { status: 201 });
    }

    const statement = /^\/v1\/reseller\/reservations\/([^/]+)\/usage-statement$/u.exec(
      url.pathname,
    );
    if (request.method === "GET" && statement) {
      const actor = await resellerActor(request);
      return Response.json({
        statement: await reseller.statement({
          organizationId: organizationOf(actor),
          tenantRef: tenantRef(requiredQuery(url, "tenantRef")),
          reservationId: segment(statement[1]),
        }),
      });
    }

    const resources = /^\/v1\/organizations\/([^/]+)\/resources$/u.exec(url.pathname);
    if (request.method === "GET" && resources) {
      const organizationId = segment(resources[1]);
      await scoped(request, organizationId, "resources:read");
      const space = url.searchParams.get("space");
      const cursor = url.searchParams.get("cursor");
      const page = await inventory.listResources(organizationId, {
        limit: pageSize(url),
        ...(space === null ? {} : { space: segment(space) }),
        ...(cursor === null ? {} : { cursor }),
      });
      return Response.json({
        resources: page.resources.map(presentResource),
        ...(page.cursor === null ? {} : { cursor: page.cursor }),
      });
    }

    const organizationResource = /^\/v1\/organizations\/([^/]+)\/resources\/([^/]+)$/u.exec(
      url.pathname,
    );
    if (request.method === "GET" && organizationResource) {
      const organizationId = segment(organizationResource[1]);
      const resourceUid = segment(organizationResource[2]);
      await scoped(request, organizationId, "resources:read");
      const resource = await inventory.resourceByUid(organizationId, resourceUid);
      if (!resource) controlError("not_found", 404);
      return Response.json({ resource: presentResource(resource) });
    }

    const organizationAttachments = /^\/v1\/organizations\/([^/]+)\/attachments$/u.exec(
      url.pathname,
    );
    if (organizationAttachments) {
      const organizationId = segment(organizationAttachments[1]);
      if (request.method === "GET") {
        await scoped(request, organizationId, "resources:read");
        const resourceUid = url.searchParams.get("resourceUid");
        return Response.json({
          attachments: await attachments.list(organizationId, {
            limit: pageSize(url),
            ...(resourceUid === null ? {} : { resourceUid: segment(resourceUid) }),
          }),
        });
      }
      if (request.method === "POST") {
        await scoped(request, organizationId, "resources:write");
        const body = await jsonObject(request);
        exactKeys(body, [
          "id",
          "consumerResourceUid",
          "providerResourceUid",
          "interfaceRef",
          "target",
          "permissions",
        ]);
        const interfaceRef = record(body.interfaceRef);
        exactKeys(interfaceRef, ["apiVersion", "name", "version", "schemaDigest"]);
        const attachment = await attachments.createAndResolve({
          tenantId: organizationId,
          id: text(body.id),
          consumerResourceUid: text(body.consumerResourceUid),
          providerResourceUid: text(body.providerResourceUid),
          interfaceRef: {
            apiVersion: enumValue(interfaceRef.apiVersion, [
              "interfaces.takoform.com/v1alpha1",
            ]) as "interfaces.takoform.com/v1alpha1",
            name: text(interfaceRef.name),
            version: text(interfaceRef.version),
            schemaDigest: text(interfaceRef.schemaDigest) as `sha256:${string}`,
          },
          target: text(body.target),
          permissions: stringList(body.permissions),
        });
        return Response.json({ attachment }, { status: 201 });
      }
    }

    const organizationAttachment = /^\/v1\/organizations\/([^/]+)\/attachments\/([^/]+)$/u.exec(
      url.pathname,
    );
    if (organizationAttachment) {
      const organizationId = segment(organizationAttachment[1]);
      const attachmentId = segment(organizationAttachment[2]);
      if (request.method === "GET") {
        await scoped(request, organizationId, "resources:read");
        const attachment = await attachments.read(organizationId, attachmentId);
        if (!attachment) controlError("not_found", 404);
        return Response.json({ attachment });
      }
      if (request.method === "DELETE") {
        await scoped(request, organizationId, "resources:write");
        await attachments.remove(organizationId, attachmentId);
        return new Response(null, { status: 204 });
      }
    }

    const resourceMigrations =
      /^\/v1\/organizations\/([^/]+)\/resources\/([^/]+)\/migrations$/u.exec(url.pathname);
    if (resourceMigrations) {
      const organizationId = segment(resourceMigrations[1]);
      const resourceUid = segment(resourceMigrations[2]);
      if (request.method === "GET") {
        await scoped(request, organizationId, "resources:read");
        return Response.json({
          migrations: await migrations.list(organizationId, resourceUid, pageSize(url)),
        });
      }
      if (request.method === "POST") {
        await migrationActor(request, organizationId);
        const body = await jsonObject(request);
        exactKeys(body, [
          "id",
          "targetOfferingId",
          "commercialTenantRef",
          "reservationId",
          "mode",
          "transferFormat",
        ]);
        const targetOfferingId = text(body.targetOfferingId);
        const commercialTenantRef = tenantRef(body.commercialTenantRef);
        const reservationId = text(body.reservationId);
        await requireMigrationReservation({
          organizationId,
          commercialTenantRef,
          reservationId,
          targetOfferingId,
          allowCaptured: false,
        });
        const migration = await migrations.plan({
          tenantId: organizationId,
          id: text(body.id),
          resourceUid,
          targetOfferingId,
          commercialTenantRef,
          commercialAuthorizationRef: reservationId,
          mode: enumValue(body.mode, ["offline", "online"]) as "offline" | "online",
          transferFormat: text(body.transferFormat),
        });
        return Response.json({ migration }, { status: 201 });
      }
    }

    const resourceMigration =
      /^\/v1\/organizations\/([^/]+)\/resources\/([^/]+)\/migrations\/([^/]+)(?:\/(execute|cutover|rollback|cancel))?$/u.exec(
        url.pathname,
      );
    if (resourceMigration) {
      const organizationId = segment(resourceMigration[1]);
      const resourceUid = segment(resourceMigration[2]);
      const migrationId = segment(resourceMigration[3]);
      const action = resourceMigration[4];
      if (request.method === "GET" && action === undefined) {
        await scoped(request, organizationId, "resources:read");
        const migration = await migrations.read(organizationId, migrationId);
        if (!migration || migration.resourceUid !== resourceUid) controlError("not_found", 404);
        return Response.json({ migration });
      }
      if (request.method === "POST" && action !== undefined) {
        await migrationActor(request, organizationId);
        const held = await migrations.read(organizationId, migrationId);
        if (!held || held.resourceUid !== resourceUid) controlError("not_found", 404);
        if (action === "execute") {
          return Response.json({
            migration: await migrations.execute(organizationId, migrationId),
          });
        }
        if (action === "cutover") {
          if (!held.commercialTenantRef) controlError("migration_conflict", 409);
          const reservation = await requireMigrationReservation({
            organizationId,
            commercialTenantRef: held.commercialTenantRef,
            reservationId: held.commercialAuthorizationRef,
            targetOfferingId: held.targetOfferingId,
            allowCaptured: true,
          });
          const migration = await migrations.cutover(organizationId, migrationId);
          const statement = await reseller.capture({
            organizationId,
            tenantRef: held.commercialTenantRef,
            reservationId: held.commercialAuthorizationRef,
            usage: { quantity: reservation.quantity },
          });
          return Response.json({ migration, statement });
        }
        if (action === "cancel") {
          if (!held.commercialTenantRef) controlError("migration_conflict", 409);
          const heldReservation = await reseller.reservation({
            organizationId,
            tenantRef: held.commercialTenantRef,
            reservationId: held.commercialAuthorizationRef,
          });
          if (
            heldReservation.offeringId !== held.targetOfferingId ||
            heldReservation.quantity !== 1 ||
            heldReservation.status === "captured"
          ) {
            controlError("migration_commercial_authority_invalid", 409);
          }
          const migration = await migrations.cancel(organizationId, migrationId);
          const reservation =
            heldReservation.status === "active"
              ? await reseller.release({
                  organizationId,
                  tenantRef: held.commercialTenantRef,
                  reservationId: held.commercialAuthorizationRef,
                })
              : heldReservation;
          return Response.json({ migration, reservation });
        }
        return Response.json({ migration: await migrations.rollback(organizationId, migrationId) });
      }
    }

    const s3Credentials =
      /^\/v1\/organizations\/([^/]+)\/resources\/([^/]+)\/s3-credentials$/u.exec(url.pathname);
    if (request.method === "POST" && s3Credentials) {
      const organizationId = segment(s3Credentials[1]);
      const resourceUid = segment(s3Credentials[2]);
      const body = await jsonObject(request);
      exactKeys(body, ["access"], ["expiresInSeconds"]);
      const access = enumValue(body.access, ["read-only", "read-write"]) as S3Access;
      await scoped(
        request,
        organizationId,
        access === "read-write" ? "resources:write" : "resources:read",
      );
      if (!s3) controlError("backend_unavailable", 503);

      const resource = await inventory.resourceByUid(organizationId, resourceUid);
      if (!resource) controlError("not_found", 404);
      const installed = forms.find((form) =>
        sameFormRef(form.identity.formRef, resource.resource.form.formRef),
      );
      const exposesObjects = installed?.providedInterfaces?.some(
        (candidate) =>
          candidate.apiVersion === TAKOFORM_EDGE_OBJECTS_INTERFACE.apiVersion &&
          candidate.name === TAKOFORM_EDGE_OBJECTS_INTERFACE.name &&
          candidate.version === TAKOFORM_EDGE_OBJECTS_INTERFACE.version &&
          candidate.schemaDigest === TAKOFORM_EDGE_OBJECTS_INTERFACE.schemaDigest,
      );
      const deployment = await deployments.active(organizationId, resourceUid);
      if (!installed || !exposesObjects || !deployment) {
        controlError("unsupported_capability", 409);
      }
      const ready = resource.resource.status.conditions.some(
        (condition) => condition.type === "Ready" && condition.status === "True",
      );
      if (!ready) controlError("resource_not_ready", 409);

      const authority = {
        organizationId,
        resourceUid,
        deploymentId: deployment.id,
        offeringId: deployment.offeringId,
        providerPackRef: deployment.providerPackRef,
        providerInstallationRef: deployment.providerInstallationRef,
        nativeId: deployment.nativeId,
        access,
      };
      const limits = s3.limits(authority);
      if (!limits) controlError("unsupported_capability", 409);
      const ttlSeconds =
        body.expiresInSeconds === undefined
          ? limits.defaultSeconds
          : integer(body.expiresInSeconds);
      if (ttlSeconds < limits.minimumSeconds || ttlSeconds > limits.maximumSeconds) {
        controlError("invalid_argument", 400);
      }
      const issue = { ...authority, ttlSeconds };
      const connection = validateS3CredentialSet(await s3.issue(issue), issue, options.clock());
      return Response.json(
        {
          kind: "takoserver.s3-connection@v1",
          endpoint: connection.endpoint,
          region: connection.region,
          bucket: connection.bucket,
          credentials: {
            accessKeyId: connection.accessKeyId,
            secretAccessKey: connection.secretAccessKey,
            sessionToken: connection.sessionToken,
            expiresAt: connection.expiresAt,
          },
        },
        {
          status: 201,
          headers: { "cache-control": "private, no-store", pragma: "no-cache" },
        },
      );
    }

    const operations = /^\/v1\/organizations\/([^/]+)\/operations$/u.exec(url.pathname);
    if (request.method === "GET" && operations) {
      const organizationId = segment(operations[1]);
      await scoped(request, organizationId, "resources:read");
      return Response.json({
        operations: await inventory.listOperations(organizationId, pageSize(url)),
      });
    }

    return controlError("not_found", 404);
  }

  async function requireMigrationReservation(input: {
    readonly organizationId: string;
    readonly commercialTenantRef: string;
    readonly reservationId: string;
    readonly targetOfferingId: string;
    readonly allowCaptured: boolean;
  }) {
    const reservation = await reseller.reservation({
      organizationId: input.organizationId,
      tenantRef: input.commercialTenantRef,
      reservationId: input.reservationId,
    });
    if (
      reservation.offeringId !== input.targetOfferingId ||
      reservation.quantity !== 1 ||
      (reservation.status !== "active" &&
        !(input.allowCaptured && reservation.status === "captured")) ||
      (reservation.status === "active" && Date.parse(reservation.expiresAt) <= clock().getTime())
    ) {
      controlError("migration_commercial_authority_invalid", 409);
    }
    const offering = catalog.findOffering(input.targetOfferingId);
    if (!offering || (await catalog.digest(offering)) !== reservation.offeringDigest) {
      controlError("migration_commercial_authority_invalid", 409);
    }
    return reservation;
  }
}

/**
 * A resource as a console shows it.
 *
 * `status` is the resource's own account of itself and is passed through
 * unedited; conditions and outputs are what a person actually reads. The
 * provider's native id is not among them — it names the account we hold on
 * their behalf, and nothing a customer can act on.
 */
function presentResource(listing: ResourceListing): Record<string, unknown> {
  const resource = listing.resource as unknown as {
    readonly spec?: unknown;
    readonly status?: unknown;
    readonly form?: unknown;
  };
  return {
    apiVersion: listing.apiVersion,
    kind: listing.kind,
    // Two resources of the same kind are not necessarily the same thing: the
    // Form's identity includes the digest of its own schema. Omitting it would
    // leave a reader unable to tell which definition they are looking at.
    ...(resource.form === undefined ? {} : { form: resource.form }),
    metadata: {
      space: listing.space,
      name: listing.name,
      uid: listing.uid,
      generation: listing.generation,
      revision: listing.revision,
      updatedAt: listing.updatedAt,
    },
    ...(resource.spec === undefined ? {} : { spec: resource.spec }),
    ...(resource.status === undefined ? {} : { status: resource.status }),
  };
}

/** A page size a caller may ask for, within what the server will serve. */
function pageSize(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 50;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) controlError("invalid_argument", 400);
  return Math.min(value, 200);
}

export class ControlError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "ControlError";
  }
}

function controlError(code: string, status: number): never {
  throw new ControlError(code, status);
}

/**
 * Maps every failure the control plane can raise onto one envelope. Codes are
 * ours; the messages are derived from them, so no internal text escapes.
 */
export function controlErrorResponse(error: unknown): Response {
  const { code, status } = classify(error);
  return Response.json({ error: { code, message: code.replaceAll("_", " ") } }, { status });
}

function classify(error: unknown): { code: string; status: number } {
  if (error instanceof ControlError) return { code: error.code, status: error.status };
  if (error instanceof ResellerError) return { code: error.code, status: error.status };
  if (error instanceof AuthError) {
    const status =
      error.code === "unauthenticated"
        ? 401
        : error.code === "permission_denied"
          ? 403
          : error.code === "not_found"
            ? 404
            : 400;
    return { code: error.code, status };
  }
  if (error instanceof LedgerError) {
    return {
      code: error.code,
      status:
        error.code === "insufficient_funds" ? 402 : error.code === "invalid_amount" ? 400 : 500,
    };
  }
  if (error instanceof TokenError) return { code: error.code, status: 400 };
  if (error instanceof S3CredentialError) {
    return { code: error.code, status: error.code === "backend_unavailable" ? 503 : 502 };
  }
  if (error instanceof AttachmentError) {
    const status =
      error.code === "resource_not_found"
        ? 404
        : error.code === "attachment_unsupported"
          ? 422
          : 409;
    return { code: error.code, status };
  }
  if (error instanceof ResourceMigrationError) {
    const status =
      error.code === "resource_not_found"
        ? 404
        : error.code === "backend_unavailable"
          ? 503
          : error.code === "transfer_unsupported"
            ? 422
            : 409;
    return { code: error.code, status };
  }
  // A credential the verifier refused is the caller's problem to fix, and it
  // reads as an outage if it arrives as a 500. Which check failed is logged
  // rather than returned: the codes describe somebody's identity, and the
  // difference between "expired" and "wrong audience" is not the caller's to
  // learn from a stranger's token.
  if (
    error instanceof GoogleIdentityError ||
    error instanceof OperatorAssertionError ||
    error instanceof TakosIdIdentityError
  ) {
    if (process.env?.TAKOSERVER_TRACE_HOST_ERRORS) {
      console.warn(`takoserver.signin.refused ${error.name} ${error.code}`);
    }
    return { code: "unauthenticated", status: 401 };
  }
  return { code: "internal_error", status: 500 };
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=") || null;
  }
  return null;
}

function sessionCookie(token: string, secure: boolean): string {
  return [
    `takoserver_session=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=43200",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function clearSessionCookie(secure: boolean): string {
  return [
    "takoserver_session=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function organizationOf(actor: Actor): string {
  if (!actor.organizationId) throw new AuthError("permission_denied");
  return actor.organizationId;
}

async function jsonObject(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    controlError("invalid_argument", 400);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BODY_BYTES) {
    controlError("invalid_argument", 400);
  }
  try {
    const parsed = parseStrictJson(bytes, MAX_BODY_BYTES);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      controlError("invalid_argument", 400);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof StrictJsonError) controlError("invalid_argument", 400);
    throw error;
  }
}

/**
 * Exactly the required keys, plus any of the optional ones.
 *
 * Refusing an unknown key is what keeps a typo from being silently ignored —
 * a request that looks accepted and did something other than what it said.
 */
function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(value);
  const missing = required.filter((key) => !actual.includes(key));
  const unknown = actual.filter((key) => !required.includes(key) && !optional.includes(key));
  if (missing.length > 0 || unknown.length > 0) controlError("invalid_argument", 400);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    controlError("invalid_argument", 400);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return bounded(value, 1_024);
}

/**
 * A string field with its own length.
 *
 * The general bound is sized for a name, and a signed assertion is not a name:
 * a Google ID token routinely runs past a kilobyte, so the ordinary limit
 * rejected every real sign-in as a malformed request. Bounds belong to fields,
 * not to types.
 */
function bounded(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) {
    controlError("invalid_argument", 400);
  }
  return value as string;
}

function tenantRef(value: unknown): string {
  const parsed = text(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(parsed)) controlError("invalid_argument", 400);
  return parsed;
}

function resourceName(value: unknown): string {
  const parsed = text(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(parsed)) {
    controlError("invalid_argument", 400);
  }
  return parsed;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)) controlError("invalid_argument", 400);
  return value as number;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) controlError("invalid_argument", 400);
  return value;
}

function enumValue(value: unknown, allowed: readonly string[]): string {
  const parsed = text(value);
  if (!allowed.includes(parsed)) controlError("invalid_argument", 400);
  return parsed;
}

function scopeList(value: unknown): readonly ApiKeyScope[] {
  if (!Array.isArray(value)) controlError("invalid_argument", 400);
  const scopes = value as unknown[];
  if (
    scopes.some((scope) => typeof scope !== "string" || !API_KEY_SCOPES.includes(scope as never))
  ) {
    controlError("invalid_argument", 400);
  }
  return scopes as readonly ApiKeyScope[];
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    controlError("invalid_argument", 400);
  }
  const values = value as unknown[];
  if (values.some((item) => typeof item !== "string")) {
    controlError("invalid_argument", 400);
  }
  return values as readonly string[];
}

function segment(value: string | undefined): string {
  if (!value || value.includes("%") || value.length > 128) controlError("invalid_argument", 400);
  return value;
}

function requiredQuery(url: URL, key: string): string {
  const values = url.searchParams.getAll(key);
  if (values.length !== 1 || !values[0]) controlError("invalid_argument", 400);
  return values[0];
}
