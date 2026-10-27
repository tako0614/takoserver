import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { canonicalJson } from "../src/json.ts";
import { createMoneyCutoverSql } from "../src/money-cutover-sql.ts";
import type { Sql, SqlParam, SqlStatement } from "../src/ports.ts";
import {
  buildFinancialR1BoundedAttemptCustodyStatement,
  createFinancialR1AttemptDataReader,
} from "../src/shared-financial-retained-r1.ts";
import {
  createD1Sql,
  type D1DatabaseLike,
  type D1ResultLike,
  type D1StatementLike,
} from "../src/sql-d1.ts";
import { ACTIONS, AT, EPOCH, fixture, SCOPE } from "./helpers/financial-r1-custody-fixture.ts";

const ATTEMPTS = "financial_r1_preparation_attempts";
const RETURNING_COLUMNS = [
  "r1_ref",
  "challenge_ref",
  "preparation_ref",
  "receipt_ref",
  "action_kind",
  "organization_id",
  "action_reference",
  "request_fingerprint",
  "command_json",
  "command_digest",
  "scope_json",
  "writer_epoch",
  "recorded_at",
] as const;

async function copyExactSyntheticFixture(source: Awaited<ReturnType<typeof fixture>>, target: Sql) {
  const schema = source.db
    .query(
      "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 WHEN 'trigger' THEN 3 ELSE 4 END, name",
    )
    .all() as { type: string; name: string; sql: string }[];
  const statements: SqlStatement[] = schema.map(({ sql }) => ({ sql }));

  const tables = schema.filter((object) => object.type === "table");
  for (const { name } of tables) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const columns = source.db.query(`PRAGMA table_info(${quoted})`).all() as {
      name: string;
      hidden?: number;
    }[];
    const writable = columns.filter((column) => column.hidden !== 1).map((column) => column.name);
    if (writable.length === 0) continue;
    const rows = source.db
      .query(`SELECT ${writable.map((column) => `"${column}"`).join(",")} FROM ${quoted}`)
      .all() as Record<string, SqlParam>[];
    for (const row of rows) {
      const values = writable.map((column) => {
        if (!Object.hasOwn(row, column) || row[column] === undefined)
          throw new Error(`missing fixture value for ${name}.${column}`);
        return row[column];
      });
      statements.push({
        sql: `INSERT INTO ${quoted} (${writable.map((column) => `"${column}"`).join(",")}) VALUES (${writable.map(() => "?").join(",")})`,
        params: values,
      });
    }
  }
  for (let offset = 0; offset < statements.length; offset += 64) {
    await target.batch(statements.slice(offset, offset + 64));
  }
}

async function harness() {
  const source = await fixture();
  const id = `financial-r1-bounded-${crypto.randomUUID()}`;
  let runtime: Miniflare | undefined;
  try {
    runtime = new Miniflare({
      workers: [
        {
          config: {
            name: id,
            type: "worker",
            compatibilityDate: "2026-08-17",
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
    const database = await runtime.getD1Database("STATE_DB");
    const session = database.withSession("first-primary");
    const statementMap = new WeakMap<object, ReturnType<typeof session.prepare>>();
    const counters = { all: 0, writesAll: 0, batch: 0 };
    let loseNextBatchAck = false;
    function wrap(
      native: ReturnType<typeof session.prepare>,
      writeAttempt = false,
    ): D1StatementLike {
      const statement: D1StatementLike = {
        bind(...values) {
          return wrap(native.bind(...values), writeAttempt);
        },
        async all() {
          counters.all++;
          if (writeAttempt) counters.writesAll++;
          return (await native.all()) as D1ResultLike;
        },
      };
      statementMap.set(statement, native);
      return statement;
    }
    const observed: D1DatabaseLike = {
      prepare: (query) =>
        wrap(session.prepare(query), !/^(?:SELECT|PRAGMA|EXPLAIN)\b/iu.test(query.trimStart())),
      async batch(statements) {
        counters.batch++;
        const native = statements.map((statement) => {
          const value = statementMap.get(statement);
          if (!value) throw new Error("Foreign fixture statement");
          return value;
        });
        const committed = (await session.batch<Record<string, unknown>>(native)) as D1ResultLike[];
        if (loseNextBatchAck) {
          loseNextBatchAck = false;
          return committed.slice(0, 1);
        }
        return committed;
      },
    };
    const raw = createD1Sql(observed, { acknowledgement: "explicit-d1-result" });
    const bootstrap = createD1Sql(
      {
        prepare: (query) => wrap(session.prepare(query)),
        batch: observed.batch,
      },
      { acknowledgement: "explicit-d1-result" },
    );
    await copyExactSyntheticFixture(source, bootstrap);
    const sql = createMoneyCutoverSql(raw, EPOCH);
    const realm = await verifyHostedBillingFinancialRealm({
      sql,
      reader: { client: source.client },
      expected: { accountId: "acct_enrollment", mode: "test", billingAuthority: "enrollment" },
      prices: [{ priceId: "price_enrollment", monthlyAmountMinor: 1000 }],
    });
    const options = { ...source.options, sql, realm };
    const resetCounters = () => {
      counters.all = 0;
      counters.writesAll = 0;
      counters.batch = 0;
    };
    const loseBatchAck = () => {
      loseNextBatchAck = true;
    };
    return { source, runtime, database, sql, raw, options, counters, resetCounters, loseBatchAck };
  } catch (error) {
    source.close();
    await runtime?.dispose();
    throw error;
  }
}

test("native Miniflare D1 preserves R1 bounded claim, replay and held original across every action", async () => {
  const h = await harness();
  try {
    for (const action of ACTIONS) {
      const command = await h.source.command(action, `native-${action.kind}`);
      const claim = await buildFinancialR1BoundedAttemptCustodyStatement(h.options, command, AT);
      expect(claim.params).toHaveLength(16);
      expect(claim.sql.match(/\?/gu)).toHaveLength(16);
      const first = await h.sql.run(claim.sql, claim.params);
      expect(first.changes).toBe(1);
      expect(first.rows).toHaveLength(1);
      const firstRow = first.rows[0];
      if (!firstRow) throw new Error("native D1 did not return the inserted claim");
      expect(Object.keys(firstRow).sort()).toEqual([...RETURNING_COLUMNS].sort());
      expect((await h.sql.run(claim.sql, claim.params)).changes).toBe(0);

      const changedAction = action.kind === "topup" ? { ...action, amountMinor: 6000 } : action;
      const changed = await h.source.command(
        changedAction,
        `native-changed-${action.kind}`,
        "Changed displayed terms for the same business claim.",
      );
      const changedClaim = await buildFinancialR1BoundedAttemptCustodyStatement(
        h.options,
        changed,
        AT,
      );
      expect((await h.sql.run(changedClaim.sql, changedClaim.params)).changes).toBe(0);

      const held = await createFinancialR1AttemptDataReader(h.options).readOriginalAttemptData(
        command,
      );
      expect(held.status).toBe("found");
      if (held.status !== "found") throw new Error("missing native held original");
      expect(held.fullCommandJson).toBe(canonicalJson(command));
    }
  } finally {
    h.source.close();
    await h.runtime.dispose();
  }
}, 60_000);

test("native D1 exact13 postimage precedes a deliberate late constraint and rolls back the permit batch", async () => {
  const positive = await harness();
  let fault: Awaited<ReturnType<typeof harness>> | undefined;
  try {
    fault = await harness();
    const action = ACTIONS[0];
    if (!action) throw new Error("missing topup fixture");
    const command = await positive.source.command(action, "native-late-fault");
    const claim = await buildFinancialR1BoundedAttemptCustodyStatement(
      positive.options,
      command,
      AT,
    );
    const claimParams = claim.params;
    if (!claimParams) throw new Error("missing native bounded claim binds");
    const positiveWrite = await positive.sql.run(claim.sql, claim.params);
    expect(positiveWrite.changes).toBe(1);
    const positiveRow = positiveWrite.rows[0];
    if (!positiveRow) throw new Error("native positive control returned no claim row");
    expect(Object.keys(positiveRow).sort()).toEqual([...RETURNING_COLUMNS].sort());
    expect(positiveRow).toMatchObject(
      Object.fromEntries(RETURNING_COLUMNS.map((column, index) => [column, claimParams[index]])),
    );

    const faultCommand = await fault.source.command(action, "native-late-fault");
    const faultClaim = await buildFinancialR1BoundedAttemptCustodyStatement(
      fault.options,
      faultCommand,
      AT,
    );
    expect(faultClaim).toEqual(claim);
    await fault.raw.run(
      "CREATE TABLE bounded_claim_late_fault(value INTEGER NOT NULL CONSTRAINT bounded_claim_late_fault_only CHECK(value=1))",
    );
    const columns = RETURNING_COLUMNS.map((column) => `claim.${column} IS ?`).join(" AND ");
    const barrier = `INSERT INTO bounded_claim_late_fault(value) SELECT CASE WHEN (SELECT count(*) FROM ${ATTEMPTS})=1 AND EXISTS(SELECT 1 FROM ${ATTEMPTS} AS claim WHERE ${columns}) THEN 0 ELSE 1 END`;
    const faultParams = faultClaim.params;
    if (!faultParams) throw new Error("missing native bounded claim binds");
    let caught: unknown;
    try {
      await fault.sql.batch([
        faultClaim,
        { sql: barrier, params: faultParams.slice(0, RETURNING_COLUMNS.length) },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "constraint" });
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("bounded_claim_late_fault_only");
    expect(await fault.raw.query(`SELECT count(*) AS n FROM ${ATTEMPTS}`)).toEqual([{ n: 0 }]);
    expect(await fault.raw.query("SELECT count(*) AS n FROM bounded_claim_late_fault")).toEqual([
      { n: 0 },
    ]);
    expect(await fault.raw.query("SELECT count(*) AS n FROM money_cutover_writer_permit")).toEqual([
      { n: 0 },
    ]);
  } finally {
    try {
      fault?.source.close();
      await fault?.runtime.dispose();
    } finally {
      positive.source.close();
      await positive.runtime.dispose();
    }
  }
}, 60_000);

test("native committed ACK loss exposes only held GET data and never resends the Money batch", async () => {
  const h = await harness();
  try {
    const action = ACTIONS[0];
    if (!action) throw new Error("missing topup fixture");
    const command = await h.source.command(action, "native-ack-loss");
    const claim = await buildFinancialR1BoundedAttemptCustodyStatement(h.options, command, AT);
    const externalBefore = { providerRequests: h.source.providerRequests, clocks: h.source.clocks };
    h.resetCounters();
    h.loseBatchAck();
    await expect(h.sql.run(claim.sql, claim.params)).rejects.toMatchObject({ code: "unavailable" });
    expect(h.counters.batch).toBe(1);
    expect(h.counters.writesAll).toBe(0);
    expect(await h.raw.query(`SELECT count(*) AS n FROM ${ATTEMPTS}`)).toEqual([{ n: 1 }]);

    const before = { ...h.counters };
    const held = await createFinancialR1AttemptDataReader(h.options).readBusinessAttemptData({
      kind: command.original.c0.selection.action.kind as "topup",
      organizationId: SCOPE.organizationId,
      reference: action.reference,
    });
    expect(held.status).toBe("found");
    if (held.status !== "found") throw new Error("missing native held original after ACK loss");
    expect(held.fullCommandJson).toBe(canonicalJson(command));
    expect(h.counters.batch).toBe(before.batch);
    expect(h.counters.writesAll).toBe(before.writesAll);
    expect(h.counters.all).toBeGreaterThan(before.all);
    expect({ providerRequests: h.source.providerRequests, clocks: h.source.clocks }).toEqual(
      externalBefore,
    );
  } finally {
    h.source.close();
    await h.runtime.dispose();
  }
}, 60_000);

test("native Money freeze and epoch rotation fence the bounded claim before any retained row", async () => {
  const frozen = await harness();
  try {
    const action = ACTIONS[0];
    if (!action) throw new Error("missing topup fixture");
    const command = await frozen.source.command(action, "native-freeze");
    const claim = await buildFinancialR1BoundedAttemptCustodyStatement(frozen.options, command, AT);
    await frozen.raw.run("INSERT INTO money_cutover_freeze VALUES(1,?,?,?,?,?)", [
      EPOCH,
      EPOCH,
      EPOCH,
      EPOCH,
      EPOCH,
    ]);
    await expect(frozen.sql.run(claim.sql, claim.params)).rejects.toThrow();
    expect(await frozen.raw.query(`SELECT count(*) AS n FROM ${ATTEMPTS}`)).toEqual([{ n: 0 }]);
    expect(await frozen.raw.query("SELECT count(*) AS n FROM money_cutover_writer_permit")).toEqual(
      [{ n: 0 }],
    );
  } finally {
    frozen.source.close();
    await frozen.runtime.dispose();
  }

  const rotated = await harness();
  try {
    const action = ACTIONS[0];
    if (!action) throw new Error("missing topup fixture");
    const command = await rotated.source.command(action, "native-epoch");
    const claim = await buildFinancialR1BoundedAttemptCustodyStatement(
      rotated.options,
      command,
      AT,
    );
    await rotated.raw.run(
      "UPDATE money_cutover_authorized_epoch SET writer_epoch=? WHERE singleton=1",
      [`sha256:${"e".repeat(64)}`],
    );
    await expect(rotated.sql.run(claim.sql, claim.params)).rejects.toThrow();
    expect(await rotated.raw.query(`SELECT count(*) AS n FROM ${ATTEMPTS}`)).toEqual([{ n: 0 }]);
    expect(
      await rotated.raw.query("SELECT count(*) AS n FROM money_cutover_writer_permit"),
    ).toEqual([{ n: 0 }]);
  } finally {
    rotated.source.close();
    await rotated.runtime.dispose();
  }
}, 60_000);
