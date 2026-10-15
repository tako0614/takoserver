import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import {
  createMoneyCutoverSql,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
  moneyCutoverFinancialTriggerSql,
} from "../src/money-cutover-sql.ts";
import {
  createD1Sql,
  type D1DatabaseLike,
  type D1ResultLike,
  type D1StatementLike,
} from "../src/sql-d1.ts";

async function harness() {
  const id = `integration-d1-ack-${crypto.randomUUID()}`;
  const runtime = new Miniflare({
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
  try {
    const database = await runtime.getD1Database("STATE_DB");
    const session = database.withSession("first-primary");
    const statementMap = new WeakMap<object, ReturnType<typeof session.prepare>>();
    const raw: { readonly kind: "all" | "batch"; readonly value: unknown }[] = [];
    const calls = { all: 0, batch: 0 };
    let corruptAll: ((value: D1ResultLike) => D1ResultLike) | undefined;
    let corruptBatch: ((value: readonly D1ResultLike[]) => readonly D1ResultLike[]) | undefined;
    function wrap(native: ReturnType<typeof session.prepare>): D1StatementLike {
      const statement: D1StatementLike = {
        bind(...values) {
          return wrap(native.bind(...values));
        },
        async all() {
          calls.all++;
          const value = await native.all();
          raw.push({ kind: "all", value });
          return corruptAll ? corruptAll(value) : value;
        },
      };
      statementMap.set(statement, native);
      return statement;
    }
    const observed: D1DatabaseLike = {
      prepare: (query) => wrap(session.prepare(query)),
      async batch(statements) {
        calls.batch++;
        const native = statements.map((statement) => {
          const value = statementMap.get(statement);
          if (!value) throw new Error("Foreign fixture statement");
          return value;
        });
        const value = await session.batch<Record<string, unknown>>(native);
        raw.push({ kind: "batch", value });
        return corruptBatch ? corruptBatch(value) : value;
      },
    };
    return {
      database,
      raw,
      calls,
      sql: createD1Sql(observed, { acknowledgement: "explicit-d1-result" }),
      corruptAll(callback: (value: D1ResultLike) => D1ResultLike) {
        corruptAll = callback;
      },
      corruptBatch(callback: (value: readonly D1ResultLike[]) => readonly D1ResultLike[]) {
        corruptBatch = callback;
      },
      close: () => runtime.dispose(),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

test("native D1 exposes explicit raw ACKs for RETURNING, reads, DDL, DML and actual permit batches", async () => {
  const h = await harness();
  try {
    expect(
      await h.sql.run("CREATE TABLE ack_rows (id TEXT PRIMARY KEY, version INTEGER NOT NULL)"),
    ).toEqual({ rows: [], changes: 0 });
    expect(await h.sql.run("INSERT INTO ack_rows VALUES (?, ?)", ["original", 1])).toEqual({
      rows: [],
      changes: 1,
    });
    expect(
      await h.sql.run(
        "UPDATE ack_rows SET version = version + 1 WHERE id = ? AND version = ? RETURNING id, version",
        ["original", 1],
      ),
    ).toEqual({ rows: [{ id: "original", version: 2 }], changes: 1 });
    expect(
      await h.sql.run(
        "UPDATE ack_rows SET version = version + 1 WHERE id = ? AND version = ? RETURNING id, version",
        ["original", 1],
      ),
    ).toEqual({ rows: [], changes: 0 });
    expect(await h.sql.query("SELECT id, version FROM ack_rows")).toEqual([
      { id: "original", version: 2 },
    ]);
    const mixed = await h.sql.batch([
      { sql: "INSERT INTO ack_rows VALUES ('second', 1) RETURNING id, version" },
      { sql: "SELECT id, version FROM ack_rows WHERE id = 'original'" },
      { sql: "UPDATE ack_rows SET version = 3 WHERE id = 'original'" },
    ]);
    expect(mixed).toEqual([
      { rows: [{ id: "second", version: 1 }], changes: 1 },
      { rows: [{ id: "original", version: 2 }], changes: 0 },
      { rows: [], changes: 1 },
    ]);
    expect(await h.sql.run("DELETE FROM ack_rows WHERE id = 'second'")).toEqual({
      rows: [],
      changes: 1,
    });
    // Existing public builders on an isolated synthetic schema, no financial migration/adoption.
    for (const ddl of [
      MONEY_CUTOVER_FREEZE_DDL,
      MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
      MONEY_CUTOVER_PERMIT_DDL,
      MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
      "CREATE TABLE ledger (id TEXT PRIMARY KEY)",
      moneyCutoverFinancialTriggerSql("ledger", "INSERT"),
    ]) {
      await h.sql.run(ddl);
    }
    const epoch = `sha256:${"c".repeat(64)}`;
    await h.sql.run("INSERT INTO money_cutover_authorized_epoch VALUES (1, ?)", [epoch]);
    const canonical = createMoneyCutoverSql(h.sql, epoch);
    expect(await canonical.run("INSERT INTO ledger VALUES ('original-permit-write')")).toEqual({
      rows: [],
      changes: 1,
    });
    expect(await canonical.query("SELECT * FROM ledger")).toEqual([
      { id: "original-permit-write" },
    ]);
    const independent = h.database.withSession("first-primary");
    expect(
      (await independent.prepare("SELECT COUNT(*) AS n FROM money_cutover_writer_permit").all())
        .results,
    ).toEqual([{ n: 0 }]);
  } finally {
    console.info("D1_ACK_RAW_CANONICAL", JSON.stringify(h.raw));
    await h.close();
  }
}, 60_000);

test("native committed writes with damaged ACKs stay unknown after exactly one send", async () => {
  const h = await harness();
  try {
    await h.sql.run("CREATE TABLE effects (id TEXT PRIMARY KEY, version INTEGER NOT NULL)");
    const corruptions: readonly [string, (value: D1ResultLike) => D1ResultLike][] = [
      ["missing changes", (value) => ({ ...value, meta: {} })],
      ["null results", (value) => ({ ...value, results: null })],
      [
        "missing success",
        (value) => {
          const incomplete = { ...value };
          delete incomplete.success;
          return incomplete;
        },
      ],
    ];
    for (const [name, corruption] of corruptions) {
      h.corruptAll(corruption);
      const before = h.calls.all;
      await expect(
        h.sql.run("INSERT INTO effects VALUES (?, 1) RETURNING id, version", [name]),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(h.calls.all).toBe(before + 1);
      const fresh = h.database.withSession("first-primary");
      expect(
        (await fresh.prepare("SELECT id, version FROM effects WHERE id = ?").bind(name).all())
          .results,
      ).toEqual([{ id: name, version: 1 }]);
    }
  } finally {
    console.info("D1_ACK_RAW_COMMITTED_SINGLE", JSON.stringify(h.raw));
    await h.close();
  }
}, 60_000);

test("native committed batches with truncated or sparse ACKs are not resent", async () => {
  const h = await harness();
  try {
    await h.sql.run("CREATE TABLE effects (id TEXT PRIMARY KEY, version INTEGER NOT NULL)");
    const corruptions: readonly [
      string,
      (value: readonly D1ResultLike[]) => readonly D1ResultLike[],
    ][] = [
      ["truncated", (value) => value.slice(0, 1)],
      ["sparse", (value) => new Array<D1ResultLike>(value.length)],
    ];
    for (const [name, corruption] of corruptions) {
      h.corruptBatch(corruption);
      const before = h.calls.batch;
      await expect(
        h.sql.batch([
          { sql: "INSERT INTO effects VALUES (?, 1) RETURNING id, version", params: [name] },
          { sql: "UPDATE effects SET version = 2 WHERE id = ? RETURNING version", params: [name] },
        ]),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(h.calls.batch).toBe(before + 1);
      const fresh = h.database.withSession("first-primary");
      expect(
        (await fresh.prepare("SELECT id, version FROM effects WHERE id = ?").bind(name).all())
          .results,
      ).toEqual([{ id: name, version: 2 }]);
    }
  } finally {
    console.info("D1_ACK_RAW_COMMITTED_BATCH", JSON.stringify(h.raw));
    await h.close();
  }
}, 60_000);
