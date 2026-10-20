import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { additiveAuthDDL } from "../src/auth-authority-schema-plan.ts";
import { createCredentialAuthorityClassStore } from "../src/credential-authority-class.ts";
import { type Sql, SqlError, type SqlStatement, type SqlWrite } from "../src/ports.ts";
import { AuthAuthorityStoreError } from "../src/shared-principal-authority.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import type { WorkerRequestSql } from "../src/worker-request-composition.ts";
import {
  createSharedRpPrincipalIssuanceStore,
  createWorkerRequestSharedRpIssuanceContribution,
  type FreshSharedRpIssuanceData,
} from "../src/worker-request-shared-principal-issuance.ts";
import { workspaceBillingOrganizationRef } from "../src/workspace-billing-organization.ts";

// Synthetic storage-only cases. No verified RP/human/native/target/Clock grant.
const opened = new Set<Database>();
afterEach(() => {
  for (const db of opened) db.close();
  opened.clear();
});
const digest = (c: string) => `sha256:${c.repeat(64)}` as const;
function input(): FreshSharedRpIssuanceData {
  const now = Date.now();
  const at = new Date(now).toISOString();
  return {
    principal: {
      principalId: "prn_fixture",
      principalIncarnation: "principal_inc_fixture",
      createdAt: at,
      origin: { ref: "synthetic-origin", digest: digest("a") },
      binding: {
        ref: "binding_fixture",
        issuer: "https://issuer.invalid",
        subject: "account_fixture",
        controllerIncarnation: "synthetic-controller",
        targetRef: "synthetic-target",
        evidence: { ref: "synthetic-evidence", digest: digest("b") },
        enrolledAt: at,
      },
    },
    credential: {
      ref: "authority_fixture",
      incarnation: "credential_inc_fixture",
      targetRef: "synthetic-target",
      principalId: "prn_fixture",
      principalIncarnation: "principal_inc_fixture",
      issuanceRef: "synthetic-issuance",
      issuanceDigest: digest("c"),
      issuedAt: at,
    },
    rp: {
      principalBindingRef: "binding_fixture",
      registrationRef: "synthetic-registration",
      registrationDigest: digest("d"),
      sessionDigest: digest("e"),
      sessionCreatedAt: now,
      enrolledSessionVersion: 0,
      issuer: "https://issuer.invalid",
      clientId: "fixture-client",
      subject: "account_fixture",
      issuerSessionId: "fixture-sid",
      authTime: Math.floor(now / 1000),
      accountId: "account_fixture",
      workspaceId: "workspace_fixture",
      workspaceRef: "workspace-ref",
    },
    organizationId: "org_fixture",
    session: {
      digest: digest("e"),
      accountId: "account_fixture",
      principalId: "prn_fixture",
      workspaceId: "workspace_fixture",
      payload: "synthetic-encrypted-payload",
      createdAt: now,
      lastUsedAt: now,
      absoluteExpiresAt: now + 60000,
      grantCheckedAt: now,
      version: 0,
      status: "active",
    },
  };
}
function fixture() {
  const db = new Database(":memory:");
  opened.add(db);
  db.exec(
    readFileSync(
      new URL("./fixtures/auth-authority-candidate-schema.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(additiveAuthDDL);
  const original = createSqliteSql(db);
  const calls: (readonly SqlStatement[])[] = [];
  const sql: Sql = {
    query: (...args) => original.query(...args),
    run: (...args) => original.run(...args),
    async batch(statements) {
      calls.push(statements);
      return await original.batch(statements);
    },
  };
  const counts = () =>
    [
      "principals",
      "auth_principal_incarnations",
      "shared_principal_bindings",
      "shared_auth_sessions",
      "credential_authority_classes",
    ].map((name) => db.query(`SELECT count(*) AS n FROM ${name}`).get());
  return { db, original, sql, calls, counts };
}

test("Root fixed3 and original RP pair are one batch, with exact returned postimages", async () => {
  const f = fixture();
  const data = input();
  const result = await createSharedRpPrincipalIssuanceStore({ sql: f.sql }).issueFreshOnce(data);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toHaveLength(5);
  expect(f.calls[0]?.every((statement) => (statement.params?.length ?? 0) <= 100)).toBe(true);
  expect(f.calls[0]?.[3]?.sql.startsWith("INSERT INTO shared_auth_sessions")).toBe(true);
  expect(f.calls[0]?.[4]?.sql).toContain("INSERT INTO credential_authority_classes");
  expect(result.principal.binding.ref).toBe(data.principal.binding.ref);
  expect(result.session).toEqual(data.session);
  expect(
    (
      await createCredentialAuthorityClassStore({ sql: f.original }).readRetained(
        data.credential.ref,
      )
    )?.origin,
  ).toEqual(data.credential);
});
test("deliberate last INSERT SQL rejection rolls back the four preceding real writes", async () => {
  const f = fixture();
  const before = f.counts();
  f.db.exec(
    "CREATE TRIGGER fixture_late_class_fault BEFORE INSERT ON credential_authority_classes BEGIN SELECT RAISE(ABORT,'fixture_late_class_fault'); END",
  );
  let priorFourPassed = false;
  let originalSqlFault: unknown;
  const instrumented: Sql = {
    ...f.sql,
    async batch(statements) {
      f.calls.push(statements);
      f.db.exec("BEGIN IMMEDIATE");
      try {
        const writes: SqlWrite[] = [];
        for (const statement of statements.slice(0, 4)) {
          writes.push(await f.original.run(statement.sql, statement.params));
        }
        expect(writes).toHaveLength(4);
        expect(writes.every((w) => w.changes === 1 && w.rows.length === 1)).toBe(true);
        expect(f.counts()).toEqual([{ n: 1 }, { n: 1 }, { n: 1 }, { n: 1 }, { n: 0 }]);
        priorFourPassed = true;
        const last = statements[4];
        if (!last) throw new Error("fixture missing last statement");
        try {
          await f.original.run(last.sql, last.params);
        } catch (error) {
          originalSqlFault = error;
          throw error;
        }
        throw new Error("fixture expected actual class SQL rejection");
      } finally {
        f.db.exec("ROLLBACK");
      }
    },
  };
  let failure: unknown;
  try {
    await createSharedRpPrincipalIssuanceStore({ sql: instrumented }).issueFreshOnce(input());
  } catch (error) {
    failure = error;
  }
  expect(priorFourPassed).toBe(true);
  expect(originalSqlFault).toBeInstanceOf(SqlError);
  expect((originalSqlFault as SqlError).code).toBe("constraint");
  expect((originalSqlFault as SqlError).message).toContain("fixture_late_class_fault");
  expect(failure).toBe(originalSqlFault);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toHaveLength(5);
  expect(f.counts()).toEqual(before);
});
test("committed acknowledgement loss is unknown and the same instance never resends", async () => {
  const f = fixture();
  const store = createSharedRpPrincipalIssuanceStore({
    sql: {
      ...f.sql,
      async batch(statements) {
        await f.sql.batch(statements);
        throw new Error("lost ACK");
      },
    },
  });
  await expect(store.issueFreshOnce(input())).rejects.toThrow("lost ACK");
  await expect(store.issueFreshOnce(input())).rejects.toThrow("unavailable");
  expect(f.calls).toHaveLength(1);
  expect(
    (
      await createCredentialAuthorityClassStore({ sql: f.original }).readRetained(
        input().credential.ref,
      )
    )?.class,
  ).toBe("official-shared-rp-session");
});
test("malformed or missing batch ACKs normalize unavailable without a second write", async () => {
  const malformed: ((writes: readonly SqlWrite[]) => unknown)[] = [
    () => null,
    () => ({}),
    () => Array(5).fill(null),
    (writes) => writes.map((w, i) => (i === 4 ? { ...w, rows: [] } : w)),
    (writes) => writes.map((w, i) => (i === 4 ? { ...w, rows: null } : w)),
    (writes) => writes.map((w, i) => (i === 4 ? { ...w, rows: [null] } : w)),
    (writes) => writes.map((w, i) => (i === 4 ? { ...w, changes: 0 } : w)),
  ];
  for (const damage of malformed) {
    const f = fixture();
    const store = createSharedRpPrincipalIssuanceStore({
      sql: {
        ...f.sql,
        async batch(statements) {
          const writes = await f.sql.batch(statements);
          return damage(writes) as readonly SqlWrite[];
        },
      },
    });
    let failure: unknown;
    try {
      await store.issueFreshOnce(input());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AuthAuthorityStoreError);
    expect((failure as AuthAuthorityStoreError).code).toBe("unavailable");
    await expect(store.issueFreshOnce(input())).rejects.toThrow("unavailable");
    expect(f.calls).toHaveLength(1);
  }
});
test("a substituted class scope is rejected even with positive actual ACK", async () => {
  const f = fixture();
  const store = createSharedRpPrincipalIssuanceStore({
    sql: {
      ...f.sql,
      async batch(statements) {
        const writes = await f.sql.batch(statements);
        return writes.map((w, i) =>
          i === 4 ? { ...w, rows: w.rows.map((r) => ({ ...r, target_ref: "crossed" })) } : w,
        );
      },
    },
  });
  await expect(store.issueFreshOnce(input())).rejects.toThrow("unavailable");
  expect(f.calls).toHaveLength(1);
});
test("input accessors are rejected without evaluation or SQL", async () => {
  const f = fixture();
  let getters = 0;
  const data = Object.defineProperty(input(), "principal", {
    get() {
      getters++;
      throw new Error("getter");
    },
  });
  await expect(
    createSharedRpPrincipalIssuanceStore({ sql: f.sql }).issueFreshOnce(data),
  ).rejects.toThrow("invalid");
  expect(getters).toBe(0);
  expect(f.calls).toHaveLength(0);
});
test("crossed principal target or subject is refused before the batch", async () => {
  for (const field of ["targetRef", "subject"] as const) {
    const f = fixture();
    const data = input();
    const crossed = {
      ...data,
      principal: { ...data.principal, binding: { ...data.principal.binding, [field]: "crossed" } },
    };
    await expect(
      createSharedRpPrincipalIssuanceStore({ sql: f.sql }).issueFreshOnce(crossed),
    ).rejects.toThrow("invalid");
    expect(f.calls).toHaveLength(0);
  }
});
test("a Sql-like DTO cannot bind the fixed contribution to an actual request origin", () => {
  const f = fixture();
  expect(() =>
    createWorkerRequestSharedRpIssuanceContribution({
      sql: f.sql,
      moneyGuard: "ready",
    } as WorkerRequestSql),
  ).toThrow();
  expect(f.calls).toHaveLength(0);
});

// The realm's billing authority selects the workspace-billing Organization
// contract: the tuple must name the derivation, and the Organization, its owner
// membership and the Workspace binding join the same fresh issuance batch.
const AUTHORITY = "takoserver.hosted.staging-test.v1";
const workspaceBindingsDdl = (() => {
  const migration = readFileSync(
    new URL("../migrations/0099_hosted_billing_extensions.sql", import.meta.url),
    "utf8",
  );
  const start = migration.indexOf("CREATE TABLE org_wallet_workspace_bindings");
  return migration.slice(start, migration.indexOf(");", start) + 2);
})();
async function organizationInput(): Promise<FreshSharedRpIssuanceData> {
  const data = input();
  return {
    ...data,
    organizationId: await workspaceBillingOrganizationRef(AUTHORITY, data.rp.workspaceRef),
  };
}

test("fresh issuance materializes the derived workspace billing Organization after the companion", async () => {
  const f = fixture();
  f.db.exec(workspaceBindingsDdl);
  const data = await organizationInput();
  await createSharedRpPrincipalIssuanceStore({
    sql: f.sql,
    workspaceBillingAuthority: AUTHORITY,
  }).issueFreshOnce(data);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toHaveLength(9);
  expect(f.calls[0]?.[4]?.sql).toContain("INSERT INTO credential_authority_classes");
  expect(f.calls[0]?.[5]?.sql).toContain("INSERT INTO orgs");
  expect(f.db.query("SELECT id, name, owner_principal_id FROM orgs").all()).toEqual([
    { id: data.organizationId, name: "Personal workspace", owner_principal_id: "prn_fixture" },
  ]);
  expect(f.db.query("SELECT org_id, principal_id, role FROM org_memberships").all()).toEqual([
    { org_id: data.organizationId, principal_id: "prn_fixture", role: "owner" },
  ]);
  expect(
    f.db.query("SELECT workspace_ref, org_id FROM org_wallet_workspace_bindings").all(),
  ).toEqual([{ workspace_ref: "workspace-ref", org_id: data.organizationId }]);
});

test("a tuple naming any other Organization is refused before the batch", async () => {
  const f = fixture();
  f.db.exec(workspaceBindingsDdl);
  await expect(
    createSharedRpPrincipalIssuanceStore({
      sql: f.sql,
      workspaceBillingAuthority: AUTHORITY,
    }).issueFreshOnce(input()),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  expect(f.counts().every((row) => (row as { n: number }).n === 0)).toBe(true);
});

test("an existing Organization owned by another principal aborts the whole issuance", async () => {
  const f = fixture();
  f.db.exec(workspaceBindingsDdl);
  const data = await organizationInput();
  f.db
    .query("INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)")
    .run(data.organizationId, "Personal workspace", "prn_other", new Date().toISOString());
  await expect(
    createSharedRpPrincipalIssuanceStore({
      sql: f.sql,
      workspaceBillingAuthority: AUTHORITY,
    }).issueFreshOnce(data),
  ).rejects.toThrow();
  expect(f.counts().every((row) => (row as { n: number }).n === 0)).toBe(true);
  expect(f.db.query("SELECT count(*) AS n FROM org_memberships").get()).toEqual({ n: 0 });
  expect(f.db.query("SELECT count(*) AS n FROM org_wallet_workspace_bindings").get()).toEqual({
    n: 0,
  });
});
