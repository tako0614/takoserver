import { bytesDigest } from "./json.ts";
import type { Clock, Sql } from "./ports.ts";

/**
 * Who is calling, and what they are allowed to ask for.
 *
 * Sessions and API keys are the same mechanism wearing two hats: a bearer
 * secret that resolves to a principal, optionally scoped to one organization
 * and a set of scopes. Only the SHA-256 digest of a secret is ever stored, so
 * the database cannot leak a usable credential, and a secret is returned to its
 * creator exactly once.
 */

export type IdentityProvider = "takos-id" | "google" | "github";

/**
 * How a caller may sign in here, as the console needs to hear it.
 *
 * `method` is the part that matters: the same provider is reached one way when
 * a real OAuth client is configured and another way when the operator is still
 * vouching by signature. Advertising the provider without the method leaves a
 * console to guess, and it will guess the one that looks finished.
 */
export interface IdentityProviderDescriptor {
  readonly id: IdentityProvider;
  readonly displayName: string;
  readonly method: "oidc" | "operator-assertion";
  /** Public OAuth client id, present only for `oidc`. */
  readonly clientId?: string;
  /** Exact OIDC issuer, when discovery rather than a provider-specific SDK owns sign-in. */
  readonly issuer?: string;
}

export const API_KEY_SCOPES = [
  "ai:invoke",
  "catalog:read",
  "resources:read",
  "resources:write",
  "wallet:read",
  "reseller:write",
  "usage:read",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * Scopes that carry others with them.
 *
 * A key that may create a resource may see the resource it created. Requiring
 * both separately does not make anything safer — a writer can learn the state
 * by writing — and it does make every key issued before a read scope existed
 * unable to list its own work, which is how a new scope quietly breaks
 * everything already deployed.
 */
const IMPLIED: Partial<Record<ApiKeyScope, readonly ApiKeyScope[]>> = {
  "resources:write": ["resources:read"],
};

/** Whether these granted scopes cover the one being asked for. */
export function grants(scopes: readonly ApiKeyScope[], wanted: ApiKeyScope): boolean {
  return scopes.some((held) => held === wanted || (IMPLIED[held] ?? []).includes(wanted));
}

export interface Principal {
  readonly id: string;
  readonly provider: IdentityProvider;
  readonly providerSubject: string;
  readonly email: string;
  readonly displayName: string;
}

export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly ownerPrincipalId: string;
  readonly createdAt: string;
}

export interface ApiKey {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** Exact durable state of one API-key id. Expiry never means absence. */
export interface ApiKeyAdministrationStatus {
  readonly apiKey: ApiKey;
  /** The row has not been revoked. This remains true after expiry. */
  readonly present: boolean;
  /** The bearer can currently authenticate. */
  readonly usable: boolean;
  readonly revokedAt: string | null;
}

export type ApiKeyAdministrationIssue =
  | {
      readonly kind: "issued";
      readonly apiKey: ApiKey;
      readonly secret: string;
    }
  | {
      /** The caller-supplied id was already consumed; its secret is unrecoverable. */
      readonly kind: "existing";
      readonly status: ApiKeyAdministrationStatus;
    }
  | {
      /** Another unrevoked key owns the requested exclusive name. */
      readonly kind: "exclusive_conflict";
    };

/**
 * Internal API-key administration shared by the owner routes and narrow
 * operator authorities. It never authenticates a session or invents a member.
 */
export interface ApiKeyAdministration {
  organizationOwnerPrincipalId(organizationId: string): Promise<string | null>;
  list(organizationId: string): Promise<readonly ApiKey[]>;
  status(input: {
    readonly organizationId: string;
    readonly apiKeyId: string;
  }): Promise<ApiKeyAdministrationStatus | null>;
  issue(input: {
    readonly organizationId: string;
    readonly name: string;
    readonly scopes: readonly ApiKeyScope[];
    readonly expiresInSeconds: number;
    /** Optional stable id for an operation whose response may be lost. */
    readonly apiKeyId?: string;
    /** Atomically refuses while any unrevoked key has this exact name. */
    readonly exclusiveUnrevokedName?: string;
  }): Promise<ApiKeyAdministrationIssue>;
  /** Idempotent internally: null means the exact id was never present. */
  revoke(input: {
    readonly organizationId: string;
    readonly apiKeyId: string;
  }): Promise<ApiKeyAdministrationStatus | null>;
}

/** The resolved caller. `organizationId` is absent for a bare user session. */
export interface Actor {
  /** Principal used by the data/Host plane. Each API key is its own service principal. */
  readonly hostPrincipalId: string;
  /** Human identity used only for account ownership and key administration. */
  readonly principalId: string;
  readonly organizationId?: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly kind: "session" | "api_key";
}

export interface ExternalIdentityVerifier {
  verify(input: {
    readonly provider: IdentityProvider;
    readonly assertion: string;
    /** Which advertised method produced the assertion. */
    readonly method?: IdentityProviderDescriptor["method"] | undefined;
    /** The value the caller asked the provider to embed in the token. */
    readonly nonce?: string | undefined;
    /** Canonical request origin, for credentials that are audience-bound to one Host. */
    readonly audience?: string | undefined;
  }): Promise<{
    readonly providerSubject: string;
    readonly email: string;
    readonly displayName: string;
    readonly organizations?: readonly {
      readonly id: string;
      readonly name: string;
      readonly role: "owner" | "member";
    }[];
  }>;
}

export type AuthErrorCode = "unauthenticated" | "permission_denied" | "not_found" | "invalid";

export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(code);
    this.name = "AuthError";
  }
}

export interface Accounts {
  /** Exchanges a verified external assertion for a principal and a session. */
  signIn(input: {
    readonly provider: IdentityProvider;
    readonly assertion: string;
    readonly method?: IdentityProviderDescriptor["method"] | undefined;
    readonly nonce?: string | undefined;
    readonly audience?: string | undefined;
    readonly sessionTtlSeconds?: number;
  }): Promise<{ readonly principal: Principal; readonly sessionToken: string }>;
  /**
   * Read-only proof that an assertion names an already-stored exact owner.
   * It never provisions a principal, projects membership, or issues a bearer.
   */
  proveExistingOwner(input: {
    readonly provider: IdentityProvider;
    readonly assertion: string;
    readonly method: "operator-assertion";
    readonly organizationId: string;
    readonly audience: string;
  }): Promise<{ readonly principal: Principal; readonly organization: Organization }>;
  createOrganization(input: {
    readonly actor: Actor;
    readonly name: string;
  }): Promise<Organization>;
  organization(id: string): Promise<Organization | null>;
  /** The person behind a session, for a console to greet and to audit against. */
  principal(id: string): Promise<Principal | null>;
  /** Every organization this principal owns, oldest first. */
  organizations(principalId: string): Promise<readonly Organization[]>;
  /**
   * The organization's live keys. Secrets are never stored, so they cannot be
   * listed — what a console shows is which keys exist, what they may do, and
   * when they lapse.
   */
  apiKeys(input: {
    readonly actor: Actor;
    readonly organizationId: string;
  }): Promise<readonly ApiKey[]>;
  /** Returns the secret exactly once; only its digest is retained. */
  createApiKey(input: {
    readonly actor: Actor;
    readonly organizationId: string;
    readonly name: string;
    readonly scopes: readonly ApiKeyScope[];
    readonly expiresInSeconds: number;
  }): Promise<{ readonly apiKey: ApiKey; readonly secret: string }>;
  revokeApiKey(input: {
    readonly actor: Actor;
    readonly organizationId: string;
    readonly apiKeyId: string;
  }): Promise<ApiKey>;
  /** Resolves a bearer credential. Returns null for anything unusable. */
  authenticate(authorization: string | null): Promise<Actor | null>;
  /** Revokes exactly one live session represented by a bearer authorization. */
  revokeSession(authorization: string | null): Promise<void>;
  /** Resolves and requires a scope on one organization. */
  authorize(authorization: string | null, scope: ApiKeyScope): Promise<Actor | null>;
  /** Refuses unless the actor owns the organization outright. */
  requireOwner(actor: Actor, organizationId: string): Promise<Organization>;
}

export interface CreateAccountsOptions {
  readonly sql: Sql;
  readonly identity: ExternalIdentityVerifier;
  readonly clock?: Clock;
  readonly randomSecret?: () => string;
  readonly randomId?: () => string;
  /** Composition-owned capability; ordinary callers may omit it. */
  readonly apiKeyAdministration?: ApiKeyAdministration;
}

export interface CreateApiKeyAdministrationOptions {
  readonly sql: Sql;
  readonly clock?: Clock;
  readonly randomSecret?: () => string;
  readonly randomId?: () => string;
}

export function createApiKeyAdministration(
  options: CreateApiKeyAdministrationOptions,
): ApiKeyAdministration {
  const { sql } = options;
  const clock = options.clock ?? (() => new Date());
  const randomSecret = options.randomSecret ?? defaultSecret;
  const randomId = options.randomId ?? (() => crypto.randomUUID().replaceAll("-", ""));

  const organizationOwnerPrincipalId = async (organizationId: string): Promise<string | null> => {
    const rows = await sql.query("SELECT owner_principal_id FROM orgs WHERE id = ?", [
      organizationId,
    ]);
    const value = rows[0]?.owner_principal_id;
    return typeof value === "string" ? value : null;
  };

  const status = async (input: {
    readonly organizationId: string;
    readonly apiKeyId: string;
  }): Promise<ApiKeyAdministrationStatus | null> => {
    const rows = await sql.query(
      `SELECT id, org_id, name, scopes_json, created_at, expires_at, revoked_at
       FROM auth_tokens WHERE id = ? AND org_id = ? AND kind = 'api_key'`,
      [input.apiKeyId, input.organizationId],
    );
    const row = rows[0];
    if (!row) return null;
    const apiKey = apiKeyFromRow(row);
    const revokedAt = typeof row.revoked_at === "string" ? row.revoked_at : null;
    const present = revokedAt === null;
    return {
      apiKey,
      present,
      usable: present && Date.parse(apiKey.expiresAt) > clock().getTime(),
      revokedAt,
    };
  };

  return {
    organizationOwnerPrincipalId,

    async list(organizationId) {
      const rows = await sql.query(
        `SELECT id, org_id, name, scopes_json, created_at, expires_at FROM auth_tokens
         WHERE org_id = ? AND kind = 'api_key' AND revoked_at IS NULL
         ORDER BY created_at DESC, id DESC LIMIT 200`,
        [organizationId],
      );
      return rows.map(apiKeyFromRow);
    },

    status,

    async issue(input) {
      const ownerPrincipalId = await organizationOwnerPrincipalId(input.organizationId);
      if (!ownerPrincipalId) throw new AuthError("not_found");
      const scopes = validScopes(input.scopes);
      if (input.name.length === 0 || input.name.length > 128) throw new AuthError("invalid");
      if (!Number.isSafeInteger(input.expiresInSeconds) || input.expiresInSeconds <= 0) {
        throw new AuthError("invalid");
      }
      const id = input.apiKeyId ?? `key_${randomId()}`;
      if (!/^key_[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$/u.test(id)) {
        throw new AuthError("invalid");
      }
      if (
        input.exclusiveUnrevokedName !== undefined &&
        input.exclusiveUnrevokedName !== input.name
      ) {
        throw new AuthError("invalid");
      }
      const now = clock();
      const createdAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + input.expiresInSeconds * 1_000).toISOString();
      const secret = randomSecret();
      const secretDigest = await bytesDigest(new TextEncoder().encode(secret));
      const params = [
        secretDigest,
        id,
        ownerPrincipalId,
        input.organizationId,
        input.name,
        JSON.stringify([...scopes]),
        createdAt,
        expiresAt,
      ] as const;
      const write =
        input.exclusiveUnrevokedName === undefined
          ? await sql.run(
              `INSERT INTO auth_tokens
                 (secret_digest, id, kind, principal_id, org_id, name, scopes_json, created_at, expires_at)
               VALUES (?, ?, 'api_key', ?, ?, ?, ?, ?, ?)`,
              params,
            )
          : await sql.run(
              `INSERT INTO auth_tokens
                 (secret_digest, id, kind, principal_id, org_id, name, scopes_json, created_at, expires_at)
               SELECT ?, ?, 'api_key', ?, ?, ?, ?, ?, ?
               WHERE NOT EXISTS (
                 SELECT 1 FROM auth_tokens
                 WHERE org_id = ? AND kind = 'api_key' AND name = ? AND revoked_at IS NULL
               )
               ON CONFLICT(id) DO NOTHING`,
              [...params, input.organizationId, input.exclusiveUnrevokedName],
            );
      if (write.changes === 1) {
        return {
          kind: "issued",
          apiKey: {
            id,
            organizationId: input.organizationId,
            name: input.name,
            scopes,
            createdAt,
            expiresAt,
          },
          secret,
        };
      }
      if (input.apiKeyId !== undefined) {
        const existing = await status({
          organizationId: input.organizationId,
          apiKeyId: input.apiKeyId,
        });
        if (existing) return { kind: "existing", status: existing };
      }
      return { kind: "exclusive_conflict" };
    },

    async revoke(input) {
      const existing = await status(input);
      if (!existing) return null;
      if (existing.present) {
        await sql.run(
          `UPDATE auth_tokens SET revoked_at = ?
           WHERE id = ? AND org_id = ? AND kind = 'api_key' AND revoked_at IS NULL`,
          [clock().toISOString(), input.apiKeyId, input.organizationId],
        );
      }
      return await status(input);
    },
  };
}

export function createAccounts(options: CreateAccountsOptions): Accounts {
  const { sql, identity } = options;
  const clock = options.clock ?? (() => new Date());
  const randomSecret = options.randomSecret ?? defaultSecret;
  const randomId = options.randomId ?? (() => crypto.randomUUID().replaceAll("-", ""));
  const apiKeyAdministration =
    options.apiKeyAdministration ??
    createApiKeyAdministration({ sql, clock, randomSecret, randomId });
  const stamp = (): string => clock().toISOString();
  const after = (seconds: number): string =>
    new Date(clock().getTime() + seconds * 1_000).toISOString();

  const issueSessionToken = async (input: {
    readonly principalId: string;
    readonly expiresInSeconds: number;
  }): Promise<{
    id: string;
    secret: string;
    createdAt: string;
    expiresAt: string;
  }> => {
    const secret = randomSecret();
    const id = `ses_${randomId()}`;
    const createdAt = stamp();
    const expiresAt = after(input.expiresInSeconds);
    await sql.run(
      `INSERT INTO auth_tokens
         (secret_digest, id, kind, principal_id, org_id, name, scopes_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        await bytesDigest(new TextEncoder().encode(secret)),
        id,
        "session",
        input.principalId,
        null,
        "session",
        "[]",
        createdAt,
        expiresAt,
      ],
    );
    return { id, secret, createdAt, expiresAt };
  };

  const accounts: Accounts = {
    async signIn({ provider, assertion, method, nonce, audience, sessionTtlSeconds }) {
      if (provider !== "takos-id" && provider !== "google" && provider !== "github") {
        throw new AuthError("invalid");
      }
      const verified = await identity.verify({
        provider,
        assertion,
        method,
        nonce,
        audience,
      });
      const rows = await sql.query(
        "SELECT id, email, display_name FROM principals WHERE provider = ? AND provider_subject = ?",
        [provider, verified.providerSubject],
      );
      const existing = rows[0];
      const id = existing ? String(existing.id) : `prn_${randomId()}`;
      if (!existing) {
        await sql.run(
          `INSERT INTO principals (id, provider, provider_subject, email, display_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, provider, verified.providerSubject, verified.email, verified.displayName, stamp()],
        );
      }
      if (provider === "takos-id") {
        const owned = (verified.organizations ?? []).filter(
          (organization) => organization.role === "owner",
        );
        const projectedAt = stamp();
        await sql.batch([
          {
            sql: "DELETE FROM org_memberships WHERE principal_id = ?",
            params: [id],
          },
          ...owned.flatMap((organization) => [
            {
              sql: `INSERT INTO orgs (id, name, owner_principal_id, created_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                      owner_principal_id = excluded.owner_principal_id`,
              params: [organization.id, organization.name, id, projectedAt],
            },
            {
              sql: `INSERT INTO org_memberships (org_id, principal_id, role, created_at)
                    VALUES (?, ?, 'owner', ?)
                    ON CONFLICT(org_id, principal_id) DO UPDATE SET role = 'owner'`,
              params: [organization.id, id, projectedAt],
            },
          ]),
        ]);
      }
      const { secret } = await issueSessionToken({
        principalId: id,
        expiresInSeconds: sessionTtlSeconds ?? 12 * 60 * 60,
      });
      return {
        principal: {
          id,
          provider,
          providerSubject: verified.providerSubject,
          email: verified.email,
          displayName: verified.displayName,
        },
        sessionToken: secret,
      };
    },

    async proveExistingOwner({ provider, assertion, method, organizationId, audience }) {
      if (provider !== "google" && provider !== "github") {
        throw new AuthError("invalid");
      }
      const verified = await identity.verify({
        provider,
        assertion,
        method,
        audience,
      });
      const rows = await sql.query(
        `SELECT p.id AS principal_id,
                o.id AS organization_id, o.name AS organization_name,
                o.owner_principal_id, o.created_at AS organization_created_at
         FROM principals p
         JOIN orgs o ON o.owner_principal_id = p.id AND o.id = ?
         JOIN org_memberships m
           ON m.org_id = o.id AND m.principal_id = p.id AND m.role = 'owner'
         WHERE p.provider = ? AND p.provider_subject = ?
           AND p.email = ? AND p.display_name = ?`,
        [organizationId, provider, verified.providerSubject, verified.email, verified.displayName],
      );
      const row = rows[0];
      // Unknown identities, stale membership and somebody else's organization
      // are deliberately indistinguishable, and this path has made no write.
      if (!row) throw new AuthError("not_found");
      const principal: Principal = {
        id: String(row.principal_id),
        provider,
        providerSubject: verified.providerSubject,
        email: verified.email,
        displayName: verified.displayName,
      };
      return {
        principal,
        organization: {
          id: String(row.organization_id),
          name: String(row.organization_name),
          ownerPrincipalId: String(row.owner_principal_id),
          createdAt: String(row.organization_created_at),
        },
      };
    },

    async createOrganization({ actor, name }) {
      if (name.length === 0 || name.length > 128) throw new AuthError("invalid");
      const principal = await accounts.principal(actor.principalId);
      if (!principal || principal.provider === "takos-id") throw new AuthError("invalid");
      const id = `org_${randomId()}`;
      const createdAt = stamp();
      await sql.run(
        "INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)",
        [id, name, actor.principalId, createdAt],
      );
      await sql.run(
        "INSERT INTO org_memberships (org_id, principal_id, role, created_at) VALUES (?, ?, 'owner', ?)",
        [id, actor.principalId, createdAt],
      );
      return { id, name, ownerPrincipalId: actor.principalId, createdAt };
    },

    async organization(id) {
      const rows = await sql.query(
        "SELECT id, name, owner_principal_id, created_at FROM orgs WHERE id = ?",
        [id],
      );
      const row = rows[0];
      return row
        ? {
            id: String(row.id),
            name: String(row.name),
            ownerPrincipalId: String(row.owner_principal_id),
            createdAt: String(row.created_at),
          }
        : null;
    },

    async principal(id) {
      const rows = await sql.query(
        "SELECT id, provider, provider_subject, email, display_name FROM principals WHERE id = ?",
        [id],
      );
      const row = rows[0];
      return row
        ? {
            id: String(row.id),
            provider: String(row.provider) as IdentityProvider,
            providerSubject: String(row.provider_subject),
            email: String(row.email),
            displayName: String(row.display_name),
          }
        : null;
    },

    async organizations(principalId) {
      const rows = await sql.query(
        `SELECT o.id, o.name, o.owner_principal_id, o.created_at FROM orgs o
         JOIN org_memberships m ON m.org_id = o.id
         WHERE m.principal_id = ? ORDER BY o.created_at ASC, o.id ASC LIMIT 200`,
        [principalId],
      );
      return rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        ownerPrincipalId: String(row.owner_principal_id),
        createdAt: String(row.created_at),
      }));
    },

    async apiKeys({ actor, organizationId }) {
      await accounts.requireOwner(actor, organizationId);
      return await apiKeyAdministration.list(organizationId);
    },

    async createApiKey({ actor, organizationId, name, scopes, expiresInSeconds }) {
      await accounts.requireOwner(actor, organizationId);
      const issued = await apiKeyAdministration.issue({
        organizationId,
        name,
        scopes,
        expiresInSeconds,
      });
      if (issued.kind !== "issued") throw new AuthError("invalid");
      return { apiKey: issued.apiKey, secret: issued.secret };
    },

    async revokeApiKey({ actor, organizationId, apiKeyId }) {
      await accounts.requireOwner(actor, organizationId);
      const revoked = await apiKeyAdministration.revoke({ organizationId, apiKeyId });
      if (!revoked) throw new AuthError("not_found");
      return revoked.apiKey;
    },

    async revokeSession(authorization) {
      const secret = bearer(authorization);
      if (!secret) throw new AuthError("unauthenticated");
      const revokedAt = stamp();
      const result = await sql.run(
        `UPDATE auth_tokens SET revoked_at = ?
         WHERE secret_digest = ? AND kind = 'session' AND revoked_at IS NULL AND expires_at > ?`,
        [revokedAt, await bytesDigest(new TextEncoder().encode(secret)), revokedAt],
      );
      if (result.changes !== 1) throw new AuthError("unauthenticated");
    },

    async authenticate(authorization) {
      const secret = bearer(authorization);
      if (!secret) return null;
      const rows = await sql.query(
        `SELECT id, kind, principal_id, org_id, scopes_json FROM auth_tokens
         WHERE secret_digest = ? AND revoked_at IS NULL AND expires_at > ?`,
        [await bytesDigest(new TextEncoder().encode(secret)), stamp()],
      );
      const row = rows[0];
      if (!row) return null;
      const organizationId = row.org_id;
      const kind = String(row.kind) === "session" ? "session" : "api_key";
      return {
        hostPrincipalId:
          kind === "session" ? String(row.principal_id) : `api-key:${String(row.id)}`,
        principalId: String(row.principal_id),
        ...(typeof organizationId === "string" ? { organizationId } : {}),
        scopes: JSON.parse(String(row.scopes_json)) as ApiKeyScope[],
        kind,
      };
    },

    async authorize(authorization, scope) {
      const actor = await accounts.authenticate(authorization);
      if (!actor?.organizationId || !grants(actor.scopes, scope)) return null;
      return actor;
    },

    async requireOwner(actor, organizationId) {
      const memberships = await sql.query(
        `SELECT m.role FROM org_memberships m
         JOIN orgs o ON o.id = m.org_id AND o.owner_principal_id = m.principal_id
         WHERE m.org_id = ? AND m.principal_id = ? AND m.role = 'owner'`,
        [organizationId, actor.principalId],
      );
      const organization = memberships[0] ? await accounts.organization(organizationId) : null;
      // An unknown organization and one owned by somebody else are reported the
      // same way, so ownership cannot be probed by watching status codes.
      if (!organization) {
        throw new AuthError("not_found");
      }
      return organization;
    },
  };

  return accounts;
}

function apiKeyFromRow(row: Readonly<Record<string, unknown>>): ApiKey {
  return {
    id: String(row.id),
    organizationId: String(row.org_id),
    name: String(row.name),
    scopes: JSON.parse(String(row.scopes_json)) as readonly ApiKeyScope[],
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
  };
}

function validScopes(scopes: readonly ApiKeyScope[]): readonly ApiKeyScope[] {
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !API_KEY_SCOPES.includes(scope))
  ) {
    throw new AuthError("invalid");
  }
  return [...scopes];
}

function bearer(authorization: string | null): string | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const secret = authorization.slice("Bearer ".length);
  return secret.length >= 16 && secret.length <= 512 ? secret : null;
}

function defaultSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
