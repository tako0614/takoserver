import { Counter } from "./counter.mjs";

// Independent application-side witness around the ordinary Counter. All
// persisted witness data belongs to the same application-private SQL store.
export class Witness extends Counter {
  constructor(context, env) {
    super(context, env);
    this.order = ["constructor"];
  }
  async start(turn) {
    this.order.push("start");
    await super.start(turn);
    await this.context.storage.execute("CREATE TABLE IF NOT EXISTS witness (n INTEGER)");
    await this.context.storage.execute("INSERT INTO witness VALUES (1)");
    this.order.push("ready");
  }
  async fetch(request, turn) {
    this.order.push("fetch");
    const url = new URL(request.url);
    if (url.pathname === "/sql-probe") {
      const errors = [];
      for (const [sql, params] of [
        ["INSERT INTO counter VALUES (2, ?)", [1e20]],
        ["INSERT INTO counter VALUES (3, 7) RETURNING 1e20 AS value", []],
        ["INSERT INTO counter VALUES (4, 7); INSERT INTO counter VALUES (5, 8)", []],
        ["INSERT INTO counter VALUES (1, 7)", []],
        ["SELECT ?", [{ encoding: "base64", data: "bad!" }]],
        [
          "WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<10001) SELECT v FROM n",
          [],
        ],
      ]) {
        try {
          await this.context.storage.execute(sql, params);
          errors.push("allowed");
        } catch (error) {
          errors.push({ name: error.name, code: error.code });
        }
      }
      await this.context.storage.execute("CREATE TABLE IF NOT EXISTS trigger_log (value INTEGER)");
      await this.context.storage.execute(
        "CREATE TRIGGER IF NOT EXISTS record_counter AFTER UPDATE ON counter BEGIN INSERT INTO trigger_log VALUES (CASE WHEN new.value > 0 THEN new.value ELSE 0 END); INSERT INTO trigger_log VALUES (1); END; -- trailing comment",
      );
      await this.context.storage.query("UPDATE counter SET value = 777");
      const triggerRollback = await this.context.storage.query(
        "SELECT count(*) AS n FROM trigger_log",
      );
      await this.context.storage.execute("DROP TRIGGER record_counter");
      return Response.json({
        errors,
        rows: (await this.context.storage.query("SELECT * FROM counter ORDER BY id")).rows,
        triggerRollback: triggerRollback.rows[0].n,
      });
    }
    if (url.searchParams.has("hold")) {
      const gate = await this.env.CONTROL.fetch("http://control/hold");
      await gate.text();
    }
    if (url.pathname === "/witness") {
      const starts = await this.context.storage.query("SELECT count(*) AS n FROM witness");
      let hidden;
      try {
        await import("./host.mjs");
        hidden = "allowed";
      } catch {
        hidden = "blocked";
      }
      let builtin;
      try {
        await import("cloudflare:workers");
        builtin = "allowed";
      } catch {
        builtin = "blocked";
      }
      await this.context.storage.query(
        "INSERT INTO counter VALUES (1, 999) ON CONFLICT(id) DO UPDATE SET value = 999",
      );
      let atomic;
      try {
        await this.context.storage.transaction([
          { sql: "UPDATE counter SET value = 888" },
          { sql: "INVALID" },
        ]);
        atomic = "committed";
      } catch (error) {
        atomic = error.code;
      }
      await this.context.storage.query("CREATE TABLE query_must_rollback (value INTEGER)");
      const schema = await this.context.storage.query(
        "SELECT name FROM sqlite_schema WHERE type = 'table'",
      );
      await this.context.storage.execute("CREATE TABLE IF NOT EXISTS blobs (value BLOB)");
      await this.context.storage.execute("DELETE FROM blobs");
      const committed = await this.context.storage.transaction([
        { sql: "INSERT INTO blobs VALUES (?)", params: [{ encoding: "base64", data: "AAH/" }] },
        { sql: "SELECT value FROM blobs" },
      ]);
      const controls = [];
      for (const sql of ["COMMIT", "ROLLBACK", "BEGIN", "SAVEPOINT escape"]) {
        try {
          await this.context.storage.execute(sql);
          controls.push("allowed");
        } catch (error) {
          controls.push(error.code);
        }
      }
      return Response.json({
        order: this.order,
        starts: starts.rows[0].n,
        hidden,
        builtin,
        atomic,
        schema: schema.rows.map((row) => row.name),
        blob: committed.results[1].rows[0].value,
        controls,
        contextKeys: Object.keys(this.context).sort(),
        storageKeys: Object.keys(this.context.storage).sort(),
        envKeys: Object.keys(this.env).sort(),
        signal: turn.signal instanceof AbortSignal,
      });
    }
    return super.fetch(request, turn);
  }
}
