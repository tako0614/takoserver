import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { type Sql, SqlError } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

function ledgerSql(): Sql {
  const database = new Database(":memory:");
  const sql = createSqliteSql(database);
  database.exec(`
    CREATE TABLE ledger (
      id TEXT PRIMARY KEY NOT NULL,
      org_id TEXT NOT NULL,
      type TEXT NOT NULL,
      ref TEXT NOT NULL,
      settled_delta INTEGER NOT NULL,
      held_delta INTEGER NOT NULL,
      UNIQUE (org_id, type, ref)
    );
    CREATE TABLE operations (
      id TEXT PRIMARY KEY NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      not_before INTEGER NOT NULL DEFAULT 0
    );
  `);
  return sql;
}

describe("Sql port", () => {
  test("reports the rows a write actually changed", async () => {
    const sql = ledgerSql();

    const inserted = await sql.run(
      "INSERT INTO ledger (id, org_id, type, ref, settled_delta, held_delta) VALUES (?, ?, ?, ?, ?, ?)",
      ["e1", "org_a", "funding", "ref_1", 5_000, 0],
    );
    expect(inserted.changes).toBe(1);

    // The same funding reference must never credit twice. The UNIQUE index is
    // the invariant; INSERT OR IGNORE turns it into a zero-change no-op.
    const replayed = await sql.run(
      "INSERT OR IGNORE INTO ledger (id, org_id, type, ref, settled_delta, held_delta) VALUES (?, ?, ?, ?, ?, ?)",
      ["e2", "org_a", "funding", "ref_1", 5_000, 0],
    );
    expect(replayed.changes).toBe(0);

    const rows = await sql.query("SELECT COUNT(*) AS total FROM ledger WHERE org_id = ?", [
      "org_a",
    ]);
    expect(rows).toEqual([{ total: 1 }]);
  });

  test("expresses a balance guard as a single statement", async () => {
    const sql = ledgerSql();
    await sql.run(
      "INSERT INTO ledger (id, org_id, type, ref, settled_delta, held_delta) VALUES (?, ?, ?, ?, ?, ?)",
      ["e1", "org_a", "funding", "ref_1", 1_000, 0],
    );

    const hold = (id: string, amount: number) =>
      sql.run(
        `INSERT INTO ledger (id, org_id, type, ref, settled_delta, held_delta)
         SELECT ?, ?, 'hold', ?, 0, ?
         WHERE (SELECT COALESCE(SUM(settled_delta - held_delta), 0) FROM ledger WHERE org_id = ?) >= ?`,
        [id, "org_a", id, amount, "org_a", amount],
      );

    expect((await hold("h1", 600)).changes).toBe(1);
    // 400 remains available, so a second 600 hold must not be written at all.
    expect((await hold("h2", 600)).changes).toBe(0);
    expect((await hold("h3", 400)).changes).toBe(1);

    const [available] = await sql.query(
      "SELECT COALESCE(SUM(settled_delta - held_delta), 0) AS available FROM ledger WHERE org_id = ?",
      ["org_a"],
    );
    expect(available).toEqual({ available: 0 });
  });

  test("claims a row exactly once under contention", async () => {
    const sql = ledgerSql();
    await sql.run("INSERT INTO operations (id, state, not_before) VALUES (?, 'pending', 0)", [
      "op_1",
    ]);

    const claim = () =>
      sql.run(
        "UPDATE operations SET not_before = ?, attempts = attempts + 1 WHERE id = ? AND state = 'pending' AND not_before <= ?",
        [30, "op_1", 0],
      );

    expect((await claim()).changes).toBe(1);
    // The lease moved forward, so the second claimer finds nothing to take.
    expect((await claim()).changes).toBe(0);
  });

  test("commits a batch all or none", async () => {
    const sql = ledgerSql();

    await expect(
      sql.batch([
        {
          sql: "INSERT INTO ledger (id, org_id, type, ref, settled_delta, held_delta) VALUES (?, ?, ?, ?, ?, ?)",
          params: ["e1", "org_a", "funding", "ref_1", 100, 0],
        },
        {
          sql: "INSERT INTO ledger (id, org_id, type, ref, settled_delta, held_delta) VALUES (?, ?, ?, ?, ?, ?)",
          params: ["e2", "org_a", "funding", "ref_1", 100, 0],
        },
      ]),
    ).rejects.toBeInstanceOf(SqlError);

    // The first statement succeeded before the UNIQUE violation aborted the
    // batch; nothing may survive.
    expect(await sql.query("SELECT COUNT(*) AS total FROM ledger")).toEqual([{ total: 0 }]);

    const written = await sql.batch([
      {
        sql: "INSERT INTO ledger (id, org_id, type, ref, settled_delta, held_delta) VALUES (?, ?, ?, ?, ?, ?)",
        params: ["e1", "org_a", "funding", "ref_1", 100, 0],
      },
      {
        sql: "UPDATE operations SET state = 'succeeded' WHERE id = ?",
        params: ["absent"],
      },
    ]);
    expect(written.map((entry) => entry.changes)).toEqual([1, 0]);
    expect(await sql.query("SELECT COUNT(*) AS total FROM ledger")).toEqual([{ total: 1 }]);
  });

  test("classifies a constraint violation apart from an outage", async () => {
    const sql = ledgerSql();
    const failure = await sql
      .run("INSERT INTO ledger (id, org_id, type, ref) VALUES (?, ?, ?, ?)", [
        "e1",
        "org_a",
        "funding",
        "ref_1",
      ])
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SqlError);
    expect((failure as SqlError).code).toBe("constraint");
  });
});

describe("ObjectStore port", () => {
  test("round-trips bytes and pages a prefix", async () => {
    const store = createMemoryObjectStore();
    const body = new TextEncoder().encode("takoform artifact");

    const written = await store.put("art/one", body, { contentType: "text/plain" });
    expect(written.size).toBe(body.byteLength);
    expect(written.contentType).toBe("text/plain");

    const read = await store.get("art/one");
    expect(read).not.toBeNull();
    expect(new Uint8Array(await new Response(read?.body).arrayBuffer())).toEqual(body);
    // The etag is derived from content, so an identical body re-put is stable.
    expect((await store.put("art/two", body)).etag).toBe(written.etag);

    expect(await store.head("art/absent")).toBeNull();

    const first = await store.list({ prefix: "art/", limit: 1 });
    expect(first.objects.map((object) => object.key)).toEqual(["art/one"]);
    expect(first.truncated).toBe(true);

    const second = await store.list({
      prefix: "art/",
      limit: 1,
      ...(first.cursor ? { cursor: first.cursor } : {}),
    });
    expect(second.objects.map((object) => object.key)).toEqual(["art/two"]);
    expect(second.truncated).toBe(false);

    expect(await store.delete("art/one")).toBe(true);
    expect(await store.delete("art/one")).toBe(false);
  });
});
