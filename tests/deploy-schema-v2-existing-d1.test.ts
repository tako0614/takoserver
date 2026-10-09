import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";

function statements(source: string): readonly string[] {
  const result: string[] = [];
  let rest = source.replace(/^\s*--.*$/gmu, "").trim();
  while (rest) {
    const end = /^CREATE\s+(?:TEMP\s+)?TRIGGER\b/iu.test(rest)
      ? /^END\s*;/imu.exec(rest)
      : /;/u.exec(rest);
    if (!end) throw new Error("incomplete audited migration statement");
    const length = end.index + end[0].length;
    result.push(rest.slice(0, length));
    rest = rest.slice(length).trim();
  }
  return result;
}

test("real local D1 retains populated v1 data across canonical 0066→0088", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "v2-existing-wave-d1-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default {fetch(){return new Response('ok')}}",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "v2-existing-wave-d1-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const db = await runtime.getD1Database("STATE_DB");
    await db
      .prepare(
        "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
      )
      .run();
    async function apply(start: number, end: number) {
      for (const migration of MIGRATIONS.slice(start, end)) {
        for (const statement of statements(migration.sql)) await db.prepare(statement).run();
        await db
          .prepare("INSERT INTO d1_migrations(name,applied_at) VALUES (?, 'fixture')")
          .bind(migration.name)
          .run();
      }
    }
    await apply(0, 66);
    await db
      .prepare(`INSERT INTO cloudflare_managed_worker_receipts
      (provider_id, resource_uid, native_id, kind, logical_worker_id, operation_id,
       generation, descriptor_digest, state)
      VALUES ('provider-a', 'worker-a', 'worker:worker-a', 'worker', 'worker-a',
       'create-worker-a', 1, ?, 'committed')`)
      .bind(`sha256:${"a".repeat(64)}`)
      .run();
    const before = await db
      .prepare(
        "SELECT provider_id,resource_uid,native_id,state FROM cloudflare_managed_worker_receipts WHERE resource_uid='worker-a'",
      )
      .first();
    await apply(66, 88);
    const after = await db
      .prepare(
        "SELECT provider_id,resource_uid,native_id,state FROM cloudflare_managed_worker_receipts WHERE resource_uid='worker-a'",
      )
      .first();
    expect(after).toEqual(before);
    expect(
      (await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all()).results.map(
        (row) => row.name,
      ),
    ).toEqual(MIGRATIONS.slice(0, 88).map((migration) => migration.name));
    expect(
      await db
        .prepare("SELECT state FROM tf_cloudflare_provider_invocation_epoch WHERE singleton=1")
        .first(),
    ).toMatchObject({ state: "closed" });
    expect(
      (await db.prepare("PRAGMA table_info(tf_v2_worker_invocations)").all()).results.map(
        (row) => row.name,
      ),
    ).toContain("sqlite_drain_state");
  } finally {
    await runtime.dispose();
  }
}, 120_000);
