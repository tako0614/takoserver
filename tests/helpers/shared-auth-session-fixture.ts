import { Miniflare } from "miniflare";
import { createSharedAuthSessionStore } from "../../src/shared-auth-session-store.ts";
import { createD1Sql, type D1DatabaseLike } from "../../src/sql-d1.ts";

// TEST-ONLY proposed additive storage contract. These literals exercise real
// D1 SQL/CAS without adopting a migration number, touching the schema owner, or
// reading operator-private files. No target has these future tables deployed.
export const SHARED_AUTH_TEST_ONLY_DDL = [
  `CREATE TABLE shared_auth_attempts (
     digest TEXT PRIMARY KEY NOT NULL,
     payload TEXT NOT NULL CHECK (length(payload) BETWEEN 1 AND 65536),
     created_at INTEGER NOT NULL CHECK (created_at >= 0),
     expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
   )`,
  "CREATE INDEX shared_auth_attempts_expiry ON shared_auth_attempts (expires_at, digest)",
  `CREATE TABLE shared_auth_sessions (
     digest TEXT PRIMARY KEY NOT NULL,
     account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 512),
     principal_id TEXT NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 512),
     workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 512),
     payload TEXT NOT NULL CHECK (length(payload) BETWEEN 1 AND 65536),
     created_at INTEGER NOT NULL CHECK (created_at >= 0),
     last_used_at INTEGER NOT NULL CHECK (last_used_at >= created_at),
     absolute_expires_at INTEGER NOT NULL CHECK (absolute_expires_at > last_used_at),
     grant_checked_at INTEGER NOT NULL CHECK (grant_checked_at BETWEEN created_at AND last_used_at),
     version INTEGER NOT NULL CHECK (version BETWEEN 0 AND 9007199254740990),
     status TEXT NOT NULL CHECK (status IN ('active', 'checking', 'revocation_pending', 'revoked'))
   )`,
  `CREATE INDEX shared_auth_sessions_revoked_expiry
     ON shared_auth_sessions (status, absolute_expires_at, digest)`,
  `CREATE TRIGGER shared_auth_sessions_immutable BEFORE UPDATE ON shared_auth_sessions
   WHEN NEW.digest IS NOT OLD.digest OR NEW.account_id IS NOT OLD.account_id
     OR NEW.principal_id IS NOT OLD.principal_id OR NEW.workspace_id IS NOT OLD.workspace_id
     OR NEW.created_at IS NOT OLD.created_at OR NEW.absolute_expires_at IS NOT OLD.absolute_expires_at
   BEGIN SELECT RAISE(ABORT, 'shared auth session identity is immutable'); END`,
  `CREATE TABLE shared_auth_revocations (
     id TEXT PRIMARY KEY NOT NULL,
     session_digest TEXT NOT NULL,
     payload TEXT NOT NULL CHECK (length(payload) BETWEEN 1 AND 65536),
     created_at INTEGER NOT NULL CHECK (created_at >= 0),
     next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= created_at),
     version INTEGER NOT NULL CHECK (version BETWEEN 0 AND 9007199254740990),
     status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching')),
     lease_until INTEGER,
     attempts INTEGER NOT NULL CHECK (attempts >= 0),
     CHECK ((status = 'pending' AND lease_until IS NULL)
         OR (status = 'dispatching' AND lease_until IS NOT NULL AND lease_until >= created_at))
   )`,
  "CREATE INDEX shared_auth_revocations_retry ON shared_auth_revocations (next_attempt_at, id)",
  "CREATE INDEX shared_auth_revocations_session ON shared_auth_revocations (session_digest, id)",
  `CREATE TRIGGER shared_auth_revocations_immutable BEFORE UPDATE ON shared_auth_revocations
   WHEN NEW.id IS NOT OLD.id OR NEW.session_digest IS NOT OLD.session_digest
     OR NEW.payload IS NOT OLD.payload OR NEW.created_at IS NOT OLD.created_at
   BEGIN SELECT RAISE(ABORT, 'shared auth revocation identity is immutable'); END`,
];

export async function createSharedAuthSessionStoreD1Fixture() {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "shared-auth-session-store-d1-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { AUTH_DB: { type: "d1", id: "shared-auth-session-store-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("AUTH_DB");
    // Composition, rather than the vendor-neutral store, chooses primary reads.
    const sql = createD1Sql(database.withSession("first-primary") as unknown as D1DatabaseLike);
    for (const statement of SHARED_AUTH_TEST_ONLY_DDL) await sql.run(statement);
    return { runtime, sql, store: createSharedAuthSessionStore(sql) };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
