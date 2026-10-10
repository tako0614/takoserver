import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSql, SQLITE_CONTROL_BUSY_TIMEOUT_MS } from "../src/sql-sqlite.ts";

/**
 * The control database is read by operators (`sqlite3`, backup tools, pollers)
 * while the Host writes. SQLite's default is to fail a contended statement
 * immediately with `database is locked`, which the Host then reported as an
 * anonymous background-pass failure. A bounded wait turns a short external read
 * into a short delay; the bound keeps a stuck holder from hanging a write.
 */

function openRoot(): { readonly root: string; readonly path: string } {
  const root = mkdtempSync(join(tmpdir(), "takoserver-busy-timeout-"));
  return { root, path: join(root, "control.sqlite") };
}

/** A separate process, because bun:sqlite blocks its own thread while it waits. */
async function holdWriteLock(path: string, milliseconds: number): Promise<() => Promise<void>> {
  const script = `
    import { Database } from "bun:sqlite";
    const db = new Database(process.argv[1]);
    db.exec("BEGIN IMMEDIATE");
    db.exec("INSERT INTO held VALUES (1)");
    process.stdout.write("locked\\n");
    await Bun.sleep(Number(process.argv[2]));
    db.exec("COMMIT");
  `;
  const child = Bun.spawn([process.execPath, "-e", script, path, String(milliseconds)], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain("locked");
  return async () => {
    await child.exited;
  };
}

test("the control database waits a bounded time instead of failing on an external lock", async () => {
  const { root, path } = openRoot();
  try {
    const setup = new Database(path);
    setup.exec("CREATE TABLE held (n INTEGER)");
    setup.close();

    const database = new Database(path);
    const sql = createSqliteSql(database);
    expect(database.query("PRAGMA busy_timeout").get()).toEqual({
      timeout: SQLITE_CONTROL_BUSY_TIMEOUT_MS,
    });
    expect(SQLITE_CONTROL_BUSY_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(SQLITE_CONTROL_BUSY_TIMEOUT_MS).toBeLessThanOrEqual(10_000);

    const released = await holdWriteLock(path, 400);
    const started = Date.now();
    // Blocks this thread until the other process commits, then succeeds.
    await sql.run("INSERT INTO held VALUES (2)");
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    await released();
    expect(database.query("SELECT count(*) AS n FROM held").get()).toEqual({ n: 2 });
    database.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lock held past the bound still fails closed with a database error", async () => {
  const { root, path } = openRoot();
  try {
    const setup = new Database(path);
    setup.exec("CREATE TABLE held (n INTEGER)");
    setup.close();

    const database = new Database(path);
    const sql = createSqliteSql(database);
    // Lower the wait for this one connection so the test does not spend the
    // production bound; the property under test is "bounded, then an error".
    database.exec("PRAGMA busy_timeout = 100");
    const released = await holdWriteLock(path, 1_200);
    let failure: unknown;
    try {
      await sql.run("INSERT INTO held VALUES (3)");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).message)).toMatch(/locked|busy/iu);
    await released();
    expect(database.query("SELECT count(*) AS n FROM held").get()).toEqual({ n: 1 });
    database.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
