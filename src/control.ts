import { type Accounts, type Actor, API_KEY_SCOPES, type ApiKeyScope, AuthError } from "./auth.ts";
import type { Catalog } from "./catalog.ts";
import { type FundingSettlementVerifier, type Ledger, LedgerError } from "./ledger.ts";
import type { Clock } from "./ports.ts";
import { type Reseller, ResellerError } from "./reseller.ts";
import { parseStrictJson, StrictJsonError } from "./strict-json.ts";
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

export interface CreateControlRoutesOptions {
  readonly accounts: Accounts;
  readonly ledger: Ledger;
  readonly catalog: Catalog;
  readonly reseller: Reseller;
  readonly tokens: TokenService;
  readonly settlement: FundingSettlementVerifier;
  readonly clock: Clock;
}

export type ControlRoutes = (request: Request, url: URL) => Promise<Response | null>;

export function createControlRoutes(options: CreateControlRoutesOptions): ControlRoutes {
  const { accounts, ledger, catalog, reseller, tokens, settlement } = options;

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
    if (actor.organizationId !== organizationId || !actor.scopes.includes(scope)) {
      throw new AuthError("permission_denied");
    }
    return actor;
  };

  const resellerActor = async (request: Request): Promise<Actor> => {
    const actor = await accounts.authenticate(authorization(request));
    if (!actor?.organizationId || !actor.scopes.includes("reseller:write")) {
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
    if (request.method === "GET" && url.pathname === "/v1/identity/providers") {
      return Response.json({ providers: ["google", "github"] });
    }

    if (request.method === "POST" && url.pathname === "/v1/sessions") {
      const body = await jsonObject(request);
      exactKeys(body, ["provider", "assertion"]);
      const { principal, sessionToken } = await accounts.signIn({
        provider: enumValue(body.provider, ["google", "github"]) as "google" | "github",
        assertion: text(body.assertion),
      });
      return Response.json({ principal, sessionToken });
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
            price: offering.price,
            protocols: offering.protocols,
            ...(offering.regions ? { regions: offering.regions } : {}),
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
      /^\/v1\/reseller\/reservations\/([^/]+)\/(capture|release|provision-tokens)$/u.exec(
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
        exactKeys(usage, ["meter", "quantity"]);
        const statement = await reseller.capture({
          organizationId,
          tenantRef: tenantRef(body.tenantRef),
          reservationId,
          usage: { meter: text(usage.meter), quantity: number(usage.quantity) },
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

    return controlError("not_found", 404);
  }
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
  return { code: "internal_error", status: 500 };
}

function authorization(request: Request): string | null {
  return request.headers.get("authorization");
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

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    controlError("invalid_argument", 400);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    controlError("invalid_argument", 400);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) {
    controlError("invalid_argument", 400);
  }
  return value as string;
}

function tenantRef(value: unknown): string {
  const parsed = text(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(parsed)) controlError("invalid_argument", 400);
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

function segment(value: string | undefined): string {
  if (!value || value.includes("%") || value.length > 128) controlError("invalid_argument", 400);
  return value;
}

function requiredQuery(url: URL, key: string): string {
  const values = url.searchParams.getAll(key);
  if (values.length !== 1 || !values[0]) controlError("invalid_argument", 400);
  return values[0];
}
