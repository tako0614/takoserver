import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
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
  type RetainedSharedRpIssuanceData,
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
  const result = await createSharedRpPrincipalIssuanceStore({
    sql: f.sql,
    workspaceBillingAuthority: null,
  }).issueFreshOnce(data);
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
    await createSharedRpPrincipalIssuanceStore({
      sql: instrumented,
      workspaceBillingAuthority: null,
    }).issueFreshOnce(input());
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
    workspaceBillingAuthority: null,
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
      workspaceBillingAuthority: null,
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
    workspaceBillingAuthority: null,
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
    createSharedRpPrincipalIssuanceStore({
      sql: f.sql,
      workspaceBillingAuthority: null,
    }).issueFreshOnce(data),
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
      createSharedRpPrincipalIssuanceStore({
        sql: f.sql,
        workspaceBillingAuthority: null,
      }).issueFreshOnce(crossed),
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

test("the Org INSERT returns its exact inserted row and the later Org writes return none", async () => {
  const f = fixture();
  f.db.exec(workspaceBindingsDdl);
  const data = await organizationInput();
  const acks: (readonly SqlWrite[])[] = [];
  await createSharedRpPrincipalIssuanceStore({
    workspaceBillingAuthority: AUTHORITY,
    sql: {
      ...f.sql,
      async batch(statements) {
        const writes = await f.sql.batch(statements);
        acks.push(writes);
        return writes;
      },
    },
  }).issueFreshOnce(data);
  expect(acks[0]?.slice(5)).toEqual([
    {
      changes: 1,
      rows: [
        {
          id: data.organizationId,
          name: "Personal workspace",
          owner_principal_id: "prn_fixture",
          created_at: new Date(data.session.createdAt).toISOString(),
        },
      ],
    },
    { changes: 1, rows: [] },
    { changes: 1, rows: [] },
    { changes: 0, rows: [] },
  ]);
});

test("Organization ACKs that do not match the exact row effect are unavailable after the write", async () => {
  // Index 5 is the Org INSERT, 6 the owner membership, 7 the Workspace
  // binding and 8 the final consistency guard.
  const damaged: ((writes: readonly SqlWrite[]) => unknown)[] = [
    // An Org insert claimed by changes but not by its returned row.
    (w) => w.map((x, i) => (i === 5 ? { changes: 1, rows: [] } : x)),
    // A returned Org row without any change.
    (w) => w.map((x, i) => (i === 5 ? { ...x, changes: 0 } : x)),
    // A returned row naming another owner, name, time or Org.
    ...(["owner_principal_id", "name", "created_at", "id"] as const).map(
      (key) => (w: readonly SqlWrite[]) =>
        w.map((x, i) =>
          i === 5 ? { ...x, rows: x.rows.map((r) => ({ ...r, [key]: "crossed" })) } : x,
        ),
    ),
    // An extra or missing returned column.
    (w) => w.map((x, i) => (i === 5 ? { ...x, rows: x.rows.map((r) => ({ ...r, extra: 1 })) } : x)),
    // Two returned Org rows.
    (w) => w.map((x, i) => (i === 5 ? { ...x, changes: 2, rows: [x.rows[0], x.rows[0]] } : x)),
    // Membership or Workspace binding changing more than its one row.
    (w) => w.map((x, i) => (i === 6 ? { ...x, changes: 2 } : x)),
    (w) => w.map((x, i) => (i === 7 ? { ...x, changes: 2 } : x)),
    // Membership returning a row.
    (w) => w.map((x, i) => (i === 6 ? { ...x, rows: [{}] } : x)),
    // The final guard changing or returning anything.
    (w) => w.map((x, i) => (i === 8 ? { ...x, changes: 1 } : x)),
    (w) => w.map((x, i) => (i === 8 ? { ...x, rows: [{}] } : x)),
    // A missing Organization ACK.
    (w) => w.slice(0, 8),
  ];
  for (const damage of damaged) {
    const f = fixture();
    f.db.exec(workspaceBindingsDdl);
    const store = createSharedRpPrincipalIssuanceStore({
      workspaceBillingAuthority: AUTHORITY,
      sql: {
        ...f.sql,
        async batch(statements) {
          return damage(await f.sql.batch(statements)) as readonly SqlWrite[];
        },
      },
    });
    let failure: unknown;
    try {
      await store.issueFreshOnce(await organizationInput());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AuthAuthorityStoreError);
    expect((failure as AuthAuthorityStoreError).code).toBe("unavailable");
    expect(f.calls).toHaveLength(1);
  }
});

test("an Org changed by trigger rows beyond its own is acknowledged only with its exact row", async () => {
  // D1 counts trigger rows in changes: an inserted Org may report more than 1.
  const f = fixture();
  f.db.exec(workspaceBindingsDdl);
  await createSharedRpPrincipalIssuanceStore({
    workspaceBillingAuthority: AUTHORITY,
    sql: {
      ...f.sql,
      async batch(statements) {
        const writes = await f.sql.batch(statements);
        return writes.map((x, i) => (i === 5 ? { ...x, changes: 3 } : x));
      },
    },
  }).issueFreshOnce(await organizationInput());
  expect(f.db.query("SELECT count(*) AS n FROM orgs").get()).toEqual({ n: 1 });
});

// The private session_write failure marker: closed step and code only, the
// same error rethrown, and no output on success.
const MARKER = "takoserver.shared_auth.session_write.failure.v1";
async function markerOf(
  run: (f: ReturnType<typeof fixture>) => Promise<unknown>,
  organization = false,
): Promise<{ failure: unknown; lines: unknown[][] }> {
  const f = fixture();
  if (organization) f.db.exec(workspaceBindingsDdl);
  const spy = spyOn(console, "error").mockImplementation(() => {});
  let failure: unknown;
  let lines: unknown[][] = [];
  try {
    await run(f);
  } catch (error) {
    failure = error;
  } finally {
    lines = spy.mock.calls.map((call) => [...call]);
    spy.mockRestore();
  }
  return { failure, lines };
}
function damagedStore(
  f: ReturnType<typeof fixture>,
  damage: (writes: readonly SqlWrite[]) => unknown,
  authority: string | null = null,
) {
  return createSharedRpPrincipalIssuanceStore({
    workspaceBillingAuthority: authority,
    sql: {
      ...f.sql,
      async batch(statements) {
        return damage(await f.sql.batch(statements)) as readonly SqlWrite[];
      },
    },
  });
}

test("session_write marker names the closed step and code of each refusal", async () => {
  const lost = new Error("synthetic lost acknowledgement prn_fixture");
  const cases: {
    readonly step: string;
    readonly code: string;
    readonly organization?: boolean;
    readonly run: (f: ReturnType<typeof fixture>) => Promise<unknown>;
  }[] = [
    {
      step: "issuance_input",
      code: "store_invalid",
      run: (f) =>
        createSharedRpPrincipalIssuanceStore({
          sql: f.sql,
          workspaceBillingAuthority: null,
        }).issueFreshOnce({ ...input(), organizationId: undefined } as never),
    },
    {
      step: "organization_derivation",
      code: "store_invalid",
      organization: true,
      run: (f) =>
        createSharedRpPrincipalIssuanceStore({
          sql: f.sql,
          workspaceBillingAuthority: AUTHORITY,
        }).issueFreshOnce(input()),
    },
    {
      step: "batch",
      code: "other",
      run: (f) =>
        createSharedRpPrincipalIssuanceStore({
          workspaceBillingAuthority: null,
          sql: {
            ...f.sql,
            async batch(statements) {
              await f.sql.batch(statements);
              throw lost;
            },
          },
        }).issueFreshOnce(input()),
    },
    {
      step: "batch",
      code: "sql_constraint",
      run: async (f) => {
        await createSharedRpPrincipalIssuanceStore({
          sql: f.sql,
          workspaceBillingAuthority: null,
        }).issueFreshOnce(input());
        f.calls.length = 0;
        await createSharedRpPrincipalIssuanceStore({
          sql: f.sql,
          workspaceBillingAuthority: null,
        }).issueFreshOnce(input());
      },
    },
    {
      step: "batch_ack",
      code: "store_unavailable",
      run: (f) => damagedStore(f, (w) => w.slice(0, 4)).issueFreshOnce(input()),
    },
    {
      step: "organization_ack",
      code: "store_unavailable",
      organization: true,
      run: async (f) =>
        damagedStore(
          f,
          (w) => w.map((x, i) => (i === 5 ? { ...x, rows: [] } : x)),
          AUTHORITY,
        ).issueFreshOnce(await organizationInput()),
    },
    {
      step: "fixed_ack",
      code: "store_unavailable",
      run: (f) =>
        damagedStore(f, (w) =>
          w.map((x, i) => (i === 4 ? { ...x, changes: 0 } : x)),
        ).issueFreshOnce(input()),
    },
    {
      step: "row_postimage",
      code: "store_unavailable",
      run: (f) =>
        damagedStore(f, (w) =>
          w.map((x, i) =>
            i === 3 ? { ...x, rows: x.rows.map((r) => ({ ...r, payload: "crossed" })) } : x,
          ),
        ).issueFreshOnce(input()),
    },
    {
      step: "principal_postimage",
      code: "store_unavailable",
      run: (f) =>
        damagedStore(f, (w) =>
          w.map((x, i) =>
            i === 0 ? { ...x, rows: x.rows.map((r) => ({ ...r, created_at: "crossed" })) } : x,
          ),
        ).issueFreshOnce(input()),
    },
    {
      step: "issuance_attempted",
      code: "store_unavailable",
      run: async (f) => {
        const store = damagedStore(f, (w) => w.slice(0, 4));
        await store.issueFreshOnce(input()).catch(() => {});
        await store.issueFreshOnce(input());
      },
    },
  ];
  for (const selected of cases) {
    const { failure, lines } = await markerOf(selected.run, selected.organization);
    expect(failure).toBeInstanceOf(Error);
    // One marker per refused write (the attempted case refuses twice).
    expect(lines).toHaveLength(selected.step === "issuance_attempted" ? 2 : 1);
    const last = lines.at(-1);
    expect(last).toHaveLength(1);
    const parsed = JSON.parse(String(last?.[0]));
    expect(parsed).toEqual({ marker: MARKER, step: selected.step, code: selected.code });
    // Nothing from the input, the error message or the SQL leaks into it.
    expect(String(last?.[0])).not.toMatch(/prn_|binding_|authority_|sha256|INSERT|account_/u);
    if (selected.code === "other") expect(failure).toBe(lost);
  }
});

test("session_write marker is silent on success and a failing logger keeps the same error", async () => {
  const quiet = await markerOf((f) =>
    createSharedRpPrincipalIssuanceStore({
      sql: f.sql,
      workspaceBillingAuthority: null,
    }).issueFreshOnce(input()),
  );
  expect(quiet.failure).toBeUndefined();
  expect(quiet.lines).toEqual([]);

  const f = fixture();
  const lost = new Error("synthetic lost acknowledgement");
  const spy = spyOn(console, "error").mockImplementation(() => {
    throw new Error("logger down");
  });
  try {
    await expect(
      createSharedRpPrincipalIssuanceStore({
        workspaceBillingAuthority: null,
        sql: {
          ...f.sql,
          async batch() {
            throw lost;
          },
        },
      }).issueFreshOnce(input()),
    ).rejects.toBe(lost);
  } finally {
    spy.mockRestore();
  }
});

// Retained issuance: a returning subject's NEW session and class on its
// existing principal and binding. Storage mechanics only.
function retainedInput(): RetainedSharedRpIssuanceData {
  const first = input();
  const now = Date.now();
  return {
    principal: {
      principalId: first.principal.principalId,
      principalIncarnation: first.principal.principalIncarnation,
      bindingRef: first.principal.binding.ref,
      targetRef: first.principal.binding.targetRef,
      issuer: first.principal.binding.issuer,
      subject: first.principal.binding.subject,
    },
    credential: {
      ...first.credential,
      ref: "authority_fixture_2",
      incarnation: "credential_inc_fixture_2",
      issuanceRef: "synthetic-issuance-2",
    },
    rp: { ...first.rp, sessionDigest: digest("f"), sessionCreatedAt: now },
    organizationId: first.organizationId,
    session: {
      ...first.session,
      digest: digest("f"),
      createdAt: now,
      lastUsedAt: now,
      grantCheckedAt: now,
    },
  };
}
async function bound() {
  const f = fixture();
  await createSharedRpPrincipalIssuanceStore({
    sql: f.sql,
    workspaceBillingAuthority: null,
  }).issueFreshOnce(input());
  f.calls.length = 0;
  return f;
}

test("retained issuance writes only the RP pair on the existing binding", async () => {
  const f = await bound();
  const before = f.counts();
  const data = retainedInput();
  const result = await createSharedRpPrincipalIssuanceStore({
    sql: f.sql,
    workspaceBillingAuthority: null,
  }).issueRetainedOnce(data);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toHaveLength(2);
  expect(f.calls[0]?.[0]?.sql.startsWith("INSERT INTO shared_auth_sessions")).toBe(true);
  expect(f.calls[0]?.[1]?.sql).toContain("INSERT INTO credential_authority_classes");
  expect(result.principal).toEqual(data.principal);
  expect(f.counts()).toEqual([before[0], before[1], before[2], { n: 2 }, { n: 2 }]);
});

test("crossed retained DATA is refused before any batch", async () => {
  const crossed: ((data: RetainedSharedRpIssuanceData) => unknown)[] = [
    (d) => ({ ...d, principal: { ...d.principal, bindingRef: "binding_other" } }),
    (d) => ({ ...d, principal: { ...d.principal, targetRef: "target_other" } }),
    (d) => ({ ...d, principal: { ...d.principal, principalIncarnation: "inc_other" } }),
    (d) => ({ ...d, principal: { ...d.principal, issuer: "https://other.invalid" } }),
    (d) => ({ ...d, principal: { ...d.principal, subject: "account_other" } }),
    (d) => ({ ...d, principal: { ...d.principal, extra: 1 } }),
    (d) => ({ ...d, session: { ...d.session, principalId: "prn_other" } }),
    (d) => ({ ...d, rp: { ...d.rp, accountId: "account_other" } }),
  ];
  for (const cross of crossed) {
    const f = await bound();
    const failure = await createSharedRpPrincipalIssuanceStore({
      sql: f.sql,
      workspaceBillingAuthority: null,
    })
      .issueRetainedOnce(cross(retainedInput()) as RetainedSharedRpIssuanceData)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AuthAuthorityStoreError);
    expect((failure as AuthAuthorityStoreError).code).toBe("invalid");
    expect(f.calls).toHaveLength(0);
  }
});

test("retained issuance refuses damaged pair ACKs after one write and never resends", async () => {
  const damaged: [string, (writes: readonly SqlWrite[]) => unknown][] = [
    ["batch_ack", (w) => w.slice(0, 1)],
    ["pair_ack", (w) => w.map((x, i) => (i === 0 ? { ...x, changes: 0 } : x))],
    ["pair_ack", (w) => w.map((x, i) => (i === 1 ? { ...x, rows: [] } : x))],
    [
      "row_postimage",
      (w) =>
        w.map((x, i) =>
          i === 1 ? { ...x, rows: x.rows.map((r) => ({ ...r, principal_binding_ref: "x" })) } : x,
        ),
    ],
  ];
  for (const [step, damage] of damaged) {
    const f = await bound();
    const store = damagedStore(f, damage);
    const { failure, lines } = await markerOf(() => store.issueRetainedOnce(retainedInput()));
    expect(failure).toBeInstanceOf(AuthAuthorityStoreError);
    expect((failure as AuthAuthorityStoreError).code).toBe("unavailable");
    expect(lines.map((line) => JSON.parse(String(line[0])))).toEqual([
      { marker: MARKER, step, code: "store_unavailable" },
    ]);
    await expect(store.issueRetainedOnce(retainedInput())).rejects.toThrow("unavailable");
    expect(f.calls).toHaveLength(1);
  }
});

test("with a realm the retained batch carries only the Org owner guard, acknowledged as a no-op", async () => {
  const setup = async () => {
    const f = fixture();
    f.db.exec(workspaceBindingsDdl);
    await createSharedRpPrincipalIssuanceStore({
      sql: f.sql,
      workspaceBillingAuthority: AUTHORITY,
    }).issueFreshOnce(await organizationInput());
    f.calls.length = 0;
    const data = retainedInput();
    return {
      f,
      data: {
        ...data,
        organizationId: await workspaceBillingOrganizationRef(AUTHORITY, data.rp.workspaceRef),
      },
    };
  };
  const ok = await setup();
  await createSharedRpPrincipalIssuanceStore({
    sql: ok.f.sql,
    workspaceBillingAuthority: AUTHORITY,
  }).issueRetainedOnce(ok.data);
  expect(ok.f.calls[0]).toHaveLength(3);
  expect(ok.f.calls[0]?.[2]?.sql).toContain("SELECT ?, '', ? WHERE NOT EXISTS");
  expect(ok.f.calls[0]?.some((statement) => statement.sql.includes("INSERT INTO orgs"))).toBe(
    false,
  );

  for (const damage of [
    (w: readonly SqlWrite[]) => w.map((x, i) => (i === 2 ? { ...x, changes: 1 } : x)),
    (w: readonly SqlWrite[]) => w.map((x, i) => (i === 2 ? { ...x, rows: [{}] } : x)),
    (w: readonly SqlWrite[]) => w.slice(0, 2),
  ]) {
    const { f, data } = await setup();
    const { failure, lines } = await markerOf(() =>
      damagedStore(f, damage, AUTHORITY).issueRetainedOnce(data),
    );
    expect((failure as AuthAuthorityStoreError).code).toBe("unavailable");
    expect(JSON.parse(String(lines.at(-1)?.[0])).step).toMatch(/^(organization_ack|batch_ack)$/u);
  }
});
