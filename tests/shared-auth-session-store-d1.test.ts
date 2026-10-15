import { expect, test } from "bun:test";
import type { Sql } from "../src/ports.ts";
import {
  createSharedAuthFinalSessionStore,
  createSharedAuthSessionStore,
  type OidcSessionRecord,
} from "../src/shared-auth-session-store.ts";
import { createD1Sql, type D1DatabaseLike, type D1StatementLike } from "../src/sql-d1.ts";
import { createSharedAuthSessionStoreD1Fixture as fixture } from "./helpers/shared-auth-session-fixture.ts";

const NOW = 1_800_000_000_000;
const SESSION = `sha256:${"a".repeat(64)}`;
const ATTEMPT = `sha256:${"b".repeat(64)}`;

function session(digest = SESSION): OidcSessionRecord {
  return {
    digest,
    accountId: "pairwise-canonical-account",
    principalId: "principal:takoserver:local-customer",
    workspaceId: "retained-local-workspace",
    payload: "sealed:original-offline-grant",
    createdAt: NOW,
    lastUsedAt: NOW,
    absoluteExpiresAt: NOW + 86_400_000,
    grantCheckedAt: NOW,
    version: 0,
    status: "active",
  };
}

/** Component fixture for the adopted driver ABI; its actual driver/native integration is pending. */
async function finalFixture() {
  const original = await fixture();
  try {
    const database = await original.runtime.getD1Database("AUTH_DB");
    const sql = createD1Sql(
      database.withSession("first-primary") as unknown as D1DatabaseLike,
      { acknowledgement: "explicit-d1-result" },
    );
    return {
      ...original,
      sql,
      store: createSharedAuthFinalSessionStore(sql),
      ordinary: createSharedAuthSessionStore(sql),
    };
  } catch (error) {
    await original.runtime.dispose();
    throw error;
  }
}

test("native D1 atomically burns one callback attempt and burns an expired callback", async () => {
  const { runtime, sql, store } = await fixture();
  try {
    const attempt = {
      digest: ATTEMPT,
      payload: "sealed:pkce",
      createdAt: NOW,
      expiresAt: NOW + 1000,
    };
    expect(await store.putAttempt(attempt)).toBe(true);
    expect(await store.putAttempt({ ...attempt, payload: "sealed:other" })).toBe(false);
    const consumed = await Promise.all([
      store.consumeAttempt(ATTEMPT, NOW + 1),
      store.consumeAttempt(ATTEMPT, NOW + 1),
    ]);
    expect(consumed.filter(Boolean)).toEqual([attempt]);
    expect(await sql.query("SELECT * FROM shared_auth_attempts")).toEqual([]);
    await store.putAttempt(attempt);
    expect(await store.consumeAttempt(ATTEMPT, NOW + 1000)).toBeNull();
    expect(await store.consumeAttempt(ATTEMPT, NOW)).toBeNull();
  } finally {
    await runtime.dispose();
  }
}, 30_000);

test("native D1 persists opaque sessions and chooses exactly one refresh claimant", async () => {
  const { runtime, sql, store } = await fixture();
  try {
    const original = session();
    expect(await store.createSession(original)).toBe(true);
    expect(await store.createSession({ ...original, workspaceId: "other-workspace" })).toBe(false);
    // A new store instance proves the grant and fence survive a handler restart.
    expect(await createSharedAuthSessionStore(sql).readSession(SESSION)).toEqual(original);
    const results = await Promise.all([
      store.claimSession(SESSION, 0, NOW + 1),
      store.claimSession(SESSION, 0, NOW + 1),
    ]);
    expect(results.filter(Boolean)).toEqual([{ ...original, status: "checking", version: 1 }]);
    expect(await store.claimSession(SESSION, 1, NOW + 60_000)).toBeNull();
    expect(await store.touchSession(SESSION, 1, NOW + 2)).toBe(false);
    expect(
      await store.completeSession(SESSION, 1, {
        payload: "sealed:rotated-grant",
        grantCheckedAt: NOW + 2,
        lastUsedAt: NOW + 2,
      }),
    ).toBe(true);
    expect(await store.listPendingRevocations(NOW + 3, 128)).toEqual([]);
    expect(await store.touchSession(SESSION, 1, NOW + 3)).toBe(false);
    expect(await store.touchSession(SESSION, 2, NOW + 3)).toBe(true);
    expect(await store.readSession(SESSION)).toEqual({
      ...original,
      payload: "sealed:rotated-grant",
      grantCheckedAt: NOW + 2,
      lastUsedAt: NOW + 3,
      version: 3,
    });
  } finally {
    await runtime.dispose();
  }
}, 30_000);

test("native D1 expiry and immutable identity cannot revive or reassign a session", async () => {
  const { runtime, sql, store } = await fixture();
  try {
    const original = session();
    await store.createSession(original);
    for (const column of [
      "digest",
      "account_id",
      "principal_id",
      "workspace_id",
      "created_at",
      "absolute_expires_at",
    ]) {
      await expect(
        sql.run(`UPDATE shared_auth_sessions SET ${column} = ? WHERE digest = ?`, [
          column.endsWith("_at") ? NOW + 10 : "changed-identity",
          SESSION,
        ]),
      ).rejects.toMatchObject({ code: "constraint" });
    }
    expect(await store.claimSession(SESSION, 0, original.absoluteExpiresAt)).toBeNull();
    expect(await store.touchSession(SESSION, 0, original.absoluteExpiresAt)).toBe(false);
    expect(await store.readSession(SESSION)).toEqual(original);
    // Active rows, including expired ones, retain the grant until revocation settles.
    expect(await store.cleanupRevokedSessions(original.absoluteExpiresAt + 1, 128)).toBe(0);
  } finally {
    await runtime.dispose();
  }
}, 30_000);

test("native D1 touch selects its own immutable post-update row and one concurrent CAS winner", async () => {
  const { runtime, sql, store, ordinary } = await finalFixture();
  try {
    const original = session();
    await store.createSession(original);
    const results = await Promise.all([
      store.touchSessionAndSelect(SESSION, 0, NOW + 1),
      store.touchSessionAndSelect(SESSION, 0, NOW + 1),
    ]);
    const selected = results.find((row) => row !== null);
    if (selected === undefined) throw new Error("expected one selected final session row");
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((row) => row === null)).toHaveLength(1);
    expect(selected).toEqual({ ...original, lastUsedAt: NOW + 1, version: 1 });
    expect(Object.isFrozen(selected)).toBe(true);
    expect(await createSharedAuthSessionStore(sql).readSession(SESSION)).toEqual(selected);
    expect(await store.touchSession(SESSION, 1, NOW + 2)).toBe(true);
    expect((await store.readSession(SESSION))?.version).toBe(2);
    expect(selected?.version).toBe(1);
    expect(await store.touchSessionAndSelect(SESSION, 1, NOW + 3)).toBeNull();
    await expect(ordinary.touchSessionAndSelect(SESSION, 1, NOW + 3))
      .rejects.toThrow("no qualified known-miss acknowledgement");
    expect(await store.touchSession(SESSION, 2, NOW + 3)).toBe(true);
    expect((await store.readSession(SESSION))?.version).toBe(3);
  } finally {
    await runtime.dispose();
  }
}, 30_000);

test.each(["before", "after"] as const)(
  "native D1 touch with unknown %s-commit acknowledgement throws without resend or substitute read",
  async (phase) => {
    const { runtime, sql, store } = await finalFixture();
    try {
      await store.createSession(session());
      let writes = 0;
      let reads = 0;
      const uncertain: Sql = {
        async query(statement, params) {
          reads += 1;
          return await sql.query(statement, params);
        },
        batch: (statements) => sql.batch(statements),
        async run(statement, params) {
          writes += 1;
          if (phase === "after") await sql.run(statement, params);
          throw new Error("synthetic transport lost the touch acknowledgement");
        },
      };
      await expect(
        createSharedAuthFinalSessionStore(uncertain).touchSessionAndSelect(SESSION, 0, NOW + 1),
      ).rejects.toThrow("synthetic transport lost the touch acknowledgement");
      expect(writes).toBe(1);
      expect(reads).toBe(0);
      expect((await store.readSession(SESSION))?.version).toBe(phase === "after" ? 1 : 0);
    } finally {
      await runtime.dispose();
    }
  },
  30_000,
);

test("strict native post-commit raw acknowledgement loss cannot become a known zero", async () => {
  const { runtime, store } = await finalFixture();
  try {
    await store.createSession(session());
    const database = await runtime.getD1Database("AUTH_DB");
    const native = database.withSession("first-primary") as unknown as D1DatabaseLike;
    let writes = 0;
    // This is an explicitly synthetic native-response loss after the real D1
    // update commits. It is not a qualified production driver or Root graph.
    function loseResponse(prepared: D1StatementLike): D1StatementLike {
      return {
        bind(...params) {
          return loseResponse(prepared.bind(...params));
        },
        async all() {
          await prepared.all();
          writes += 1;
          return {};
        },
      };
    }
    const transport: D1DatabaseLike = {
      prepare(statement) {
        return loseResponse(native.prepare(statement));
      },
      async batch() {
        throw new Error("final touch must not issue another batch or recovery command");
      },
    };
    const strict = createD1Sql(transport, { acknowledgement: "explicit-d1-result" });
    await expect(
      createSharedAuthFinalSessionStore(strict).touchSessionAndSelect(SESSION, 0, NOW + 1),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(writes).toBe(1);
    expect((await store.readSession(SESSION))?.version).toBe(1);
  } finally {
    await runtime.dispose();
  }
}, 30_000);

test.each(["missing row", "zero with row", "extra rows", "wrong digest", "wrong version"])(
  "native D1 touch rejects a synthetic malformed acknowledgement: %s",
  async (failure) => {
    const { runtime, sql, store } = await finalFixture();
    try {
      await store.createSession(session());
      let writes = 0;
      const malformed: Sql = {
        query: (statement, params) => sql.query(statement, params),
        batch: (statements) => sql.batch(statements),
        async run(statement, params) {
          writes += 1;
          const result = await sql.run(statement, params);
          const row = result.rows[0];
          if (!row) throw new Error("missing real primary RETURNING image");
          if (failure === "missing row") return { changes: 1, rows: [] };
          if (failure === "zero with row") return { changes: 0, rows: [row] };
          if (failure === "extra rows") return { changes: 1, rows: [row, row] };
          return {
            changes: 1,
            rows: [{ ...row, ...(failure === "wrong digest"
              ? { digest: `sha256:${"c".repeat(64)}` }
              : { version: 3 }) }],
          };
        },
      };
      await expect(
        createSharedAuthFinalSessionStore(malformed).touchSessionAndSelect(SESSION, 0, NOW + 1),
      ).rejects.toBeInstanceOf(TypeError);
      expect(writes).toBe(1);
      expect((await store.readSession(SESSION))?.version).toBe(1);
    } finally {
      await runtime.dispose();
    }
  },
  30_000,
);

test("native D1 logout denies first and preserves failed/retryable revocation across restarts", async () => {
  const { runtime, sql, store } = await fixture();
  try {
    await store.createSession(session());
    expect(await store.revokeSession(SESSION, NOW + 1)).toBe(true);
    expect(await store.revokeSession(SESSION, NOW + 2)).toBe(false);
    expect((await store.readSession(SESSION))?.status).toBe("revocation_pending");
    expect(await store.claimSession(SESSION, 1, NOW + 2)).toBeNull();
    expect(await store.touchSession(SESSION, 1, NOW + 2)).toBe(false);
    const pending = (await createSharedAuthSessionStore(sql).listPendingRevocations(NOW + 2, 1))[0];
    expect(pending).toMatchObject({
      sessionDigest: SESSION,
      payload: "sealed:original-offline-grant",
      status: "pending",
      version: 0,
      attempts: 0,
    });
    if (!pending) throw new Error("expected durable revocation");
    const claims = await Promise.all([
      store.claimRevocation(pending.id, 0, NOW + 2),
      store.claimRevocation(pending.id, 0, NOW + 2),
    ]);
    const claimed = claims.find((result) => result !== null);
    expect(claims.filter(Boolean)).toHaveLength(1);
    if (!claimed) throw new Error("expected revocation claim");
    expect(await store.retryRevocation(pending.id, claimed.version, NOW + 1000)).toBe(true);
    expect(await store.listPendingRevocations(NOW + 999, 1)).toEqual([]);
    const next = (await createSharedAuthSessionStore(sql).listPendingRevocations(NOW + 1000, 1))[0];
    if (!next) throw new Error("expected retry after failed issuer call");
    expect(await store.completeRevocation(pending.id, claimed.version)).toBe(false);
    const retry = await store.claimRevocation(next.id, next.version, NOW + 1000);
    if (!retry) throw new Error("expected retry claim");
    expect(retry.attempts).toBe(2);
    expect(await store.completeRevocation(retry.id, retry.version)).toBe(true);
    expect(await store.listPendingRevocations(NOW + 1001, 1)).toEqual([]);
    expect((await store.readSession(SESSION))?.status).toBe("revoked");
    expect(await store.touchSession(SESSION, 2, NOW + 1001)).toBe(false);
    expect(await store.cleanupRevokedSessions(NOW + 86_400_000, 1)).toBe(1);
  } finally {
    await runtime.dispose();
  }
}, 30_000);

test("native D1 logout/refresh race durably revokes BOTH original and rotated grants", async () => {
  const { runtime, store } = await fixture();
  try {
    await store.createSession(session());
    const checking = await store.claimSession(SESSION, 0, NOW + 1);
    if (!checking) throw new Error("expected refresh claim");
    await store.revokeSession(SESSION, NOW + 2);
    expect(
      await store.completeSession(SESSION, checking.version, {
        payload: "sealed:rotated-grant-after-logout",
        grantCheckedAt: NOW + 3,
        lastUsedAt: NOW + 3,
      }),
    ).toBe(false);
    const queued = await store.listPendingRevocations(NOW + 3, 128);
    expect(queued.map((row) => row.payload).sort()).toEqual([
      "sealed:original-offline-grant",
      "sealed:rotated-grant-after-logout",
    ]);
    for (const [index, row] of queued.entries()) {
      const claim = await store.claimRevocation(row.id, row.version, NOW + 4);
      if (!claim) throw new Error("expected queued claim");
      expect(await store.completeRevocation(claim.id, claim.version)).toBe(true);
      expect((await store.readSession(SESSION))?.status).toBe(
        index === 0 ? "revocation_pending" : "revoked",
      );
    }
    expect(await store.claimSession(SESSION, 3, NOW + 5)).toBeNull();
  } finally {
    await runtime.dispose();
  }
}, 30_000);

test("native D1 rejected refresh settlement and callback errors retain grants without a session FK", async () => {
  const { runtime, sql, store } = await fixture();
  try {
    await store.queueRevocation({
      id: "callback-failure",
      sessionDigest: SESSION,
      payload: "sealed:callback-grant",
      createdAt: NOW,
    });
    await store.queueRevocation({
      id: "callback-failure",
      sessionDigest: SESSION,
      payload: "sealed:callback-grant",
      createdAt: NOW,
    });
    await expect(
      store.queueRevocation({
        id: "callback-failure",
        sessionDigest: SESSION,
        payload: "sealed:different-grant",
        createdAt: NOW,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(
      await store.completeSession(SESSION, 99, {
        payload: "sealed:unknown-session-rotated-grant",
        grantCheckedAt: NOW,
        lastUsedAt: NOW,
      }),
    ).toBe(false);
    expect(await store.readSession(SESSION)).toBeNull();
    expect(await store.listPendingRevocations(NOW, 128)).toHaveLength(2);
    for (const row of await store.listPendingRevocations(NOW, 128)) {
      const claim = await store.claimRevocation(row.id, row.version, NOW);
      if (!claim) throw new Error("expected orphan grant claim");
      await store.completeRevocation(claim.id, claim.version);
    }
    expect(await sql.query("SELECT * FROM shared_auth_revocations")).toEqual([]);
  } finally {
    await runtime.dispose();
  }
}, 30_000);

test("native D1 revocation lease recovery is allowed while abandoned REFRESH claims stay denied", async () => {
  const { runtime, store } = await fixture();
  try {
    await store.createSession(session());
    await store.claimSession(SESSION, 0, NOW);
    expect(await store.claimSession(SESSION, 1, NOW + 90_000)).toBeNull();
    await store.revokeSession(SESSION, NOW + 1);
    const pending = (await store.listPendingRevocations(NOW + 1, 1))[0];
    if (!pending) throw new Error("expected logout outbox");
    const oldClaim = await store.claimRevocation(pending.id, pending.version, NOW + 2);
    if (!oldClaim) throw new Error("expected initial revocation claim");
    expect(await store.listPendingRevocations(NOW + 30_001, 1)).toEqual([]);
    const recoverable = (await store.listPendingRevocations(NOW + 30_002, 1))[0];
    if (!recoverable) throw new Error("expected crashed revocation lease recovery");
    const nextClaim = await store.claimRevocation(
      recoverable.id,
      recoverable.version,
      NOW + 30_002,
    );
    if (!nextClaim) throw new Error("expected recovered claim");
    expect(await store.completeRevocation(oldClaim.id, oldClaim.version)).toBe(false);
    expect(await store.retryRevocation(oldClaim.id, oldClaim.version, NOW + 31_000)).toBe(false);
    expect(await store.completeRevocation(nextClaim.id, nextClaim.version)).toBe(true);
  } finally {
    await runtime.dispose();
  }
}, 30_000);

test("native D1 lost refresh-claim acknowledgement cannot replay the old grant", async () => {
  const { runtime, sql, store } = await fixture();
  try {
    await store.createSession(session());
    let loseAcknowledgement = true;
    const uncertainSql: Sql = {
      query: (statement, params) => sql.query(statement, params),
      batch: (statements) => sql.batch(statements),
      async run(statement, params) {
        const result = await sql.run(statement, params);
        if (loseAcknowledgement && statement.includes("status = 'checking'")) {
          loseAcknowledgement = false;
          throw new Error("test-only lost write acknowledgement");
        }
        return result;
      },
    };
    await expect(
      createSharedAuthSessionStore(uncertainSql).claimSession(SESSION, 0, NOW + 1),
    ).rejects.toThrow("test-only lost write acknowledgement");
    const recovered = createSharedAuthSessionStore(sql);
    expect((await recovered.readSession(SESSION))?.status).toBe("checking");
    expect(await recovered.claimSession(SESSION, 1, NOW + 60_000)).toBeNull();
    expect(await recovered.touchSession(SESSION, 1, NOW + 60_000)).toBe(false);
    expect(await recovered.revokeSession(SESSION, NOW + 60_000)).toBe(true);
    const pending = (await recovered.listPendingRevocations(NOW + 60_000, 1))[0];
    if (!pending) throw new Error("expected revocation after uncertain refresh claim");
    const claim = await recovered.claimRevocation(pending.id, pending.version, NOW + 60_000);
    if (!claim) throw new Error("expected revocation claim");
    await recovered.completeRevocation(claim.id, claim.version);
    expect((await recovered.readSession(SESSION))?.status).toBe("revoked");
    expect(
      await recovered.completeSession(SESSION, 1, {
        payload: "sealed:late-rotation-after-revocation",
        grantCheckedAt: NOW + 60_001,
        lastUsedAt: NOW + 60_001,
      }),
    ).toBe(false);
    expect((await recovered.readSession(SESSION))?.status).toBe("revoked");
    expect(await recovered.listPendingRevocations(NOW + 60_001, 1)).toHaveLength(1);
    expect(await recovered.cleanupRevokedSessions(NOW + 100_000_000, 1)).toBe(0);
  } finally {
    await runtime.dispose();
  }
}, 30_000);

test("native D1 rolls back the outbox copy when the local logout fence write fails", async () => {
  const { runtime, sql, store } = await fixture();
  try {
    await store.createSession(session());
    await sql.run(
      `CREATE TRIGGER test_only_reject_logout BEFORE UPDATE ON shared_auth_sessions
       WHEN NEW.status = 'revocation_pending'
       BEGIN SELECT RAISE(ABORT, 'test-only failed local fence'); END`,
    );
    await expect(store.revokeSession(SESSION, NOW + 1)).rejects.toMatchObject({
      code: "constraint",
    });
    expect(await store.readSession(SESSION)).toEqual(session());
    expect(await sql.query("SELECT * FROM shared_auth_revocations")).toEqual([]);
    await sql.run("DROP TRIGGER test_only_reject_logout");
    expect(await store.revokeSession(SESSION, NOW + 1)).toBe(true);
    expect((await store.readSession(SESSION))?.status).toBe("revocation_pending");
    expect(await store.listPendingRevocations(NOW + 1, 1)).toHaveLength(1);
  } finally {
    await runtime.dispose();
  }
}, 30_000);

test("native D1 uncertain complete/create ACK recovery atomically queues and fences active sessions", async () => {
  const { runtime, sql, store } = await fixture();
  try {
    await store.createSession(session());
    await store.claimSession(SESSION, 0, NOW + 1);
    const uncertainSql: Sql = {
      query: (statement, params) => sql.query(statement, params),
      run: (statement, params) => sql.run(statement, params),
      async batch(statements) {
        const result = await sql.batch(statements);
        if (statements.some(({ sql }) => sql.includes("SET payload = ?")))
          throw new Error("test-only lost completion acknowledgement");
        return result;
      },
    };
    const update = {
      payload: "sealed:rotated-grant-with-lost-complete-ack",
      grantCheckedAt: NOW + 2,
      lastUsedAt: NOW + 2,
    };
    await expect(
      createSharedAuthSessionStore(uncertainSql).completeSession(SESSION, 1, update),
    ).rejects.toThrow("test-only lost completion acknowledgement");
    expect((await store.readSession(SESSION))?.status).toBe("active");
    await createSharedAuthSessionStore(sql).queueRevocation({
      id: `uncertain:${SESSION}:1`,
      sessionDigest: SESSION,
      payload: update.payload,
      createdAt: NOW + 3,
    });
    expect((await store.readSession(SESSION))?.status).toBe("revocation_pending");
    expect(await store.touchSession(SESSION, 3, NOW + 4)).toBe(false);
    expect((await store.listPendingRevocations(NOW + 3, 128)).map((row) => row.payload)).toEqual([
      update.payload,
    ]);

    const createdDigest = `sha256:${"d".repeat(64)}`;
    const uncertainCreateSql: Sql = {
      query: (statement, params) => sql.query(statement, params),
      batch: (statements) => sql.batch(statements),
      async run(statement, params) {
        const result = await sql.run(statement, params);
        if (statement.includes("INSERT INTO shared_auth_sessions"))
          throw new Error("test-only lost create acknowledgement");
        return result;
      },
    };
    await expect(
      createSharedAuthSessionStore(uncertainCreateSql).createSession(session(createdDigest)),
    ).rejects.toThrow("test-only lost create acknowledgement");
    await store.queueRevocation({
      id: "uncertain-callback-create",
      sessionDigest: createdDigest,
      payload: session(createdDigest).payload,
      createdAt: NOW + 4,
    });
    expect((await store.readSession(createdDigest))?.status).toBe("revocation_pending");
    expect(await store.claimSession(createdDigest, 1, NOW + 5)).toBeNull();

    const checkingDigest = `sha256:${"e".repeat(64)}`;
    await store.createSession(session(checkingDigest));
    await store.claimSession(checkingDigest, 0, NOW + 1);
    await store.queueRevocation({
      id: "uncertain-before-completion",
      sessionDigest: checkingDigest,
      payload: "sealed:fresh-grant-not-yet-stored",
      createdAt: NOW + 5,
    });
    expect((await store.readSession(checkingDigest))?.status).toBe("revocation_pending");
    expect(
      (await store.listPendingRevocations(NOW + 5, 128))
        .filter((row) => row.sessionDigest === checkingDigest)
        .map((row) => row.payload)
        .sort(),
    ).toEqual(["sealed:fresh-grant-not-yet-stored", "sealed:original-offline-grant"]);
  } finally {
    await runtime.dispose();
  }
}, 30_000);

test("native D1 conflicting revocation id never fences the wrong local session", async () => {
  const { runtime, store } = await fixture();
  try {
    await store.queueRevocation({
      id: "claimed-revocation-id",
      sessionDigest: SESSION,
      payload: "sealed:orphan-grant",
      createdAt: NOW,
    });
    const unrelatedDigest = `sha256:${"f".repeat(64)}`;
    const original = session(unrelatedDigest);
    await store.createSession(original);
    await expect(
      store.queueRevocation({
        id: "claimed-revocation-id",
        sessionDigest: unrelatedDigest,
        payload: "sealed:different-grant",
        createdAt: NOW + 1,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(await store.readSession(unrelatedDigest)).toEqual(original);
    expect(await store.listPendingRevocations(NOW + 1, 128)).toHaveLength(1);
    expect(await store.touchSession(unrelatedDigest, 0, NOW + 1)).toBe(true);
  } finally {
    await runtime.dispose();
  }
}, 30_000);

test("native D1 uncertain-grant enqueue and local authentication fence roll back together", async () => {
  const { runtime, sql, store } = await fixture();
  try {
    const original = session();
    await store.createSession(original);
    await sql.run(
      `CREATE TRIGGER test_only_reject_queue_fence BEFORE UPDATE ON shared_auth_sessions
       WHEN NEW.status = 'revocation_pending'
       BEGIN SELECT RAISE(ABORT, 'test-only failed queue fence'); END`,
    );
    const input = {
      id: "uncertain-queue-fence-failure",
      sessionDigest: SESSION,
      payload: "sealed:uncertain-fresh-grant",
      createdAt: NOW + 1,
    };
    await expect(store.queueRevocation(input)).rejects.toMatchObject({ code: "constraint" });
    expect(await store.readSession(SESSION)).toEqual(original);
    expect(await sql.query("SELECT * FROM shared_auth_revocations")).toEqual([]);
    await sql.run("DROP TRIGGER test_only_reject_queue_fence");
    await store.queueRevocation(input);
    expect((await store.readSession(SESSION))?.status).toBe("revocation_pending");
    expect(await store.listPendingRevocations(NOW + 1, 128)).toHaveLength(2);
  } finally {
    await runtime.dispose();
  }
}, 30_000);

test("native D1 sweeps expire at most 128 indexed attempts, preserving active and pending rows", async () => {
  const { runtime, sql, store } = await fixture();
  try {
    for (let index = 0; index < 130; index++) {
      await store.putAttempt({
        digest: `sha256:${index.toString(16).padStart(64, "0")}`,
        payload: "sealed:expired-attempt",
        createdAt: NOW,
        expiresAt: NOW + 1,
      });
    }
    await store.putAttempt({
      digest: ATTEMPT,
      payload: "sealed:active-attempt",
      createdAt: NOW,
      expiresAt: NOW + 1000,
    });
    await store.createSession(session());
    const pendingDigest = `sha256:${"c".repeat(64)}`;
    await store.createSession(session(pendingDigest));
    await store.revokeSession(pendingDigest, NOW + 2);
    expect(await store.cleanupExpiredAttempts(NOW + 2, 128)).toBe(128);
    expect(await sql.query("SELECT digest FROM shared_auth_attempts")).toHaveLength(3);
    expect(await store.cleanupExpiredAttempts(NOW + 2, 128)).toBe(2);
    expect(await store.consumeAttempt(ATTEMPT, NOW + 3)).toMatchObject({
      payload: "sealed:active-attempt",
    });
    const plan = await sql.query(
      "EXPLAIN QUERY PLAN SELECT digest FROM shared_auth_attempts WHERE expires_at <= ? ORDER BY expires_at, digest LIMIT ?",
      [NOW + 2, 128],
    );
    expect(plan.some((row) => String(row.detail).includes("shared_auth_attempts_expiry"))).toBe(
      true,
    );
    expect(await store.cleanupRevokedSessions(NOW + 100_000_000, 128)).toBe(0);
    expect((await store.readSession(SESSION))?.status).toBe("active");
    expect((await store.readSession(pendingDigest))?.status).toBe("revocation_pending");
    const trace = boundedSql(sql);
    const boundedStore = createSharedAuthSessionStore(trace.sql);
    await boundedStore.cleanupExpiredAttempts(NOW + 2, 128);
    await boundedStore.listPendingRevocations(NOW + 3, 128);
    await expect(boundedStore.cleanupExpiredAttempts(NOW, 129)).rejects.toBeInstanceOf(TypeError);
    await expect(boundedStore.listPendingRevocations(NOW, 0)).rejects.toBeInstanceOf(TypeError);
    expect(trace.maxParameters()).toBeLessThan(100);
  } finally {
    await runtime.dispose();
  }
}, 30_000);

function boundedSql(sql: Sql) {
  let maximum = 0;
  return {
    maxParameters: () => maximum,
    sql: {
      query: (statement, params) => {
        maximum = Math.max(maximum, params?.length ?? 0);
        return sql.query(statement, params);
      },
      run: (statement, params) => {
        maximum = Math.max(maximum, params?.length ?? 0);
        return sql.run(statement, params);
      },
      batch: (statements) => {
        for (const statement of statements)
          maximum = Math.max(maximum, statement.params?.length ?? 0);
        return sql.batch(statements);
      },
    } satisfies Sql,
  };
}
