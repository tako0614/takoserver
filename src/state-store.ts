import type { ServiceAllowance } from "./contracts.ts";
import type { GrantReplayStore } from "./runtime-grants.ts";

const ACTIVE_KEY_LIMIT = 32;
const EXPIRED_REPLAY_DELETE_LIMIT = 64;

const LOAD_ACTIVE_KEYS_SQL = `
SELECT key_id, public_jwk
FROM runtime_grant_keys
WHERE revoked_at_epoch_seconds IS NULL
ORDER BY key_id
LIMIT ?`;

const DELETE_EXPIRED_REPLAYS_SQL = `
DELETE FROM runtime_grant_replays
WHERE grant_id IN (
  SELECT grant_id
  FROM runtime_grant_replays
  WHERE expires_at_epoch_seconds <= ?
  ORDER BY expires_at_epoch_seconds, grant_id
  LIMIT ?
)`;

const CONSUME_REPLAY_SQL = `
INSERT OR IGNORE INTO runtime_grant_replays (
  grant_id,
  expires_at_epoch_seconds,
  consumed_at_epoch_seconds
)
VALUES (?, ?, ?)`;

const LOOKUP_RESOURCE_SQL = `
SELECT
  organization_id,
  security_domain_id,
  tenant_ref,
  resource_ref,
  reservation_id,
  offering_id,
  offering_digest,
  backend_id,
  native_id,
  allowances_json
FROM runtime_resources
WHERE security_domain_id = ? AND tenant_ref = ? AND resource_ref = ?
LIMIT 1`;

export interface D1QueryResult {
  readonly results: readonly Record<string, unknown>[];
  readonly meta: { readonly changes: number };
}

/** Minimal D1 statement port. The generated Env's D1Database is the production implementation. */
export interface D1StatementPort {
  bind(...values: unknown[]): D1StatementPort;
  all(): Promise<D1QueryResult>;
  run(): Promise<D1QueryResult>;
}

/** Narrow adapter seam used by portable tests; it intentionally is not a hand-written Env. */
export interface D1DatabasePort {
  prepare(query: string): D1StatementPort;
}

export type DurableStateErrorCode =
  | "state_unavailable"
  | "no_active_keys"
  | "invalid_key_material"
  | "resource_not_found"
  | "invalid_resource_record";

export class DurableStateError extends Error {
  constructor(readonly code: DurableStateErrorCode) {
    super(code);
    this.name = "DurableStateError";
  }
}

export class D1GrantReplayStore implements GrantReplayStore {
  readonly #database: D1DatabasePort;

  constructor(database: D1DatabasePort) {
    this.#database = databasePort(database);
  }

  async consume(input: {
    readonly grantId: string;
    readonly expiresAtEpochSeconds: number;
    readonly nowEpochSeconds: number;
  }): Promise<boolean> {
    const grantId = replayReference(input.grantId);
    const expiresAt = epochSeconds(input.expiresAtEpochSeconds);
    const now = epochSeconds(input.nowEpochSeconds);
    if (expiresAt <= now) throw new TypeError("replay expiry must be in the future");

    try {
      await this.#database
        .prepare(DELETE_EXPIRED_REPLAYS_SQL)
        .bind(now, EXPIRED_REPLAY_DELETE_LIMIT)
        .run();
      const inserted = await this.#database
        .prepare(CONSUME_REPLAY_SQL)
        .bind(grantId, expiresAt, now)
        .run();
      if (inserted.meta.changes !== 0 && inserted.meta.changes !== 1) {
        throw new DurableStateError("state_unavailable");
      }
      return inserted.meta.changes === 1;
    } catch (error) {
      if (error instanceof DurableStateError) throw error;
      throw new DurableStateError("state_unavailable");
    }
  }
}

export class D1GrantKeyStore {
  readonly #database: D1DatabasePort;

  constructor(database: D1DatabasePort) {
    this.#database = databasePort(database);
  }

  async loadActiveKeys(): Promise<ReadonlyMap<string, CryptoKey>> {
    let rows: readonly Record<string, unknown>[];
    try {
      const result = await this.#database
        .prepare(LOAD_ACTIVE_KEYS_SQL)
        .bind(ACTIVE_KEY_LIMIT + 1)
        .all();
      rows = result.results;
    } catch {
      throw new DurableStateError("state_unavailable");
    }
    if (rows.length === 0) throw new DurableStateError("no_active_keys");
    if (rows.length > ACTIVE_KEY_LIMIT) throw new DurableStateError("state_unavailable");

    const keys = new Map<string, CryptoKey>();
    for (const row of rows) {
      const keyId = keyReference(row.key_id);
      if (keys.has(keyId)) throw new DurableStateError("invalid_key_material");
      const jwk = publicEd25519Jwk(row.public_jwk, keyId);
      let key: CryptoKey;
      try {
        key = await crypto.subtle.importKey("jwk", jwk, "Ed25519", false, ["verify"]);
      } catch {
        throw new DurableStateError("invalid_key_material");
      }
      if (key.type !== "public" || !key.usages.includes("verify")) {
        throw new DurableStateError("invalid_key_material");
      }
      keys.set(keyId, key);
    }
    return keys;
  }
}

export interface DurableResourceRecord {
  readonly organizationId: string;
  readonly securityDomainId: string;
  readonly tenantRef: string;
  readonly resourceRef: string;
  readonly reservationId: string;
  readonly offeringId: string;
  readonly offeringDigest: `sha256:${string}`;
  readonly backendId: string;
  readonly nativeId: string;
  readonly allowances: readonly ServiceAllowance[];
}

/**
 * Read side of the durable resource registry. The future provisioning owner
 * writes this table; the data-plane Worker receives no registry mutation API.
 */
export class D1ResourceRegistry {
  readonly #database: D1DatabasePort;

  constructor(database: D1DatabasePort) {
    this.#database = databasePort(database);
  }

  async lookup(input: {
    readonly securityDomainId: string;
    readonly tenantRef: string;
    readonly resourceRef: string;
  }): Promise<DurableResourceRecord | null> {
    const securityDomainId = resourceReference(input.securityDomainId, 128);
    const tenantRef = resourceReference(input.tenantRef, 128);
    const resourceRef = resourceReference(input.resourceRef, 128);
    let rows: readonly Record<string, unknown>[];
    try {
      const result = await this.#database
        .prepare(LOOKUP_RESOURCE_SQL)
        .bind(securityDomainId, tenantRef, resourceRef)
        .all();
      rows = result.results;
    } catch {
      throw new DurableStateError("state_unavailable");
    }
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new DurableStateError("invalid_resource_record");
    const row = rows[0];
    if (!row) throw new DurableStateError("invalid_resource_record");
    return resourceRow(row);
  }
}

function databasePort(value: D1DatabasePort): D1DatabasePort {
  if (!value || typeof value.prepare !== "function") {
    throw new TypeError("D1 database binding is required");
  }
  return value;
}

function replayReference(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u.test(value)) {
    throw new TypeError("invalid replay reference");
  }
  return value;
}

function keyReference(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(value)) {
    throw new DurableStateError("invalid_key_material");
  }
  return value;
}

function resourceReference(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > maxLength ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]+$/u.test(value)
  ) {
    throw new DurableStateError("invalid_resource_record");
  }
  return value;
}

function resourceRow(row: Record<string, unknown>): DurableResourceRecord {
  const tenantRef = resourceReference(row.tenant_ref, 128);
  const resourceRef = resourceReference(row.resource_ref, 128);
  return {
    organizationId: resourceReference(row.organization_id, 128),
    securityDomainId: resourceReference(row.security_domain_id, 128),
    tenantRef,
    resourceRef,
    reservationId: resourceReference(row.reservation_id, 128),
    offeringId: resourceReference(row.offering_id, 128),
    offeringDigest: resourceDigest(row.offering_digest),
    backendId: resourceReference(row.backend_id, 128),
    nativeId: resourceReference(row.native_id, 512),
    allowances: serviceAllowances(row.allowances_json),
  };
}

function resourceDigest(value: unknown): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new DurableStateError("invalid_resource_record");
  }
  return value as `sha256:${string}`;
}

function serviceAllowances(value: unknown): readonly ServiceAllowance[] {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 4_096) {
    throw new DurableStateError("invalid_resource_record");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DurableStateError("invalid_resource_record");
  }
  if (!Array.isArray(parsed) || parsed.length > 16) {
    throw new DurableStateError("invalid_resource_record");
  }
  const protocols = new Set<string>();
  const allowances: ServiceAllowance[] = [];
  for (const entry of parsed) {
    if (
      !isRecord(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !==
        JSON.stringify(["authority", "mode", "protocol"]) ||
      (entry.protocol !== "s3" && entry.protocol !== "openai") ||
      entry.mode !== "direct" ||
      entry.authority !== "resource_scoped_grant" ||
      protocols.has(entry.protocol)
    ) {
      throw new DurableStateError("invalid_resource_record");
    }
    protocols.add(entry.protocol);
    allowances.push({
      protocol: entry.protocol,
      mode: "direct",
      authority: "resource_scoped_grant",
    });
  }
  return allowances;
}

function epochSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("invalid epoch seconds");
  return value;
}

function publicEd25519Jwk(value: unknown, keyId: string): JsonWebKey {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 4_096) {
    throw new DurableStateError("invalid_key_material");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DurableStateError("invalid_key_material");
  }
  if (
    !isRecord(parsed) ||
    parsed.kty !== "OKP" ||
    parsed.crv !== "Ed25519" ||
    typeof parsed.x !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(parsed.x) ||
    "d" in parsed ||
    (parsed.kid !== undefined && parsed.kid !== keyId) ||
    (parsed.use !== undefined && parsed.use !== "sig") ||
    (parsed.key_ops !== undefined &&
      (!Array.isArray(parsed.key_ops) ||
        parsed.key_ops.length !== 1 ||
        parsed.key_ops[0] !== "verify"))
  ) {
    throw new DurableStateError("invalid_key_material");
  }
  return { kty: "OKP", crv: "Ed25519", x: parsed.x, key_ops: ["verify"], ext: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
