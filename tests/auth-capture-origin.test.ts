import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  AuthError,
  assertAuthTokenCaptureReader,
  createAccounts,
  type ExternalIdentityVerifier,
} from "../src/auth.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { bytesDigest } from "../src/json.ts";
import {
  assertMoneyCutoverSqlOrigin,
  createMoneyCutoverSql,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
  moneyCutoverFinancialTriggerSql,
} from "../src/money-cutover-sql.ts";
import { type Sql, SqlError } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

// Real local SQLite observations; no verified person, class, target or payer.
const opened = new Set<Database>();
afterEach(() => {
  for (const database of opened) database.close();
  opened.clear();
});
const now = Date.UTC(2026, 9, 15, 12);
const epoch = `sha256:${"a".repeat(64)}`;
const otherEpoch = `sha256:${"b".repeat(64)}`;
const identity: ExternalIdentityVerifier = {
  async verify() {
    throw new Error("Identity verification is outside this storage-origin fixture");
  },
};

function openSql() {
  const database = new Database(":memory:");
  opened.add(database);
  return { database, sql: createSqliteSql(database) };
}

async function accountsFixture() {
  const { database, sql } = openSql();
  for (const migration of MIGRATIONS) database.exec(migration.sql);
  const secret = "synthetic-local-token-origin-test";
  const digest = await bytesDigest(new TextEncoder().encode(secret));
  await sql.run(
    `INSERT INTO principals (id, provider, provider_subject, email, display_name, created_at)
     VALUES ('p_origin', 'google', 'synthetic-origin-subject', 'origin@example.test', 'Origin', ?)`,
    [new Date(now).toISOString()],
  );
  await sql.run(
    `INSERT INTO auth_tokens
       (secret_digest, id, kind, principal_id, org_id, name, scopes_json, created_at, expires_at)
     VALUES (?, 'ses_origin', 'session', 'p_origin', NULL, 'session', '[]', ?, ?)`,
    [digest, new Date(now).toISOString(), new Date(now + 60_000).toISOString()],
  );
  const accounts = createAccounts({ sql, identity, clock: () => new Date(now) });
  return { database, sql, accounts, authorization: `Bearer ${secret}`, digest };
}

function ownDescriptor(value: object, name: string): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor) throw new Error(`Fixture expected own property: ${name}`);
  return descriptor;
}

describe("Accounts capture reader origin", () => {
  test("checks the actual factory and Sql while preserving the real token observation", async () => {
    const { sql, accounts, authorization, digest } = await accountsFixture();
    const before = await sql.query("SELECT total_changes() AS count");
    expect(() => assertAuthTokenCaptureReader(accounts, { sql })).not.toThrow();
    const capture = await accounts.captureAuthenticatedToken(authorization);
    expect(accounts.inspectAuthenticatedTokenCapture(capture)).toEqual({
      tokenId: "ses_origin",
      digest,
      kind: "session",
      principalId: "p_origin",
      organizationId: null,
      scopesJson: "[]",
      scopes: [],
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    expect(await accounts.authenticate(authorization)).toEqual({
      hostPrincipalId: "p_origin",
      principalId: "p_origin",
      kind: "session",
      scopes: [],
    });
    expect(await sql.query("SELECT total_changes() AS count")).toEqual(before);
    expect(
      await sql.query(
        `SELECT name FROM sqlite_schema WHERE name IN
         ('credential_authority_classes', 'auth_principal_incarnations', 'shared_principal_bindings')`,
      ),
    ).toEqual([]);
  });

  test("rejects copied, inherited, proxied and self-asserting ports without invoking them", async () => {
    const { sql, accounts } = await accountsFixture();
    let calls = 0;
    const alleged = {
      ...accounts,
      assertOrigin() {
        calls++;
        return true;
      },
    };
    const inherited: unknown = Object.create(accounts);
    const serialized: unknown = JSON.parse(JSON.stringify(accounts));
    for (const reader of [alleged, inherited, serialized, new Proxy(accounts, {}), null]) {
      expect(() => assertAuthTokenCaptureReader(reader, { sql })).toThrow(AuthError);
    }
    expect(calls).toBe(0);
  });

  test("does not read getters on an unknown reader", async () => {
    const { sql } = await accountsFixture();
    let calls = 0;
    const alleged = {
      get captureAuthenticatedToken() {
        calls++;
        throw new Error("Untrusted capture getter invoked");
      },
      get inspectAuthenticatedTokenCapture() {
        calls++;
        throw new Error("Untrusted inspection getter invoked");
      },
    };
    expect(() => assertAuthTokenCaptureReader(alleged, { sql })).toThrow(AuthError);
    expect(calls).toBe(0);
  });

  test("refuses either overwritten original method and accepts exact restoration", async () => {
    const { sql, accounts } = await accountsFixture();
    let calls = 0;
    for (const name of ["captureAuthenticatedToken", "inspectAuthenticatedTokenCapture"]) {
      const original = ownDescriptor(accounts, name);
      Object.defineProperty(accounts, name, {
        configurable: true,
        value() {
          calls++;
          return null;
        },
      });
      expect(() => assertAuthTokenCaptureReader(accounts, { sql })).toThrow(AuthError);
      Object.defineProperty(accounts, name, original);
      expect(() => assertAuthTokenCaptureReader(accounts, { sql })).not.toThrow();
    }
    expect(calls).toBe(0);
  });

  test("refuses accessor replacements on the actual reader without running them", async () => {
    const { sql, accounts } = await accountsFixture();
    let calls = 0;
    for (const name of ["captureAuthenticatedToken", "inspectAuthenticatedTokenCapture"]) {
      const original = ownDescriptor(accounts, name);
      Object.defineProperty(accounts, name, {
        configurable: true,
        get() {
          calls++;
          throw new Error("Replaced capture getter invoked");
        },
      });
      expect(() => assertAuthTokenCaptureReader(accounts, { sql })).toThrow(AuthError);
      Object.defineProperty(accounts, name, original);
    }
    expect(calls).toBe(0);
  });

  test("requires the exact Sql object and never invokes a context getter", async () => {
    const { database, sql, accounts } = await accountsFixture();
    expect(() =>
      assertAuthTokenCaptureReader(accounts, { sql: createSqliteSql(database) }),
    ).toThrow(AuthError);
    expect(() => assertAuthTokenCaptureReader(accounts, { sql: openSql().sql })).toThrow(AuthError);
    let calls = 0;
    const context = {
      get sql(): Sql {
        calls++;
        return sql;
      },
    };
    expect(() => assertAuthTokenCaptureReader(accounts, context)).toThrow(AuthError);
    expect(calls).toBe(0);
  });

  test("keeps captures factory-private even when two genuine factories use the same Sql", async () => {
    const { sql, accounts, authorization } = await accountsFixture();
    const other = createAccounts({ sql, identity, clock: () => new Date(now) });
    expect(() => assertAuthTokenCaptureReader(other, { sql })).not.toThrow();
    const capture = await accounts.captureAuthenticatedToken(authorization);
    expect(other.inspectAuthenticatedTokenCapture(capture)).toBeNull();
    expect(accounts.inspectAuthenticatedTokenCapture(capture)?.tokenId).toBe("ses_origin");
  });

  test("origin survives revocation as history and grants no current token use", async () => {
    const { sql, accounts, authorization } = await accountsFixture();
    const capture = await accounts.captureAuthenticatedToken(authorization);
    await accounts.revokeSession(authorization);
    expect(() => assertAuthTokenCaptureReader(accounts, { sql })).not.toThrow();
    expect(accounts.inspectAuthenticatedTokenCapture(capture)?.tokenId).toBe("ses_origin");
    expect(await accounts.captureAuthenticatedToken(authorization)).toBeNull();
    expect(await accounts.authenticate(authorization)).toBeNull();
    expect(Object.hasOwn(accounts, "readValidatedCredential")).toBe(false);
    expect(Object.hasOwn(accounts, "readValidatedPrincipalBinding")).toBe(false);
  });
});

describe("Money Sql wrapper origin", () => {
  test("checks the genuine wrapper without writes or exposing its underlying Sql", async () => {
    const { sql } = openSql();
    const wrapped = createMoneyCutoverSql(sql, epoch);
    const before = await sql.query("SELECT total_changes() AS count");
    expect(() => assertMoneyCutoverSqlOrigin(wrapped, { writerEpoch: epoch })).not.toThrow();
    expect(await wrapped.query("SELECT 7 AS value")).toEqual([{ value: 7 }]);
    expect(await sql.query("SELECT total_changes() AS count")).toEqual(before);
    expect(Object.keys(wrapped).sort()).toEqual(["batch", "query", "run"]);
    expect(Object.hasOwn(wrapped, "raw")).toBe(false);
  });

  test("rejects raw Sql, copied methods, an inherited wrapper and proxy", () => {
    const { sql } = openSql();
    const wrapped = createMoneyCutoverSql(sql, epoch);
    const inherited: unknown = Object.create(wrapped);
    for (const candidate of [sql, { ...wrapped }, inherited, new Proxy(wrapped, {}), null]) {
      expect(() => assertMoneyCutoverSqlOrigin(candidate, { writerEpoch: epoch })).toThrow(
        SqlError,
      );
    }
  });

  test("does not invoke fake wrapper getters or its self-assertion", () => {
    let calls = 0;
    const alleged = {
      get query() {
        calls++;
        throw new Error("Untrusted query getter invoked");
      },
      assertOrigin() {
        calls++;
        return true;
      },
    };
    expect(() => assertMoneyCutoverSqlOrigin(alleged, { writerEpoch: epoch })).toThrow(SqlError);
    expect(calls).toBe(0);
  });

  test("refuses each replaced original method without calling it", () => {
    const { sql } = openSql();
    const wrapped = createMoneyCutoverSql(sql, epoch);
    let calls = 0;
    for (const name of ["query", "run", "batch"]) {
      const original = ownDescriptor(wrapped, name);
      Object.defineProperty(wrapped, name, {
        configurable: true,
        value() {
          calls++;
          throw new Error("Replaced wrapper method invoked");
        },
      });
      expect(() => assertMoneyCutoverSqlOrigin(wrapped, { writerEpoch: epoch })).toThrow(SqlError);
      Object.defineProperty(wrapped, name, original);
      expect(() => assertMoneyCutoverSqlOrigin(wrapped, { writerEpoch: epoch })).not.toThrow();
    }
    expect(calls).toBe(0);
  });

  test("refuses actual wrapper accessor replacements without running them", () => {
    const { sql } = openSql();
    const wrapped = createMoneyCutoverSql(sql, epoch);
    let calls = 0;
    for (const name of ["query", "run", "batch"]) {
      const original = ownDescriptor(wrapped, name);
      Object.defineProperty(wrapped, name, {
        configurable: true,
        get() {
          calls++;
          throw new Error("Replaced wrapper getter invoked");
        },
      });
      expect(() => assertMoneyCutoverSqlOrigin(wrapped, { writerEpoch: epoch })).toThrow(SqlError);
      Object.defineProperty(wrapped, name, original);
    }
    expect(calls).toBe(0);
  });

  test("requires the exact primitive epoch rather than another valid or malformed epoch", () => {
    const { sql } = openSql();
    const wrapped = createMoneyCutoverSql(sql, epoch);
    for (const writerEpoch of [otherEpoch, "", "usd-micros-v2", `${epoch} `]) {
      expect(() => assertMoneyCutoverSqlOrigin(wrapped, { writerEpoch })).toThrow(SqlError);
    }
  });

  test("does not run a context epoch getter", () => {
    const { sql } = openSql();
    const wrapped = createMoneyCutoverSql(sql, epoch);
    let calls = 0;
    const context = {
      get writerEpoch(): string {
        calls++;
        return epoch;
      },
    };
    expect(() => assertMoneyCutoverSqlOrigin(wrapped, context)).toThrow(SqlError);
    expect(calls).toBe(0);
  });

  test("distinct genuine wrappers on one raw backend are not the Accounts backend identity", async () => {
    const { sql, authorization } = await accountsFixture();
    const first = createMoneyCutoverSql(sql, epoch);
    const second = createMoneyCutoverSql(sql, epoch);
    const accounts = createAccounts({ sql: first, identity, clock: () => new Date(now) });
    expect(() => assertMoneyCutoverSqlOrigin(first, { writerEpoch: epoch })).not.toThrow();
    expect(() => assertMoneyCutoverSqlOrigin(second, { writerEpoch: epoch })).not.toThrow();
    expect(() => assertAuthTokenCaptureReader(accounts, { sql: first })).not.toThrow();
    expect(() => assertAuthTokenCaptureReader(accounts, { sql: second })).toThrow(AuthError);
    const capture = await accounts.captureAuthenticatedToken(authorization);
    expect(accounts.inspectAuthenticatedTokenCapture(capture)?.tokenId).toBe("ses_origin");
  });

  test("origin does not override actual freeze or later writer-epoch revocation", async () => {
    const { database, sql } = openSql();
    // Synthetic empty guard fixture, not an installed Financial schema/capability.
    database.exec(MONEY_CUTOVER_FREEZE_DDL);
    database.exec(MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL);
    database.exec(MONEY_CUTOVER_PERMIT_DDL);
    database.exec(MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL);
    database.exec("CREATE TABLE ledger (id TEXT PRIMARY KEY NOT NULL)");
    database.exec(moneyCutoverFinancialTriggerSql("ledger", "INSERT"));
    await sql.run("INSERT INTO money_cutover_authorized_epoch VALUES (1, ?)", [epoch]);
    const wrapped = createMoneyCutoverSql(sql, epoch);
    expect((await wrapped.run("INSERT INTO ledger VALUES ('original')")).changes).toBe(1);
    await sql.run("INSERT INTO money_cutover_freeze VALUES (1, ?, ?, ?, ?, ?)", [
      epoch,
      epoch,
      epoch,
      epoch,
      epoch,
    ]);
    expect(() => assertMoneyCutoverSqlOrigin(wrapped, { writerEpoch: epoch })).not.toThrow();
    await expect(wrapped.run("INSERT INTO ledger VALUES ('frozen')")).rejects.toMatchObject({
      code: "constraint",
    });
    expect(await sql.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
    await sql.run("DELETE FROM money_cutover_freeze");
    await sql.run("UPDATE money_cutover_authorized_epoch SET writer_epoch = ?", [otherEpoch]);
    expect(() => assertMoneyCutoverSqlOrigin(wrapped, { writerEpoch: epoch })).not.toThrow();
    await expect(wrapped.run("INSERT INTO ledger VALUES ('revoked')")).rejects.toMatchObject({
      code: "constraint",
    });
    expect(await sql.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
    expect(await sql.query("SELECT id FROM ledger")).toEqual([{ id: "original" }]);
  });
});
