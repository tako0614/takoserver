import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createAccounts } from "../src/auth.ts";
import { additiveAuthFullRpDDL } from "../src/auth-authority-schema-plan.ts";
import {
  type CredentialAuthorityOrigin,
  createCredentialAuthorityClassStore,
  type RpAuthorityIdentity,
} from "../src/credential-authority-class.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { resolveIdentity } from "../src/identity-setup.ts";
import { base64UrlEncode } from "../src/json.ts";
import {
  createSharedAuthSessionStore,
  type OidcAttempt,
  type OidcSessionRecord,
} from "../src/shared-auth-session-store.ts";
import {
  authAuthorityDigest,
  createSharedPrincipalAuthorityStore,
} from "../src/shared-principal-authority.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

// Structural storage/lifecycle coverage only. bindLegacy inputs below are not
// proof, and this test does not qualify a genuine RP verifier or issuer carrier.
const audience = "https://auth103-rp-schema.example.test";
const opened = new Set<Database>();
afterEach(() => {
  for (const db of opened) db.close();
  opened.clear();
});

async function fixture() {
  const db = new Database(":memory:");
  opened.add(db);
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  const hasRpSessions = () =>
    db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='shared_auth_sessions'")
      .all().length > 0;
  expect(hasRpSessions()).toBe(false);
  db.exec(additiveAuthFullRpDDL);
  expect(hasRpSessions()).toBe(true);
  const sql = createSqliteSql(db);
  const now = Date.now();
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const verifier = resolveIdentity({
    operatorPublicKeyJwk: { kty: "OKP", crv: "Ed25519", x: String(publicKey.x) },
    operatorAudience: audience,
    clock: () => new Date(now),
  }).verifier;
  const payload = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        purpose: "sign-in",
        aud: audience,
        provider: "google",
        subject: "existing-google-principal",
        email: "existing-google-principal@example.test",
        displayName: "Existing legacy principal",
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 300,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    pair.privateKey,
    new TextEncoder().encode(payload),
  );
  const accounts = createAccounts({ sql, identity: verifier, clock: () => new Date(now) });
  const legacy = await accounts.signIn({
    provider: "google",
    method: "operator-assertion",
    audience,
    assertion: `${payload}.${base64UrlEncode(new Uint8Array(signature))}`,
  });
  const principalRows = await sql.query(
    "SELECT id,provider,provider_subject,created_at FROM principals WHERE id=?",
    [legacy.principal.id],
  );
  const persistedPrincipal = principalRows[0];
  if (
    principalRows.length !== 1 ||
    !persistedPrincipal ||
    persistedPrincipal.id !== legacy.principal.id ||
    persistedPrincipal.provider !== legacy.principal.provider ||
    persistedPrincipal.provider_subject !== legacy.principal.providerSubject ||
    typeof persistedPrincipal.created_at !== "string"
  ) {
    throw new Error("legacy Principal row does not match the signed-in fixture");
  }
  const principalAuthority = createSharedPrincipalAuthorityStore({ sql });
  const binding = await principalAuthority.bindLegacy({
    principalId: legacy.principal.id,
    principalIncarnation: `proved-legacy-${crypto.randomUUID()}`,
    provider: "google",
    providerSubject: legacy.principal.providerSubject,
    createdAt: persistedPrincipal.created_at,
    origin: {
      ref: `structural:legacy-origin:${crypto.randomUUID()}`,
      digest: `sha256:${"a".repeat(64)}`,
    },
    binding: {
      ref: `structural:legacy-binding:${crypto.randomUUID()}`,
      issuer: "https://issuer.example.test",
      subject: legacy.principal.providerSubject,
      controllerIncarnation: `controller-${crypto.randomUUID()}`,
      targetRef: "structural:target",
      evidence: {
        ref: `structural:binding-evidence:${crypto.randomUUID()}`,
        digest: `sha256:${"b".repeat(64)}`,
      },
      enrolledAt: new Date(now).toISOString(),
    },
  });
  return {
    db,
    sql,
    now,
    binding,
    classes: createCredentialAuthorityClassStore({ sql }),
    sessions: createSharedAuthSessionStore(sql),
  };
}

function session(
  digest: string,
  principalId: string,
  accountId: string,
  now: number,
  payload = "structural-encrypted-grant",
): OidcSessionRecord {
  return {
    digest,
    accountId,
    principalId,
    workspaceId: "workspace-legacy",
    payload,
    createdAt: now - 5_000,
    lastUsedAt: now - 3_000,
    absoluteExpiresAt: now + 60 * 60 * 1000,
    grantCheckedAt: now - 3_000,
    version: 0,
    status: "active",
  };
}

function credentialOrigin(
  binding: { principalId: string; principalIncarnation: string; targetRef: string },
  suffix: string,
  now: number,
): CredentialAuthorityOrigin {
  return {
    ref: `structural:rp-authority:${suffix}`,
    incarnation: `structural:rp-credential:${suffix}`,
    targetRef: binding.targetRef,
    principalId: binding.principalId,
    principalIncarnation: binding.principalIncarnation,
    issuanceRef: `structural:rp-issuance:${suffix}`,
    issuanceDigest: `sha256:${"c".repeat(64)}`,
    issuedAt: new Date(now).toISOString(),
  };
}

function rpIdentity(
  binding: {
    ref: string;
    issuer: string;
    subject: string;
  },
  sessionDigest: RpAuthorityIdentity["sessionDigest"],
  sessionCreatedAt: number,
): RpAuthorityIdentity {
  return {
    principalBindingRef: binding.ref,
    registrationRef: "structural:rp-registration",
    registrationDigest: `sha256:${"d".repeat(64)}`,
    sessionDigest,
    sessionCreatedAt,
    enrolledSessionVersion: 0,
    issuer: binding.issuer,
    clientId: "structural:rp-client",
    subject: binding.subject,
    issuerSessionId: "structural:issuer-session",
    authTime: Math.floor(sessionCreatedAt / 1000),
    accountId: binding.subject,
    workspaceId: "workspace-legacy",
    workspaceRef: "structural:workspace",
  };
}

test("Auth full RP candidate supports the actual store and retires exact class history", async () => {
  const f = await fixture();
  const digest = authAuthorityDigest(`sha256:${"e".repeat(64)}`);
  const value = session(digest, f.binding.principalId, f.binding.subject, f.now);
  expect(await f.sessions.createSession(value)).toBe(true);
  expect(await f.sessions.createSession({ ...value, payload: "must-not-replace" })).toBe(false);
  expect(await f.sessions.readSession(digest)).toEqual(value);
  expect(
    await f.sql.query(
      "SELECT digest,account_id,principal_id,workspace_id,payload,created_at,last_used_at,absolute_expires_at,grant_checked_at,version,status FROM shared_auth_sessions WHERE digest=?",
      [digest],
    ),
  ).toEqual([
    {
      digest,
      account_id: value.accountId,
      principal_id: value.principalId,
      workspace_id: value.workspaceId,
      payload: value.payload,
      created_at: value.createdAt,
      last_used_at: value.lastUsedAt,
      absolute_expires_at: value.absoluteExpiresAt,
      grant_checked_at: value.grantCheckedAt,
      version: 0,
      status: "active",
    },
  ]);
  const replace = await f.sql.run(
    `INSERT OR REPLACE INTO shared_auth_sessions
      (digest,account_id,principal_id,workspace_id,payload,created_at,last_used_at,
       absolute_expires_at,grant_checked_at,version,status)
      VALUES (?,?,?,?,?,?,?,?,?,0,'active')`,
    [
      value.digest,
      value.accountId,
      value.principalId,
      value.workspaceId,
      "replace-must-be-ignored",
      value.createdAt,
      value.lastUsedAt,
      value.absoluteExpiresAt,
      value.grantCheckedAt,
    ],
  );
  expect(replace.changes).toBe(0);
  expect(await f.sessions.readSession(digest)).toEqual(value);
  await expect(
    f.sql.run("UPDATE shared_auth_sessions SET principal_id='reassigned' WHERE digest=?", [digest]),
  ).rejects.toMatchObject({ code: "constraint" });
  await expect(
    f.sql.run("UPDATE shared_auth_sessions SET version=version+2 WHERE digest=?", [digest]),
  ).rejects.toMatchObject({ code: "constraint" });

  const attempt: OidcAttempt = {
    digest: `sha256:${"9".repeat(64)}`,
    payload: "structural-single-use-attempt",
    createdAt: f.now - 2_000,
    expiresAt: f.now + 30_000,
  };
  expect(await f.sessions.putAttempt(attempt)).toBe(true);
  expect(await f.sessions.putAttempt({ ...attempt, payload: "replacement" })).toBe(false);
  const attemptReplace = await f.sql.run(
    `INSERT OR REPLACE INTO shared_auth_attempts (digest,payload,created_at,expires_at)
     VALUES (?,?,?,?)`,
    [attempt.digest, "replace-must-be-ignored", attempt.createdAt, attempt.expiresAt],
  );
  expect(attemptReplace.changes).toBe(0);
  const attemptIgnore = await f.sql.run(
    `INSERT OR IGNORE INTO shared_auth_attempts (digest,payload,created_at,expires_at)
     VALUES (?,?,?,?)`,
    [attempt.digest, "ignore-must-not-replace", attempt.createdAt, attempt.expiresAt],
  );
  expect(attemptIgnore.changes).toBe(0);
  expect(await f.sessions.consumeAttempt(attempt.digest, f.now)).toEqual(attempt);

  const origin = credentialOrigin(f.binding, "lifecycle", f.now);
  const rp = rpIdentity(f.binding, digest, value.createdAt);
  await f.sql.batch([f.classes.sharedRpIssuanceStatement(origin, rp, "structural:organization")]);
  const enrolled = await f.classes.readRetained(origin.ref);
  expect(enrolled?.backend).toBe("shared-rp-session");
  expect(enrolled?.state).toBe("active");

  const claimedSession = await f.sessions.claimSession(digest, 0, f.now - 1_000);
  expect(claimedSession).toMatchObject({ status: "checking", version: 1 });
  if (!claimedSession) throw new Error("RP store did not claim the active session");
  // completeSession is one-shot; this regression performs one known settlement.
  expect(
    await f.sessions.completeSession(digest, claimedSession.version, {
      payload: "structural-rotated-encrypted-grant",
      grantCheckedAt: f.now,
      lastUsedAt: f.now + 1,
    }),
  ).toBe(true);
  expect(await f.sessions.readSession(digest)).toMatchObject({
    status: "active",
    version: 2,
    payload: "structural-rotated-encrypted-grant",
  });
  // The lost-ACK rule is caller policy: this test observes a known CAS result
  // only and does not simulate an unknown adapter acknowledgement or retry it.
  const selected = await f.sessions.touchSessionAndSelect(digest, 2, f.now + 2);
  expect(selected).toMatchObject({ status: "active", version: 3, lastUsedAt: f.now + 2 });
  expect((await f.sessions.readSession(digest))?.version).toBe(3);
  expect((await f.classes.readRetained(origin.ref))?.state).toBe("active");

  expect(await f.sessions.revokeSession(digest, f.now + 1)).toBe(true);
  expect(await f.sessions.readSession(digest)).toMatchObject({
    status: "revocation_pending",
    version: 4,
  });
  const fenced = await f.classes.readRetained(origin.ref);
  expect(fenced?.state).toBe("retired");
  expect(fenced?.terminal?.reason).toBe("rp-session-terminal");
  expect(fenced?.terminal?.ref).toBe(`rp-session-terminal:${digest}:${value.createdAt}`);

  const [pending] = await f.sessions.listPendingRevocations(f.now + 1, 10);
  if (!pending) throw new Error("RP store did not persist the logout outbox row");
  const claimed = await f.sessions.claimRevocation(pending.id, pending.version, f.now + 1);
  if (!claimed) throw new Error("RP store did not claim the logout outbox row");
  expect(await f.sessions.completeRevocation(claimed.id, claimed.version)).toBe(true);
  expect(await f.sessions.readSession(digest)).toMatchObject({ status: "revoked", version: 5 });
  expect(await f.sessions.cleanupRevokedSessions(value.absoluteExpiresAt + 1, 10)).toBe(1);
  expect(await f.sessions.readSession(digest)).toBeNull();
  expect(await f.sessions.createSession({ ...value, payload: "replay-after-cleanup" })).toBe(false);
  expect(await f.sessions.readSession(digest)).toBeNull();
  expect((await f.classes.readRetained(origin.ref))?.state).toBe("retired");
});

test("existing-session revocation queue is idempotent, retryable, and no-replace", async () => {
  const f = await fixture();
  const digest = `sha256:${"6".repeat(64)}`;
  const value = session(digest, f.binding.principalId, f.binding.subject, f.now);
  expect(await f.sessions.createSession(value)).toBe(true);
  const input = {
    id: `structural-current-session-revocation-${crypto.randomUUID()}`,
    sessionDigest: digest,
    payload: value.payload,
    createdAt: f.now,
  };
  await f.sessions.queueRevocation(input);
  expect(await f.sessions.readSession(digest)).toMatchObject({
    status: "revocation_pending",
    version: 1,
  });
  await f.sessions.queueRevocation(input);
  await expect(
    f.sessions.queueRevocation({ ...input, payload: "conflicting-payload" }),
  ).rejects.toThrow("Invalid shared auth store input or row");

  const [persisted] = await f.sessions.listPendingRevocations(f.now, 10);
  if (!persisted) throw new Error("RP store did not persist the current-session revocation");
  expect(persisted).toMatchObject({
    id: input.id,
    sessionDigest: digest,
    payload: input.payload,
    status: "pending",
    version: 0,
    attempts: 0,
  });
  const outboxReplace = await f.sql.run(
    `INSERT OR REPLACE INTO shared_auth_revocations
      (id,session_digest,payload,created_at,next_attempt_at,version,status,lease_until,attempts)
     VALUES (?,?,?,?,?,0,'pending',NULL,0)`,
    [input.id, digest, "replace-must-be-ignored", f.now, f.now],
  );
  expect(outboxReplace.changes).toBe(0);
  const outboxIgnore = await f.sql.run(
    `INSERT OR IGNORE INTO shared_auth_revocations
      (id,session_digest,payload,created_at,next_attempt_at,version,status,lease_until,attempts)
     VALUES (?,?,?,?,?,0,'pending',NULL,0)`,
    [input.id, digest, "ignore-must-not-replace", f.now, f.now],
  );
  expect(outboxIgnore.changes).toBe(0);
  expect(await f.sessions.listPendingRevocations(f.now, 10)).toEqual([persisted]);

  const firstClaim = await f.sessions.claimRevocation(persisted.id, persisted.version, f.now);
  expect(firstClaim).toMatchObject({ status: "dispatching", version: 1, attempts: 1 });
  if (!firstClaim) throw new Error("RP store did not claim the current-session revocation");
  expect(await f.sessions.retryRevocation(firstClaim.id, firstClaim.version, f.now + 1)).toBe(true);
  const [retryable] = await f.sessions.listPendingRevocations(f.now + 1, 10);
  expect(retryable).toMatchObject({ status: "pending", version: 2, attempts: 1 });
  if (!retryable) throw new Error("RP store did not return the retried revocation");
  const secondClaim = await f.sessions.claimRevocation(retryable.id, retryable.version, f.now + 1);
  expect(secondClaim).toMatchObject({ status: "dispatching", version: 3, attempts: 2 });
  if (!secondClaim) throw new Error("RP store did not reclaim the retried revocation");
  expect(await f.sessions.completeRevocation(secondClaim.id, secondClaim.version)).toBe(true);
  expect(await f.sessions.readSession(digest)).toMatchObject({ status: "revoked", version: 2 });
  expect(await f.sessions.listPendingRevocations(f.now + 1, 10)).toEqual([]);
});

test("session versions and outbox attempt counters fail closed at safe-integer limits", async () => {
  const f = await fixture();
  const maxSafe = Number.MAX_SAFE_INTEGER;
  const digest = `sha256:${"7".repeat(64)}`;
  const value = {
    ...session(digest, f.binding.principalId, f.binding.subject, f.now),
    version: maxSafe - 1,
  };
  await f.sql.run(
    `INSERT INTO shared_auth_sessions
      (digest,account_id,principal_id,workspace_id,payload,created_at,last_used_at,
       absolute_expires_at,grant_checked_at,version,status)
     VALUES (?,?,?,?,?,?,?,?,?,?,'active')`,
    [
      value.digest,
      value.accountId,
      value.principalId,
      value.workspaceId,
      value.payload,
      value.createdAt,
      value.lastUsedAt,
      value.absoluteExpiresAt,
      value.grantCheckedAt,
      value.version,
    ],
  );
  await expect(f.sessions.touchSession(digest, maxSafe - 1, f.now)).rejects.toMatchObject({
    code: "constraint",
  });
  await expect(
    f.sql.run("UPDATE shared_auth_sessions SET version=version+1 WHERE digest=?", [digest]),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.sessions.readSession(digest)).toEqual(value);

  const revocationId = `structural-counter-limit-${crypto.randomUUID()}`;
  await f.sql.run(
    `INSERT INTO shared_auth_revocations
      (id,session_digest,payload,created_at,next_attempt_at,version,status,lease_until,attempts)
     VALUES (?,?,?, ?, ?,0,'pending',NULL,?)`,
    [revocationId, `sha256:${"8".repeat(64)}`, "structural-counter-grant", f.now, f.now, maxSafe],
  );
  await expect(f.sessions.claimRevocation(revocationId, 0, f.now)).rejects.toMatchObject({
    code: "constraint",
  });
  expect(await f.sessions.listPendingRevocations(f.now, 10)).toMatchObject([
    { id: revocationId, status: "pending", version: 0, attempts: maxSafe, leaseUntil: null },
  ]);
});

test("Auth RP class guard and deletion lifecycle fail closed and roll back the session write", async () => {
  const f = await fixture();
  const orphanDigest = `sha256:${"2".repeat(64)}`;
  await f.sessions.queueRevocation({
    id: `structural-orphan-revocation-${crypto.randomUUID()}`,
    sessionDigest: orphanDigest,
    payload: "structural-orphan-grant",
    createdAt: f.now,
  });
  expect(await f.sessions.listPendingRevocations(f.now, 10)).toHaveLength(1);

  const insertedDigest = `sha256:${"f".repeat(64)}`;
  const missingDigest = authAuthorityDigest(`sha256:${"0".repeat(64)}`);
  const value = session(insertedDigest, f.binding.principalId, f.binding.subject, f.now);
  const origin = credentialOrigin(f.binding, "rollback", f.now);
  const mismatchedRp = rpIdentity(f.binding, missingDigest, value.createdAt);

  await expect(
    f.sql.batch([
      {
        sql: `INSERT INTO shared_auth_sessions
          (digest,account_id,principal_id,workspace_id,payload,created_at,last_used_at,
           absolute_expires_at,grant_checked_at,version,status)
          VALUES (?,?,?,?,?,?,?,?,?,0,'active')`,
        params: [
          value.digest,
          value.accountId,
          value.principalId,
          value.workspaceId,
          value.payload,
          value.createdAt,
          value.lastUsedAt,
          value.absoluteExpiresAt,
          value.grantCheckedAt,
        ],
      },
      f.classes.sharedRpIssuanceStatement(origin, mismatchedRp, "structural:organization"),
    ]),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.sessions.readSession(insertedDigest)).toBeNull();
  expect(await f.classes.readRetained(origin.ref)).toBeNull();

  const deleteDigest = authAuthorityDigest(`sha256:${"1".repeat(64)}`);
  const deletable = session(deleteDigest, f.binding.principalId, f.binding.subject, f.now);
  expect(await f.sessions.createSession(deletable)).toBe(true);
  const deleteOrigin = credentialOrigin(f.binding, "delete", f.now);
  const deleteRp = rpIdentity(f.binding, deleteDigest, deletable.createdAt);
  await f.sql.batch([
    f.classes.sharedRpIssuanceStatement(deleteOrigin, deleteRp, "structural:organization"),
  ]);
  await f.sql.run("DELETE FROM shared_auth_sessions WHERE digest=?", [deleteDigest]);
  const history = await f.classes.readRetained(deleteOrigin.ref);
  expect(history?.state).toBe("retired");
  expect(history?.terminal?.reason).toBe("rp-session-terminal");
  expect(history?.terminal?.ref).toBe(`rp-session-terminal:${deleteDigest}:${deletable.createdAt}`);
});
