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
import type { SqlStatement } from "../src/ports.ts";
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

// These cases exercise the fixed storage companion on the actual SQLite
// adapter. The structural origin/binding fixture is not a genuine RP issuer,
// registered schema, qualified native adapter, or distinct-human proof.
function newRpInputs(f: Awaited<ReturnType<typeof fixture>>, suffix: string) {
  const digest = authAuthorityDigest(`sha256:${"3".repeat(64)}`);
  const value: OidcSessionRecord = {
    ...session(digest, f.binding.principalId, f.binding.subject, f.now),
    createdAt: f.now,
    lastUsedAt: f.now,
    grantCheckedAt: f.now,
  };
  return {
    value,
    origin: credentialOrigin(f.binding, suffix, f.now),
    rp: rpIdentity(f.binding, digest, value.createdAt),
    organizationId: "structural:organization",
  };
}

test("NEW RP companion commits one session and one retained class with both exact postimages", async () => {
  const f = await fixture();
  const input = newRpInputs(f, "atomic-new");
  const pair = f.classes.sharedRpNewSessionIssuanceStatements(
    input.origin,
    input.rp,
    input.organizationId,
    input.value,
  );
  expect(Object.isFrozen(pair)).toBe(true);
  expect(pair).toHaveLength(2);
  for (const statement of pair) {
    expect(Object.isFrozen(statement)).toBe(true);
    expect(Object.isFrozen(statement.params)).toBe(true);
  }
  const written = await f.sql.batch(pair);
  expect(written).toHaveLength(2);
  expect(written.map((write) => write.changes)).toEqual([1, 1]);
  expect(written.map((write) => write.rows.length)).toEqual([1, 1]);
  expect(written[0]?.rows).toEqual([
    {
      digest: input.value.digest,
      account_id: input.value.accountId,
      principal_id: input.value.principalId,
      workspace_id: input.value.workspaceId,
      payload: input.value.payload,
      created_at: f.now,
      last_used_at: f.now,
      absolute_expires_at: input.value.absoluteExpiresAt,
      grant_checked_at: f.now,
      version: 0,
      status: "active",
    },
  ]);
  expect(written[1]?.rows[0]).toMatchObject({
    authority_ref: input.origin.ref,
    credential_incarnation: input.origin.incarnation,
    class: "official-shared-rp-session",
    backend: "shared-rp-session",
    principal_id: input.value.principalId,
    principal_incarnation: input.origin.principalIncarnation,
    principal_binding_ref: input.rp.principalBindingRef,
    rp_registration_ref: input.rp.registrationRef,
    rp_registration_digest: input.rp.registrationDigest,
    session_digest: input.value.digest,
    session_created_at: f.now,
    session_enrolled_version: 0,
    organization_id: input.organizationId,
    workspace_id: input.value.workspaceId,
    workspace_ref: input.rp.workspaceRef,
    state: "active",
  });
  expect(await f.sessions.readSession(input.value.digest)).toEqual(input.value);
  expect(await f.classes.readRetained(input.origin.ref)).toEqual({
    origin: input.origin,
    class: "official-shared-rp-session",
    backend: "shared-rp-session",
    organizationId: input.organizationId,
    rp: input.rp,
    state: "active",
    terminal: null,
  });
});

test("NEW RP companion rejects a byte-identical old session after an actual unrelated changes=1", async () => {
  const f = await fixture();
  const input = newRpInputs(f, "identical-old-session");
  expect(await f.sessions.createSession(input.value)).toBe(true);
  const attempt: OidcAttempt = {
    digest: `sha256:${"4".repeat(64)}`,
    payload: "structural-prior-write",
    createdAt: f.now,
    expiresAt: f.now + 30_000,
  };
  expect(await f.sessions.putAttempt(attempt)).toBe(true);
  expect(
    (await f.sql.run("DELETE FROM shared_auth_attempts WHERE digest=?", [attempt.digest])).changes,
  ).toBe(1);
  expect(await f.sql.query("SELECT changes() AS changes")).toEqual([{ changes: 1 }]);
  const before = await f.sessions.readSession(input.value.digest);
  const pair = f.classes.sharedRpNewSessionIssuanceStatements(
    input.origin,
    input.rp,
    input.organizationId,
    input.value,
  );
  await expect(f.sql.batch(pair)).rejects.toMatchObject({ code: "constraint" });
  expect(await f.sessions.readSession(input.value.digest)).toEqual(before);
  expect(await f.classes.readRetained(input.origin.ref)).toBeNull();
  expect(await f.sql.query("SELECT authority_ref FROM credential_authority_classes")).toEqual([]);
});

test("NEW RP companion cannot reuse a deleted session retained only in retired class history", async () => {
  const f = await fixture();
  const input = newRpInputs(f, "retained-only-original");
  await f.sql.batch(
    f.classes.sharedRpNewSessionIssuanceStatements(
      input.origin,
      input.rp,
      input.organizationId,
      input.value,
    ),
  );
  expect(
    (await f.sql.run("DELETE FROM shared_auth_sessions WHERE digest=?", [input.value.digest]))
      .changes,
  ).toBe(1);
  const history = await f.classes.readRetained(input.origin.ref);
  expect(history).toMatchObject({ state: "retired", terminal: { reason: "rp-session-terminal" } });
  const replacement = credentialOrigin(f.binding, "retained-only-replacement", f.now);
  await expect(
    f.sql.batch(
      f.classes.sharedRpNewSessionIssuanceStatements(
        replacement,
        input.rp,
        input.organizationId,
        input.value,
      ),
    ),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await f.sessions.readSession(input.value.digest)).toBeNull();
  expect(await f.classes.readRetained(replacement.ref)).toBeNull();
  expect(await f.classes.readRetained(input.origin.ref)).toEqual(history);
  expect(await f.sql.query("SELECT authority_ref FROM credential_authority_classes")).toEqual([
    { authority_ref: input.origin.ref },
  ]);
});

for (const fault of ["binding", "issuer", "subject", "incarnation", "target"] as const) {
  test(`NEW RP companion rolls the new session back when the retained ${fault} guard fails`, async () => {
    const f = await fixture();
    const input = newRpInputs(f, `guard-${fault}`);
    const origin = {
      ...input.origin,
      ...(fault === "incarnation" ? { principalIncarnation: "structural:wrong-incarnation" } : {}),
      ...(fault === "target" ? { targetRef: "structural:wrong-target" } : {}),
    };
    const rp = {
      ...input.rp,
      ...(fault === "binding" ? { principalBindingRef: "structural:missing-binding" } : {}),
      ...(fault === "issuer" ? { issuer: "https://wrong-issuer.example.test" } : {}),
      ...(fault === "subject" ? { subject: "structural:wrong-subject" } : {}),
    };
    const pair = f.classes.sharedRpNewSessionIssuanceStatements(
      origin,
      rp,
      input.organizationId,
      input.value,
    );
    await expect(f.sql.batch(pair)).rejects.toMatchObject({ code: "constraint" });
    expect(await f.sessions.readSession(input.value.digest)).toBeNull();
    expect(await f.classes.readRetained(origin.ref)).toBeNull();
    expect(await f.sql.query("SELECT authority_ref FROM credential_authority_classes")).toEqual([]);
  });
}

test("NEW RP companion refuses mismatched record identity and nonfresh record fields before SQL", async () => {
  const f = await fixture();
  const input = newRpInputs(f, "input-refusal");
  const records: readonly OidcSessionRecord[] = [
    { ...input.value, digest: `sha256:${"5".repeat(64)}` },
    { ...input.value, accountId: "structural:other-account" },
    { ...input.value, principalId: "structural:other-principal" },
    { ...input.value, workspaceId: "structural:other-workspace" },
    {
      ...input.value,
      createdAt: f.now + 1,
      lastUsedAt: f.now + 1,
      grantCheckedAt: f.now + 1,
    },
    { ...input.value, lastUsedAt: f.now + 1 },
    { ...input.value, grantCheckedAt: f.now + 1 },
    { ...input.value, absoluteExpiresAt: f.now },
    { ...input.value, version: 1 },
    { ...input.value, status: "checking" },
  ];
  for (const record of records) {
    expect(() =>
      f.classes.sharedRpNewSessionIssuanceStatements(
        input.origin,
        input.rp,
        input.organizationId,
        record,
      ),
    ).toThrow("auth_authority_invalid");
  }
  for (const rp of [
    { ...input.rp, enrolledSessionVersion: 1 },
    { ...input.rp, sessionCreatedAt: f.now + 1 },
    { ...input.rp, sessionDigest: authAuthorityDigest(`sha256:${"5".repeat(64)}`) },
    { ...input.rp, accountId: "structural:other-account" },
    { ...input.rp, workspaceId: "structural:other-workspace" },
  ]) {
    expect(() =>
      f.classes.sharedRpNewSessionIssuanceStatements(
        input.origin,
        rp,
        input.organizationId,
        input.value,
      ),
    ).toThrow("auth_authority_invalid");
  }
  expect(await f.sessions.readSession(input.value.digest)).toBeNull();
  expect(await f.classes.readRetained(input.origin.ref)).toBeNull();
});

test("NEW RP companion requires all eleven own DATA fields without invoking record getters", async () => {
  const f = await fixture();
  const input = newRpInputs(f, "record-own-data");
  let getterCalls = 0;
  for (const key of Object.keys(input.value)) {
    const accessor = { ...input.value };
    Object.defineProperty(accessor, key, {
      enumerable: true,
      get() {
        getterCalls++;
        throw new Error("record getter must not execute");
      },
    });
    expect(() =>
      f.classes.sharedRpNewSessionIssuanceStatements(
        input.origin,
        input.rp,
        input.organizationId,
        accessor,
      ),
    ).toThrow("auth_authority_invalid");
    const inherited = { ...input.value };
    Reflect.deleteProperty(inherited, key);
    Object.setPrototypeOf(inherited, input.value);
    expect(() =>
      f.classes.sharedRpNewSessionIssuanceStatements(
        input.origin,
        input.rp,
        input.organizationId,
        inherited,
      ),
    ).toThrow("auth_authority_invalid");
  }
  const extra = { ...input.value, unrelated: "must-not-be-captured" };
  expect(() =>
    f.classes.sharedRpNewSessionIssuanceStatements(
      input.origin,
      input.rp,
      input.organizationId,
      extra,
    ),
  ).toThrow("auth_authority_invalid");
  expect(getterCalls).toBe(0);
  expect(await f.sessions.readSession(input.value.digest)).toBeNull();
});

test("NEW RP companion captures origin, identity and session DATA before later input mutation", async () => {
  const f = await fixture();
  const input = newRpInputs(f, "captured-inputs");
  const expectedRecord = { ...input.value };
  const expectedOrigin = { ...input.origin };
  const expectedRp = { ...input.rp };
  const pair = f.classes.sharedRpNewSessionIssuanceStatements(
    input.origin,
    input.rp,
    input.organizationId,
    input.value,
  );
  let getterCalls = 0;
  for (const key of Object.keys(input.value)) {
    Object.defineProperty(input.value, key, {
      get() {
        getterCalls++;
        throw new Error("captured record must not be reread");
      },
    });
  }
  Object.defineProperty(input.origin, "ref", { value: "structural:mutated-authority-ref" });
  Object.defineProperty(input.origin, "targetRef", { value: "structural:mutated-target" });
  Object.defineProperty(input.rp, "subject", { value: "structural:mutated-subject" });
  Object.defineProperty(input.rp, "workspaceRef", { value: "structural:mutated-workspace-ref" });
  const written = await f.sql.batch(pair);
  expect(written.map((write) => write.changes)).toEqual([1, 1]);
  expect(written.map((write) => write.rows.length)).toEqual([1, 1]);
  expect(getterCalls).toBe(0);
  expect(await f.sessions.readSession(expectedRecord.digest)).toEqual(expectedRecord);
  expect(await f.classes.readRetained(expectedOrigin.ref)).toEqual({
    origin: expectedOrigin,
    class: "official-shared-rp-session",
    backend: "shared-rp-session",
    organizationId: input.organizationId,
    rp: expectedRp,
    state: "active",
    terminal: null,
  });
  expect(await f.classes.readRetained("structural:mutated-authority-ref")).toBeNull();
});

for (const fault of ["payload", "last-used", "absolute-expiry", "grant-checked"] as const) {
  test(`NEW RP companion aborts the whole batch after a transported ${fault} value differs from its captured record`, async () => {
    const f = await fixture();
    const input = newRpInputs(f, `transport-${fault}`);
    const pair = f.classes.sharedRpNewSessionIssuanceStatements(
      input.origin,
      input.rp,
      input.organizationId,
      input.value,
    );
    // Deliberate transport-fault injection: retain the fixed INSERT SQL and
    // mandatory companion, change only one otherwise schema-valid payload.
    const params = [...(pair[0].params ?? [])];
    if (fault === "payload") params[4] = "structural:transport-substituted-grant";
    if (fault === "last-used") params[6] = f.now + 1;
    if (fault === "absolute-expiry") params[7] = input.value.absoluteExpiresAt + 1;
    if (fault === "grant-checked") {
      params[6] = f.now + 1;
      params[8] = f.now + 1;
    }
    await expect(f.sql.batch([{ sql: pair[0].sql, params }, pair[1]])).rejects.toMatchObject({
      code: "constraint",
    });
    expect(await f.sessions.readSession(input.value.digest)).toBeNull();
    expect(await f.classes.readRetained(input.origin.ref)).toBeNull();
  });
}

async function moneyWrappedRpFixture() {
  const f = await fixture();
  const epoch = `sha256:${"a".repeat(64)}`;
  const {
    createMoneyCutoverSql,
    MONEY_CUTOVER_FREEZE_DDL,
    MONEY_CUTOVER_PERMIT_DDL,
    MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
    MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
  } = await import("../src/money-cutover-sql.ts");
  // Same published guard bootstrap as worker-request-composition's isolated
  // fixture. These existing exports are storage setup, not registered-schema
  // or genuine-target proof. Refuse a pre-existing, different guard definition.
  for (const guard of [
    { name: "money_cutover_freeze", type: "table", ddl: MONEY_CUTOVER_FREEZE_DDL },
    { name: "money_cutover_writer_permit", type: "table", ddl: MONEY_CUTOVER_PERMIT_DDL },
    {
      name: "money_cutover_authorized_epoch",
      type: "table",
      ddl: MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
    },
    {
      name: "money_cutover_permit_epoch_guard",
      type: "trigger",
      ddl: MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
    },
  ]) {
    const existing = await f.sql.query("SELECT type, name, sql FROM sqlite_master WHERE name=?", [
      guard.name,
    ]);
    if (existing.length === 0) f.db.exec(guard.ddl);
    expect(
      await f.sql.query("SELECT type, name, sql FROM sqlite_master WHERE name=?", [guard.name]),
    ).toEqual([{ type: guard.type, name: guard.name, sql: guard.ddl }]);
  }
  const guards = await f.sql.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?,?) ORDER BY name",
    ["money_cutover_authorized_epoch", "money_cutover_writer_permit"],
  );
  expect(guards).toEqual([
    { name: "money_cutover_authorized_epoch" },
    { name: "money_cutover_writer_permit" },
  ]);
  const authorized = await f.sql.query(
    "SELECT singleton, writer_epoch FROM money_cutover_authorized_epoch",
  );
  if (authorized.length === 0) {
    await f.sql.run("INSERT INTO money_cutover_authorized_epoch VALUES (1, ?)", [epoch]);
  }
  expect(
    await f.sql.query("SELECT singleton, writer_epoch FROM money_cutover_authorized_epoch"),
  ).toEqual([{ singleton: 1, writer_epoch: epoch }]);
  const submitted: (readonly SqlStatement[])[] = [];
  const rawBatch = f.sql.batch;
  f.sql.batch = async (statements) => {
    submitted.push(statements);
    return rawBatch.call(f.sql, statements);
  };
  return { ...f, epoch, submitted, moneySql: createMoneyCutoverSql(f.sql, epoch) };
}

function expectMoneyPair(
  statements: readonly SqlStatement[] | undefined,
  pair: readonly [SqlStatement, SqlStatement],
  epoch: string,
) {
  expect(statements).toHaveLength(4);
  expect(statements?.[0]).toEqual({
    sql: "INSERT INTO money_cutover_writer_permit (singleton, epoch, writer_epoch) VALUES (1, 'usd-micros-v2', ?)",
    params: [epoch],
  });
  expect(statements?.[1]).toBe(pair[0]);
  expect(statements?.[2]).toBe(pair[1]);
  expect(statements?.[3]).toEqual({
    sql: "DELETE FROM money_cutover_writer_permit WHERE singleton = 1 AND epoch = 'usd-micros-v2' AND writer_epoch = ?",
    params: [epoch],
  });
}

test("Money-wrapped NEW RP companion keeps the original pair adjacent and returns both one-row writes", async () => {
  const f = await moneyWrappedRpFixture();
  const input = newRpInputs(f, "money-new");
  const pair = f.classes.sharedRpNewSessionIssuanceStatements(
    input.origin,
    input.rp,
    input.organizationId,
    input.value,
  );
  const written = await f.moneySql.batch(pair);
  expect(f.submitted).toHaveLength(1);
  expectMoneyPair(f.submitted[0], pair, f.epoch);
  expect(written.map((write) => write.changes)).toEqual([1, 1]);
  expect(written.map((write) => write.rows.length)).toEqual([1, 1]);
  expect(await f.sessions.readSession(input.value.digest)).toEqual(input.value);
  expect(await f.classes.readRetained(input.origin.ref)).toMatchObject({ state: "active" });
  expect(await f.sql.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
});

test("Money permit changes=1 cannot turn an ignored old RP session into a NEW class", async () => {
  const f = await moneyWrappedRpFixture();
  const input = newRpInputs(f, "money-ignored-old");
  expect(await f.sessions.createSession(input.value)).toBe(true);
  const pair = f.classes.sharedRpNewSessionIssuanceStatements(
    input.origin,
    input.rp,
    input.organizationId,
    input.value,
  );
  await expect(f.moneySql.batch(pair)).rejects.toMatchObject({ code: "constraint" });
  expect(f.submitted).toHaveLength(1);
  expectMoneyPair(f.submitted[0], pair, f.epoch);
  expect(await f.sessions.readSession(input.value.digest)).toEqual(input.value);
  expect(await f.classes.readRetained(input.origin.ref)).toBeNull();
  expect(await f.sql.query("SELECT authority_ref FROM credential_authority_classes")).toEqual([]);
  expect(await f.sql.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
});
