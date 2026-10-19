import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { buildUnregisteredV2WorkerNativeIdentityMigrationCandidate } from "../scripts/deploy/v2-worker-native-identity-migration-candidate.ts";
import { createAccounts } from "../src/auth.ts";
import { additiveAuthFull103DDL } from "../src/auth-authority-schema-plan.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { resolveIdentity } from "../src/identity-setup.ts";
import { base64UrlEncode } from "../src/json.ts";
import { type Sql, SqlError, type SqlStatement } from "../src/ports.ts";
import { createD1Sql, type D1DatabaseLike } from "../src/sql-d1.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";

// Local Miniflare D1 component only: actual historical100, unregistered owner
// 101/102, then the full103 alternative. No migration registration, installed
// physical target, genuine shared human/issuer, Financial port or deploy claim.
// Imported SQL is opaque data. Never include its text or native errors in an
// assertion, error cause, console message or snapshot.
const ownerTriggerDigest = "5b1172d4e06a5c750a14128a8eb26a0dbe3c7703a3c01aa1c34e2d514cd13be0";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const quoted = (name: string) => `"${name.replace(/"/gu, '""')}"`;
const authTables = [
  "auth_principal_incarnations",
  "shared_principal_bindings",
  "credential_authority_classes",
  "shared_auth_sessions",
] as const;

type NativeCategory =
  | "NOT_AUTHORIZED"
  | "TRANSACTION"
  | "PRAGMA"
  | "SYNTAX"
  | "NO_TABLE"
  | "NO_COLUMN"
  | "NOTNULL"
  | "FK"
  | "ACK"
  | "OTHER";
const nativeCodes = [
  "SQLITE_CONSTRAINT_NOTNULL",
  "SQLITE_CONSTRAINT_FOREIGNKEY",
  "SQLITE_CONSTRAINT",
  "SQLITE_AUTH",
  "SQLITE_ERROR",
  "SQLITE_MISUSE",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_TOOBIG",
  "SQLITE_RANGE",
  "SQLITE_INTERRUPT",
] as const;

function nativeCategory(message: string): NativeCategory {
  if (/\b(?:not authorized|NOT_AUTHORIZED|SQLITE_AUTH)\b/iu.test(message)) return "NOT_AUTHORIZED";
  if (
    /to execute a transaction|state\.storage\.transaction|cannot (?:start a transaction|commit|rollback)|no transaction is active|within a transaction/iu.test(
      message,
    )
  )
    return "TRANSACTION";
  if (
    /\bPRAGMA\b[^\r\n]{0,96}(?:denied|not allowed|unsupported|forbidden)|(?:denied|not allowed|unsupported|forbidden)[^\r\n]{0,96}\bPRAGMA\b|may assign only defer_foreign_keys/iu.test(
      message,
    )
  )
    return "PRAGMA";
  if (/\bsyntax error\b|\bincomplete input\b|\bunrecognized token\b/iu.test(message))
    return "SYNTAX";
  if (/\bno such table\b/iu.test(message)) return "NO_TABLE";
  if (/\bno such column\b|\bhas no column named\b/iu.test(message)) return "NO_COLUMN";
  if (/\bNOT NULL constraint failed\b/u.test(message)) return "NOTNULL";
  if (/\bFOREIGN KEY constraint failed\b/u.test(message)) return "FK";
  if (
    /^D1 returned (?:a truncated batch result|an? (?:incomplete|invalid) (?:batch|statement|result row) acknowledgement)$/u.test(
      message,
    )
  )
    return "ACK";
  return "OTHER";
}

class OpaqueNativeError extends Error {
  readonly label: string;
  readonly code: "unavailable" | "constraint" | "invalid" | "unclassified";
  readonly nativeCode: (typeof nativeCodes)[number] | "UNKNOWN";
  readonly category: NativeCategory;
  readonly messageSha256: string;
  readonly lateNullFault: boolean;
  readonly foreignKeyFault: boolean;

  constructor(label: string, original: unknown) {
    const nested = original instanceof OpaqueNativeError ? original : undefined;
    const message = nested ? "" : original instanceof Error ? original.message : typeof original;
    const phase = nested?.label ?? label;
    const code = nested?.code ?? (original instanceof SqlError ? original.code : "unclassified");
    const nativeCode =
      nested?.nativeCode ??
      nativeCodes.find((value) => new RegExp(`\\b${value}\\b`, "u").test(message)) ??
      "UNKNOWN";
    const category = nested?.category ?? nativeCategory(message);
    const messageSha256 = nested?.messageSha256 ?? digest(message);
    super(
      `${phase}; code ${code}; native ${nativeCode}; category ${category}; opaque diagnostic ${messageSha256}`,
    );
    this.name = "OpaqueNativeError";
    this.label = phase;
    this.code = code;
    this.nativeCode = nativeCode;
    this.category = category;
    this.messageSha256 = messageSha256;
    // Preserve the existing regression discriminators without retaining or
    // logging original messages, SQL, query, cause, rows or parameters.
    this.lateNullFault =
      nested?.lateNullFault ??
      /NOT NULL constraint failed: shared_auth_attempts\.digest(?=$|[:\r\n])/u.test(message);
    this.foreignKeyFault =
      nested?.foreignKeyFault ?? /FOREIGN KEY constraint failed/u.test(message);
    if (!nested) {
      // Closed diagnostic DATA only. A rewrap neither rehashes nor relabels it.
      console.error(JSON.stringify({ phase, code, nativeCode, category, messageSha256 }));
    }
  }
}

async function opaque<T>(label: string, work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new OpaqueNativeError(label, error);
  }
}

function frames(source: string, label = "Host statement framing"): readonly SqlStatement[] {
  try {
    return frameHostMigrationSql(source).map((sql) => ({ sql }));
  } catch (error) {
    throw new OpaqueNativeError(label, error);
  }
}

function rowDigest(row: unknown): string {
  const encoded = JSON.stringify(row, (_key, value: unknown) => {
    if (value instanceof ArrayBuffer) return { blob: Buffer.from(value).toString("hex") };
    if (ArrayBuffer.isView(value))
      return {
        blob: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex"),
      };
    return value;
  });
  if (encoded === undefined) throw new Error("native application row encoding is incomplete");
  return digest(encoded);
}

async function checkpoint(sql: Sql) {
  const catalog = await sql.query(`SELECT type, name, tbl_name, sql,
    CASE WHEN instr(upper(sql), 'WITHOUT ROWID') > 0 THEN 1 ELSE 0 END AS no_rowid
    FROM main.sqlite_schema WHERE substr(name,1,4) <> '_cf_'
    ORDER BY type, name COLLATE BINARY`);
  const schema = catalog.map((row) => {
    const { type, name, tbl_name: table, sql: body, no_rowid: noRowid } = row;
    if (
      typeof type !== "string" ||
      typeof name !== "string" ||
      typeof table !== "string" ||
      (body !== null && typeof body !== "string") ||
      (noRowid !== 0 && noRowid !== 1)
    )
      throw new Error("native catalog metadata is incomplete");
    return { type, name, table, noRowid, sqlDigest: body === null ? null : digest(body) };
  });
  const rows: Record<string, { count: number; digests: string[] }> = {};
  for (const object of schema) {
    // D1/SQLite platform-owned tables are not application predecessor rows.
    // Every application table, including 101/102, remains in the comparison.
    if (object.type !== "table" || object.name.startsWith("sqlite_")) continue;
    const values = await sql.query(
      `SELECT ${object.noRowid ? "*" : "rowid, *"} FROM ${quoted(object.name)}`,
    );
    rows[object.name] = { count: values.length, digests: values.map(rowDigest).sort() };
  }
  return { schema, rows };
}

async function principalShape(sql: Sql) {
  const indexes = await sql.query(`SELECT name, "unique", origin, partial
    FROM pragma_index_list('principals', 'main') ORDER BY name COLLATE BINARY`);
  const indexed = [];
  for (const index of indexes) {
    if (typeof index.name !== "string") throw new Error("native Principal index metadata missing");
    indexed.push({
      ...index,
      columns: await sql.query(
        "SELECT seqno, cid, name FROM pragma_index_info(?, 'main') ORDER BY seqno",
        [index.name],
      ),
    });
  }
  return { columns: await sql.query("PRAGMA main.table_info('principals')"), indexes: indexed };
}

async function settled(sql: Sql) {
  expect(await sql.query("SELECT count(*) AS count FROM pragma_foreign_key_check")).toEqual([
    { count: 0 },
  ]);
  expect(await sql.query("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
  expect(await sql.query("PRAGMA defer_foreign_keys")).toEqual([{ defer_foreign_keys: 0 }]);
  expect(
    await sql.query("SELECT count(*) AS count FROM sqlite_schema WHERE name LIKE 'auth103_%'"),
  ).toEqual([{ count: 0 }]);
}

async function fixture() {
  let phase = "native database acquisition";
  const id = `full103-conservation-${crypto.randomUUID()}`;
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
  const close = () => opaque("native runtime disposal", () => runtime.dispose());
  try {
    const database = await opaque("native database acquisition", () =>
      runtime.getD1Database("STATE_DB"),
    );
    // Same existing local-issuer fixture's structural D1 type adaptation. This
    // is an actual native primary, not a mock Sql or an origin capability.
    phase = "native primary selection";
    const primary = database.withSession("first-primary") as unknown as D1DatabaseLike;
    const prepare = primary.prepare.bind(primary);
    const batch = primary.batch.bind(primary);
    const batchSizes: number[] = [];
    phase = "native adapter construction";
    const raw = createD1Sql(
      {
        prepare,
        async batch(statements) {
          batchSizes.push(statements.length);
          return batch(statements);
        },
      },
      { acknowledgement: "explicit-d1-result" },
    );
    const sql: Sql = {
      query: (statement, params) => opaque(`${phase}/read`, () => raw.query(statement, params)),
      run: (statement, params) => opaque(`${phase}/write`, () => raw.run(statement, params)),
      batch: (statements) => opaque(`${phase}/batch`, () => raw.batch(statements)),
    };
    phase = "historical prefix metadata";
    const prefix = MIGRATIONS.filter(({ name }) => Number(name.slice(0, 4)) <= 100);
    expect(prefix.length).toBe(100);
    expect(prefix.map(({ name }) => Number(name.slice(0, 4)))).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    // Each actual historical source remains unedited and owns one native
    // atomic batch. Host framing never disables foreign-key enforcement or strips guards.
    for (const [index, migration] of prefix.entries()) {
      // Canonical filename DATA only; an unexpected value is never printed.
      const name = /^\d{4}_[a-z0-9_]{1,128}\.sql$/u.test(migration.name)
        ? migration.name
        : "unclassified-name";
      phase = `historical ${index + 1} ${name}`;
      await sql.batch(frames(migration.sql, `${phase}/frame`));
    }
    phase = "owner101 Container candidate";
    await sql.batch(v2ContainerOwnerMigrationCandidate());
    phase = "owner102 Worker native identity candidate";
    await sql.batch(
      buildUnregisteredV2WorkerNativeIdentityMigrationCandidate().statements.map((text) => ({
        sql: text,
      })),
    );

    // Port the existing SQLite conservation fixture, not a new Auth schema or
    // an invented shared/genuine credential producer. Accounts owns issuance.
    phase = "legacy identity construction";
    const now = new Date("2026-10-16T00:00:00.000Z");
    const audience = "https://principal-preservation.example.test";
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const key = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const identity = resolveIdentity({
      operatorPublicKeyJwk: { kty: "OKP", crv: "Ed25519", x: String(key.x) },
      operatorAudience: audience,
      clock: () => new Date(now),
    }).verifier;
    phase = "legacy Accounts construction";
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
    phase = "legacy signIn";
    const signedIn = await accounts.signIn({
      provider: "google",
      method: "operator-assertion",
      audience,
      assertion: `${payload}.${base64UrlEncode(new Uint8Array(signature))}`,
    });
    phase = "legacy authenticate";
    const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
    if (!actor) throw new Error("legacy native fixture did not authenticate");
    phase = "legacy createOrganization";
    const organization = await accounts.createOrganization({ actor, name: "Preserved owner org" });
    phase = "legacy personal owner reference";
    await sql.run(
      "INSERT INTO personal_organizations (principal_id, org_id, created_at) VALUES (?, ?, ?)",
      [signedIn.principal.id, organization.id, now.toISOString()],
    );
    phase = "legacy createApiKey";
    await accounts.createApiKey({
      actor,
      organizationId: organization.id,
      name: "Preserved key",
      scopes: ["resources:write"],
      expiresInSeconds: 3600,
    });
    // Exact historical-row fixtures from the SQLite conservation test. These
    // provider labels are data, not evidence of upstream/shared sign-in.
    phase = "legacy github provider row";
    await sql.run(
      `INSERT INTO principals
      (rowid, id, provider, provider_subject, email, display_name, created_at)
      VALUES (101, 'old-github', 'github', 'old-subject', 'old@example.test', ?, ?)`,
      ["履歴\nname", "2024-03-01T02:03:04+09:00"],
    );
    phase = "legacy takos-id provider row";
    await sql.run(`INSERT INTO principals
      (rowid, id, provider, provider_subject, email, display_name, created_at)
      VALUES (204, 'old-takos-id', 'takos-id', 'old-upstream', '', '', '2023-01-01')`);

    phase = "legacy settled checks";
    await settled(sql);
    phase = "full103 statement framing";
    const transition = frames(additiveAuthFull103DDL, phase);
    phase = "full103 predecessor ready";
    return {
      sql,
      close,
      batchSizes,
      transition,
      principalId: signedIn.principal.id,
      apply: (tail: readonly SqlStatement[] = []) => {
        phase = "full103 atomic transition";
        return sql.batch([...transition, ...tail]);
      },
    };
  } catch (error) {
    await close();
    throw new OpaqueNativeError(phase, error);
  }
}

test("native full103 single batch preserves predecessor application rows, Principal shape and owner references", async () => {
  const f = await fixture();
  try {
    const before = await checkpoint(f.sql);
    const shape = await principalShape(f.sql);
    const originalOwner = before.schema.find(
      (object) =>
        object.type === "trigger" && object.name === "personal_organizations_owner_insert",
    );
    expect(originalOwner?.sqlDigest).toBe(ownerTriggerDigest);
    expect(
      await f.sql.query(`SELECT count(*) AS principals, count(DISTINCT provider) AS providers,
      sum(CASE WHEN (rowid=101 AND id='old-github') OR (rowid=204 AND id='old-takos-id')
        THEN 1 ELSE 0 END) AS fixed_rowids FROM principals`),
    ).toEqual([{ principals: 3, providers: 3, fixed_rowids: 2 }]);
    const batches = f.batchSizes.length;
    await f.apply();
    expect(f.batchSizes.slice(batches)).toEqual([f.transition.length]);
    const after = await checkpoint(f.sql);
    for (const [name, values] of Object.entries(before.rows))
      expect(after.rows[name]).toEqual(values);
    const predecessorObjects = new Set(before.schema.map(({ type, name }) => `${type}:${name}`));
    expect(
      after.schema.filter(
        (object) =>
          object.table !== "principals" && predecessorObjects.has(`${object.type}:${object.name}`),
      ),
    ).toEqual(before.schema.filter((object) => object.table !== "principals"));
    expect(await principalShape(f.sql)).toEqual(shape);
    expect(
      after.schema.find(
        (object) =>
          object.type === "trigger" && object.name === "personal_organizations_owner_insert",
      )?.sqlDigest,
    ).toBe(ownerTriggerDigest);
    const beforePrincipal = before.schema.find(
      (object) => object.type === "table" && object.name === "principals",
    );
    const afterPrincipal = after.schema.find(
      (object) => object.type === "table" && object.name === "principals",
    );
    expect(afterPrincipal?.sqlDigest).not.toBe(beforePrincipal?.sqlDigest);
    for (const table of authTables) expect(after.rows[table]).toEqual({ count: 0, digests: [] });
    await settled(f.sql);
  } finally {
    await f.close();
  }
}, 60_000);

test("native full103 late NOT NULL fault rolls back the complete schema and every predecessor row", async () => {
  const f = await fixture();
  try {
    const before = await checkpoint(f.sql);
    const batches = f.batchSizes.length;
    // Inspect the actual opaque framed prefix only as a boolean. Even a
    // derived historical trigger must not supply this fault-table INSERT.
    const prefixWritesFaultTable = f.transition.some(({ sql }) =>
      /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:(?:main|"main"|\[main\])\s*\.\s*)?(?:"shared_auth_attempts"|\[shared_auth_attempts\]|shared_auth_attempts)(?=[\s(])/iu.test(
        sql,
      ),
    );
    expect(prefixWritesFaultTable).toBe(false);
    // This table is created only by the full RP tail, which contains no INSERT
    // into it. The restored Principal INSERT cannot emit this column error.
    // The final INSERT emits one NULL only when the positive postshape, full
    // required-object set and retained fixture rows are all present. Otherwise
    // it inserts zero rows: the required rejection then FAILS, never passes.
    // This is an intentional failing attempt row, not an Auth origin/proof.
    const late: SqlStatement = {
      sql: `WITH required(type, name, tbl_name) AS (
        VALUES ('table', 'auth_principal_incarnations', 'auth_principal_incarnations'),
          ('index', 'auth_principal_incarnations_active', 'auth_principal_incarnations'),
          ('table', 'shared_principal_bindings', 'shared_principal_bindings'),
          ('index', 'shared_principal_bindings_identity_active', 'shared_principal_bindings'),
          ('index', 'shared_principal_bindings_principal', 'shared_principal_bindings'),
          ('table', 'credential_authority_classes', 'credential_authority_classes'),
          ('index', 'credential_authority_classes_token_id_active', 'credential_authority_classes'),
          ('index', 'credential_authority_classes_principal', 'credential_authority_classes'),
          ('index', 'credential_authority_classes_binding', 'credential_authority_classes'),
          ('trigger', 'auth_principal_incarnations_no_replace', 'auth_principal_incarnations'),
          ('trigger', 'auth_principal_incarnations_no_delete', 'auth_principal_incarnations'),
          ('trigger', 'auth_principal_incarnations_terminal_only', 'auth_principal_incarnations'),
          ('trigger', 'shared_principal_bindings_no_replace', 'shared_principal_bindings'),
          ('trigger', 'shared_principal_bindings_no_delete', 'shared_principal_bindings'),
          ('trigger', 'shared_principal_bindings_terminal_only', 'shared_principal_bindings'),
          ('trigger', 'credential_authority_classes_no_replace', 'credential_authority_classes'),
          ('trigger', 'credential_authority_classes_no_delete', 'credential_authority_classes'),
          ('trigger', 'credential_authority_classes_terminal_only', 'credential_authority_classes'),
          ('trigger', 'auth_principal_incarnations_initial', 'auth_principal_incarnations'),
          ('trigger', 'shared_principal_bindings_initial', 'shared_principal_bindings'),
          ('trigger', 'credential_authority_classes_initial', 'credential_authority_classes'),
          ('trigger', 'auth_principal_id_no_reuse', 'principals'),
          ('trigger', 'auth_principal_identity_enrolled', 'principals'),
          ('trigger', 'auth_principal_deleted', 'principals'),
          ('trigger', 'auth_principal_retired', 'auth_principal_incarnations'),
          ('trigger', 'auth_binding_retired', 'shared_principal_bindings'),
          ('trigger', 'auth_token_identity_enrolled', 'auth_tokens'),
          ('trigger', 'auth_token_revoked', 'auth_tokens'),
          ('trigger', 'auth_token_deleted', 'auth_tokens'),
          ('table', 'shared_auth_attempts', 'shared_auth_attempts'),
          ('index', 'shared_auth_attempts_expiry', 'shared_auth_attempts'),
          ('trigger', 'shared_auth_attempts_no_replace_before_insert', 'shared_auth_attempts'),
          ('trigger', 'shared_auth_attempts_no_update', 'shared_auth_attempts'),
          ('table', 'shared_auth_sessions', 'shared_auth_sessions'),
          ('index', 'shared_auth_sessions_cleanup', 'shared_auth_sessions'),
          ('trigger', 'shared_auth_sessions_no_reuse_before_insert', 'shared_auth_sessions'),
          ('trigger', 'shared_auth_sessions_update_guard', 'shared_auth_sessions'),
          ('trigger', 'shared_auth_sessions_retire_class_after_status', 'shared_auth_sessions'),
          ('trigger', 'shared_auth_sessions_retire_class_before_delete', 'shared_auth_sessions'),
          ('table', 'shared_auth_revocations', 'shared_auth_revocations'),
          ('index', 'shared_auth_revocations_due', 'shared_auth_revocations'),
          ('index', 'shared_auth_revocations_session', 'shared_auth_revocations'),
          ('trigger', 'shared_auth_revocations_no_replace_before_insert', 'shared_auth_revocations'),
          ('trigger', 'shared_auth_revocations_update_guard', 'shared_auth_revocations'),
          ('trigger', 'personal_organizations_owner_insert', 'personal_organizations')
      ), retained(principal_id) AS (VALUES (?))
      INSERT INTO shared_auth_attempts (digest, payload, created_at, expires_at)
      SELECT NULL, 'structural-native-late-fault', 0, 1
      WHERE NOT EXISTS (
        SELECT 1 FROM required e WHERE NOT EXISTS (
          SELECT 1 FROM main.sqlite_schema s
          WHERE s.type=e.type AND s.name=e.name AND s.tbl_name=e.tbl_name))
        AND (SELECT count(*) FROM pragma_table_info('shared_auth_attempts', 'main'))=4
        AND (SELECT count(*) FROM pragma_table_info('shared_auth_attempts', 'main')
          WHERE name='digest' AND type='TEXT' AND "notnull"=1 AND pk=1)=1
        AND (SELECT count(*) FROM pragma_table_info('principals', 'main'))=6
        AND (SELECT count(*) FROM pragma_table_info('principals', 'main')
          WHERE name IN ('id','provider','provider_subject','email','display_name','created_at')
            AND type='TEXT' AND "notnull"=1)=6
        AND (SELECT count(*) FROM main.sqlite_schema WHERE type='table' AND name='principals'
          AND instr(sql, 'CHECK (provider IN (''takos-id'', ''google'', ''github'', ''shared-account''))')>0)=1
        AND (SELECT count(*) FROM principals)=3
        AND EXISTS (SELECT 1 FROM principals p JOIN retained r ON p.id=r.principal_id
          WHERE p.provider='google' AND p.provider_subject='preserved-owner'
            AND p.email='preserved-owner@example.test' AND p.display_name='既存 Owner'
            AND p.created_at='2026-10-16T00:00:00.000Z')
        AND EXISTS (SELECT 1 FROM principals WHERE rowid=101 AND id='old-github'
          AND provider='github' AND provider_subject='old-subject' AND email='old@example.test'
          AND display_name=? AND created_at='2024-03-01T02:03:04+09:00')
        AND EXISTS (SELECT 1 FROM principals WHERE rowid=204 AND id='old-takos-id'
          AND provider='takos-id' AND provider_subject='old-upstream' AND email=''
          AND display_name='' AND created_at='2023-01-01')
        AND EXISTS (SELECT 1 FROM retained r JOIN orgs o ON o.owner_principal_id=r.principal_id
          JOIN personal_organizations p ON p.org_id=o.id AND p.principal_id=r.principal_id
          JOIN org_memberships m ON m.org_id=o.id AND m.principal_id=r.principal_id
          WHERE m.role='owner')
        AND EXISTS (SELECT 1 FROM auth_tokens t JOIN retained r ON t.principal_id=r.principal_id
          WHERE t.kind='session')
        AND EXISTS (SELECT 1 FROM auth_tokens t JOIN retained r ON t.principal_id=r.principal_id
          WHERE t.kind='api_key')
        AND NOT EXISTS (
          SELECT 1 FROM auth_principal_incarnations UNION ALL
          SELECT 1 FROM shared_principal_bindings UNION ALL
          SELECT 1 FROM credential_authority_classes ) AND NOT EXISTS (
          SELECT 1 FROM shared_auth_attempts UNION ALL
          SELECT 1 FROM shared_auth_sessions UNION ALL
          SELECT 1 FROM shared_auth_revocations)
        AND NOT EXISTS (SELECT 1 FROM main.sqlite_schema WHERE name LIKE 'auth103_%')
        AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)`,
      params: [f.principalId, "履歴\nname"],
    };
    await expect(f.apply([late])).rejects.toMatchObject({
      code: "constraint",
      lateNullFault: true,
    });
    // Submitted batch size is a transport-shape check, not reachability proof.
    // Reachability is the new-table error gated by all SQL postconditions above.
    expect(f.batchSizes.slice(batches)).toEqual([f.transition.length + 1]);
    expect(await checkpoint(f.sql)).toEqual(before);
    await settled(f.sql);
  } finally {
    await f.close();
  }
}, 60_000);

test("native full103 keeps the legacy owner foreign key enforced after the atomic transition", async () => {
  const f = await fixture();
  try {
    await f.apply();
    const before = await checkpoint(f.sql);
    await expect(
      f.sql.run("DELETE FROM principals WHERE id = ?", [f.principalId]),
    ).rejects.toMatchObject({ code: "constraint", foreignKeyFault: true });
    expect(await checkpoint(f.sql)).toEqual(before);
    await settled(f.sql);
  } finally {
    await f.close();
  }
}, 60_000);
