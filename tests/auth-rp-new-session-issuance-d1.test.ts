import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { additiveAuthFullRpDDL } from "../src/auth-authority-schema-plan.ts";
import {
  type CredentialAuthorityOrigin,
  createCredentialAuthorityClassStore,
  type RpAuthorityIdentity,
} from "../src/credential-authority-class.ts";
import {
  createMoneyCutoverSql,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../src/money-cutover-sql.ts";
import type { Row, SqlParam, SqlStatement, SqlWrite } from "../src/ports.ts";
import {
  createSharedAuthSessionStore,
  type OidcSessionRecord,
} from "../src/shared-auth-session-store.ts";
import { createSharedPrincipalAuthorityStore } from "../src/shared-principal-authority.ts";
import {
  createD1Sql,
  type D1DatabaseLike,
  type D1ResultLike,
  type D1StatementLike,
} from "../src/sql-d1.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";

// SQL mechanics only. createFresh receives synthetic DATA, not enrollment,
// a genuine RP verifier/issuer, human binding, callback/cookie or NEW authority.
const base = readFileSync(
  new URL("./fixtures/auth-authority-candidate-schema.sql", import.meta.url),
  "utf8",
);
const WRITER = `sha256:${"c".repeat(64)}`;
const modes = ["raw", "money"] as const;
type Mode = (typeof modes)[number];
interface NativeBatch {
  readonly sql: readonly string[];
  readonly params: readonly (readonly SqlParam[])[];
  results: readonly D1ResultLike[] | null;
  rejected: boolean;
}

async function fixture(mode: Mode) {
  const id = `rp-pair-d1-${crypto.randomUUID()}`;
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
          env: { AUTH_DB: { type: "d1", id } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("AUTH_DB");
    const primary = database.withSession("first-primary");
    const batches: NativeBatch[] = [];
    // Maps only actual native prepared statements, never an authority capture.
    const originals = new WeakMap<
      D1StatementLike,
      {
        readonly native: ReturnType<typeof primary.prepare>;
        readonly sql: string;
        readonly params: readonly SqlParam[];
      }
    >();
    function forward(
      native: ReturnType<typeof primary.prepare>,
      sql: string,
      params: readonly SqlParam[] = [],
    ): D1StatementLike {
      const statement: D1StatementLike = {
        bind(...values) {
          return forward(native.bind(...values), sql, [...values]);
        },
        all: () => native.all<Row>(),
      };
      originals.set(statement, { native, sql, params });
      return statement;
    }
    const observed: D1DatabaseLike = {
      prepare: (sql) => forward(primary.prepare(sql), sql),
      async batch(statements) {
        const selected = statements.map((statement) => {
          const original = originals.get(statement);
          if (!original) throw new Error("native pair batch crossed primary sessions");
          return original;
        });
        const entry: NativeBatch = {
          sql: selected.map((item) => item.sql),
          params: selected.map((item) => [...item.params]),
          results: null,
          rejected: false,
        };
        batches.push(entry);
        try {
          const result = await primary.batch<Row>(selected.map((item) => item.native));
          entry.results = structuredClone(result);
          return result;
        } catch (error) {
          entry.rejected = true;
          throw error;
        }
      },
    };
    const raw = createD1Sql(observed, { acknowledgement: "explicit-d1-result" });
    for (const statement of frameHostMigrationSql(base)) await raw.run(statement);
    // Replace only the owning synthetic fixture's minimal RP table with the
    // actual full RP candidate. The fixture source and registry stay untouched.
    await raw.run("DROP TABLE shared_auth_sessions");
    for (const source of [
      additiveAuthFullRpDDL,
      MONEY_CUTOVER_FREEZE_DDL,
      MONEY_CUTOVER_PERMIT_DDL,
      MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
      MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
      "CREATE TABLE test_pair_marks (id INTEGER PRIMARY KEY NOT NULL, label TEXT NOT NULL)",
      "CREATE TABLE test_pair_audit (id INTEGER PRIMARY KEY, digest TEXT NOT NULL)",
    ])
      for (const statement of frameHostMigrationSql(source)) await raw.run(statement);
    await raw.run("INSERT INTO money_cutover_authorized_epoch VALUES (1, ?)", [WRITER]);
    const sql = mode === "money" ? createMoneyCutoverSql(raw, WRITER) : raw;
    const now = Date.now() - 1000;
    const at = new Date(now).toISOString();
    const binding = await createSharedPrincipalAuthorityStore({ sql }).createFresh({
      principalId: "synthetic:rp-principal",
      principalIncarnation: "synthetic:rp-principal-incarnation",
      createdAt: at,
      origin: { ref: "synthetic:principal-origin", digest: `sha256:${"a".repeat(64)}` },
      binding: {
        ref: "synthetic:principal-binding",
        issuer: "https://synthetic-rp.example.test",
        subject: "synthetic:shared-account",
        controllerIncarnation: "synthetic:controller",
        targetRef: "synthetic:unqualified-target",
        evidence: { ref: "synthetic:binding-data", digest: `sha256:${"b".repeat(64)}` },
        enrolledAt: at,
      },
    });
    const record: OidcSessionRecord = {
      digest: `sha256:${"e".repeat(64)}`,
      accountId: binding.subject,
      principalId: binding.principalId,
      workspaceId: "synthetic:workspace",
      payload: "synthetic-unverified-encrypted-grant",
      createdAt: now,
      lastUsedAt: now,
      absoluteExpiresAt: now + 3_600_000,
      grantCheckedAt: now,
      version: 0,
      status: "active",
    };
    const classes = createCredentialAuthorityClassStore({ sql });
    const identity: RpAuthorityIdentity = {
      principalBindingRef: binding.ref,
      registrationRef: "synthetic:unqualified-rp-registration",
      registrationDigest: `sha256:${"d".repeat(64)}`,
      sessionDigest: `sha256:${"e".repeat(64)}`,
      sessionCreatedAt: record.createdAt,
      enrolledSessionVersion: 0,
      issuer: binding.issuer,
      clientId: "synthetic:rp-client",
      subject: binding.subject,
      issuerSessionId: "synthetic:issuer-session",
      authTime: Math.floor(now / 1000),
      accountId: record.accountId,
      workspaceId: record.workspaceId,
      workspaceRef: "synthetic:workspace-ref",
    };
    function build(suffix = "new", targetRef = binding.targetRef) {
      const origin: CredentialAuthorityOrigin = {
        ref: `synthetic:rp-authority:${suffix}`,
        incarnation: `synthetic:rp-credential:${suffix}`,
        targetRef,
        principalId: binding.principalId,
        principalIncarnation: binding.principalIncarnation,
        issuanceRef: `synthetic:rp-issuance:${suffix}`,
        issuanceDigest: `sha256:${"f".repeat(64)}`,
        issuedAt: at,
      };
      return {
        origin,
        pair: classes.sharedRpNewSessionIssuanceStatements(
          origin,
          identity,
          "synthetic:organization",
          record,
        ),
      };
    }
    async function state() {
      const rows: Record<string, readonly Row[]> = {};
      for (const table of [
        "principals",
        "auth_principal_incarnations",
        "shared_principal_bindings",
        "auth_tokens",
        "credential_authority_classes",
        "shared_auth_attempts",
        "shared_auth_sessions",
        "shared_auth_revocations",
        "test_pair_marks",
        "test_pair_audit",
        "money_cutover_freeze",
        "money_cutover_writer_permit",
        "money_cutover_authorized_epoch",
      ])
        rows[table] = await raw.query(`SELECT * FROM ${table} ORDER BY rowid`);
      return {
        rows,
        schema: await raw.query(
          "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
        ),
      };
    }
    batches.length = 0;
    return {
      mode,
      runtime,
      raw,
      sql,
      batches,
      classes,
      record,
      identity,
      build,
      state,
      sessions: createSharedAuthSessionStore(sql),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const mark = (id: number): SqlStatement => ({
  sql: "INSERT INTO test_pair_marks(id,label) VALUES (?,?)",
  params: [id, `synthetic:mark:${id}`],
});
const changes: SqlStatement = { sql: "SELECT changes() AS actual_changes" };

function assertAdjacent(f: Fixture, pair: readonly SqlStatement[], preceding = 0) {
  const native = f.batches.at(-1);
  if (!native) throw new Error("missing actual native pair batch");
  const offset = f.mode === "money" ? 1 : 0;
  expect(native.sql).toHaveLength(2 + preceding + offset * 2);
  expect(native.sql.slice(offset + preceding, offset + preceding + 2)).toEqual(
    pair.map((statement) => statement.sql),
  );
  expect(native.params.slice(offset + preceding, offset + preceding + 2)).toEqual(
    pair.map((statement) => statement.params ?? []),
  );
  expect(
    native.sql.filter((sql) => sql.startsWith("INSERT INTO money_cutover_writer_permit")),
  ).toHaveLength(offset);
  expect(
    native.sql.filter((sql) => sql.startsWith("DELETE FROM money_cutover_writer_permit")),
  ).toHaveLength(offset);
  if (offset) {
    expect(native.sql[0]?.startsWith("INSERT INTO money_cutover_writer_permit")).toBe(true);
    expect(native.sql.at(-1)?.startsWith("DELETE FROM money_cutover_writer_permit")).toBe(true);
  }
  return native;
}

async function assertPostimages(f: Fixture, result: readonly SqlWrite[]) {
  expect(result).toHaveLength(2);
  expect(result[0]?.rows).toEqual([
    {
      digest: f.record.digest,
      account_id: f.record.accountId,
      principal_id: f.record.principalId,
      workspace_id: f.record.workspaceId,
      payload: f.record.payload,
      created_at: f.record.createdAt,
      last_used_at: f.record.lastUsedAt,
      absolute_expires_at: f.record.absoluteExpiresAt,
      grant_checked_at: f.record.grantCheckedAt,
      version: 0,
      status: "active",
    },
  ]);
  expect(result[0]?.rows).toEqual(await f.raw.query("SELECT * FROM shared_auth_sessions"));
  expect(result[1]?.rows).toHaveLength(1);
  expect(result[1]?.rows).toEqual(await f.raw.query("SELECT * FROM credential_authority_classes"));
  const native = f.batches.at(-1);
  const offset = f.mode === "money" ? 1 : 0;
  expect(native?.results?.slice(offset, offset + 2).map((item) => item.meta?.changes)).toEqual(
    result.map((item) => item.changes),
  );
}

function report(f: Fixture, label: string) {
  console.info(
    "ROOT_RP_PAIR_NATIVE",
    JSON.stringify({
      mode: f.mode,
      label,
      batches: f.batches.map((batch) => ({
        statements: batch.sql.length,
        rejected: batch.rejected,
        packets:
          batch.results?.map((result) => ({
            success: result.success,
            meta: result.meta,
            returnedRows: result.results?.length,
          })) ?? null,
      })),
    }),
  );
}

async function run(mode: Mode, body: (f: Fixture) => Promise<void>) {
  const f = await fixture(mode);
  try {
    await body(f);
  } catch (error) {
    report(f, "failed-case");
    throw error;
  } finally {
    await f.runtime.dispose();
  }
}

for (const mode of modes) {
  test(
    `${mode} native NEW pair returns both exact postimages and actual acknowledgements`,
    () =>
      run(mode, async (f) => {
        const { origin, pair } = f.build();
        expect(Object.isFrozen(pair)).toBe(true);
        for (const statement of pair) {
          expect(Object.isFrozen(statement)).toBe(true);
          expect(Object.isFrozen(statement.params)).toBe(true);
        }
        const result = await f.sql.batch(pair);
        expect(result.map((item) => item.changes)).toEqual([1, 1]);
        const native = assertAdjacent(f, pair);
        expect(native.rejected).toBe(false);
        await assertPostimages(f, result);
        expect(await f.classes.readRetained(origin.ref)).toEqual({
          origin,
          class: "official-shared-rp-session",
          backend: "shared-rp-session",
          organizationId: "synthetic:organization",
          rp: f.identity,
          state: "active",
          terminal: null,
        });
        report(f, "positive");
      }),
    30_000,
  );

  test(
    `${mode} native identical old session IGNORE zero defeats preceding changes one`,
    () =>
      run(mode, async (f) => {
        const { pair } = f.build();
        expect(await f.sessions.createSession(f.record)).toBe(true);
        const control = await f.sql.batch([mark(1), pair[0], changes]);
        expect(control[0]?.changes).toBe(1);
        expect(control[1]).toEqual({ changes: 0, rows: [] });
        expect(control[2]?.rows).toEqual([{ actual_changes: 0 }]);
        const before = await f.state();
        await expect(f.sql.batch([mark(2), ...pair])).rejects.toMatchObject({ code: "constraint" });
        expect(assertAdjacent(f, pair, 1).rejected).toBe(true);
        expect(await f.state()).toEqual(before);
        expect(await f.classes.readRetained(f.build().origin.ref)).toBeNull();
        report(f, "ignored-existing");
      }),
    30_000,
  );

  test(
    `${mode} native deleted session retained class forbids reuse and rolls back`,
    () =>
      run(mode, async (f) => {
        const first = f.build();
        await f.sql.batch(first.pair);
        await f.sql.run("DELETE FROM shared_auth_sessions WHERE digest=?", [f.record.digest]);
        expect(await f.sessions.readSession(f.record.digest)).toBeNull();
        expect(await f.classes.readRetained(first.origin.ref)).toMatchObject({ state: "retired" });
        const next = f.build("reuse");
        const control = await f.sql.batch([mark(1), next.pair[0], changes]);
        expect(control[0]?.changes).toBe(1);
        expect(control[1]).toEqual({ changes: 0, rows: [] });
        expect(control[2]?.rows).toEqual([{ actual_changes: 0 }]);
        const before = await f.state();
        await expect(f.sql.batch([mark(2), ...next.pair])).rejects.toMatchObject({
          code: "constraint",
        });
        expect(assertAdjacent(f, next.pair, 1).rejected).toBe(true);
        expect(await f.state()).toEqual(before);
        expect(await f.classes.readRetained(next.origin.ref)).toBeNull();
        report(f, "retained-reuse");
      }),
    30_000,
  );

  test(
    `${mode} native false class guard aborts the actual session and prior DML`,
    () =>
      run(mode, async (f) => {
        const { pair } = f.build("foreign", "synthetic:foreign-target");
        const before = await f.state();
        await expect(f.sql.batch([mark(1), ...pair])).rejects.toMatchObject({ code: "constraint" });
        expect(assertAdjacent(f, pair, 1).rejected).toBe(true);
        expect(await f.state()).toEqual(before);
        report(f, "guard-false");
      }),
    30_000,
  );

  test(
    `${mode} native first payload wire fault is refused by exact full-row guard`,
    () =>
      run(mode, async (f) => {
        const { pair } = f.build();
        expect(pair[0].params?.[4]).toBe(f.record.payload);
        const damaged: SqlStatement = {
          sql: pair[0].sql,
          params: (pair[0].params ?? []).map((value, index) =>
            index === 4 ? "synthetic:payload-fault" : value,
          ),
        };
        const control = await f.sql.batch([damaged]);
        expect(control[0]?.changes).toBe(1);
        expect(control[0]?.rows[0]?.payload).toBe("synthetic:payload-fault");
        await f.sql.run("DELETE FROM shared_auth_sessions WHERE digest=?", [f.record.digest]);
        const before = await f.state();
        await expect(f.sql.batch([mark(1), damaged, pair[1]])).rejects.toMatchObject({
          code: "constraint",
        });
        expect(assertAdjacent(f, [damaged, pair[1]], 1).rejected).toBe(true);
        expect(await f.state()).toEqual(before);
        expect(pair[0].params?.[4]).toBe(f.record.payload);
        report(f, "payload-fault");
      }),
    30_000,
  );

  test(
    `${mode} native trigger fanout preserves raw metadata and exact postimages`,
    () =>
      run(mode, async (f) => {
        await f.raw.run(`CREATE TRIGGER test_pair_session_audit AFTER INSERT ON shared_auth_sessions
      BEGIN INSERT INTO test_pair_audit(digest) VALUES(NEW.digest); END`);
        const { pair } = f.build();
        const result = await f.sql.batch(pair);
        expect(assertAdjacent(f, pair).rejected).toBe(false);
        await assertPostimages(f, result);
        expect(await f.raw.query("SELECT digest FROM test_pair_audit")).toEqual([
          { digest: f.record.digest },
        ]);
        report(f, "trigger-fanout");
      }),
    30_000,
  );
}
