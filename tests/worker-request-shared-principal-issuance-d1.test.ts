// Fresh RP issuance on a local Miniflare D1 built from the served schema:
// migrations through 0100, the Auth103 canonical source, Financial 0104 and
// Root 0105, under the same strict D1 driver and Sql wrappers the Worker uses.
// D1 reports meta.changes as the statement's total_changes() delta, so rows
// written by triggers count; bun:sqlite reports sqlite3_changes() and cannot
// show this. Synthetic DATA only: no verified RP, human, native or Clock grant.
import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import { createAuth103CanonicalSourceArtifacts } from "../scripts/deploy/auth103-canonical-recipes.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { FINANCIAL_0104_DDL } from "../src/financial-0104-source-contract.ts";
import {
  createFreshNativeSql,
  createMoneyCutoverSql,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../src/money-cutover-sql.ts";
import { type Sql, SqlError, type SqlWrite } from "../src/ports.ts";
import { ROOT_0105_DDL } from "../src/root-0105-org-capture-triggers.ts";
import { createSharedAuthSessionStore } from "../src/shared-auth-session-store.ts";
import {
  AuthAuthorityStoreError,
  createSharedPrincipalAuthorityStore,
} from "../src/shared-principal-authority.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import {
  createSharedRpPrincipalIssuanceStore,
  type FreshSharedRpIssuanceData,
  type RetainedSharedRpIssuanceData,
  resolveSharedRpSubjectBinding,
} from "../src/worker-request-shared-principal-issuance.ts";
import { workspaceBillingOrganizationRef } from "../src/workspace-billing-organization.ts";

const ROOT = resolve(import.meta.dir, "..");
const AUTHORITY = "takoserver.hosted.staging-test.v1";
const WORKSPACE_REF = `wrk_${"0".repeat(32)}`;
const WRITER = `sha256:${"c".repeat(64)}`;
const ISSUER = "https://issuer.invalid";
const SUBJECT = "account_fixture";
const modes = ["money", "fresh-native"] as const;
type Mode = (typeof modes)[number];
const digest = (c: string) => `sha256:${c.repeat(64)}` as const;
const runtimes: Miniflare[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

/** One fresh principal for the fixture subject, as the fresh-callback projection mints it. */
async function input(sessionDigest = digest("e")): Promise<FreshSharedRpIssuanceData> {
  const now = Date.now() - 1000;
  const at = new Date(now).toISOString();
  const id = () => crypto.randomUUID();
  const principalId = `prn_${id()}`;
  const principalIncarnation = `pri_${id()}`;
  const bindingRef = `spb_${id()}`;
  return {
    principal: {
      principalId,
      principalIncarnation,
      createdAt: at,
      origin: { ref: `pro_${id()}`, digest: digest("a") },
      binding: {
        ref: bindingRef,
        issuer: ISSUER,
        subject: SUBJECT,
        controllerIncarnation: `ctl_${id()}`,
        targetRef: "synthetic-target",
        evidence: { ref: `bev_${id()}`, digest: digest("a") },
        enrolledAt: at,
      },
    },
    credential: {
      ref: `cra_${id()}`,
      incarnation: `cri_${id()}`,
      targetRef: "synthetic-target",
      principalId,
      principalIncarnation,
      issuanceRef: `iss_${id()}`,
      issuanceDigest: digest("c"),
      issuedAt: at,
    },
    rp: {
      principalBindingRef: bindingRef,
      registrationRef: "synthetic-registration",
      registrationDigest: digest("d"),
      sessionDigest,
      sessionCreatedAt: now,
      enrolledSessionVersion: 0,
      issuer: ISSUER,
      clientId: "fixture-client",
      subject: SUBJECT,
      issuerSessionId: "fixture-sid",
      authTime: Math.floor(now / 1000),
      accountId: SUBJECT,
      workspaceId: "workspace_fixture",
      workspaceRef: WORKSPACE_REF,
    },
    organizationId: await workspaceBillingOrganizationRef(AUTHORITY, WORKSPACE_REF),
    session: {
      digest: sessionDigest,
      accountId: SUBJECT,
      principalId,
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

async function servedD1(mode: Mode) {
  const id = `fresh-rp-issuance-d1-${crypto.randomUUID()}`;
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: id,
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('local only'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id } },
          triggers: [],
        },
      },
    ],
  });
  runtimes.push(runtime);
  const database = await runtime.getD1Database("STATE_DB");
  for (const source of [
    ...MIGRATIONS.filter(({ name }) => Number(name.slice(0, 4)) <= 100).map(({ sql }) => sql),
    ...createAuth103CanonicalSourceArtifacts(ROOT).files.map(({ sql }) => sql),
    FINANCIAL_0104_DDL,
    ROOT_0105_DDL,
  ]) {
    const statements = frameHostMigrationSql(source);
    if (statements.length > 0)
      await database.batch(statements.map((statement) => database.prepare(statement)));
  }
  const raw = createD1Sql(database.withSession("first-primary"), {
    acknowledgement: "explicit-d1-result",
  });
  let selected: Sql;
  if (mode === "money") {
    const present = await raw.query(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name='money_cutover_writer_permit'",
    );
    if (present.length === 0)
      for (const ddl of [
        MONEY_CUTOVER_FREEZE_DDL,
        MONEY_CUTOVER_PERMIT_DDL,
        MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
        MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
      ])
        await raw.run(ddl);
    await raw.run("INSERT INTO money_cutover_authorized_epoch VALUES (1, ?)", [WRITER]);
    selected = createMoneyCutoverSql(raw, WRITER);
  } else selected = createFreshNativeSql(raw);
  const acks: (readonly SqlWrite[])[] = [];
  const sql: Sql = {
    query: (...args) => selected.query(...args),
    run: (...args) => selected.run(...args),
    async batch(statements) {
      const writes = await selected.batch(statements);
      acks.push(writes);
      return writes;
    },
  };
  const count = async (table: string) =>
    (await database.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n;
  const counts = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          "principals",
          "auth_principal_incarnations",
          "shared_principal_bindings",
          "shared_auth_sessions",
          "credential_authority_classes",
          "orgs",
          "org_memberships",
          "org_wallet_workspace_bindings",
          "financial_customer_history_birth_observations",
          "financial_customer_history_org_changes",
        ].map(async (table) => [table, await count(table)] as const),
      ),
    );
  return { database, raw, sql, acks, count, counts };
}

const issue = (sql: Sql, data: FreshSharedRpIssuanceData, authority: string | null = AUTHORITY) =>
  createSharedRpPrincipalIssuanceStore({
    sql,
    workspaceBillingAuthority: authority,
  }).issueFreshOnce(data);

for (const mode of modes) {
  test(`${mode}: D1 counts the Root 0105 birth row in the orgs ACK and issuance still acknowledges`, async () => {
    const d1 = await servedD1(mode);
    const data = await input();
    const result = await issue(d1.sql, data);
    expect(result.session.digest).toBe(data.session.digest);
    expect(result.principal.binding.ref).toBe(data.principal.binding.ref);
    expect(d1.acks).toHaveLength(1);
    // The fixed five each change exactly their own row (no write trigger on
    // those tables). The orgs INSERT changes one row and Root 0105's AFTER
    // INSERT trigger appends one raw birth observation; membership and
    // Workspace binding change one row each; the final guard changes none.
    expect(d1.acks[0]?.map((write) => write.changes)).toEqual([1, 1, 1, 1, 1, 2, 1, 1, 0]);
    expect(await d1.counts()).toMatchObject({
      principals: 1,
      shared_principal_bindings: 1,
      shared_auth_sessions: 1,
      credential_authority_classes: 1,
      orgs: 1,
      org_memberships: 1,
      org_wallet_workspace_bindings: 1,
      financial_customer_history_birth_observations: 1,
    });
  }, 60000);

  test(`${mode}: without a billing realm the fixed five acknowledge on D1 with no Organization rows`, async () => {
    const d1 = await servedD1(mode);
    await issue(d1.sql, await input(), null);
    expect(d1.acks[0]?.map((write) => write.changes)).toEqual([1, 1, 1, 1, 1]);
    expect(await d1.count("orgs")).toBe(0);
    expect(await d1.count("shared_auth_sessions")).toBe(1);
  }, 60000);
}

test("on the served schema only orgs carries a row-writing INSERT trigger among the issuance tables", async () => {
  // The exact ACK bounds rely on this: fixed-five, membership and Workspace
  // binding INSERTs change only their own rows; orgs proves its row by RETURNING.
  const d1 = await servedD1("money");
  const rows = await d1.raw.query(
    `SELECT tbl_name, name, sql FROM sqlite_schema WHERE type='trigger' AND tbl_name IN
      ('principals','auth_principal_incarnations','shared_principal_bindings',
       'shared_auth_sessions','credential_authority_classes','orgs','org_memberships',
       'org_wallet_workspace_bindings')`,
  );
  const writing = rows
    .filter((row) => /\bON\b/u.test(String(row.sql)) && /\bINSERT\s+ON\b/iu.test(String(row.sql)))
    .filter((row) => {
      const body = String(row.sql).slice(String(row.sql).search(/\bBEGIN\b/u));
      return /\b(INSERT|UPDATE|DELETE|REPLACE)\b/u.test(body);
    })
    .map((row) => `${row.tbl_name}:${row.name}`)
    .sort();
  expect(writing).toEqual([
    "orgs:financial_history_capture_org_insert",
    "orgs:financial_history_capture_org_replace",
  ]);
}, 60000);

test("an Org re-created after its raw birth was recorded acknowledges with no new birth row", async () => {
  const d1 = await servedD1("money");
  const data = await input();
  // A prior Org with the same id leaves its raw birth (and a delete change)
  // behind, so the issuance INSERT writes its base row and no trigger row.
  await d1.database
    .prepare("INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)")
    .bind(data.organizationId, "Personal workspace", "prn_previous", new Date().toISOString())
    .run();
  await d1.database.prepare("DELETE FROM orgs WHERE id = ?").bind(data.organizationId).run();
  const before = await d1.counts();
  expect(before.financial_customer_history_birth_observations).toBe(1);
  await issue(d1.sql, data);
  expect(d1.acks[0]?.map((write) => write.changes)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 0]);
  expect(await d1.counts()).toMatchObject({
    orgs: 1,
    financial_customer_history_birth_observations: 1,
    financial_customer_history_org_changes: before.financial_customer_history_org_changes,
  });
}, 60000);

test("an Organization already materialized for the principal acknowledges with no Org changes", async () => {
  const d1 = await servedD1("money");
  const data = await input();
  const at = new Date().toISOString();
  // The owner tuple exists before the batch: every Organization INSERT selects
  // nothing, so no trigger runs and each statement changes exactly 0 rows.
  await d1.database.batch([
    d1.database
      .prepare("INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(data.organizationId, "Personal workspace", data.principal.principalId, at),
    d1.database
      .prepare(
        "INSERT INTO org_memberships (org_id, principal_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      )
      .bind(data.organizationId, data.principal.principalId, at),
    d1.database
      .prepare(
        "INSERT INTO org_wallet_workspace_bindings (workspace_ref, org_id, created_at) VALUES (?, ?, ?)",
      )
      .bind(WORKSPACE_REF, data.organizationId, at),
  ]);
  const before = await d1.counts();
  await issue(d1.sql, data);
  expect(d1.acks[0]?.map((write) => write.changes)).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0]);
  expect(d1.acks[0]?.slice(5).map((write) => write.rows)).toEqual([[], [], [], []]);
  expect(await d1.counts()).toMatchObject({
    orgs: 1,
    org_memberships: 1,
    org_wallet_workspace_bindings: 1,
    financial_customer_history_birth_observations:
      before.financial_customer_history_birth_observations,
    shared_auth_sessions: 1,
  });
}, 60000);

test("a second fresh principal for an already bound subject is refused atomically", async () => {
  // The fresh-callback projection always mints a NEW principal and binding.
  // Auth103's binding trigger refuses a second root binding for the same
  // (issuer, subject), so a returning user's fresh issuance never commits.
  const d1 = await servedD1("money");
  await issue(d1.sql, await input(digest("e")), null);
  const before = await d1.counts();
  let failure: unknown;
  try {
    await issue(d1.sql, await input(digest("f")), null);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(String((failure as Error).message)).toContain("Current proved Principal binding required");
  expect(await d1.counts()).toEqual(before);
}, 60000);

// Returning subject: a later fresh callback for a subject whose binding is
// active and current issues a NEW session and credential class on the SAME
// principal and binding. The retained issuance re-proves the binding inside
// its batch through the companion's existing currentness guard.

/** A later login's DATA for the principal and binding the first login created. */
function returning(
  first: FreshSharedRpIssuanceData,
  sessionDigest = digest("f"),
  override: Partial<{ targetRef: string }> = {},
): RetainedSharedRpIssuanceData {
  const now = Date.now() - 500;
  const at = new Date(now).toISOString();
  const id = () => crypto.randomUUID();
  const targetRef = override.targetRef ?? first.principal.binding.targetRef;
  return {
    principal: {
      principalId: first.principal.principalId,
      principalIncarnation: first.principal.principalIncarnation,
      bindingRef: first.principal.binding.ref,
      targetRef,
      issuer: first.principal.binding.issuer,
      subject: first.principal.binding.subject,
    },
    credential: {
      ref: `cra_${id()}`,
      incarnation: `cri_${id()}`,
      targetRef,
      principalId: first.principal.principalId,
      principalIncarnation: first.principal.principalIncarnation,
      issuanceRef: `iss_${id()}`,
      issuanceDigest: digest("9"),
      issuedAt: at,
    },
    rp: {
      ...first.rp,
      sessionDigest,
      sessionCreatedAt: now,
      issuerSessionId: "fixture-sid-2",
      authTime: Math.floor(now / 1000),
    },
    organizationId: first.organizationId,
    session: {
      ...first.session,
      digest: sessionDigest,
      payload: "synthetic-encrypted-payload-2",
      createdAt: now,
      lastUsedAt: now,
      absoluteExpiresAt: now + 60000,
      grantCheckedAt: now,
    },
  };
}
const issueRetained = (sql: Sql, data: RetainedSharedRpIssuanceData) =>
  createSharedRpPrincipalIssuanceStore({
    sql,
    workspaceBillingAuthority: AUTHORITY,
  }).issueRetainedOnce(data);
const target = { issuer: ISSUER, subject: SUBJECT, targetRef: "synthetic-target" };
async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}
async function retireBinding(d1: Awaited<ReturnType<typeof servedD1>>, ref: string) {
  await d1.database
    .prepare(
      `UPDATE shared_principal_bindings SET state='retired', terminal_reason='fixture-retired',
        terminal_at=?, terminal_ref='fixture-retire' WHERE binding_ref=?`,
    )
    .bind(new Date().toISOString(), ref)
    .run();
}

test("a subject with no binding resolves to absent and may enroll fresh", async () => {
  const d1 = await servedD1("money");
  expect(await resolveSharedRpSubjectBinding(d1.sql, target)).toBeNull();
}, 60000);

test("a returning subject reuses its principal, binding and Org with a second session", async () => {
  const d1 = await servedD1("money");
  const first = await input(digest("e"));
  await issue(d1.sql, first);
  const resolved = await resolveSharedRpSubjectBinding(d1.sql, target);
  expect(resolved).toEqual({
    principalId: first.principal.principalId,
    principalIncarnation: first.principal.principalIncarnation,
    bindingRef: first.principal.binding.ref,
    targetRef: "synthetic-target",
    issuer: ISSUER,
    subject: SUBJECT,
  });
  // The callback revokes the browser's previous session before writing.
  expect(
    await createSharedAuthSessionStore(d1.sql).revokeSession(first.session.digest, Date.now()),
  ).toBe(true);
  const later = returning(first);
  const result = await issueRetained(d1.sql, later);
  expect(result.principal.bindingRef).toBe(first.principal.binding.ref);
  expect(result.session.digest).toBe(later.session.digest);
  // Session and class rows only, then the Organization owner guard alone,
  // which writes nothing.
  expect(d1.acks.at(-1)?.map((write) => write.changes)).toEqual([1, 1, 0]);
  expect(d1.acks.at(-1)?.[2]?.rows).toEqual([]);
  expect(await d1.counts()).toMatchObject({
    principals: 1,
    auth_principal_incarnations: 1,
    shared_principal_bindings: 1,
    shared_auth_sessions: 2,
    credential_authority_classes: 2,
    orgs: 1,
    org_memberships: 1,
    org_wallet_workspace_bindings: 1,
    financial_customer_history_birth_observations: 1,
  });
  expect(
    await d1.raw.query(
      "SELECT digest, status, principal_id FROM shared_auth_sessions ORDER BY created_at",
    ),
  ).toEqual([
    {
      digest: first.session.digest,
      status: "revocation_pending",
      principal_id: first.principal.principalId,
    },
    { digest: later.session.digest, status: "active", principal_id: first.principal.principalId },
  ]);
  expect(
    await d1.raw.query(
      `SELECT session_digest, state, principal_binding_ref, organization_id
       FROM credential_authority_classes ORDER BY session_created_at`,
    ),
  ).toEqual([
    {
      session_digest: first.session.digest,
      state: "retired",
      principal_binding_ref: first.principal.binding.ref,
      organization_id: first.organizationId,
    },
    {
      session_digest: later.session.digest,
      state: "active",
      principal_binding_ref: first.principal.binding.ref,
      organization_id: first.organizationId,
    },
  ]);
  expect(await d1.raw.query("SELECT owner_principal_id FROM orgs")).toEqual([
    { owner_principal_id: first.principal.principalId },
  ]);
}, 60000);

test("a subject with only a retired binding is refused and never re-enrolled", async () => {
  const d1 = await servedD1("money");
  const first = await input(digest("e"));
  await issue(d1.sql, first);
  await retireBinding(d1, first.principal.binding.ref);
  const before = await d1.counts();
  const resolved = await refusal(() => resolveSharedRpSubjectBinding(d1.sql, target));
  expect(resolved).toBeInstanceOf(AuthAuthorityStoreError);
  expect((resolved as AuthAuthorityStoreError).code).toBe("unavailable");
  // Neither a fresh principal nor the retired binding can carry a new session.
  const fresh = await input(digest("f"));
  expect(await refusal(() => issue(d1.sql, fresh))).toBeInstanceOf(Error);
  expect(await refusal(() => issueRetained(d1.sql, returning(first)))).toBeInstanceOf(Error);
  expect(await d1.counts()).toEqual(before);
}, 60000);

test("a binding for another native target is refused at resolution and inside the batch", async () => {
  const d1 = await servedD1("money");
  const first = await input(digest("e"));
  await issue(d1.sql, first);
  const before = await d1.counts();
  const resolved = await refusal(() =>
    resolveSharedRpSubjectBinding(d1.sql, { ...target, targetRef: "another-target" }),
  );
  expect(resolved).toBeInstanceOf(AuthAuthorityStoreError);
  // A crossed target cannot pass the companion's in-batch binding guard either.
  expect(
    await refusal(() =>
      issueRetained(d1.sql, returning(first, digest("f"), { targetRef: "another-target" })),
    ),
  ).toBeInstanceOf(Error);
  expect(await d1.counts()).toEqual(before);
}, 60000);

test("a binding retired after resolution is refused inside the batch with no rows", async () => {
  const d1 = await servedD1("money");
  const first = await input(digest("e"));
  await issue(d1.sql, first);
  expect(await resolveSharedRpSubjectBinding(d1.sql, target)).not.toBeNull();
  await retireBinding(d1, first.principal.binding.ref);
  const before = await d1.counts();
  expect(await refusal(() => issueRetained(d1.sql, returning(first)))).toBeInstanceOf(Error);
  expect(await d1.counts()).toEqual(before);
}, 60000);

test("a returning login never writes an Organization: missing, foreign or rebound Orgs are refused", async () => {
  // Enrolled without a billing realm: the subject's principal owns no Org.
  const d1 = await servedD1("money");
  const first = await input(digest("e"));
  await issue(d1.sql, first, null);
  let before = await d1.counts();
  expect(await refusal(() => issueRetained(d1.sql, returning(first)))).toBeInstanceOf(Error);
  expect(await d1.counts()).toEqual(before);

  // The Workspace's Org owned by another principal is never transferred.
  const at = new Date().toISOString();
  await d1.database.batch([
    d1.database
      .prepare("INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(first.organizationId, "Personal workspace", "prn_other", at),
    d1.database
      .prepare(
        "INSERT INTO org_memberships (org_id, principal_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      )
      .bind(first.organizationId, "prn_other", at),
    d1.database
      .prepare(
        "INSERT INTO org_wallet_workspace_bindings (workspace_ref, org_id, created_at) VALUES (?, ?, ?)",
      )
      .bind(WORKSPACE_REF, first.organizationId, at),
  ]);
  before = await d1.counts();
  expect(await refusal(() => issueRetained(d1.sql, returning(first, digest("7"))))).toBeInstanceOf(
    Error,
  );
  expect(await d1.counts()).toEqual(before);
  expect(await d1.raw.query("SELECT owner_principal_id FROM orgs")).toEqual([
    { owner_principal_id: "prn_other" },
  ]);
}, 60000);

test("a returning login for another Workspace or without its owner membership is refused", async () => {
  const d1 = await servedD1("money");
  const first = await input(digest("e"));
  await issue(d1.sql, first);
  const before = await d1.counts();
  // Another Workspace would derive a second Org for the same principal.
  const otherRef = `wrk_${"1".repeat(32)}`;
  const moved = returning(first, digest("7"));
  const rebound: RetainedSharedRpIssuanceData = {
    ...moved,
    rp: { ...moved.rp, workspaceRef: otherRef },
    organizationId: await workspaceBillingOrganizationRef(AUTHORITY, otherRef),
  };
  expect(await refusal(() => issueRetained(d1.sql, rebound))).toBeInstanceOf(Error);
  expect(await d1.counts()).toEqual(before);
  // A removed owner membership is not restored by a later login.
  await d1.database
    .prepare("DELETE FROM org_memberships WHERE org_id = ?")
    .bind(first.organizationId)
    .run();
  const trimmed = await d1.counts();
  expect(await refusal(() => issueRetained(d1.sql, returning(first, digest("8"))))).toBeInstanceOf(
    Error,
  );
  expect(await d1.counts()).toEqual(trimmed);
}, 60000);

test("a subject whose active binding is a successor is refused", async () => {
  const d1 = await servedD1("money");
  const first = await input(digest("e"));
  await issue(d1.sql, first, null);
  await retireBinding(d1, first.principal.binding.ref);
  const principals = createSharedPrincipalAuthorityStore({ sql: d1.raw });
  const root = await principals.readBinding(first.principal.binding.ref);
  if (!root) throw new Error("root binding absent");
  await principals.appendSuccessor(root, {
    ref: `spb_${crypto.randomUUID()}`,
    controllerIncarnation: `ctl_${crypto.randomUUID()}`,
    evidence: { ref: `bev_${crypto.randomUUID()}`, digest: digest("b") },
    enrolledAt: new Date().toISOString(),
  });
  expect(
    (await d1.raw.query("SELECT state FROM shared_principal_bindings ORDER BY state")).map(
      (row) => row.state,
    ),
  ).toEqual(["active", "retired"]);
  const resolved = await refusal(() => resolveSharedRpSubjectBinding(d1.sql, target));
  expect(resolved).toBeInstanceOf(AuthAuthorityStoreError);
}, 60000);

test("resolution refuses bindings that change between its two reads", async () => {
  const d1 = await servedD1("money");
  const first = await input(digest("e"));
  await issue(d1.sql, first);
  let reads = 0;
  const drifting: Sql = {
    ...d1.sql,
    async query(text, params) {
      const rows = await d1.sql.query(text, params);
      if (!text.includes("FROM shared_principal_bindings WHERE issuer=?")) return rows;
      reads += 1;
      return reads === 2
        ? rows.map((row) => ({ ...row, controller_incarnation: "ctl_drifted" }))
        : rows;
    },
  };
  const resolved = await refusal(() => resolveSharedRpSubjectBinding(drifting, target));
  expect(resolved).toBeInstanceOf(AuthAuthorityStoreError);
  expect(reads).toBe(2);
}, 60000);

test("two concurrent first logins for one subject: one wins, the other fails closed", async () => {
  const d1 = await servedD1("money");
  const results = await Promise.allSettled([
    issue(d1.sql, await input(digest("e"))),
    issue(d1.sql, await input(digest("f"))),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const lost = results.find((result) => result.status === "rejected");
  // A constraint refusal: never session_invalid, so the RP answers
  // session_unavailable, and the instance never resends it.
  expect((lost as PromiseRejectedResult).reason).toBeInstanceOf(SqlError);
  expect(await d1.counts()).toMatchObject({
    principals: 1,
    auth_principal_incarnations: 1,
    shared_principal_bindings: 1,
    shared_auth_sessions: 1,
    credential_authority_classes: 1,
    orgs: 1,
    org_memberships: 1,
    org_wallet_workspace_bindings: 1,
    financial_customer_history_birth_observations: 1,
  });
}, 60000);

test("revokeSession acknowledges by its returned row although D1 counts the class retirement", async () => {
  const d1 = await servedD1("money");
  const first = await input(digest("e"));
  await issue(d1.sql, first);
  const store = createSharedAuthSessionStore(d1.sql);
  const acks = d1.acks.length;
  expect(await store.revokeSession(first.session.digest, Date.now())).toBe(true);
  // The session UPDATE changes its row and the AFTER UPDATE trigger retires
  // the session's credential class, so D1 reports 2 for that statement.
  expect(d1.acks[acks]?.[1]?.changes).toBe(2);
  expect(
    await d1.raw.query("SELECT state FROM credential_authority_classes WHERE session_digest=?", [
      first.session.digest,
    ]),
  ).toEqual([{ state: "retired" }]);
  // Already fenced and unknown sessions are not revoked again.
  expect(await store.revokeSession(first.session.digest, Date.now())).toBe(false);
  expect(await store.revokeSession(digest("0"), Date.now())).toBe(false);
}, 60000);

test("a subject bound through a proved-legacy binding is refused with no writes", async () => {
  const d1 = await servedD1("money");
  const at = new Date().toISOString();
  await d1.raw.run(
    "INSERT INTO principals(id,provider,provider_subject,email,display_name,created_at) VALUES (?,'google',?,'legacy@example.invalid','Legacy Fixture',?)",
    ["prn_legacy_fixture", SUBJECT, at],
  );
  await createSharedPrincipalAuthorityStore({ sql: d1.raw }).bindLegacy({
    principalId: "prn_legacy_fixture",
    principalIncarnation: "pri_legacy_fixture",
    provider: "google",
    providerSubject: SUBJECT,
    createdAt: at,
    origin: { ref: "legacy-origin", digest: digest("b") },
    binding: {
      ref: "spb_legacy_fixture",
      issuer: ISSUER,
      subject: SUBJECT,
      controllerIncarnation: "ctl_legacy_fixture",
      targetRef: "synthetic-target",
      evidence: { ref: "legacy-evidence", digest: digest("c") },
      enrolledAt: at,
    },
  });
  expect(
    await d1.raw.query(
      "SELECT binding_kind, state, previous_binding_ref FROM shared_principal_bindings",
    ),
  ).toEqual([{ binding_kind: "proved-legacy", state: "active", previous_binding_ref: null }]);
  const before = await d1.counts();
  const acks = d1.acks.length;
  const resolved = await refusal(() => resolveSharedRpSubjectBinding(d1.sql, target));
  expect(resolved).toBeInstanceOf(AuthAuthorityStoreError);
  expect((resolved as AuthAuthorityStoreError).code).toBe("unavailable");
  expect(await d1.counts()).toEqual(before);
  expect(d1.acks).toHaveLength(acks);
}, 60000);

test("an anchor that is not active, or names another incarnation, is refused with no writes", async () => {
  const d1 = await servedD1("money");
  const first = await input(digest("e"));
  await issue(d1.sql, first);
  // The Auth103 triggers retire the binding together with its anchor, so an
  // active binding over an inactive anchor is shown through the read side.
  const anchored = (damage: (row: Record<string, unknown>) => Record<string, unknown>): Sql => ({
    ...d1.sql,
    async query(text, params) {
      const rows = await d1.sql.query(text, params);
      return text.includes("FROM auth_principal_incarnations WHERE principal_id=?")
        ? rows.map((row) => damage({ ...row }))
        : rows;
    },
  });
  const before = await d1.counts();
  const acks = d1.acks.length;
  // One fixed instant, so both resolution reads see identical rows and the
  // refusal comes from the anchor check, not from drift detection.
  const retiredAt = new Date().toISOString();
  for (const damage of [
    (row: Record<string, unknown>) => ({
      ...row,
      state: "retired",
      terminal_reason: "fixture-retired",
      terminal_at: retiredAt,
      terminal_ref: "fixture-retire",
    }),
    (row: Record<string, unknown>) => ({ ...row, principal_incarnation: "pri_other" }),
  ]) {
    const resolved = await refusal(() => resolveSharedRpSubjectBinding(anchored(damage), target));
    expect(resolved).toBeInstanceOf(AuthAuthorityStoreError);
    expect((resolved as AuthAuthorityStoreError).code).toBe("unavailable");
  }
  // The undamaged rows resolve, so the refusals above come from the anchor.
  expect(await resolveSharedRpSubjectBinding(d1.sql, target)).not.toBeNull();
  expect(await d1.counts()).toEqual(before);
  expect(d1.acks).toHaveLength(acks);
}, 60000);

test("revokeSession refuses a change count without its exact returned row", async () => {
  const d1 = await servedD1("money");
  const first = await input(digest("e"));
  await issue(d1.sql, first);
  const shapes: ((fenced: SqlWrite) => SqlWrite)[] = [
    // The old acceptance shape: one change and no returned row.
    () => ({ changes: 1, rows: [] }),
    // A returned row for another session, or not fenced.
    (fenced) => ({ ...fenced, rows: fenced.rows.map((row) => ({ ...row, digest: digest("0") })) }),
    (fenced) => ({ ...fenced, rows: fenced.rows.map((row) => ({ ...row, status: "active" })) }),
    // A returned row without any change, or two rows.
    (fenced) => ({ ...fenced, changes: 0 }),
    (fenced) => ({ ...fenced, rows: [...fenced.rows, ...fenced.rows] }),
  ];
  for (const [index, shape] of shapes.entries()) {
    // Each shape revokes its own active session on the same binding.
    const later = returning(first, digest(String(index + 1)));
    await issueRetained(d1.sql, later);
    const store = createSharedAuthSessionStore({
      ...d1.sql,
      async batch(statements) {
        const writes = await d1.sql.batch(statements);
        return writes.map((write, at) => (at === 1 ? shape(write) : write));
      },
    });
    expect(await store.revokeSession(later.session.digest, Date.now())).toBe(false);
    // The real UPDATE did fence the row; only the acknowledgement was damaged.
    expect(
      await d1.raw.query("SELECT status FROM shared_auth_sessions WHERE digest=?", [
        later.session.digest,
      ]),
    ).toEqual([{ status: "revocation_pending" }]);
  }
}, 60000);
