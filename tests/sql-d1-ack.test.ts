import { describe, expect, test } from "bun:test";
import type { Sql, SqlStatement } from "../src/ports.ts";
import { createD1Sql, type D1ResultLike } from "../src/sql-d1.ts";

const complete = { success: true, results: [], meta: { changes: 0 } };

// Deliberately untyped external ACKs cross the adapter's runtime boundary.
// These counters prove transport calls, not actual native commit outcomes.
function fixture(reply: unknown, batchReply: unknown = [reply]) {
  const calls = { prepare: 0, all: 0, batch: 0, bind: 0 };
  const statement = {
    bind() {
      calls.bind++;
      return statement;
    },
    async all() {
      calls.all++;
      return reply;
    },
  };
  const database = {
    prepare() {
      calls.prepare++;
      return statement;
    },
    async batch() {
      calls.batch++;
      return batchReply;
    },
  };
  function create(options?: { readonly acknowledgement?: "explicit-d1-result" }): Sql {
    return Reflect.apply(createD1Sql, undefined, [database, options]);
  }
  return { calls, database, create };
}

describe("explicit D1 result acknowledgement", () => {
  test("preserves explicit zero and the actual returned row image without SQL classification", async () => {
    const zero = fixture(complete);
    const sql = zero.create({ acknowledgement: "explicit-d1-result" });
    expect(await sql.run("UPDATE fixture SET value = ? RETURNING *", [1])).toEqual({
      rows: [],
      changes: 0,
    });
    expect(zero.calls).toEqual({ prepare: 1, all: 1, batch: 0, bind: 1 });
    const rows = [{ id: "original", version: 2, nullable: null }];
    const one = fixture({ success: true, results: rows, meta: { changes: 1 } });
    const write = await one.create({ acknowledgement: "explicit-d1-result" }).run("audited SQL");
    expect(write).toEqual({ rows, changes: 1 });
    expect(write.rows).toBe(rows);
  });

  test("accepts SELECT rows with zero changes and an empty array with positive changes", async () => {
    const selected = fixture({ success: true, results: [{ n: 7 }], meta: { changes: 0 } });
    expect(
      await selected.create({ acknowledgement: "explicit-d1-result" }).query("SELECT 7 AS n"),
    ).toEqual([{ n: 7 }]);
    const changed = fixture({ success: true, results: [], meta: { changes: 3 } });
    expect(
      await changed.create({ acknowledgement: "explicit-d1-result" }).run("plain DML"),
    ).toEqual({ rows: [], changes: 3 });
  });

  const malformed: readonly [string, unknown][] = [
    ["null object", null],
    ["missing object", undefined],
    ["array object", []],
    ["missing success", { results: [], meta: { changes: 0 } }],
    ["false success", { ...complete, success: false }],
    ["nonboolean success", { ...complete, success: "true" }],
    ["missing results", { success: true, meta: { changes: 0 } }],
    ["null results", { ...complete, results: null }],
    ["nonarray results", { ...complete, results: {} }],
    ["sparse rows", { ...complete, results: new Array(1) }],
    ["null row", { ...complete, results: [null] }],
    ["primitive row", { ...complete, results: [7] }],
    ["array row", { ...complete, results: [[]] }],
    ["missing metadata", { success: true, results: [] }],
    ["null metadata", { ...complete, meta: null }],
    ["array metadata", { ...complete, meta: [] }],
    ["missing changes", { ...complete, meta: {} }],
    ...[null, "0", -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53].map(
      (changes): [string, unknown] => [String(changes), { ...complete, meta: { changes } }],
    ),
  ];
  for (const [name, reply] of malformed) {
    test(`refuses ${name} ACK after one all invocation and no resend`, async () => {
      const f = fixture(reply);
      await expect(
        f.create({ acknowledgement: "explicit-d1-result" }).run("original write"),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(f.calls).toEqual({ prepare: 1, all: 1, batch: 0, bind: 0 });
    });
  }

  test("does not inherit missing acknowledgement fields from prototypes", async () => {
    const inheritedFields: unknown = Object.create(complete);
    const inheritedMeta: unknown = Object.assign(Object.create({ meta: { changes: 0 } }), {
      success: true,
      results: [],
    });
    for (const inherited of [inheritedFields, inheritedMeta]) {
      const f = fixture(inherited);
      await expect(
        f.create({ acknowledgement: "explicit-d1-result" }).run("original"),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(f.calls.all).toBe(1);
    }
  });

  test("validates every member of one complete batch and never creates an empty batch effect", async () => {
    const f = fixture(complete, [complete, { ...complete, meta: { changes: 1 } }]);
    const sql = f.create({ acknowledgement: "explicit-d1-result" });
    expect(await sql.batch([])).toEqual([]);
    expect(f.calls.batch).toBe(0);
    expect(await sql.batch([{ sql: "one" }, { sql: "two" }])).toEqual([
      { rows: [], changes: 0 },
      { rows: [], changes: 1 },
    ]);
    expect(f.calls).toEqual({ prepare: 2, all: 0, batch: 1, bind: 0 });
  });

  for (const [name, reply] of [
    ["null", null],
    ["nonarray", {}],
    ["truncated", [complete]],
    ["extra", [complete, complete, complete]],
    ["sparse", new Array(2)],
    ["bad first member", [null, complete]],
    ["bad last member", [complete, { ...complete, results: null }]],
  ] as const) {
    test(`refuses ${name} batch ACK after one batch invocation`, async () => {
      const f = fixture(complete, reply);
      await expect(
        f
          .create({ acknowledgement: "explicit-d1-result" })
          .batch([{ sql: "original one" }, { sql: "original two" }]),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(f.calls).toEqual({ prepare: 2, all: 0, batch: 1, bind: 0 });
    });
  }

  test("captures the code-selected policy before its options object changes", async () => {
    const f = fixture({ ...complete, results: null });
    const options: { acknowledgement?: "explicit-d1-result" } = {
      acknowledgement: "explicit-d1-result",
    };
    const sql = f.create(options);
    delete options.acknowledgement;
    await expect(sql.run("original")).rejects.toMatchObject({ code: "unavailable" });
    expect(f.calls.all).toBe(1);
  });

  test("compares the ACK to the submitted count when a caller alias shrinks during await", async () => {
    let release: (value: readonly D1ResultLike[]) => void = () => {
      throw new Error("Batch was not started");
    };
    const pending = new Promise<readonly D1ResultLike[]>((resolve) => {
      release = resolve;
    });
    let sends = 0;
    let submittedCount = 0;
    const statement = {
      bind() {
        return statement;
      },
      async all() {
        return complete;
      },
    };
    const sql = createD1Sql(
      {
        prepare: () => statement,
        async batch(submitted) {
          sends++;
          submittedCount = submitted.length;
          return pending;
        },
      },
      { acknowledgement: "explicit-d1-result" },
    );
    const statements: SqlStatement[] = [{ sql: "original one" }, { sql: "original two" }];
    const outcome = sql.batch(statements);
    expect(submittedCount).toBe(2);
    statements.pop();
    release([complete]);
    await expect(outcome).rejects.toMatchObject({ code: "unavailable" });
    expect(sends).toBe(1);
  });

  test("rejects an unsupported policy before preparing or sending", () => {
    const f = fixture(complete);
    expect(() =>
      Reflect.apply(createD1Sql, undefined, [f.database, { acknowledgement: "unknown" }]),
    ).toThrow(TypeError);
    expect(f.calls).toEqual({ prepare: 0, all: 0, batch: 0, bind: 0 });
  });

  test("keeps the default legacy null/missing normalization and existing negative-count behavior", async () => {
    for (const reply of [
      {},
      { results: null, meta: { changes: null } },
      { results: [], meta: { changes: "0" } },
    ]) {
      const f = fixture(reply);
      expect(await f.create().run("legacy")).toEqual({ rows: [], changes: 0 });
    }
    const f = fixture({ results: null, meta: { changes: -1 } });
    expect(await f.create().run("legacy")).toEqual({ rows: [], changes: -1 });
    expect(await f.create().batch([{ sql: "legacy" }])).toEqual([{ rows: [], changes: -1 }]);
  });

  test("preserves existing thrown constraint and unavailable mappings without retry", async () => {
    for (const [message, code] of [
      ["UNIQUE constraint failed: fixture.id", "constraint"],
      ["D1 transport disconnected", "unavailable"],
    ] as const) {
      let calls = 0;
      const statement = {
        bind() {
          return statement;
        },
        async all(): Promise<D1ResultLike> {
          calls++;
          throw new Error(message);
        },
      };
      const sql = createD1Sql(
        {
          prepare: () => statement,
          async batch() {
            calls++;
            throw new Error(message);
          },
        },
        { acknowledgement: "explicit-d1-result" },
      );
      await expect(sql.run("one")).rejects.toMatchObject({ code });
      await expect(sql.batch([{ sql: "two" }])).rejects.toMatchObject({ code });
      expect(calls).toBe(2);
    }
  });
});
