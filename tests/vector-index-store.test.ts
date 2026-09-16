import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import type { Sql, SqlParam, SqlStatement } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  createVectorIndexStore,
  type VectorIndexConfigInput,
  type VectorIndexStore,
} from "../src/vector-index-store.ts";

const SCOPE = { tenantId: "tenant-a", resourceUid: "resource-a" } as const;
const OTHER_TENANT_SCOPE = { tenantId: "tenant-b", resourceUid: "resource-a" } as const;
const CONFIG = {
  dimension: 3,
  metric: "cosine",
  filterKeys: ["boolValue", "kind", "longValue", "numberValue", "spaceId", "textValue"],
} as const;

interface Fixture {
  readonly database: Database;
  readonly sql: Sql;
  readonly store: VectorIndexStore;
}

interface SqlTrace {
  readonly sql: Sql;
  readonly queryParams: readonly (readonly SqlParam[])[];
  readonly runParams: readonly (readonly SqlParam[])[];
  readonly batches: readonly (readonly SqlStatement[])[];
}

function fixture(): Fixture {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS) database.exec(migration.sql);
  const sql = createSqliteSql(database);
  return { database, sql, store: createVectorIndexStore({ sql }) };
}

async function configured(
  recordLimit = 1_000,
  config: VectorIndexConfigInput = CONFIG,
  scope: { readonly tenantId: string; readonly resourceUid: string } = SCOPE,
): Promise<Fixture> {
  const value = fixture();
  await value.store.createIndex({ ...scope, config, recordLimit });
  return value;
}

function record(
  id: string,
  values: readonly number[] = [1, 0, 0],
  metadata: Record<string, string | number | boolean | null> = {},
) {
  return { id, values, metadata };
}

function tracedSql(
  inner: Sql,
  failBatch?: (statements: readonly SqlStatement[]) => boolean,
): SqlTrace {
  const queryParams: SqlParam[][] = [];
  const runParams: SqlParam[][] = [];
  const batches: SqlStatement[][] = [];
  const sql: Sql = {
    async query(statement, params) {
      queryParams.push([...(params ?? [])]);
      return inner.query(statement, params);
    },
    async run(statement, params) {
      runParams.push([...(params ?? [])]);
      return inner.run(statement, params);
    },
    async batch(statements) {
      batches.push([...statements]);
      if (failBatch?.(statements)) throw new Error("simulated unavailable");
      return inner.batch(statements);
    },
  };
  return { sql, queryParams, runParams, batches };
}

async function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ${code} error`);
}

describe("bounded VectorIndex SQL store lifecycle", () => {
  test("creates an immutable config, is idempotent, and keeps the private quota bounded", async () => {
    const value = fixture();
    await value.store.createIndex({ ...SCOPE, config: CONFIG, recordLimit: 2 });
    // Omitted private options do not reinterpret an existing explicit quota.
    await value.store.ensureIndex({
      ...SCOPE,
      config: { ...CONFIG, filterKeys: [...CONFIG.filterKeys].reverse() },
    });
    expect(await value.store.readIndex(SCOPE)).toMatchObject({
      ...SCOPE,
      config: { dimension: 3, metric: "cosine", filterKeys: [...CONFIG.filterKeys].sort() },
      recordLimit: 2,
    });

    await expectCode(
      () => value.store.createIndex({ ...SCOPE, config: { ...CONFIG, dimension: 4 } }),
      "invalid_spec",
    );
    await expectCode(
      () => value.store.createIndex({ ...SCOPE, config: CONFIG, recordLimit: 3 }),
      "invalid_spec",
    );
    expect(await value.store.readIndex(SCOPE)).toMatchObject({ recordLimit: 2 });
    await expectCode(
      () => value.store.createIndex({ ...SCOPE, config: CONFIG, recordLimit: 0 }),
      "invalid_spec",
    );
    await expectCode(
      () => value.store.createIndex({ ...SCOPE, config: CONFIG, recordLimit: 1_001 }),
      "invalid_spec",
    );
  });

  test("maps malformed persisted configuration to unavailable", async () => {
    const value = await configured();
    value.database.exec("DROP TRIGGER vector_index_config_immutable");
    await value.sql.run(
      `UPDATE vector_indexes SET filter_keys_json = ? WHERE tenant_id = ? AND resource_uid = ?`,
      ["{malformed", SCOPE.tenantId, SCOPE.resourceUid],
    );
    await expectCode(() => value.store.readIndex(SCOPE), "unavailable");
    await expectCode(() => value.store.query(SCOPE, { values: [1, 0, 0], topK: 1 }), "unavailable");
  });

  test("maps malformed persisted metadata to unavailable", async () => {
    const value = await configured();
    await value.store.upsert(SCOPE, { vectors: [record("corrupt", [1, 0, 0])] });
    await value.sql.run(
      `UPDATE vector_index_records SET metadata_json = ?
       WHERE tenant_id = ? AND resource_uid = ? AND namespace = ? AND id = ?`,
      ['{"nested":{"no":"scalars"}}', SCOPE.tenantId, SCOPE.resourceUid, "", "corrupt"],
    );
    await expectCode(() => value.store.get(SCOPE, { ids: ["corrupt"] }), "unavailable");
  });

  test("isolates tenants and namespaces for reads, filters, and counts", async () => {
    const value = await configured();
    await value.store.createIndex({ ...OTHER_TENANT_SCOPE, config: CONFIG });
    await value.store.upsert(SCOPE, {
      namespace: "one",
      vectors: [record("shared", [1, 0, 0], { spaceId: "one" })],
    });
    await value.store.upsert(SCOPE, {
      namespace: "two",
      vectors: [record("shared", [0, 1, 0], { spaceId: "two" })],
    });
    await value.store.upsert(OTHER_TENANT_SCOPE, {
      namespace: "one",
      vectors: [record("shared", [0, 0, 1], { spaceId: "other" })],
    });

    expect(await value.store.readCount(SCOPE)).toBe(2);
    expect(await value.store.readCount(OTHER_TENANT_SCOPE)).toBe(1);
    expect((await value.store.get(SCOPE, { namespace: "one", ids: ["shared"] })).vectors).toEqual([
      { id: "shared", values: [1, 0, 0], metadata: { spaceId: "one" } },
    ]);
    expect((await value.store.get(SCOPE, { ids: ["shared"] })).vectors).toEqual([]);
    expect(
      (
        await value.store.query(SCOPE, {
          namespace: "two",
          values: [0, 1, 0],
          topK: 10,
          filter: { spaceId: "two" },
        })
      ).matches.map((match) => match.id),
    ).toEqual(["shared"]);
    expect(
      (
        await value.store.query(OTHER_TENANT_SCOPE, {
          namespace: "one",
          values: [0, 0, 1],
          topK: 10,
        })
      ).matches.map((match) => match.id),
    ).toEqual(["shared"]);
  });

  test("replaces the complete record and clears stale filter terms and metadata", async () => {
    const value = await configured();
    await value.store.upsert(SCOPE, {
      vectors: [record("replace", [1, 0, 0], { spaceId: "old", kind: "old", textValue: "kept" })],
    });
    await value.store.upsert(SCOPE, {
      vectors: [record("replace", [0, 1, 0], { spaceId: "new" })],
    });
    expect((await value.store.get(SCOPE, { ids: ["replace"] })).vectors).toEqual([
      { id: "replace", values: [0, 1, 0], metadata: { spaceId: "new" } },
    ]);
    expect(
      (
        await value.store.query(SCOPE, {
          values: [1, 0, 0],
          topK: 10,
          filter: { spaceId: "old" },
        })
      ).matches,
    ).toEqual([]);
    expect(
      (
        await value.store.query(SCOPE, {
          values: [0, 1, 0],
          topK: 10,
          filter: { spaceId: "new" },
        })
      ).matches.map((match) => match.id),
    ).toEqual(["replace"]);
    const terms = await value.sql.query(
      `SELECT filter_key, value_type, canonical_scalar_json
       FROM vector_index_filter_terms WHERE tenant_id = ? AND resource_uid = ?`,
      [SCOPE.tenantId, SCOPE.resourceUid],
    );
    expect(terms).toEqual([
      { filter_key: "spaceId", value_type: "string", canonical_scalar_json: '"new"' },
    ]);
  });

  test("validates the complete upsert before its first effect", async () => {
    const value = await configured();
    await expectCode(
      () =>
        value.store.upsert(SCOPE, {
          vectors: [record("valid"), { id: "invalid", values: [0, 0, 0], metadata: {} }],
        }),
      "invalid_spec",
    );
    expect(await value.store.readCount(SCOPE)).toBe(0);
  });
});

describe("bounded VectorIndex SQL records and quotas", () => {
  test("allows replacement at quota, rejects new keys, and serializes concurrent admissions", async () => {
    const value = await configured(1);
    await value.store.upsert(SCOPE, { vectors: [record("only", [1, 0, 0])] });
    await value.store.upsert(SCOPE, { vectors: [record("only", [0, 1, 0])] });
    await expectCode(() => value.store.upsert(SCOPE, { vectors: [record("new")] }), "quota");
    expect(await value.store.readCount(SCOPE)).toBe(1);

    const concurrent = await configured(1);
    const results = await Promise.allSettled([
      concurrent.store.upsert(SCOPE, { vectors: [record("concurrent-a")] }),
      concurrent.store.upsert(SCOPE, { vectors: [record("concurrent-b")] }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "quota" } });
    expect(await concurrent.store.readCount(SCOPE)).toBe(1);
  });

  test("keeps an already-committed prefix when a later per-record batch is unavailable", async () => {
    const value = await configured(2);
    let batches = 0;
    const traced = tracedSql(value.sql, () => {
      batches += 1;
      return batches === 2;
    });
    const store = createVectorIndexStore({ sql: traced.sql });
    await expectCode(
      () => store.upsert(SCOPE, { vectors: [record("first"), record("second")] }),
      "unavailable",
    );
    expect(await value.store.readCount(SCOPE)).toBe(1);
    expect(
      (await value.store.get(SCOPE, { ids: ["first", "second"] })).vectors.map((item) => item.id),
    ).toEqual(["first"]);
  });

  test("indexes exact scalar types including null and long strings", async () => {
    const value = await configured();
    const longValue = "x".repeat(8_170);
    await value.store.upsert(SCOPE, {
      vectors: [
        record("text", [1, 0, 0], { textValue: "1" }),
        record("number", [1, 0, 0], { numberValue: 1 }),
        record("bool", [1, 0, 0], { boolValue: true }),
        record("null", [1, 0, 0], { textValue: null }),
        record("long", [1, 0, 0], { longValue }),
      ],
    });
    async function query(filter: Record<string, string | number | boolean | null>) {
      return (await value.store.query(SCOPE, { values: [1, 0, 0], topK: 100, filter })).matches.map(
        (match) => match.id,
      );
    }
    expect(await query({ textValue: "1" })).toEqual(["text"]);
    expect(await query({ textValue: 1 })).toEqual([]);
    expect(await query({ numberValue: 1 })).toEqual(["number"]);
    expect(await query({ boolValue: true })).toEqual(["bool"]);
    expect(await query({ textValue: null })).toEqual(["null"]);
    expect(await query({ longValue })).toEqual(["long"]);
    const terms = await value.sql.query(
      `SELECT filter_key, value_type FROM vector_index_filter_terms
       WHERE tenant_id = ? AND resource_uid = ? AND id = ? ORDER BY filter_key`,
      [SCOPE.tenantId, SCOPE.resourceUid, "null"],
    );
    expect(terms).toEqual([{ filter_key: "textValue", value_type: "null" }]);
  });
});

describe("bounded VectorIndex SQL reads and exact query", () => {
  test("returns get results in request order, omits unknowns, and deletes idempotently", async () => {
    const value = await configured();
    await value.store.upsert(SCOPE, {
      vectors: [record("a", [1, 0, 0]), record("b", [0, 1, 0])],
    });
    const got = await value.store.get(SCOPE, { ids: ["b", "missing", "a"] });
    expect(got.vectors.map((item) => item.id)).toEqual(["b", "a"]);
    const deleted = await value.store.delete(SCOPE, { ids: ["missing", "b"] });
    expect(deleted).toEqual({ ids: ["missing", "b"], count: 2 });
    expect((await value.store.get(SCOPE, { ids: ["b"] })).vectors).toEqual([]);
    expect(await value.store.delete(SCOPE, { ids: ["missing"] })).toEqual({
      ids: ["missing"],
      count: 1,
    });
  });

  test("keeps D1-style id batches at or below 100 parameters", async () => {
    const value = await configured();
    const ids = Array.from({ length: 100 }, (_, index) => `id-${String(index).padStart(3, "0")}`);
    await value.store.upsert(SCOPE, { vectors: ids.map((id) => record(id)) });
    const trace = tracedSql(value.sql);
    const store = createVectorIndexStore({ sql: trace.sql });
    const got = await store.get(SCOPE, { ids: [...ids].reverse() });
    expect(got.vectors.map((item) => item.id)).toEqual([...ids].reverse());
    await store.delete(SCOPE, { ids });
    const idCalls = [...trace.queryParams, ...trace.runParams].filter(
      (params) => params.length > 3,
    );
    expect(idCalls.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...idCalls.map((params) => params.length))).toBeLessThanOrEqual(100);
  });

  test("scans all pages, retains topK at 100, and only hydrates requested flags", async () => {
    const value = await configured();
    const ids = Array.from({ length: 100 }, (_, index) => `item-${String(index).padStart(3, "0")}`);
    await value.store.upsert(SCOPE, {
      vectors: ids.map((id, index) =>
        record(id, [index === 99 ? 0 : 1, index === 99 ? 1 : 0, 0], { kind: "all" }),
      ),
    });
    const trace = tracedSql(value.sql);
    const store = createVectorIndexStore({ sql: trace.sql });
    const result = await store.query(SCOPE, {
      values: [1, 0, 0],
      topK: 100,
      filter: { kind: "all" },
      returnMetadata: true,
      returnValues: true,
    });
    expect(result.count).toBe(100);
    expect(result.matches.map((match) => match.id)).toEqual(ids.slice(0, 99).concat("item-099"));
    for (const match of result.matches) {
      expect(match.score).toBeGreaterThanOrEqual(-1);
      expect(match.score).toBeLessThanOrEqual(1);
      expect(Number.isFinite(match.score)).toBe(true);
      expect(match.metadata).toEqual({ kind: "all" });
      expect(match.values).toBeDefined();
    }
    const withoutFlags = await store.query(SCOPE, { values: [1, 0, 0], topK: 1 });
    expect(withoutFlags.count).toBe(1);
    const match = withoutFlags.matches[0];
    expect(match && Object.hasOwn(match, "metadata")).toBe(false);
    expect(match && Object.hasOwn(match, "values")).toBe(false);
    const hydrationCalls = trace.queryParams.filter((params) => params.length > 3);
    expect(hydrationCalls.every((params) => params.length <= 100)).toBe(true);
  });

  test("does not combine a pre-replacement candidate with post-replacement metadata", async () => {
    const value = await configured();
    await value.store.upsert(SCOPE, {
      vectors: [record("race", [1, 0, 0], { spaceId: "before" })],
    });
    let replaced = false;
    const racingSql: Sql = {
      async query(statement, params) {
        const rows = await value.sql.query(statement, params);
        if (statement.includes("ORDER BY record.id ASC") && !replaced) {
          replaced = true;
          await value.store.upsert(SCOPE, {
            vectors: [record("race", [0, 1, 0], { spaceId: "before", textValue: "after" })],
          });
        }
        return rows;
      },
      run: (statement, params) => value.sql.run(statement, params),
      batch: (statements) => value.sql.batch(statements),
    };
    const racingStore = createVectorIndexStore({ sql: racingSql });
    const result = await racingStore.query(SCOPE, {
      values: [1, 0, 0],
      topK: 1,
      filter: { spaceId: "before" },
      returnMetadata: true,
    });
    // The replacement still satisfies the filter, so hydration returns its
    // complete row and recomputes the score instead of pairing old values with
    // new metadata.
    expect(result.matches).toEqual([
      {
        id: "race",
        score: 0,
        metadata: { spaceId: "before", textValue: "after" },
      },
    ]);
  });

  test("rejects out-of-bounds and undeclared query specifications", async () => {
    const value = await configured();
    await expectCode(
      () => value.store.query(SCOPE, { values: [1, 0, 0], topK: 101 }),
      "invalid_spec",
    );
    await expectCode(() => value.store.query(SCOPE, { values: [1, 0], topK: 1 }), "invalid_spec");
    await expectCode(
      () => value.store.query(SCOPE, { values: [1, 0, 0], topK: 1, filter: { notDeclared: "x" } }),
      "invalid_spec",
    );
    await expectCode(
      () => value.store.upsert(SCOPE, { namespace: "*", vectors: [record("bad")] }),
      "invalid_spec",
    );
    await expectCode(() => value.store.upsert(SCOPE, { vectors: [record("")] }), "invalid_spec");
  });

  test("deletes the index with an atomic foreign-key cascade", async () => {
    const value = await configured();
    await value.store.upsert(SCOPE, {
      vectors: [record("cascade", [1, 0, 0], { spaceId: "x" })],
    });
    expect(
      (await value.sql.query("SELECT COUNT(*) AS count FROM vector_index_filter_terms"))[0]?.count,
    ).toBe(1);
    expect(await value.store.deleteIndex(SCOPE)).toBe(true);
    expect(await value.store.deleteIndex(SCOPE)).toBe(false);
    expect(await value.store.readIndex(SCOPE)).toBeNull();
    expect(await value.store.readCount(SCOPE)).toBe(0);
    expect(
      (await value.sql.query("SELECT COUNT(*) AS count FROM vector_index_records"))[0]?.count,
    ).toBe(0);
    expect(
      (await value.sql.query("SELECT COUNT(*) AS count FROM vector_index_filter_terms"))[0]?.count,
    ).toBe(0);
  });
});
