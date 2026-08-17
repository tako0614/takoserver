import type { BackendAdapter } from "./backends.ts";
import type {
  ApiKey,
  ApiKeyScope,
  ExecutionGrant,
  ExternalIdentityVerifier,
  FundingSettlementVerifier,
  LedgerEntry,
  Organization,
  Principal,
  Quote,
  Reservation,
  ServiceOffering,
  TakoserverCommand,
  TakoserverModule,
  TakoserverResult,
  UsageStatement,
  Wallet,
} from "./contracts.ts";
import { TakoserverError } from "./contracts.ts";
import type { ProvisioningCommit } from "./resource-runtime.ts";
import type { ExecutionGrantSigner } from "./runtime-grants.ts";
import { executionIntentDigest } from "./runtime-grants.ts";

export interface CreateTakoserverOptions {
  readonly identity: ExternalIdentityVerifier;
  readonly backends: readonly BackendAdapter[];
  readonly randomToken?: () => string;
  readonly clock?: () => Date;
  readonly grantSigner?: ExecutionGrantSigner;
  readonly fundingSettlement?: FundingSettlementVerifier;
}

export function createTakoserver(options: CreateTakoserverOptions): TakoserverModule {
  if (!options.identity || typeof options.identity.verify !== "function") {
    throw new TypeError("identity verifier is required");
  }
  if (options.backends.length === 0) throw new TypeError("at least one backend is required");

  const randomToken = options.randomToken ?? secureRandomToken;
  const clock = options.clock ?? (() => new Date());
  const principals = new Map<string, Principal>();
  const sessions = new Map<string, string>();
  const organizations = new Map<string, StoredOrganization>();
  const apiKeys = new Map<string, StoredApiKey>();
  const ledgers = new Map<string, LedgerEntry[]>();
  const fundingReferences = new Map<
    string,
    { readonly amountMinor: number; readonly entry: LedgerEntry }
  >();
  const quotes = new Map<string, StoredQuote>();
  const reservations = new Map<string, StoredReservation>();
  const idempotency = new Map<string, StoredIdempotency>();
  const runtimeResources = new Map<string, StoredRuntimeResource>();
  const usageStatements = new Map<string, UsageStatement>();

  return {
    async authorizeOrganization(authorization, requiredScope) {
      if (!authorization || !ALLOWED_SCOPES.includes(requiredScope)) return null;
      try {
        const actor = await authenticate(authorization, sessions, apiKeys, clock);
        if (actor.kind !== "api-key" || !actor.scopes.includes(requiredScope)) return null;
        if (!organizations.has(actor.organizationId)) return null;
        return {
          organizationId: actor.organizationId,
          principalId: actor.principalId,
        };
      } catch {
        return null;
      }
    },
    async commitProvisioning(input: ProvisioningCommit): Promise<void> {
      const { claims, resource, usage } = input;
      if (claims.operation !== "resource.provision") {
        throw new TakoserverError("permission_denied", 403);
      }
      const reservation = reservations.get(claims.reservationId);
      if (
        !reservation ||
        reservation.tenantRef !== claims.tenantRef ||
        reservation.offeringId !== claims.offeringId ||
        reservation.offeringDigest !== claims.offeringDigest
      ) {
        throw new TakoserverError("not_found", 404);
      }
      const organization = organizations.get(reservation.organizationId);
      if (!organization || organization.securityDomainId !== claims.securityDomainId) {
        throw new TakoserverError("not_found", 404);
      }
      expireReservationIfNeeded(reservation, ledgers, clock);
      if (reservation.status !== "active" && reservation.status !== "captured") {
        ensureActiveReservation(reservation);
      }
      if (usage.meter !== reservation.meter || usage.quantity !== reservation.quantity) {
        throw invalid("provisioned usage does not match the reserved quote");
      }
      if (
        resource.id !== `resource_${reservation.id}` ||
        resource.tenantRef !== reservation.tenantRef ||
        resource.offeringId !== reservation.offeringId ||
        resource.backendId !== reservation.backendId ||
        canonicalJson(resource.form) !== canonicalJson(reservation.form)
      ) {
        throw new TakoserverError("conflict", 409, "provisioned resource identity mismatch");
      }
      const resourceKey = runtimeResourceKey(
        organization.securityDomainId,
        reservation.tenantRef,
        resource.id,
      );
      const stored: StoredRuntimeResource = Object.freeze({
        organizationId: organization.id,
        securityDomainId: organization.securityDomainId,
        tenantRef: reservation.tenantRef,
        resourceRef: resource.id,
        reservationId: reservation.id,
        offeringId: reservation.offeringId,
        offeringDigest: reservation.offeringDigest,
        backendId: resource.backendId,
        nativeId: opaqueReference(resource.nativeId, "native resource id"),
        allowances: structuredClone(reservation.allowances),
      });
      const existing = runtimeResources.get(resourceKey);
      if (existing && canonicalJson(existing) !== canonicalJson(stored)) {
        throw new TakoserverError("conflict", 409, "resource registration mismatch");
      }
      if (!existing) {
        if (reservation.status === "active") {
          captureReservation(reservation, ledgers, usageStatements, clock);
        } else if (!usageStatements.has(reservation.id)) {
          throw new TakoserverError("internal_error", 500, "captured usage statement is missing");
        }
        runtimeResources.set(resourceKey, stored);
      }
    },
    async execute(command: TakoserverCommand): Promise<TakoserverResult> {
      switch (command.kind) {
        case "identity.exchange": {
          const verified = await options.identity.verify({
            provider: command.provider,
            assertion: nonEmpty(command.assertion, "identity assertion"),
          });
          const providerSubject = nonEmpty(verified.providerSubject, "provider subject");
          const identityKey = `${command.provider}:${providerSubject}`;
          const principal =
            principals.get(identityKey) ??
            Object.freeze({
              id: `principal_${crypto.randomUUID()}`,
              identity: Object.freeze({
                provider: command.provider,
                providerSubject,
              }),
              email: nonEmpty(verified.email, "verified email"),
              displayName: nonEmpty(verified.displayName, "display name"),
            });
          principals.set(identityKey, principal);
          const sessionToken = `tks_session_${randomToken()}`;
          sessions.set(await digest(sessionToken), principal.id);
          return { kind: "identity.exchanged", principal, sessionToken };
        }
        case "organization.create": {
          const actor = await authenticate(command.authorization, sessions, apiKeys, clock);
          if (actor.kind !== "session") throw forbidden();
          const organization = Object.freeze({
            id: `org_${crypto.randomUUID()}`,
            name: nonEmpty(command.name, "organization name"),
            createdAt: clock().toISOString(),
            ownerPrincipalId: actor.principalId,
            securityDomainId: `domain_${crypto.randomUUID()}`,
          });
          organizations.set(organization.id, organization);
          return { kind: "organization.created", organization: publicOrganization(organization) };
        }
        case "api-key.create": {
          const actor = await authenticate(command.authorization, sessions, apiKeys, clock);
          const organization = ownedOrganization(
            organizations,
            command.organizationId,
            actor.principalId,
          );
          if (actor.kind !== "session" || organization.ownerPrincipalId !== actor.principalId) {
            throw forbidden();
          }
          const scopes = validatedScopes(command.scopes);
          const expiresInSeconds = positiveInteger(command.expiresInSeconds, "API key lifetime");
          if (expiresInSeconds > 90 * 24 * 60 * 60) {
            throw invalid("API key lifetime exceeds 90 days");
          }
          const secret = `tks_key_${randomToken()}`;
          const createdAt = clock();
          const apiKey = Object.freeze({
            id: `key_${crypto.randomUUID()}`,
            organizationId: organization.id,
            name: nonEmpty(command.name, "API key name"),
            scopes,
            createdAt: createdAt.toISOString(),
            expiresAt: new Date(createdAt.getTime() + expiresInSeconds * 1_000).toISOString(),
            principalId: actor.principalId,
            digest: await digest(secret),
          });
          apiKeys.set(apiKey.digest, apiKey);
          return { kind: "api-key.created", apiKey: publicApiKey(apiKey), secret };
        }
        case "api-key.revoke": {
          const actor = await authenticate(command.authorization, sessions, apiKeys, clock);
          const organization = ownedOrganization(
            organizations,
            command.organizationId,
            actor.principalId,
          );
          if (actor.kind !== "session" || organization.ownerPrincipalId !== actor.principalId) {
            throw forbidden();
          }
          const apiKeyId = opaqueReference(command.apiKeyId, "API key id");
          const apiKey = [...apiKeys.values()].find(
            (candidate) =>
              candidate.id === apiKeyId && candidate.organizationId === command.organizationId,
          );
          if (!apiKey) throw new TakoserverError("not_found", 404);
          const revoked =
            apiKey.revokedAt === undefined
              ? { ...apiKey, revokedAt: clock().toISOString() }
              : apiKey;
          apiKeys.set(apiKey.digest, revoked);
          return { kind: "api-key.revoked", apiKey: publicApiKey(revoked) };
        }
        case "wallet.get": {
          const actor = await authenticate(command.authorization, sessions, apiKeys, clock);
          authorizeOrganization(actor, organizations, command.organizationId, "wallet:read");
          expireReservations(command.organizationId, reservations, ledgers, clock);
          return {
            kind: "wallet.read",
            wallet: walletSnapshot(command.organizationId, ledgers),
          };
        }
        case "wallet.fund": {
          const actor = await authenticate(command.authorization, sessions, apiKeys, clock);
          const organization = ownedOrganization(
            organizations,
            command.organizationId,
            actor.principalId,
          );
          if (actor.kind !== "session" || organization.ownerPrincipalId !== actor.principalId) {
            throw forbidden();
          }
          const settlementProof = nonEmpty(command.settlementProof, "settlement proof");
          return idempotent(
            idempotency,
            `${command.organizationId}:wallet.fund:${idempotencyKey(command.idempotencyKey)}`,
            { settlementProof },
            async () => {
              if (!options.fundingSettlement) {
                throw new TakoserverError(
                  "internal_error",
                  500,
                  "funding settlement verifier is not configured",
                );
              }
              const settlement = await options.fundingSettlement.verify({
                organizationId: command.organizationId,
                settlementProof,
              });
              if (settlement.currency !== "USD") throw invalid("unsupported funding currency");
              const amountMinor = positiveInteger(settlement.amountMinor, "funding amount");
              const fundingRef = opaqueReference(settlement.fundingRef, "funding reference");
              const fundingKey = `${command.organizationId}:${fundingRef}`;
              const existing = fundingReferences.get(fundingKey);
              if (existing) {
                if (existing.amountMinor !== amountMinor) {
                  throw new TakoserverError(
                    "conflict",
                    409,
                    "funding reference was reused with different input",
                  );
                }
                return {
                  kind: "wallet.funded",
                  entry: existing.entry,
                  wallet: walletSnapshot(command.organizationId, ledgers),
                };
              }
              const entry = ledgerEntry(
                clock,
                command.organizationId,
                "funding",
                fundingRef,
                amountMinor,
                0,
              );
              appendLedger(ledgers, entry);
              fundingReferences.set(fundingKey, { amountMinor, entry });
              return {
                kind: "wallet.funded",
                entry,
                wallet: walletSnapshot(command.organizationId, ledgers),
              };
            },
          );
        }
        case "reseller.quote": {
          const actor = await authenticate(command.authorization, sessions, apiKeys, clock);
          authorizeOrganization(actor, organizations, command.organizationId, "reseller:write");
          const tenantRef = tenantReference(command.tenantRef);
          const offeringId = opaqueReference(command.offeringId, "offering id");
          const quantity = positiveInteger(command.quantity, "quantity");
          return idempotent(
            idempotency,
            `${command.organizationId}:reseller.quote:${idempotencyKey(command.idempotencyKey)}`,
            { tenantRef, offeringId, quantity },
            async () => {
              const offering = await findOffering(options.backends, offeringId);
              if (!offering.available) throw new TakoserverError("not_found", 404);
              const amountMinor = safeMultiply(offering.price.unitPriceMinor, quantity);
              const quote: StoredQuote = Object.freeze({
                id: `quote_${crypto.randomUUID()}`,
                organizationId: command.organizationId,
                tenantRef,
                offeringId,
                quantity,
                currency: "USD",
                amountMinor,
                meter: offering.price.unit,
                backendId: offering.backendId,
                form: structuredClone(offering.form),
                allowances: structuredClone(offering.allowances),
                offeringDigest: await offeringContractDigest(offering),
                expiresAt: plusMilliseconds(clock(), 10 * 60 * 1_000).toISOString(),
              });
              quotes.set(quote.id, quote);
              return { kind: "reseller.quoted", quote: publicQuote(quote) };
            },
          );
        }
        case "reseller.reserve": {
          const actor = await authenticate(command.authorization, sessions, apiKeys, clock);
          authorizeOrganization(actor, organizations, command.organizationId, "reseller:write");
          const tenantRef = tenantReference(command.tenantRef);
          const quoteId = opaqueReference(command.quoteId, "quote id");
          return idempotent(
            idempotency,
            `${command.organizationId}:reseller.reserve:${idempotencyKey(command.idempotencyKey)}`,
            { tenantRef, quoteId },
            async () => {
              const quote = quotes.get(quoteId);
              if (
                !quote ||
                quote.organizationId !== command.organizationId ||
                quote.tenantRef !== tenantRef
              ) {
                throw new TakoserverError("not_found", 404);
              }
              if (clock().getTime() >= Date.parse(quote.expiresAt)) throw expired();
              const wallet = walletSnapshot(command.organizationId, ledgers);
              if (wallet.availableMinor < quote.amountMinor) {
                throw new TakoserverError("insufficient_funds", 402);
              }
              const reservation: StoredReservation = {
                id: `reservation_${crypto.randomUUID()}`,
                organizationId: command.organizationId,
                tenantRef,
                quoteId: quote.id,
                offeringId: quote.offeringId,
                amountMinor: quote.amountMinor,
                meter: quote.meter,
                backendId: quote.backendId,
                form: structuredClone(quote.form),
                allowances: structuredClone(quote.allowances),
                offeringDigest: quote.offeringDigest,
                quantity: quote.quantity,
                currency: "USD",
                status: "active",
                expiresAt: new Date(
                  Math.min(
                    Date.parse(quote.expiresAt),
                    plusMilliseconds(clock(), 5 * 60 * 1_000).getTime(),
                  ),
                ).toISOString(),
              };
              reservations.set(reservation.id, reservation);
              appendLedger(
                ledgers,
                ledgerEntry(
                  clock,
                  command.organizationId,
                  "reservation_hold",
                  reservation.id,
                  0,
                  reservation.amountMinor,
                ),
              );
              return {
                kind: "reseller.reserved",
                reservation: publicReservation(reservation),
                wallet: walletSnapshot(command.organizationId, ledgers),
              };
            },
          );
        }
        case "reseller.capture": {
          const actor = await authenticate(command.authorization, sessions, apiKeys, clock);
          authorizeOrganization(actor, organizations, command.organizationId, "reseller:write");
          const tenantRef = tenantReference(command.tenantRef);
          const reservationId = opaqueReference(command.reservationId, "reservation id");
          const usage = {
            meter: opaqueReference(command.usage.meter, "usage meter"),
            quantity: positiveNumber(command.usage.quantity, "usage quantity"),
          };
          return idempotent(
            idempotency,
            `${command.organizationId}:reseller.capture:${idempotencyKey(command.idempotencyKey)}`,
            { tenantRef, reservationId, usage },
            async () => {
              const reservation = matchingReservation(
                reservations,
                reservationId,
                command.organizationId,
                tenantRef,
              );
              expireReservationIfNeeded(reservation, ledgers, clock);
              ensureActiveReservation(reservation);
              if (usage.meter !== reservation.meter || usage.quantity !== reservation.quantity) {
                throw invalid("usage does not match the reserved quote");
              }
              const statement = captureReservation(reservation, ledgers, usageStatements, clock);
              return {
                kind: "reseller.captured",
                reservation: publicReservation(reservation),
                statement,
                wallet: walletSnapshot(command.organizationId, ledgers),
              };
            },
          );
        }
        case "reseller.release": {
          const actor = await authenticate(command.authorization, sessions, apiKeys, clock);
          authorizeOrganization(actor, organizations, command.organizationId, "reseller:write");
          const tenantRef = tenantReference(command.tenantRef);
          const reservationId = opaqueReference(command.reservationId, "reservation id");
          return idempotent(
            idempotency,
            `${command.organizationId}:reseller.release:${idempotencyKey(command.idempotencyKey)}`,
            { tenantRef, reservationId },
            async () => {
              const reservation = matchingReservation(
                reservations,
                reservationId,
                command.organizationId,
                tenantRef,
              );
              expireReservationIfNeeded(reservation, ledgers, clock);
              ensureActiveReservation(reservation);
              const entry = releaseReservation(reservation, "released", ledgers, clock);
              return {
                kind: "reseller.released",
                reservation: publicReservation(reservation),
                entry,
                wallet: walletSnapshot(command.organizationId, ledgers),
              };
            },
          );
        }
        case "reseller.grant": {
          const actor = await authenticate(command.authorization, sessions, apiKeys, clock);
          const organization = authorizeOrganization(
            actor,
            organizations,
            command.organizationId,
            "reseller:write",
          );
          const tenantRef = tenantReference(command.tenantRef);
          const reservationId = opaqueReference(command.reservationId, "reservation id");
          const audience = "takoserver.runtime.v1";
          const expiresInSeconds = positiveInteger(command.expiresInSeconds, "grant lifetime");
          if (expiresInSeconds > 300) throw invalid("grant lifetime exceeds 300 seconds");
          const intentDigest = await executionIntentDigest(command.intent);
          return idempotent(
            idempotency,
            `${command.organizationId}:reseller.grant:${idempotencyKey(command.idempotencyKey)}`,
            {
              tenantRef,
              reservationId,
              audience,
              operation: command.operation,
              intentDigest,
              expiresInSeconds,
            },
            async () => {
              const reservation = matchingReservation(
                reservations,
                reservationId,
                command.organizationId,
                tenantRef,
              );
              expireReservationIfNeeded(reservation, ledgers, clock);
              if (command.operation === "resource.provision") {
                ensureActiveReservation(reservation);
              } else if (command.operation === "resource.delete") {
                throw invalid("resource delete grants are not available");
              } else {
                if (reservation.status !== "captured") {
                  throw new TakoserverError("conflict", 409, "resource is not provisioned");
                }
                const resourceRef = runtimeIntentResourceRef(command.intent, tenantRef);
                const registered = runtimeResources.get(
                  runtimeResourceKey(organization.securityDomainId, tenantRef, resourceRef),
                );
                if (
                  !registered ||
                  registered.reservationId !== reservation.id ||
                  registered.offeringId !== reservation.offeringId ||
                  registered.offeringDigest !== reservation.offeringDigest
                ) {
                  throw new TakoserverError("not_found", 404);
                }
                if (!resourceAllowsOperation(registered, command.operation)) {
                  throw invalid("operation is not allowed by the provisioned resource");
                }
              }
              if (!options.grantSigner) {
                throw new TakoserverError("internal_error", 500, "grant signer is not configured");
              }
              const issuedAt = clock();
              const expiresAt = new Date(
                Math.min(
                  issuedAt.getTime() + expiresInSeconds * 1_000,
                  Date.parse(reservation.expiresAt),
                ),
              );
              if (expiresAt.getTime() <= issuedAt.getTime()) throw expired();
              const token = await options.grantSigner.issue({
                audience,
                securityDomainId: organization.securityDomainId,
                tenantRef,
                reservationId,
                offeringId: reservation.offeringId,
                offeringDigest: reservation.offeringDigest,
                operation: command.operation,
                intentDigest,
                issuedAt,
                expiresAt,
                grantId: `grant_${randomToken()}`,
              });
              const grant: ExecutionGrant = Object.freeze({
                token,
                tenantRef,
                reservationId,
                offeringId: reservation.offeringId,
                audience,
                operation: command.operation,
                intentDigest,
                expiresAt: expiresAt.toISOString(),
              });
              return { kind: "reseller.granted", grant };
            },
          );
        }
        case "catalog.list": {
          const actor = await authenticate(command.authorization, sessions, apiKeys, clock);
          authorizeOrganization(actor, organizations, command.organizationId, "catalog:read");
          return { kind: "catalog.listed", offerings: await listOfferings(options.backends) };
        }
        case "usage.get": {
          const actor = await authenticate(command.authorization, sessions, apiKeys, clock);
          authorizeOrganization(actor, organizations, command.organizationId, "usage:read");
          const tenantRef = tenantReference(command.tenantRef);
          const reservationId = opaqueReference(command.reservationId, "reservation id");
          matchingReservation(reservations, reservationId, command.organizationId, tenantRef);
          const statement = usageStatements.get(reservationId);
          if (!statement) throw new TakoserverError("not_found", 404);
          return { kind: "usage.read", statement: structuredClone(statement) };
        }
      }
    },
  };
}

type StoredOrganization = Organization & {
  readonly ownerPrincipalId: string;
  readonly securityDomainId: string;
};
type StoredApiKey = ApiKey & {
  readonly principalId: string;
  readonly digest: string;
  revokedAt?: string;
};
type StoredQuote = Quote & {
  readonly organizationId: string;
  readonly meter: string;
  readonly backendId: string;
  readonly form: import("./contracts.ts").ExactFormRef;
  readonly allowances: readonly import("./contracts.ts").ServiceAllowance[];
  readonly offeringDigest: `sha256:${string}`;
};
type StoredReservation = Omit<Reservation, "status"> & {
  readonly organizationId: string;
  readonly meter: string;
  readonly backendId: string;
  readonly form: import("./contracts.ts").ExactFormRef;
  readonly allowances: readonly import("./contracts.ts").ServiceAllowance[];
  readonly offeringDigest: `sha256:${string}`;
  readonly quantity: number;
  status: Reservation["status"];
};
interface StoredRuntimeResource {
  readonly organizationId: string;
  readonly securityDomainId: string;
  readonly tenantRef: string;
  readonly resourceRef: string;
  readonly reservationId: string;
  readonly offeringId: string;
  readonly offeringDigest: `sha256:${string}`;
  readonly backendId: string;
  readonly nativeId: string;
  readonly allowances: readonly import("./contracts.ts").ServiceAllowance[];
}
interface StoredIdempotency {
  readonly fingerprint: string;
  readonly result: Promise<TakoserverResult>;
}
type Actor =
  | { readonly kind: "session"; readonly principalId: string }
  | {
      readonly kind: "api-key";
      readonly principalId: string;
      readonly organizationId: string;
      readonly scopes: readonly ApiKeyScope[];
    };

async function authenticate(
  authorization: string,
  sessions: ReadonlyMap<string, string>,
  apiKeys: ReadonlyMap<string, StoredApiKey>,
  clock: () => Date,
): Promise<Actor> {
  const match = /^Bearer ([^\s]+)$/u.exec(authorization);
  if (!match?.[1]) throw unauthenticated();
  const tokenDigest = await digest(match[1]);
  const principalId = sessions.get(tokenDigest);
  if (principalId !== undefined) return { kind: "session", principalId };
  const apiKey = apiKeys.get(tokenDigest);
  if (apiKey !== undefined) {
    if (apiKey.revokedAt !== undefined || clock().getTime() >= Date.parse(apiKey.expiresAt)) {
      throw unauthenticated();
    }
    return {
      kind: "api-key",
      principalId: apiKey.principalId,
      organizationId: apiKey.organizationId,
      scopes: apiKey.scopes,
    };
  }
  throw unauthenticated();
}

function authorizeOrganization(
  actor: Actor,
  organizations: ReadonlyMap<string, StoredOrganization>,
  organizationId: string,
  scope: ApiKeyScope,
): StoredOrganization {
  const organization = organizations.get(organizationId);
  if (!organization) throw forbidden();
  if (actor.kind === "session") {
    if (organization.ownerPrincipalId !== actor.principalId) throw forbidden();
    return organization;
  }
  if (actor.organizationId !== organizationId || !actor.scopes.includes(scope)) throw forbidden();
  return organization;
}

function ownedOrganization(
  organizations: ReadonlyMap<string, StoredOrganization>,
  organizationId: string,
  principalId: string,
): StoredOrganization {
  const organization = organizations.get(organizationId);
  if (!organization || organization.ownerPrincipalId !== principalId) throw forbidden();
  return organization;
}

const ALLOWED_SCOPES: readonly ApiKeyScope[] = [
  "catalog:read",
  "resources:write",
  "wallet:read",
  "reseller:write",
  "usage:read",
];

function validatedScopes(scopes: readonly ApiKeyScope[]): readonly ApiKeyScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0 || new Set(scopes).size !== scopes.length) {
    throw invalid("API key scopes must be a non-empty unique list");
  }
  if (scopes.some((scope) => !ALLOWED_SCOPES.includes(scope))) {
    throw invalid("unknown API key scope");
  }
  return Object.freeze([...scopes]);
}

function publicOrganization(organization: StoredOrganization): Organization {
  return {
    id: organization.id,
    name: organization.name,
    createdAt: organization.createdAt,
  };
}

function publicApiKey(apiKey: StoredApiKey): ApiKey {
  return {
    id: apiKey.id,
    organizationId: apiKey.organizationId,
    name: apiKey.name,
    scopes: apiKey.scopes,
    createdAt: apiKey.createdAt,
    expiresAt: apiKey.expiresAt,
  };
}

async function findOffering(
  backends: readonly BackendAdapter[],
  offeringId: string,
): Promise<ServiceOffering> {
  let found: ServiceOffering | undefined;
  for (const backend of backends) {
    for (const offering of await backend.discover()) {
      if (offering.id !== offeringId) continue;
      if (found) throw new TakoserverError("internal_error", 500, "offering id is ambiguous");
      found = {
        ...structuredClone(offering),
        backendId: backend.id,
        available: offering.available !== false,
      };
    }
  }
  if (!found) throw new TakoserverError("not_found", 404);
  return found;
}

async function listOfferings(
  backends: readonly BackendAdapter[],
): Promise<readonly ServiceOffering[]> {
  const offerings: ServiceOffering[] = [];
  const ids = new Set<string>();
  for (const backend of backends) {
    for (const offering of await backend.discover()) {
      if (ids.has(offering.id)) {
        throw new TakoserverError("internal_error", 500, "offering id is ambiguous");
      }
      ids.add(offering.id);
      offerings.push({
        ...structuredClone(offering),
        backendId: backend.id,
        available: offering.available !== false,
      });
    }
  }
  return offerings.sort((left, right) => left.id.localeCompare(right.id));
}

async function offeringContractDigest(offering: ServiceOffering): Promise<`sha256:${string}`> {
  return executionIntentDigest({
    id: offering.id,
    backendId: offering.backendId,
    kind: offering.kind,
    form: offering.form,
    price: offering.price,
    allowances: offering.allowances,
  });
}

function resourceAllowsOperation(
  resource: StoredRuntimeResource,
  operation: import("./runtime-grants.ts").ExecutionOperation,
): boolean {
  const protocol = operation === "s3.access" ? "s3" : operation === "ai.invoke" ? "openai" : null;
  return (
    protocol !== null &&
    resource.allowances.some(
      (allowance) =>
        allowance.protocol === protocol &&
        allowance.mode === "direct" &&
        allowance.authority === "resource_scoped_grant",
    )
  );
}

function runtimeIntentResourceRef(
  intent: import("./backends.ts").JsonObject,
  tenantRef: string,
): string {
  if (intent.tenantRef !== tenantRef || typeof intent.resourceRef !== "string") {
    throw invalid("data-plane intent is not bound to the provisioned tenant and resource");
  }
  return opaqueReference(intent.resourceRef, "resource reference");
}

function runtimeResourceKey(
  securityDomainId: string,
  tenantRef: string,
  resourceRef: string,
): string {
  return `${securityDomainId}:${tenantRef}:${resourceRef}`;
}

async function idempotent(
  store: Map<string, StoredIdempotency>,
  key: string,
  input: unknown,
  action: () => Promise<TakoserverResult>,
): Promise<TakoserverResult> {
  const fingerprint = canonicalJson(input);
  const existing = store.get(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new TakoserverError("conflict", 409, "idempotency key was reused with different input");
    }
    return structuredClone(await existing.result);
  }
  const result = action();
  store.set(key, { fingerprint, result });
  try {
    return structuredClone(await result);
  } catch (error) {
    store.delete(key);
    throw error;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function walletSnapshot(
  organizationId: string,
  ledgers: ReadonlyMap<string, readonly LedgerEntry[]>,
): Wallet {
  const entries = ledgers.get(organizationId) ?? [];
  const settledMinor = entries.reduce((sum, entry) => sum + entry.settledDeltaMinor, 0);
  const heldMinor = entries.reduce((sum, entry) => sum + entry.heldDeltaMinor, 0);
  const availableMinor = settledMinor - heldMinor;
  if (settledMinor < 0 || heldMinor < 0 || availableMinor < 0) {
    throw new TakoserverError("internal_error", 500, "ledger conservation invariant failed");
  }
  return {
    organizationId,
    currency: "USD",
    settledMinor,
    heldMinor,
    availableMinor,
    entries: structuredClone(entries),
  };
}

function appendLedger(ledgers: Map<string, LedgerEntry[]>, entry: LedgerEntry): void {
  const current = ledgers.get(entry.organizationId) ?? [];
  const next = [...current, entry];
  walletSnapshot(entry.organizationId, new Map([[entry.organizationId, next]]));
  ledgers.set(entry.organizationId, next);
}

function ledgerEntry(
  clock: () => Date,
  organizationId: string,
  type: LedgerEntry["type"],
  reference: string,
  settledDeltaMinor: number,
  heldDeltaMinor: number,
): LedgerEntry {
  return Object.freeze({
    id: `ledger_${crypto.randomUUID()}`,
    organizationId,
    type,
    reference,
    settledDeltaMinor,
    heldDeltaMinor,
    createdAt: clock().toISOString(),
  });
}

function publicQuote(quote: StoredQuote): Quote {
  return {
    id: quote.id,
    tenantRef: quote.tenantRef,
    offeringId: quote.offeringId,
    quantity: quote.quantity,
    currency: quote.currency,
    amountMinor: quote.amountMinor,
    expiresAt: quote.expiresAt,
  };
}

function publicReservation(reservation: StoredReservation): Reservation {
  return {
    id: reservation.id,
    tenantRef: reservation.tenantRef,
    quoteId: reservation.quoteId,
    offeringId: reservation.offeringId,
    amountMinor: reservation.amountMinor,
    currency: reservation.currency,
    status: reservation.status,
    expiresAt: reservation.expiresAt,
  };
}

function matchingReservation(
  reservations: ReadonlyMap<string, StoredReservation>,
  reservationId: string,
  organizationId: string,
  tenantRef: string,
): StoredReservation {
  const reservation = reservations.get(reservationId);
  if (
    !reservation ||
    reservation.organizationId !== organizationId ||
    reservation.tenantRef !== tenantRef
  ) {
    throw new TakoserverError("not_found", 404);
  }
  return reservation;
}

function ensureActiveReservation(reservation: StoredReservation): void {
  if (reservation.status === "expired") throw expired();
  if (reservation.status !== "active") {
    throw new TakoserverError("conflict", 409, "reservation is not active");
  }
}

function captureReservation(
  reservation: StoredReservation,
  ledgers: Map<string, LedgerEntry[]>,
  usageStatements: Map<string, UsageStatement>,
  clock: () => Date,
): UsageStatement {
  appendLedger(
    ledgers,
    ledgerEntry(
      clock,
      reservation.organizationId,
      "capture",
      reservation.id,
      -reservation.amountMinor,
      -reservation.amountMinor,
    ),
  );
  reservation.status = "captured";
  const statement: UsageStatement = Object.freeze({
    id: `usage_${crypto.randomUUID()}`,
    reservationId: reservation.id,
    tenantRef: reservation.tenantRef,
    offeringId: reservation.offeringId,
    currency: "USD",
    amountMinor: reservation.amountMinor,
    usage: { meter: reservation.meter, quantity: reservation.quantity },
    capturedAt: clock().toISOString(),
  });
  usageStatements.set(reservation.id, statement);
  return statement;
}

function expireReservations(
  organizationId: string,
  reservations: ReadonlyMap<string, StoredReservation>,
  ledgers: Map<string, LedgerEntry[]>,
  clock: () => Date,
): void {
  for (const reservation of reservations.values()) {
    if (reservation.organizationId === organizationId) {
      expireReservationIfNeeded(reservation, ledgers, clock);
    }
  }
}

function expireReservationIfNeeded(
  reservation: StoredReservation,
  ledgers: Map<string, LedgerEntry[]>,
  clock: () => Date,
): void {
  if (reservation.status === "active" && clock().getTime() >= Date.parse(reservation.expiresAt)) {
    releaseReservation(reservation, "expired", ledgers, clock);
  }
}

function releaseReservation(
  reservation: StoredReservation,
  status: "released" | "expired",
  ledgers: Map<string, LedgerEntry[]>,
  clock: () => Date,
): LedgerEntry {
  const entry = ledgerEntry(
    clock,
    reservation.organizationId,
    "release",
    reservation.id,
    0,
    -reservation.amountMinor,
  );
  appendLedger(ledgers, entry);
  reservation.status = status;
  return entry;
}

function plusMilliseconds(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}

function safeMultiply(left: number, right: number): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result <= 0) throw invalid("quoted amount is invalid");
  return result;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid(`${label} must be positive`);
  return value;
}

function positiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw invalid(`${label} must be positive`);
  return value;
}

function opaqueReference(value: string, label: string): string {
  const normalized = nonEmpty(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/u.test(normalized)) {
    throw invalid(`${label} is invalid`);
  }
  return normalized;
}

function tenantReference(value: string): string {
  return opaqueReference(value, "tenantRef");
}

function idempotencyKey(value: string): string {
  const key = opaqueReference(value, "idempotency key");
  if (key.length < 8) throw invalid("idempotency key is too short");
  return key;
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
}

function unauthenticated(): TakoserverError {
  return new TakoserverError("unauthenticated", 401);
}

function forbidden(): TakoserverError {
  return new TakoserverError("permission_denied", 403);
}

function invalid(message: string): TakoserverError {
  return new TakoserverError("invalid_argument", 400, message);
}

function expired(): TakoserverError {
  return new TakoserverError("expired", 409);
}

function nonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} is required`);
  }
  return value;
}

function secureRandomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}
