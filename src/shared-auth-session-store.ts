import type { Row, Sql } from "./ports.ts";

export interface OidcAttempt {
  readonly digest: string;
  readonly payload: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface OidcSessionRecord {
  readonly digest: string;
  readonly accountId: string;
  readonly principalId: string;
  readonly workspaceId: string;
  /** Encrypted grant, not a browser cookie or an unencrypted token. */
  readonly payload: string;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly absoluteExpiresAt: number;
  readonly grantCheckedAt: number;
  readonly version: number;
  readonly status: "active" | "checking" | "revocation_pending" | "revoked";
}

export interface OidcRevocation {
  readonly id: string;
  readonly sessionDigest: string;
  readonly payload: string;
  readonly createdAt: number;
  readonly nextAttemptAt: number;
  readonly version: number;
  readonly status: "pending" | "dispatching";
  readonly leaseUntil: number | null;
  readonly attempts: number;
}

export interface SharedAuthSessionStore {
  putAttempt(attempt: OidcAttempt): Promise<boolean>;
  consumeAttempt(digest: string, now: number): Promise<OidcAttempt | null>;
  createSession(record: OidcSessionRecord): Promise<boolean>;
  readSession(digest: string): Promise<OidcSessionRecord | null>;
  claimSession(
    digest: string,
    expectedVersion: number,
    now: number,
  ): Promise<OidcSessionRecord | null>;
  completeSession(
    digest: string,
    claimedVersion: number,
    update: {
      readonly payload: string;
      readonly grantCheckedAt: number;
      readonly lastUsedAt: number;
    },
  ): Promise<boolean>;
  /** The acknowledged post-update row from this exact primary CAS, never a later read. */
  touchSessionAndSelect(
    digest: string,
    expectedVersion: number,
    now: number,
  ): Promise<OidcSessionRecord>;
  touchSession(digest: string, expectedVersion: number, now: number): Promise<boolean>;
  revokeSession(digest: string, now: number): Promise<boolean>;
  /** Atomically persists the grant AND fences any matching active/checking session. */
  queueRevocation(input: {
    readonly id: string;
    readonly sessionDigest: string;
    readonly payload: string;
    readonly createdAt: number;
  }): Promise<void>;
  listPendingRevocations(now: number, limit: number): Promise<readonly OidcRevocation[]>;
  claimRevocation(id: string, expectedVersion: number, now: number): Promise<OidcRevocation | null>;
  completeRevocation(id: string, claimedVersion: number): Promise<boolean>;
  retryRevocation(id: string, claimedVersion: number, nextAttemptAt: number): Promise<boolean>;
  cleanupExpiredAttempts(now: number, limit: number): Promise<number>;
  cleanupRevokedSessions(before: number, limit: number): Promise<number>;
}

/**
 * Dedicated private final-observation port. Its owner must connect the actual
 * explicit-d1-result driver and the same canonical primary Sql/native client
 * used by Auth and Financial. This structural type/factory alone qualifies
 * neither a generic Sql adapter nor a fabricated response.
 */
export interface SharedAuthFinalSessionStore
  extends Omit<SharedAuthSessionStore, "touchSessionAndSelect"> {
  touchSessionAndSelect(
    digest: string,
    expectedVersion: number,
    now: number,
  ): Promise<OidcSessionRecord | null>;
}

const REVOCATION_LEASE_MS = 30_000;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const STATUSES = new Set(["active", "checking", "revocation_pending", "revoked"]);

async function touchSessionRow(
  sql: Sql,
  value: string,
  expectedVersion: number,
  now: number,
): Promise<OidcSessionRecord | null> {
  digest(value);
  version(expectedVersion);
  version(expectedVersion + 1);
  time(now);
  const result = await sql.run(
    `UPDATE shared_auth_sessions SET last_used_at = ?, version = version + 1
     WHERE digest = ? AND status = 'active' AND version = ?
       AND created_at <= ? AND last_used_at <= ? AND grant_checked_at <= ?
       AND absolute_expires_at > ? RETURNING *`,
    [now, value, expectedVersion, now, now, now, now],
  );
  // A missing/malformed success image is an unknown acknowledgement, not a
  // CAS miss. The caller must not reread or resend to turn it into success.
  if (!result || !Array.isArray(result.rows)) invalid();
  // The dedicated final factory is accepted only under the owner's actual
  // strict-connected Sql composition. The ordinary factory rejects this null.
  if (result.changes === 0 && result.rows.length === 0) return null;
  if (result.changes !== 1 || result.rows.length !== 1 || !result.rows[0]) invalid();
  const selected = sessionFrom(result.rows[0]);
  if (
    selected.digest !== value ||
    selected.status !== "active" ||
    selected.version !== expectedVersion + 1 ||
    selected.lastUsedAt !== now ||
    selected.createdAt > now ||
    selected.grantCheckedAt > now ||
    selected.absoluteExpiresAt <= now
  )
    invalid();
  return Object.freeze(selected);
}

/**
 * Uncomposed runtime preparation. These future tables are not in the adopted
 * migration lineage and this factory neither creates nor migrates them.
 * The owning composition must supply primary-consistent Sql for EVERY request
 * (D1: a fresh withSession("first-primary") per request), never a cached replica
 * reader. The caller seals all payloads and derives the opaque digests.
 *
 * A checking row is deliberately never reclaimed for another refresh: a lost
 * acknowledgement may already have rotated the upstream token. Require login
 * and revoke instead. Only revocation itself has a retryable lease.
 * completeSession is a one-shot settlement, not an acknowledgement-retry API:
 * after an unknown result the caller must deny authentication and revoke; it
 * must not submit the same successful rotation again as a new settlement.
 * queueRevocation is the durable uncertain-ACK recovery: it keeps the supplied
 * encrypted grant, copies a different stored grant, and denies the local session
 * in one batch, including a create/complete whose acknowledgement was lost.
 */
export function createSharedAuthSessionStore(sql: Sql): SharedAuthSessionStore {
  async function touchSessionAndSelect(
    value: string,
    expectedVersion: number,
    now: number,
  ): Promise<OidcSessionRecord> {
    const selected = await touchSessionRow(sql, value, expectedVersion, now);
    if (!selected) throw new Error("Shared auth touch has no qualified known-miss acknowledgement");
    return selected;
  }

  return {
    async putAttempt(attempt) {
      checkAttempt(attempt);
      const result = await sql.run(
        `INSERT INTO shared_auth_attempts (digest, payload, created_at, expires_at)
         VALUES (?, ?, ?, ?) ON CONFLICT (digest) DO NOTHING`,
        [attempt.digest, attempt.payload, attempt.createdAt, attempt.expiresAt],
      );
      return result.changes === 1;
    },

    async consumeAttempt(value, now) {
      digest(value);
      time(now);
      // Even expired attempts are burned; the result is useful only before expiry.
      const result = await sql.run(
        "DELETE FROM shared_auth_attempts WHERE digest = ? RETURNING *",
        [value],
      );
      const row = result.rows[0];
      if (!row) return null;
      const attempt = attemptFrom(row);
      return attempt.createdAt <= now && attempt.expiresAt > now ? attempt : null;
    },

    async createSession(record) {
      checkSession(record);
      if (record.status !== "active" || record.version !== 0) invalid();
      const result = await sql.run(
        `INSERT INTO shared_auth_sessions
           (digest, account_id, principal_id, workspace_id, payload, created_at,
            last_used_at, absolute_expires_at, grant_checked_at, version, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active')
         ON CONFLICT (digest) DO NOTHING`,
        [
          record.digest,
          record.accountId,
          record.principalId,
          record.workspaceId,
          record.payload,
          record.createdAt,
          record.lastUsedAt,
          record.absoluteExpiresAt,
          record.grantCheckedAt,
        ],
      );
      return result.changes === 1;
    },

    async readSession(value) {
      digest(value);
      const row = (
        await sql.query("SELECT * FROM shared_auth_sessions WHERE digest = ?", [value])
      )[0];
      return row ? sessionFrom(row) : null;
    },

    async claimSession(value, expectedVersion, now) {
      digest(value);
      version(expectedVersion);
      time(now);
      const result = await sql.run(
        `UPDATE shared_auth_sessions SET status = 'checking', version = version + 1
         WHERE digest = ? AND status = 'active' AND version = ?
           AND created_at <= ? AND last_used_at <= ? AND absolute_expires_at > ?
         RETURNING *`,
        [value, expectedVersion, now, now, now],
      );
      const row = result.rows[0];
      return row ? sessionFrom(row) : null;
    },

    async completeSession(value, claimedVersion, update) {
      digest(value);
      version(claimedVersion);
      payload(update.payload);
      time(update.grantCheckedAt);
      time(update.lastUsedAt);
      if (update.grantCheckedAt > update.lastUsedAt) invalid();
      const result = await sql.batch([
        {
          // If logout won, preserve the newly rotated grant BEFORE rejecting CAS.
          // The same batch holds the precondition stable through the UPDATE.
          sql: `INSERT INTO shared_auth_revocations
                  (id, session_digest, payload, created_at, next_attempt_at,
                   version, status, lease_until, attempts)
                SELECT ?, ?, ?, ?, ?, 0, 'pending', NULL, 0
                WHERE NOT EXISTS (
                  SELECT 1 FROM shared_auth_sessions WHERE digest = ?
                    AND status = 'checking' AND version = ?
                    AND last_used_at <= ? AND created_at <= ? AND grant_checked_at <= ?
                    AND absolute_expires_at > ?)
                ON CONFLICT (id) DO NOTHING`,
          params: [
            refreshRevocationId(value, claimedVersion),
            value,
            update.payload,
            update.lastUsedAt,
            update.lastUsedAt,
            value,
            claimedVersion,
            update.lastUsedAt,
            update.grantCheckedAt,
            update.grantCheckedAt,
            update.lastUsedAt,
          ],
        },
        {
          sql: `UPDATE shared_auth_sessions
                SET payload = ?, grant_checked_at = ?, last_used_at = ?,
                    status = 'active', version = version + 1
                WHERE digest = ? AND status = 'checking' AND version = ?
                  AND last_used_at <= ? AND created_at <= ? AND grant_checked_at <= ?
                  AND absolute_expires_at > ?`,
          params: [
            update.payload,
            update.grantCheckedAt,
            update.lastUsedAt,
            value,
            claimedVersion,
            update.lastUsedAt,
            update.grantCheckedAt,
            update.grantCheckedAt,
            update.lastUsedAt,
          ],
        },
      ]);
      return result[1]?.changes === 1;
    },

    touchSessionAndSelect,

    async touchSession(value, expectedVersion, now) {
      // Existing deny-only boolean callers gain no selected row or retry proof.
      digest(value);
      version(expectedVersion);
      time(now);
      const result = await sql.run(
        `UPDATE shared_auth_sessions SET last_used_at = ?, version = version + 1
         WHERE digest = ? AND status = 'active' AND version = ?
           AND created_at <= ? AND last_used_at <= ? AND absolute_expires_at > ?`,
        [now, value, expectedVersion, now, now, now],
      );
      return result.changes === 1;
    },

    async revokeSession(value, now) {
      digest(value);
      time(now);
      const result = await sql.batch([
        {
          sql: `INSERT INTO shared_auth_revocations
                  (id, session_digest, payload, created_at, next_attempt_at,
                   version, status, lease_until, attempts)
                SELECT digest || ':logout:' || version, digest, payload, ?, ?,
                       0, 'pending', NULL, 0
                FROM shared_auth_sessions WHERE digest = ? AND status IN ('active', 'checking')
                ON CONFLICT (id) DO NOTHING`,
          params: [now, now, value],
        },
        {
          sql: `UPDATE shared_auth_sessions SET status = 'revocation_pending', version = version + 1
                WHERE digest = ? AND status IN ('active', 'checking')`,
          params: [value],
        },
      ]);
      return result[1]?.changes === 1;
    },

    async queueRevocation(input) {
      id(input.id);
      digest(input.sessionDigest);
      payload(input.payload);
      time(input.createdAt);
      const result = await sql.batch([
        {
          sql: `INSERT INTO shared_auth_revocations
                  (id, session_digest, payload, created_at, next_attempt_at,
                   version, status, lease_until, attempts)
                VALUES (?, ?, ?, ?, ?, 0, 'pending', NULL, 0)
                ON CONFLICT (id) DO NOTHING`,
          params: [input.id, input.sessionDigest, input.payload, input.createdAt, input.createdAt],
        },
        {
          // A checking row can still contain the old grant. Preserve it before
          // fencing, since revokeSession deliberately skips already-pending rows.
          sql: `INSERT INTO shared_auth_revocations
                  (id, session_digest, payload, created_at, next_attempt_at,
                   version, status, lease_until, attempts)
                SELECT digest || ':uncertain:' || version, digest, payload, ?, ?,
                       0, 'pending', NULL, 0
                FROM shared_auth_sessions
                WHERE digest = ? AND status IN ('active', 'checking') AND payload <> ?
                  AND EXISTS (SELECT 1 FROM shared_auth_revocations
                              WHERE id = ? AND session_digest = ? AND payload = ? AND created_at = ?)
                ON CONFLICT (id) DO NOTHING`,
          params: [
            input.createdAt,
            input.createdAt,
            input.sessionDigest,
            input.payload,
            input.id,
            input.sessionDigest,
            input.payload,
            input.createdAt,
          ],
        },
        {
          // A conflicting duplicate id must never fence an unrelated session.
          sql: `UPDATE shared_auth_sessions
                SET status = 'revocation_pending', version = version + 1
                WHERE digest = ? AND status IN ('active', 'checking')
                  AND EXISTS (SELECT 1 FROM shared_auth_revocations
                              WHERE id = ? AND session_digest = ? AND payload = ? AND created_at = ?)`,
          params: [
            input.sessionDigest,
            input.id,
            input.sessionDigest,
            input.payload,
            input.createdAt,
          ],
        },
      ]);
      if (result[0]?.changes === 1) return;
      const row = (
        await sql.query("SELECT * FROM shared_auth_revocations WHERE id = ?", [input.id])
      )[0];
      if (
        !row ||
        row.session_digest !== input.sessionDigest ||
        row.payload !== input.payload ||
        row.created_at !== input.createdAt
      )
        invalid();
    },

    async listPendingRevocations(now, limit) {
      time(now);
      page(limit);
      const rows = await sql.query(
        `SELECT * FROM shared_auth_revocations
         WHERE next_attempt_at <= ?
           AND (status = 'pending' OR (status = 'dispatching' AND lease_until <= ?))
         ORDER BY next_attempt_at, id LIMIT ?`,
        [now, now, limit],
      );
      return rows.map(revocationFrom);
    },

    async claimRevocation(value, expectedVersion, now) {
      id(value);
      version(expectedVersion);
      time(now);
      time(now + REVOCATION_LEASE_MS);
      const result = await sql.run(
        `UPDATE shared_auth_revocations
         SET status = 'dispatching', lease_until = ?, version = version + 1, attempts = attempts + 1
         WHERE id = ? AND version = ? AND next_attempt_at <= ?
           AND (status = 'pending' OR (status = 'dispatching' AND lease_until <= ?))
         RETURNING *`,
        [now + REVOCATION_LEASE_MS, value, expectedVersion, now, now],
      );
      const row = result.rows[0];
      return row ? revocationFrom(row) : null;
    },

    async completeRevocation(value, claimedVersion) {
      id(value);
      version(claimedVersion);
      // A guarded UPDATE precedes DELETE so the outbox still attributes this
      // completion to its session. Pending peers prevent premature settlement.
      const result = await sql.batch([
        {
          sql: `UPDATE shared_auth_sessions SET status = 'revoked', version = version + 1
                WHERE status = 'revocation_pending'
                  AND digest = (SELECT session_digest FROM shared_auth_revocations
                                WHERE id = ? AND version = ? AND status = 'dispatching')
                  AND NOT EXISTS (SELECT 1 FROM shared_auth_revocations AS other
                                  WHERE other.session_digest = shared_auth_sessions.digest
                                    AND other.id <> ?)`,
          params: [value, claimedVersion, value],
        },
        {
          sql: `DELETE FROM shared_auth_revocations
                WHERE id = ? AND version = ? AND status = 'dispatching'`,
          params: [value, claimedVersion],
        },
      ]);
      return result[1]?.changes === 1;
    },

    async retryRevocation(value, claimedVersion, nextAttemptAt) {
      id(value);
      version(claimedVersion);
      time(nextAttemptAt);
      const result = await sql.run(
        `UPDATE shared_auth_revocations
         SET status = 'pending', lease_until = NULL, next_attempt_at = ?, version = version + 1
         WHERE id = ? AND version = ? AND status = 'dispatching'`,
        [nextAttemptAt, value, claimedVersion],
      );
      return result.changes === 1;
    },

    async cleanupExpiredAttempts(now, limit) {
      time(now);
      page(limit);
      const result = await sql.run(
        `DELETE FROM shared_auth_attempts WHERE digest IN
           (SELECT digest FROM shared_auth_attempts WHERE expires_at <= ? ORDER BY expires_at, digest LIMIT ?)`,
        [now, limit],
      );
      return result.changes;
    },

    async cleanupRevokedSessions(before, limit) {
      time(before);
      page(limit);
      const result = await sql.run(
        `DELETE FROM shared_auth_sessions WHERE digest IN
           (SELECT digest FROM shared_auth_sessions WHERE status = 'revoked'
              AND absolute_expires_at <= ?
              AND NOT EXISTS (SELECT 1 FROM shared_auth_revocations
                              WHERE session_digest = shared_auth_sessions.digest)
            ORDER BY absolute_expires_at, digest LIMIT ?)`,
        [before, limit],
      );
      return result.changes;
    },
  };
}

/**
 * Private composition only. All ordinary operations capture the SAME supplied
 * Sql; no connection, money wrapper, query or retry is created by this factory.
 * A complete 0/[] acknowledgement is a known miss only when the owning entry
 * has genuinely connected the strict native driver. Activation/native/realm
 * qualification is external owner work, not a caller flag or this factory name.
 */
export function createSharedAuthFinalSessionStore(sql: Sql): SharedAuthFinalSessionStore {
  const ordinary = createSharedAuthSessionStore(sql);
  return {
    ...ordinary,
    async touchSessionAndSelect(value, expectedVersion, now) {
      return await touchSessionRow(sql, value, expectedVersion, now);
    },
  };
}

function invalid(): never {
  throw new TypeError("Invalid shared auth store input or row");
}

function time(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
}

function version(value: number): void {
  time(value);
  if (value >= Number.MAX_SAFE_INTEGER) invalid();
}

function page(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 128) invalid();
}

function digest(value: string): void {
  if (typeof value !== "string" || !DIGEST.test(value)) invalid();
}

function id(value: string): void {
  if (typeof value !== "string" || !/^[a-zA-Z0-9:_-]{1,256}$/u.test(value)) invalid();
}

function payload(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 * 1024) invalid();
}

function identity(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /\p{Cc}/u.test(value)
  )
    invalid();
}

function checkAttempt(value: OidcAttempt): void {
  digest(value.digest);
  payload(value.payload);
  time(value.createdAt);
  time(value.expiresAt);
  if (value.expiresAt <= value.createdAt) invalid();
}

function checkSession(value: OidcSessionRecord): void {
  digest(value.digest);
  identity(value.accountId);
  identity(value.principalId);
  identity(value.workspaceId);
  payload(value.payload);
  time(value.createdAt);
  time(value.lastUsedAt);
  time(value.absoluteExpiresAt);
  time(value.grantCheckedAt);
  version(value.version);
  if (
    !STATUSES.has(value.status) ||
    value.absoluteExpiresAt <= value.createdAt ||
    value.lastUsedAt < value.createdAt ||
    value.lastUsedAt >= value.absoluteExpiresAt ||
    value.grantCheckedAt < value.createdAt ||
    value.grantCheckedAt > value.lastUsedAt
  )
    invalid();
}

function attemptFrom(row: Row): OidcAttempt {
  const result = {
    digest: row.digest as string,
    payload: row.payload as string,
    createdAt: row.created_at as number,
    expiresAt: row.expires_at as number,
  };
  checkAttempt(result);
  return result;
}

function sessionFrom(row: Row): OidcSessionRecord {
  const result = {
    digest: row.digest as string,
    accountId: row.account_id as string,
    principalId: row.principal_id as string,
    workspaceId: row.workspace_id as string,
    payload: row.payload as string,
    createdAt: row.created_at as number,
    lastUsedAt: row.last_used_at as number,
    absoluteExpiresAt: row.absolute_expires_at as number,
    grantCheckedAt: row.grant_checked_at as number,
    version: row.version as number,
    status: row.status as OidcSessionRecord["status"],
  };
  checkSession(result);
  return result;
}

function revocationFrom(row: Row): OidcRevocation {
  const result = {
    id: row.id as string,
    sessionDigest: row.session_digest as string,
    payload: row.payload as string,
    createdAt: row.created_at as number,
    nextAttemptAt: row.next_attempt_at as number,
    version: row.version as number,
    status: row.status as OidcRevocation["status"],
    leaseUntil: row.lease_until as number | null,
    attempts: row.attempts as number,
  };
  id(result.id);
  digest(result.sessionDigest);
  payload(result.payload);
  time(result.createdAt);
  time(result.nextAttemptAt);
  version(result.version);
  time(result.attempts);
  if (result.status !== "pending" && result.status !== "dispatching") invalid();
  if (result.leaseUntil !== null) time(result.leaseUntil);
  if ((result.status === "dispatching") !== (result.leaseUntil !== null)) invalid();
  return result;
}

function refreshRevocationId(value: string, claimedVersion: number): string {
  return `${value}:refresh:${claimedVersion}`;
}
