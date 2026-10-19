import { afterEach, expect, test } from "bun:test";
import { moneyFenceInstallSql } from "../scripts/deploy/schema-money-unit-cutover.ts";
import {
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../src/money-cutover-sql.ts";
import type { SqlParam, SqlStatement } from "../src/ports.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "../src/shared-auth-oidc-client.ts";
import type { D1StatementLike } from "../src/sql-d1.ts";
import { createWorkerRequestSql } from "../src/worker-request-composition.ts";
import {
  captureWorkerRequestRetainedDirectKey,
  issueWorkerRequestDirectOwnerKey,
  readWorkerRequestRetainedDirectKeyCapture,
} from "../src/worker-request-direct-owner-key.ts";
import { createHostedBillingRealmTestDatabase } from "./helpers/hosted-billing-realm-fixture.ts";

const selected = {
  organizationId: "org-selected",
  name: "selected key",
  scopes: ["wallet:read"] as const,
  expiresInSeconds: 300,
};

const close = new Set<() => void>();
afterEach(() => {
  for (const dispose of close) dispose();
  close.clear();
});

// A genuine ordinary request-factory handle with an actual owning SQLite schema
// behind a structural D1-shaped bridge. It has no native platform/source proof.
async function ordinaryRequest() {
  const database = await createHostedBillingRealmTestDatabase();
  close.add(() => database.db.close());
  const writer = `sha256:${"a".repeat(64)}`;
  for (const ddl of [
    MONEY_CUTOVER_FREEZE_DDL,
    MONEY_CUTOVER_PERMIT_DDL,
    MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
    MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
    moneyFenceInstallSql("0094"),
  ])
    database.db.exec(ddl);
  await database.sql.run("INSERT INTO money_cutover_authorized_epoch VALUES (1, ?)", [writer]);
  let sessions = 0;
  let writes = 0;
  const originals = new WeakMap<D1StatementLike, SqlStatement>();
  const session = {
    prepare(text: string) {
      const statement: D1StatementLike = {
        bind(...values: readonly SqlParam[]) {
          originals.set(statement, { sql: text, params: values });
          return statement;
        },
        async all() {
          const original = originals.get(statement);
          if (!original) throw new Error("fixture statement differs");
          const result = await database.sql.run(original.sql, original.params);
          return { success: true, results: result.rows, meta: { changes: result.changes } };
        },
      };
      originals.set(statement, { sql: text });
      return statement;
    },
    async batch() {
      writes++;
      throw new Error("unqualified request must not issue a batch");
    },
  };
  const binding = {
    prepare: session.prepare,
    batch: session.batch,
    withSession(constraint: "first-primary") {
      expect(constraint).toBe("first-primary");
      sessions++;
      return session;
    },
  };
  const connection = await createWorkerRequestSql({
    database: binding,
    writerEpoch: writer,
    publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
    consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
  });
  return { connection, sessions: () => sessions, writes: () => writes };
}

test("ordinary WorkerRequestSql cannot issue or capture a native direct key", async () => {
  const f = await ordinaryRequest();
  await expect(
    issueWorkerRequestDirectOwnerKey(f.connection, "Bearer ordinary-local-bearer", selected),
  ).rejects.toBeDefined();
  await expect(
    captureWorkerRequestRetainedDirectKey(f.connection, "Bearer ordinary-local-bearer"),
  ).rejects.toBeDefined();
  expect(f.sessions()).toBe(1);
  expect(f.writes()).toBe(0);
});

test("direct key command accessor cannot supply organization or scopes", async () => {
  const f = await ordinaryRequest();
  let reads = 0;
  for (const key of ["organizationId", "scopes"] as const) {
    const input = Object.defineProperty({ ...selected }, key, {
      get() {
        reads++;
        throw new Error("command getter must not run");
      },
    });
    await expect(issueWorkerRequestDirectOwnerKey(f.connection, null, input)).rejects.toMatchObject(
      { code: "invalid" },
    );
  }
  expect(reads).toBe(0);
  expect(f.writes()).toBe(0);
});

test("direct key command rejects scope accessors, duplicates and extra authority fields", async () => {
  const f = await ordinaryRequest();
  let reads = 0;
  const scopes = Object.defineProperty(["wallet:read"], "0", {
    get() {
      reads++;
      throw new Error("scope getter must not run");
    },
  });
  for (const input of [
    { ...selected, scopes },
    { ...selected, scopes: ["wallet:read", "wallet:read"] },
    { ...selected, targetRef: "caller-target" },
    { ...selected, current: true },
  ]) {
    // Invalid runtime commands are not nominally cast into valid authority.
    await expect(
      Reflect.apply(issueWorkerRequestDirectOwnerKey, undefined, [f.connection, null, input]),
    ).rejects.toMatchObject({ code: "invalid" });
  }
  expect(reads).toBe(0);
  expect(f.writes()).toBe(0);
});

test("direct key command rejects unknown scope and invalid lifetime before any issuance", async () => {
  const f = await ordinaryRequest();
  for (const input of [
    { ...selected, scopes: ["payer:all"] },
    { ...selected, expiresInSeconds: 0 },
    { ...selected, expiresInSeconds: Number.NaN },
    { ...selected, expiresInSeconds: Number.POSITIVE_INFINITY },
  ]) {
    await expect(
      Reflect.apply(issueWorkerRequestDirectOwnerKey, undefined, [f.connection, null, input]),
    ).rejects.toMatchObject({ code: "invalid" });
  }
  expect(f.writes()).toBe(0);
});

test("direct key capture reader rejects record DTO, cloned and foreign handles", async () => {
  const f = await ordinaryRequest();
  let reads = 0;
  const alleged = Object.defineProperty({}, "record", {
    get() {
      reads++;
      throw new Error("record getter must not run");
    },
  });
  for (const value of [null, {}, alleged, { backend: "auth-token", class: "direct-exact-org-key" }])
    expect(readWorkerRequestRetainedDirectKeyCapture(f.connection, value)).toBeNull();
  expect(reads).toBe(0);
  expect(f.writes()).toBe(0);
});
