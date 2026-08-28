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

    expect(await store.create("art/create-only", body)).not.toBeNull();
    expect(await store.create("art/create-only", new TextEncoder().encode("different"))).toBeNull();
    expect(await new Response((await store.get("art/create-only"))?.body).text()).toBe(
      "takoform artifact",
    );

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
    expect(first.objects.map((object) => object.key)).toEqual(["art/create-only"]);
    expect(first.truncated).toBe(true);

    const second = await store.list({
      prefix: "art/",
      limit: 1,
      ...(first.cursor ? { cursor: first.cursor } : {}),
    });
    expect(second.objects.map((object) => object.key)).toEqual(["art/one"]);
    expect(second.truncated).toBe(true);

    expect(await store.delete("art/one")).toBe(true);
    expect(await store.delete("art/one")).toBe(false);
  });
});

describe("artifact paths", () => {
  test("accepts a standard hidden web directory but never traversal", async () => {
    const { createTakoformArtifacts } = await import("../src/takoform/artifacts.ts");
    const { createEphemeralSql } = await import("../src/compat.ts");
    const { createMemoryObjectStore } = await import("../src/objects-mem.ts");
    const artifacts = createTakoformArtifacts({
      sql: createEphemeralSql(),
      objects: createMemoryObjectStore(),
      clock: () => new Date(),
      randomId: () => "upload",
    });

    const start = async (path: string) =>
      await artifacts.handle(
        new Request("https://api.test/apis/forms.takoform.com/v1/artifacts/uploads", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `k-${path.length}-aaaa`,
          },
          body: JSON.stringify({
            manifest: {
              apiVersion: "artifacts.takoform.com/v1alpha1",
              kind: "StaticAssetBundle",
              files: [
                { path, mediaType: "text/plain", size: 1, digest: `sha256:${"a".repeat(64)}` },
              ],
            },
          }),
        }),
        { tenantId: "tenant_a", principalId: "principal_a" },
        (code, status) => Response.json({ error: { code } }, { status }),
      );

    // `.well-known` is a standard path; refusing it would make a whole class of
    // real sites undeployable.
    expect((await start(".well-known/nodeinfo"))?.status).toBe(201);
    // Traversal is refused at parse time, before anything is recorded. The
    // transport raises rather than answering; the router is what turns that
    // into a 400 for a caller.
    for (const path of ["../escape", "a/../b", "./here"]) {
      await expect(start(path)).rejects.toMatchObject({ code: "artifact_invalid" });
    }
  });
});

/**
 * A StaticAssetBundle names its files `path` on the wire; every other manifest
 * kind names them `name`. Only an end-to-end commit proves the two agree,
 * because a mismatch surfaces nowhere until the last call of the upload.
 */
describe("static asset bundles", () => {
  test("commits an upload whose files were declared by path", async () => {
    const { createTakoformArtifacts } = await import("../src/takoform/artifacts.ts");
    const { createEphemeralSql } = await import("../src/compat.ts");
    const store = createMemoryObjectStore();
    let issued = 0;
    const artifacts = createTakoformArtifacts({
      sql: createEphemeralSql(),
      objects: store,
      clock: () => new Date(),
      randomId: () => `upload-${++issued}`,
    });
    const principal = { tenantId: "tenant_a", principalId: "principal_a" };
    const fail = (code: string, status: number) => Response.json({ error: { code } }, { status });

    const body = new TextEncoder().encode("<!doctype html>");
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const digest = `sha256:${hex}`;
    const send = (path: string, init: RequestInit) =>
      artifacts.handle(
        new Request(`https://api.test/apis/forms.takoform.com/v1/artifacts/${path}`, init),
        principal,
        fail,
      );

    const started = await send("uploads", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "assets-start" },
      body: JSON.stringify({
        manifest: {
          apiVersion: "artifacts.takoform.com/v1alpha1",
          kind: "StaticAssetBundle",
          files: [{ path: "index.html", mediaType: "text/html", size: body.byteLength, digest }],
        },
      }),
    });
    expect(started?.status).toBe(201);
    const { uploadId } = (await (started as Response).json()) as { uploadId: string };

    expect(
      (await send(`uploads/${uploadId}/blobs/${digest}`, { method: "PUT", body }))?.status,
    ).toBe(201);

    const committed = await send(`uploads/${uploadId}/commit`, {
      method: "POST",
      headers: { "idempotency-key": "assets-commit" },
    });
    expect(committed?.status).toBe(201);
    expect(await committed?.json()).toEqual({ manifestDigest: expect.any(String) });
  });
});
