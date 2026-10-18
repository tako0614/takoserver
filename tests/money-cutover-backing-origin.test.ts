import { describe, expect, test } from "bun:test";

import {
  assertMoneyCutoverSqlBackingOrigin,
  assertMoneyCutoverSqlOrigin,
  createMoneyCutoverSql,
  MONEY_CUTOVER_EPOCH,
  MONEY_CUTOVER_PERMIT_TABLE,
} from "../src/money-cutover-sql.ts";
import { type Sql, SqlError, type SqlStatement } from "../src/ports.ts";
import { createD1Sql, type D1DatabaseLike } from "../src/sql-d1.ts";

const WRITER_EPOCH = `sha256:${"a".repeat(64)}`;
const OTHER_EPOCH = `sha256:${"b".repeat(64)}`;
const METHOD_NAMES = ["query", "run", "batch"] as const;

function backing(): { raw: Sql; batches: SqlStatement[][] } {
  const batches: SqlStatement[][] = [];
  const raw: Sql = {
    async query() {
      return [];
    },
    async run() {
      return { rows: [], changes: 1 };
    },
    async batch(statements) {
      batches.push([...statements]);
      return statements.map(() => ({ rows: [], changes: 1 }));
    },
  };
  return { raw, batches };
}

function assertBacking(sql: unknown, context: unknown): void {
  assertMoneyCutoverSqlBackingOrigin(
    sql,
    context as Parameters<typeof assertMoneyCutoverSqlBackingOrigin>[1],
  );
}

function expectInvalid(assertion: () => void): void {
  try {
    assertion();
  } catch (error) {
    expect(error).toBeInstanceOf(SqlError);
    expect((error as SqlError).code).toBe("invalid");
    return;
  }
  throw new Error("expected money cutover origin rejection");
}

describe("money cutover backing origin", () => {
  test("accepts the real D1 adapter constructor shape without native method calls", () => {
    const calls = { prepare: 0, bind: 0, all: 0, batch: 0 };
    const database: D1DatabaseLike = {
      prepare() {
        calls.prepare++;
        return {
          bind() {
            calls.bind++;
            return this;
          },
          async all() {
            calls.all++;
            return { success: true, results: [], meta: { changes: 1 } };
          },
        };
      },
      async batch() {
        calls.batch++;
        return [];
      },
    };
    const raw = createD1Sql(database);
    const wrapped = createMoneyCutoverSql(raw, WRITER_EPOCH);
    expect(
      assertMoneyCutoverSqlBackingOrigin(wrapped, { rawSql: raw, writerEpoch: WRITER_EPOCH }),
    ).toBe(undefined);
    expectInvalid(() => assertBacking(wrapped, { rawSql: { ...raw }, writerEpoch: WRITER_EPOCH }));

    const originalRun = raw.run;
    Object.defineProperty(raw, "run", { value: () => undefined, configurable: true });
    expectInvalid(() => assertBacking(wrapped, { rawSql: raw, writerEpoch: WRITER_EPOCH }));
    Object.defineProperty(raw, "run", { value: originalRun, configurable: true });

    const originalBatch = raw.batch;
    let getterCalls = 0;
    Object.defineProperty(raw, "batch", {
      configurable: true,
      get() {
        getterCalls++;
        return originalBatch;
      },
    });
    expectInvalid(() => assertBacking(wrapped, { rawSql: raw, writerEpoch: WRITER_EPOCH }));
    expect(getterCalls).toBe(0);
    expect(calls).toEqual({ prepare: 0, bind: 0, all: 0, batch: 0 });
  });

  test("accepts only the captured wrapper, exact raw Sql, and writer epoch", () => {
    const { raw } = backing();
    const wrapped = createMoneyCutoverSql(raw, WRITER_EPOCH);
    expect(
      assertMoneyCutoverSqlBackingOrigin(wrapped, { rawSql: raw, writerEpoch: WRITER_EPOCH }),
    ).toBe(undefined);
    expect(assertMoneyCutoverSqlOrigin(wrapped, { writerEpoch: WRITER_EPOCH })).toBe(undefined);

    expectInvalid(() => assertBacking({ ...wrapped }, { rawSql: raw, writerEpoch: WRITER_EPOCH }));
    expectInvalid(() => assertBacking(wrapped, { rawSql: { ...raw }, writerEpoch: WRITER_EPOCH }));
    expectInvalid(() => assertBacking(wrapped, { rawSql: raw, writerEpoch: OTHER_EPOCH }));

    const { raw: foreignRaw } = backing();
    const foreignWrapper = createMoneyCutoverSql(foreignRaw, WRITER_EPOCH);
    expectInvalid(() => assertBacking(foreignWrapper, { rawSql: raw, writerEpoch: WRITER_EPOCH }));
  });

  for (const name of METHOD_NAMES) {
    test(`rejects a replaced wrapper ${name} method`, () => {
      const { raw } = backing();
      const wrapped = createMoneyCutoverSql(raw, WRITER_EPOCH);
      Object.defineProperty(wrapped, name, { value: () => undefined, configurable: true });
      expectInvalid(() => assertBacking(wrapped, { rawSql: raw, writerEpoch: WRITER_EPOCH }));
    });

    test(`rejects a wrapper ${name} accessor without calling its getter`, () => {
      const { raw } = backing();
      const wrapped = createMoneyCutoverSql(raw, WRITER_EPOCH);
      const original = wrapped[name];
      let getterCalls = 0;
      Object.defineProperty(wrapped, name, {
        configurable: true,
        get() {
          getterCalls++;
          return original;
        },
      });
      expectInvalid(() => assertBacking(wrapped, { rawSql: raw, writerEpoch: WRITER_EPOCH }));
      expect(getterCalls).toBe(0);
    });

    test(`captures the raw ${name} identity before the first assertion`, () => {
      const { raw } = backing();
      const wrapped = createMoneyCutoverSql(raw, WRITER_EPOCH);
      Object.defineProperty(raw, name, { value: () => undefined, configurable: true });
      // The existing wrapper-only assertion retains its original boundary.
      expect(assertMoneyCutoverSqlOrigin(wrapped, { writerEpoch: WRITER_EPOCH })).toBe(undefined);
      expectInvalid(() => assertBacking(wrapped, { rawSql: raw, writerEpoch: WRITER_EPOCH }));
    });

    test(`rejects a raw ${name} accessor without calling its getter`, () => {
      const { raw } = backing();
      const wrapped = createMoneyCutoverSql(raw, WRITER_EPOCH);
      const original = raw[name];
      let getterCalls = 0;
      Object.defineProperty(raw, name, {
        configurable: true,
        get() {
          getterCalls++;
          return original;
        },
      });
      expectInvalid(() => assertBacking(wrapped, { rawSql: raw, writerEpoch: WRITER_EPOCH }));
      expect(getterCalls).toBe(0);
    });
  }

  for (const name of ["rawSql", "writerEpoch"] as const) {
    test(`requires expected ${name} as own data without reading accessors`, () => {
      const { raw } = backing();
      const wrapped = createMoneyCutoverSql(raw, WRITER_EPOCH);
      const valid = { rawSql: raw, writerEpoch: WRITER_EPOCH };
      const missing: Record<string, unknown> = { ...valid };
      delete missing[name];
      expectInvalid(() => assertBacking(wrapped, missing));

      const inherited = Object.create({ [name]: valid[name] }) as Record<string, unknown>;
      const other = name === "rawSql" ? "writerEpoch" : "rawSql";
      inherited[other] = valid[other];
      expectInvalid(() => assertBacking(wrapped, inherited));

      const accessor = { ...valid };
      let getterCalls = 0;
      Object.defineProperty(accessor, name, {
        configurable: true,
        get() {
          getterCalls++;
          return valid[name];
        },
      });
      expectInvalid(() => assertBacking(wrapped, accessor));
      expect(getterCalls).toBe(0);
    });
  }

  test("a raw adapter without own data methods stays constructible but cannot qualify", () => {
    const { raw: prototype } = backing();
    const inheritedRaw = Object.create(prototype) as Sql;
    const inheritedWrapper = createMoneyCutoverSql(inheritedRaw, WRITER_EPOCH);
    expect(assertMoneyCutoverSqlOrigin(inheritedWrapper, { writerEpoch: WRITER_EPOCH })).toBe(
      undefined,
    );
    expectInvalid(() =>
      assertBacking(inheritedWrapper, { rawSql: inheritedRaw, writerEpoch: WRITER_EPOCH }),
    );

    const { raw: accessorRaw } = backing();
    const query = accessorRaw.query;
    let getterCalls = 0;
    Object.defineProperty(accessorRaw, "query", {
      configurable: true,
      get() {
        getterCalls++;
        return query;
      },
    });
    const accessorWrapper = createMoneyCutoverSql(accessorRaw, WRITER_EPOCH);
    expect(getterCalls).toBe(0);
    expectInvalid(() =>
      assertBacking(accessorWrapper, { rawSql: accessorRaw, writerEpoch: WRITER_EPOCH }),
    );
    expect(getterCalls).toBe(0);
  });

  test("keeps the public statement fence and permit, user, delete batch order", async () => {
    const { raw, batches } = backing();
    const wrapped = createMoneyCutoverSql(raw, WRITER_EPOCH);
    for (const sql of [
      "INSERT INTO money_cutover_authorized_epoch (singleton, writer_epoch) VALUES (1, 'x')",
      "DELETE FROM money_cutover_freeze WHERE singleton = 1",
    ]) {
      await expect(wrapped.batch([{ sql }])).rejects.toBeInstanceOf(SqlError);
      expect(batches).toHaveLength(0);
    }
    await expect(
      wrapped.query("SELECT * FROM money_cutover_authorized_epoch"),
    ).rejects.toBeInstanceOf(SqlError);
    expect(batches).toHaveLength(0);

    const statement = { sql: "DELETE FROM ordinary_table WHERE id = ?", params: [7] };
    expect(await wrapped.batch([statement])).toEqual([{ rows: [], changes: 1 }]);
    expect(batches).toEqual([
      [
        {
          sql: `INSERT INTO ${MONEY_CUTOVER_PERMIT_TABLE} (singleton, epoch, writer_epoch) VALUES (1, '${MONEY_CUTOVER_EPOCH}', ?)`,
          params: [WRITER_EPOCH],
        },
        statement,
        {
          sql: `DELETE FROM ${MONEY_CUTOVER_PERMIT_TABLE} WHERE singleton = 1 AND epoch = '${MONEY_CUTOVER_EPOCH}' AND writer_epoch = ?`,
          params: [WRITER_EPOCH],
        },
      ],
    ]);
  });
});
