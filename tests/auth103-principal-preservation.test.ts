import { Database, SQLiteError } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { buildUnregisteredV2WorkerNativeIdentityMigrationCandidate } from "../scripts/deploy/v2-worker-native-identity-migration-candidate.ts";
import { createAccounts } from "../src/auth.ts";
import { additiveAuthFull103DDL } from "../src/auth-authority-schema-plan.ts";
import {
  authPrincipalProviderTransitionDDL,
  authPrincipalProviderTransitionStatements,
} from "../src/auth-principal-schema-plan.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { resolveIdentity } from "../src/identity-setup.ts";
import { base64UrlEncode } from "../src/json.ts";
import { executeSqliteMigrationStatements } from "../src/migrate-sqlite.ts";
import {
  createSharedPrincipalAuthorityStore,
  type FreshSharedPrincipal,
} from "../src/shared-principal-authority.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

// A migration-component regression against historical100 plus actual owner101/102
// candidates. It neither registers those candidates nor establishes a deployed
// target, genuine shared Principal, RP issuer or consumer capability.
const opened = new Set<Database>();
afterEach(() => {
  for (const db of opened) db.close();
  opened.clear();
});
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const quoted = (name: string) => `"${name.replace(/"/gu, '""')}"`;
const ownerTriggerDigest = "5b1172d4e06a5c750a14128a8eb26a0dbe3c7703a3c01aa1c34e2d514cd13be0";

function executeOpaqueHostAuthMigration(db: Database, phase: "principal" | "full103"): void {
  const ddl = phase === "principal" ? authPrincipalProviderTransitionDDL : additiveAuthFull103DDL;
  try {
    executeSqliteMigrationStatements(db, ddl);
  } catch (error) {
    // Native SQLiteError.query can contain the derived historical trigger body.
    // Preserve failure while never attaching its raw message, query or cause.
    const rawCode = error instanceof SQLiteError ? error.code : undefined;
    const code =
      typeof rawCode === "string" && /^SQLITE_[A-Z0-9_]{1,64}$/u.test(rawCode)
        ? rawCode
        : "unclassified";
    throw new Error(
      `auth103 host-framer ${phase} failed; code ${code}; opaque ${digest(String(error))}`,
    );
  }
}

function originalOwnerTriggerSql(db: Database): string {
  const row = db
    .query(`SELECT sql FROM main.sqlite_schema
    WHERE type = 'trigger' AND name = 'personal_organizations_owner_insert'
      AND tbl_name = 'personal_organizations'`)
    .get() as { sql: unknown } | null;
  if (typeof row?.sql !== "string") throw new Error("canonical owner trigger is absent");
  return row.sql;
}

function restoredOwnerTriggerDigest(): string {
  // The independent observed catalog hash closes this source/catalog spelling
  // comparison. Protected source never appears in an assertion's value.
  const matches = authPrincipalProviderTransitionStatements()
    .map(({ sql }) => sql.replace(/^(?:[ \t\r\n]|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u, ""))
    .filter((sql) =>
      /^CREATE TRIGGER(?: IF NOT EXISTS)? personal_organizations_owner_insert(?=[ \t\r\n])/u.test(
        sql,
      ),
    );
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error("canonical owner trigger restore is not unique");
  }
  return digest(
    matches[0]
      .replace(/^CREATE TRIGGER IF NOT EXISTS /u, "CREATE TRIGGER ")
      .replace(/[ \t\r\n]+$/u, "")
      .replace(/;$/u, ""),
  );
}

function principalShape(db: Database) {
  const indexes = db
    .query(`SELECT name, "unique", origin, partial
    FROM pragma_index_list('principals', 'main') ORDER BY name COLLATE BINARY`)
    .all() as { name: string }[];
  return {
    columns: db.query("PRAGMA main.table_info('principals')").all(),
    indexes: indexes.map((index) => ({
      ...index,
      columns: db
        .query("SELECT seqno, cid, name FROM pragma_index_info(?, 'main') ORDER BY seqno")
        .all(index.name),
    })),
  };
}

function schema(db: Database) {
  const objects = db
    .query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name COLLATE BINARY")
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  // Protected historical bodies stay opaque even if an assertion fails.
  return objects.map(({ sql, ...metadata }) => ({
    ...metadata,
    sqlDigest: sql === null ? null : digest(sql),
  }));
}

function rows(db: Database) {
  const tables = db
    .query(`SELECT name, CASE WHEN instr(upper(sql), 'WITHOUT ROWID') > 0
    THEN 1 ELSE 0 END AS no_rowid FROM sqlite_schema WHERE type = 'table'
    ORDER BY name COLLATE BINARY`)
    .all() as { name: string; no_rowid: number }[];
  return Object.fromEntries(
    tables.map(({ name, no_rowid }) => [
      name,
      db
        .query(`SELECT ${no_rowid ? "*" : "rowid, *"} FROM ${quoted(name)}`)
        .all()
        .map((row) => digest(JSON.stringify(row)))
        .sort(),
    ]),
  );
}

function checkpoint(db: Database) {
  return { schema: schema(db), rows: rows(db) };
}

async function fixture() {
  const db = new Database(":memory:");
  opened.add(db);
  const prefix = MIGRATIONS.filter(({ name }) => Number(name.slice(0, 4)) <= 100);
  expect(prefix.length).toBe(100);
  expect(prefix.map(({ name }) => Number(name.slice(0, 4)))).toEqual(
    Array.from({ length: 100 }, (_, i) => i + 1),
  );
  for (const migration of prefix) {
    try {
      db.exec(migration.sql);
    } catch (error) {
      // Native SQLite diagnostics may retain the historical SQL query. Never
      // attach/rethrow that object or render protected migration bodies.
      throw new Error(
        `historical setup ${migration.name} failed (opaque diagnostic ${digest(String(error))})`,
      );
    }
  }
  const sql = createSqliteSql(db);
  await sql.batch(v2ContainerOwnerMigrationCandidate());
  await sql.batch(
    buildUnregisteredV2WorkerNativeIdentityMigrationCandidate().statements.map((text) => ({
      sql: text,
    })),
  );

  const now = new Date("2026-10-16T00:00:00.000Z");
  const audience = "https://principal-preservation.example.test";
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const key = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const identity = resolveIdentity({
    operatorPublicKeyJwk: { kty: "OKP", crv: "Ed25519", x: String(key.x) },
    operatorAudience: audience,
    clock: () => new Date(now),
  }).verifier;
  const accounts = createAccounts({ sql, identity, clock: () => new Date(now) });
  const payload = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        purpose: "sign-in",
        aud: audience,
        provider: "google",
        subject: "preserved-owner",
        email: "preserved-owner@example.test",
        displayName: "既存 Owner",
        iat: Math.floor(now.getTime() / 1000),
        exp: Math.floor(now.getTime() / 1000) + 300,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    pair.privateKey,
    new TextEncoder().encode(payload),
  );
  const signedIn = await accounts.signIn({
    provider: "google",
    method: "operator-assertion",
    audience,
    assertion: `${payload}.${base64UrlEncode(new Uint8Array(signature))}`,
  });
  const authorization = `Bearer ${signedIn.sessionToken}`;
  const actor = await accounts.authenticate(authorization);
  if (!actor) throw new Error("legacy fixture did not authenticate");
  const organization = await accounts.createOrganization({ actor, name: "Preserved owner org" });
  // Structural inbound fixture, not a free-grant/personal-org allocation proof.
  await sql.run(
    "INSERT INTO personal_organizations (principal_id, org_id, created_at) VALUES (?, ?, ?)",
    [signedIn.principal.id, organization.id, now.toISOString()],
  );
  const api = await accounts.createApiKey({
    actor,
    organizationId: organization.id,
    name: "Preserved key",
    scopes: ["resources:write"],
    expiresInSeconds: 3600,
  });
  // Historical fixtures retain real legacy provider labels. They are not fake
  // shared actors or a proof of upstream sign-in for these other two providers.
  await sql.run(
    `INSERT INTO principals
    (rowid, id, provider, provider_subject, email, display_name, created_at)
    VALUES (101, 'old-github', 'github', 'old-subject', 'old@example.test', ?, ?)
  `,
    ["履歴\nname", "2024-03-01T02:03:04+09:00"],
  );
  await sql.run(`INSERT INTO principals
    (rowid, id, provider, provider_subject, email, display_name, created_at)
    VALUES (204, 'old-takos-id', 'takos-id', 'old-upstream', '', '', '2023-01-01')`);
  return { db, sql, accounts, actor, organization, signedIn, authorization, api };
}

const insertShared = `INSERT INTO principals
  (id, provider, provider_subject, email, display_name, created_at)
  VALUES ('structural-shared', 'shared-account', 'structural-subject', '', '', '2026-10-16')`;

function noScratch(db: Database) {
  expect(db.query("SELECT name FROM sqlite_schema WHERE name LIKE 'auth103_%'").all()).toEqual([]);
}

test("preserves every predecessor row and non-Principal schema plus legacy session/key behavior", async () => {
  const f = await fixture();
  expect(digest(originalOwnerTriggerSql(f.db))).toBe(ownerTriggerDigest);
  expect(restoredOwnerTriggerDigest()).toBe(ownerTriggerDigest);
  const shape = principalShape(f.db);
  const before = checkpoint(f.db);
  await f.sql.batch(authPrincipalProviderTransitionStatements());
  const after = checkpoint(f.db);
  expect(digest(originalOwnerTriggerSql(f.db))).toBe(ownerTriggerDigest);
  expect(principalShape(f.db)).toEqual(shape);
  expect(after.rows).toEqual(before.rows);
  expect(after.schema.filter(({ tbl_name }) => tbl_name !== "principals")).toEqual(
    before.schema.filter(({ tbl_name }) => tbl_name !== "principals"),
  );
  expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(f.db.query("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
  expect(await f.accounts.authenticate(f.authorization)).toMatchObject({
    principalId: f.signedIn.principal.id,
  });
  expect(await f.accounts.authorize(`Bearer ${f.api.secret}`, "resources:write")).toMatchObject({
    principalId: f.signedIn.principal.id,
    organizationId: f.organization.id,
  });
  noScratch(f.db);
});

test("extends only the provider domain and keeps primary/unique/not-null/foreign-key checks", async () => {
  const f = await fixture();
  await f.sql.batch(authPrincipalProviderTransitionStatements());
  await expect(f.sql.run(insertShared)).resolves.toMatchObject({ changes: 1 });
  await expect(
    f.sql.run(insertShared.replace("'structural-shared'", "'duplicate-subject'")),
  ).rejects.toMatchObject({ code: "constraint" });
  await expect(
    f.sql.run(insertShared.replace("'structural-subject'", "'another-subject'")),
  ).rejects.toMatchObject({ code: "constraint" });
  await expect(
    f.sql.run(
      insertShared
        .replace("'structural-shared'", "'unknown-provider'")
        .replace("'shared-account'", "'unknown'"),
    ),
  ).rejects.toMatchObject({ code: "constraint" });
  await expect(
    f.sql.run(
      insertShared
        .replace("'structural-shared'", "'null-name'")
        .replace("'structural-subject'", "'null-name'")
        .replace("'', '',", "'', NULL,"),
    ),
  ).rejects.toMatchObject({ code: "constraint" });
  // A bare row with a new label is structural, not a genuine shared authority.
  await expect(
    f.sql.run(
      `INSERT INTO personal_organizations (principal_id, org_id, created_at)
    VALUES ('missing-principal', ?, '2026-10-16')`,
      [f.organization.id],
    ),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(f.db.query("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
});

test("late SQL failure rolls back the replacement and every scratch object", async () => {
  const f = await fixture();
  // Only this final statement can emit this named constraint. An earlier
  // migration/preflight failure must fail the oracle rather than count as PASS.
  f.db.exec(`CREATE TABLE fixture_late_failure
    (ok INTEGER CONSTRAINT fixture_after_replacement CHECK (ok = 1))`);
  const before = checkpoint(f.db);
  await expect(
    f.sql.batch([
      ...authPrincipalProviderTransitionStatements(),
      {
        sql: "INSERT INTO fixture_late_failure (ok) VALUES (0)",
      },
    ]),
  ).rejects.toMatchObject({
    code: "constraint",
    message: expect.stringContaining("fixture_after_replacement"),
  });
  expect(checkpoint(f.db)).toEqual(before);
  expect(f.db.query("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
  await expect(f.sql.run(insertShared)).rejects.toMatchObject({ code: "constraint" });
  noScratch(f.db);
});

test("a deferred foreign-key violation at COMMIT rolls back the complete transition", async () => {
  const f = await fixture();
  const before = checkpoint(f.db);
  let committed = false;
  let rolledBack = false;
  f.db.exec("BEGIN IMMEDIATE");
  try {
    // Exercise the existing host owner/framer transaction path, not a fake Sql
    // adapter. Every pre-commit operation must succeed to reach the oracle.
    executeOpaqueHostAuthMigration(f.db, "principal");
    expect(f.db.query("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 1 });
    const deletion = f.db.query("DELETE FROM principals WHERE id = ?").run(f.signedIn.principal.id);
    expect(deletion.changes).toBe(1);
    const violation = f.db
      .query("SELECT count(*) AS count FROM pragma_foreign_key_check")
      .get() as { count: number };
    expect(violation.count).toBe(1);
    let commitError: unknown;
    try {
      f.db.exec("COMMIT");
      committed = true;
    } catch (error) {
      commitError = error;
    }
    if (committed) throw new Error("isolated fixture unexpectedly committed a broken foreign key");
    // Failed FK COMMIT leaves this local transaction open; rollback it exactly
    // once. Never attempt rollback after a known successful commit.
    f.db.exec("ROLLBACK");
    rolledBack = true;
    expect(String(commitError)).toContain("FOREIGN KEY constraint failed");
  } finally {
    if (!committed && !rolledBack) f.db.exec("ROLLBACK");
  }
  expect(checkpoint(f.db)).toEqual(before);
  expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(f.db.query("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
  noScratch(f.db);
});

for (const [label, extra] of [
  ["missing canonical owner trigger", "DROP TRIGGER personal_organizations_owner_insert"],
  [
    "modified canonical owner trigger",
    `DROP TRIGGER personal_organizations_owner_insert;
    CREATE TRIGGER personal_organizations_owner_insert BEFORE INSERT ON personal_organizations
    BEGIN SELECT id FROM principals LIMIT 1; END`,
  ],
  [
    "canonical trigger on another table",
    `DROP TRIGGER personal_organizations_owner_insert;
    CREATE TRIGGER personal_organizations_owner_insert BEFORE INSERT ON org_memberships
    BEGIN SELECT id FROM principals LIMIT 1; END`,
  ],
  [
    "extra external dependent trigger",
    `CREATE TRIGGER unexpected_external_principal_trigger BEFORE INSERT ON org_memberships
    BEGIN SELECT id FROM principals LIMIT 1; END`,
  ],
  [
    "cascade reference",
    "CREATE TABLE unexpected_ref (principal_id TEXT REFERENCES principals(id) ON DELETE CASCADE)",
  ],
  [
    "restrict reference",
    "CREATE TABLE unexpected_ref (principal_id TEXT REFERENCES principals(id) ON DELETE RESTRICT)",
  ],
  ["custom index", "CREATE INDEX unexpected_principal_index ON principals(email)"],
  ["dependent view", "CREATE VIEW unexpected_principal_view AS SELECT id FROM principals"],
  [
    "attached trigger",
    "CREATE TRIGGER unexpected_principal_trigger AFTER DELETE ON principals BEGIN SELECT 1; END",
  ],
  ["column drift", "ALTER TABLE principals ADD COLUMN unexpected TEXT"],
  ["reserved name collision", "CREATE TABLE auth103_principal_rows (untouched TEXT)"],
] as const) {
  test(`rejects ${label} without adopting/removing any predecessor object`, async () => {
    const f = await fixture();
    f.db.exec(extra);
    const before = checkpoint(f.db);
    await expect(f.sql.batch(authPrincipalProviderTransitionStatements())).rejects.toMatchObject({
      code: "constraint",
    });
    expect(checkpoint(f.db)).toEqual(before);
    expect(f.db.query("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
  });
}

test("rejects canonical owner-trigger SQL byte drift without adopting it", async () => {
  const f = await fixture();
  const original = originalOwnerTriggerSql(f.db);
  expect(digest(original)).toBe(ownerTriggerDigest);
  // Change only whitespace after the known name; never inspect/copy its body.
  const changed = original.replace(
    "personal_organizations_owner_insert",
    "personal_organizations_owner_insert\n",
  );
  f.db.exec("DROP TRIGGER personal_organizations_owner_insert");
  try {
    f.db.exec(changed);
  } catch (error) {
    throw new Error(`opaque owner-trigger setup failed ${digest(String(error))}`);
  }
  expect(digest(originalOwnerTriggerSql(f.db)) === ownerTriggerDigest).toBe(false);
  const before = checkpoint(f.db);
  await expect(f.sql.batch(authPrincipalProviderTransitionStatements())).rejects.toMatchObject({
    code: "constraint",
  });
  expect(checkpoint(f.db)).toEqual(before);
  expect(f.db.query("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
});

for (const migrated of [false, true]) {
  test(`the canonical owner insert guard rejects foreign ownership ${migrated ? "after" : "before"} replacement`, async () => {
    const f = await fixture();
    if (migrated) await f.sql.batch(authPrincipalProviderTransitionStatements());
    expect(digest(originalOwnerTriggerSql(f.db))).toBe(ownerTriggerDigest);
    await f.sql.run(
      "INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)",
      ["owner-guard-foreign", "Owner guard", f.signedIn.principal.id, "2026-10-16"],
    );
    await f.sql.run(
      "INSERT INTO org_memberships (org_id, principal_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      ["owner-guard-foreign", "old-github", "2026-10-16"],
    );
    const insert = `INSERT INTO personal_organizations (principal_id, org_id, created_at)
      VALUES (?, ?, ?)`;
    const foreign = ["old-github", "owner-guard-foreign", "2026-10-16"];
    const before = checkpoint(f.db);
    await expect(f.sql.run(insert, foreign)).rejects.toMatchObject({ code: "constraint" });
    expect(checkpoint(f.db)).toEqual(before);

    // A mutation control proves this rejection belongs to this trigger, not an
    // unrelated uniqueness/FK rule. Its temporary removal always rolls back.
    f.db.exec("BEGIN IMMEDIATE");
    try {
      f.db.exec("DROP TRIGGER personal_organizations_owner_insert");
      expect(f.db.query(insert).run(...foreign)).toMatchObject({ changes: 1 });
    } finally {
      f.db.exec("ROLLBACK");
    }
    expect(checkpoint(f.db)).toEqual(before);
    expect(digest(originalOwnerTriggerSql(f.db))).toBe(ownerTriggerDigest);

    await f.sql.run(
      "INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)",
      ["owner-guard-valid", "Owner guard valid", "old-github", "2026-10-16"],
    );
    await f.sql.run(
      "INSERT INTO org_memberships (org_id, principal_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      ["owner-guard-valid", "old-github", "2026-10-16"],
    );
    await expect(
      f.sql.run(insert, ["old-github", "owner-guard-valid", "2026-10-16"]),
    ).resolves.toMatchObject({ changes: 1 });
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(f.db.query("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
    noScratch(f.db);
  });
}

for (const boundary of ["drop", "restore"] as const) {
  test(`a failure after owner-trigger ${boundary} rolls back every original object and row`, async () => {
    const f = await fixture();
    const constraint = `fixture_after_owner_trigger_${boundary}`;
    f.db.exec(`CREATE TABLE fixture_trigger_failure
      (ok INTEGER CONSTRAINT ${constraint} CHECK (ok = 1))`);
    const before = checkpoint(f.db);
    const statements = authPrincipalProviderTransitionStatements();
    const drop = statements.findIndex(
      ({ sql }) => sql === "DROP TRIGGER main.personal_organizations_owner_insert",
    );
    expect(drop > 0).toBe(true);
    // The final parent is populated before restoring the original trigger.
    // A named late assertion proves the requested boundary was actually reached.
    const last = boundary === "drop" ? drop : drop + 5;
    expect(statements[drop + 1]?.sql === "DROP TABLE main.principals").toBe(true);
    expect(
      statements[drop + 2]?.sql === "ALTER TABLE main.auth103_principals_next RENAME TO principals",
    ).toBe(true);
    expect(statements[drop + 3]?.sql.startsWith("INSERT INTO main.principals ")).toBe(true);
    const restore = statements[drop + 5]?.sql;
    expect(
      typeof restore === "string" &&
        /^(?:[ \t\r\n]|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*CREATE TRIGGER(?: IF NOT EXISTS)? personal_organizations_owner_insert(?=[ \t\r\n])/u.test(
          restore,
        ),
    ).toBe(true);
    await expect(
      f.sql.batch([
        ...statements.slice(0, last + 1),
        { sql: "INSERT INTO fixture_trigger_failure (ok) VALUES (0)" },
        ...statements.slice(last + 1),
      ]),
    ).rejects.toMatchObject({
      code: "constraint",
      message: expect.stringContaining(constraint),
    });
    expect(checkpoint(f.db)).toEqual(before);
    expect(digest(originalOwnerTriggerSql(f.db))).toBe(ownerTriggerDigest);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(f.db.query("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
    noScratch(f.db);
  });
}

test("the host statement framer composes the full103 alternative in its one owning transaction", async () => {
  const f = await fixture();
  const before = rows(f.db);
  f.db.exec("BEGIN IMMEDIATE");
  try {
    executeOpaqueHostAuthMigration(f.db, "full103");
    f.db.exec("COMMIT");
  } catch (error) {
    f.db.exec("ROLLBACK");
    throw error;
  }
  const after = rows(f.db);
  for (const [name, values] of Object.entries(before)) expect(after[name]).toEqual(values);
  expect(
    f.db
      .query(`SELECT name FROM sqlite_schema WHERE type='table'
    AND name IN ('auth_principal_incarnations', 'shared_principal_bindings',
      'credential_authority_classes', 'shared_auth_sessions')`)
      .all(),
  ).toHaveLength(4);
  await expect(f.sql.run(insertShared)).resolves.toMatchObject({ changes: 1 });
  expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(f.db.query("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
  noScratch(f.db);
});

// The fixed fresh-shared storage recipe must commit on the actual full103 chain,
// not only on the synthetic candidate fixture. Its rows stay DATA; no genuine
// RP/human proof, deployed target or consumer capability follows.
test("fresh shared Principal storage commits on the full103 chain without NULL identity text", async () => {
  const f = await fixture();
  f.db.exec("BEGIN IMMEDIATE");
  try {
    executeOpaqueHostAuthMigration(f.db, "full103");
    f.db.exec("COMMIT");
  } catch (error) {
    f.db.exec("ROLLBACK");
    throw error;
  }
  const digestRef = (text: string) => `sha256:${digest(text)}` as const;
  const input: FreshSharedPrincipal = {
    principalId: "prn_full103_fresh",
    principalIncarnation: "principal_inc_full103_fresh",
    createdAt: "2026-10-19T00:00:00.000Z",
    origin: { ref: "synthetic:origin:full103", digest: digestRef("origin") },
    binding: {
      ref: "binding_full103_fresh",
      issuer: "https://issuer.invalid",
      subject: "account_full103_fresh",
      controllerIncarnation: "controller_1",
      targetRef: "synthetic:server-target",
      evidence: { ref: "synthetic:verified-binding:full103:1", digest: digestRef("binding") },
      enrolledAt: "2026-10-19T00:00:00.000Z",
    },
  };
  const retained = await createSharedPrincipalAuthorityStore({
    sql: f.sql,
  }).createFreshWithPostimages(input);
  expect(retained.principal).toEqual({
    id: input.principalId,
    provider: "shared-account",
    provider_subject: input.binding.ref,
    email: "",
    display_name: "",
    created_at: input.createdAt,
  });
  expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  noScratch(f.db);
});

test("known completion does not permit replay/adoption of a second transition", async () => {
  const f = await fixture();
  await f.sql.batch(authPrincipalProviderTransitionStatements());
  const before = checkpoint(f.db);
  await expect(f.sql.batch(authPrincipalProviderTransitionStatements())).rejects.toMatchObject({
    code: "constraint",
  });
  expect(checkpoint(f.db)).toEqual(before);
  expect(f.db.query("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
  noScratch(f.db);
});

for (const table of ["_cf_kv", "_cf_metadata", "_cf_kv_user", "_cf_metadata_user"] as const)
  test(`native catalog barrier keeps populated ${table} CASCADE references in the original guard`, async () => {
    const f = await fixture();
    const name = quoted(table);
    f.db.exec(`CREATE TABLE ${name} (
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
      payload BLOB NOT NULL
    );`);
    f.db
      .query(`INSERT INTO ${name} (principal_id, payload) VALUES (?, X'00ff10')`)
      .run(f.signedIn.principal.id);
    const before = checkpoint(f.db);
    await expect(f.sql.batch(authPrincipalProviderTransitionStatements())).rejects.toMatchObject({
      code: "constraint",
    });
    expect(checkpoint(f.db)).toEqual(before);
    expect(f.db.inTransaction).toBe(false);
    expect(await f.accounts.authenticate(f.authorization)).toMatchObject({
      principalId: f.signedIn.principal.id,
    });
    noScratch(f.db);
  });
