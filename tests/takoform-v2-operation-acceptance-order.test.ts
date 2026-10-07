import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import type { Sql } from "../src/ports.ts";
import { createD1Sql } from "../src/sql-d1.ts";

function migration(name: string): string {
  const sql = MIGRATIONS.find((item) => item.name === name)?.sql;
  if (!sql) throw new Error(`missing ${name}`);
  return sql;
}

function operationStatements(id: string, order?: number) {
  return {
    resource: {
      sql: `INSERT INTO tf_v2_resources
      (uid, principal, form_url, space, name, backend_id, target_key,
       active_name, generation, phase, spec_json, last_operation, busy_operation)
     VALUES (?, 'org-1', 'https://example.test/form', 'prod', ?, 'backend', 'target',
             ?, 1, 'pending', '{}', ?, ?)`,
      params: [`resource-${id}`, id, id, id, id],
    },
    operation: {
      sql: `INSERT INTO tf_v2_operations
      (id, resource_uid, principal, replay_key, request_fingerprint, action, generation,
       status, effect, created_at, updated_at, retain_until, backend_id, target_key,
       backend_key, accepted_spec_json${order === undefined ? "" : ", acceptance_order"})
     VALUES (?, ?, 'org-1', ?, 'fingerprint', 'create', 1,
             'queued', 'none', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z',
             '2030-01-01T00:00:00.000Z', 'backend', 'target', ?, '{}'
             ${order === undefined ? "" : ", ?"})`,
      params:
        order === undefined
          ? [id, `resource-${id}`, id, id]
          : [id, `resource-${id}`, id, id, order],
    },
  };
}

function insertOperation(db: Database, id: string, order?: number) {
  const statements = operationStatements(id, order);
  db.query(statements.resource.sql).run(...statements.resource.params);
  db.query(statements.operation.sql).run(...statements.operation.params);
}

async function insertD1Operation(sql: Sql, id: string, order?: number) {
  const statements = operationStatements(id, order);
  await sql.run(statements.resource.sql, statements.resource.params);
  await sql.run(statements.operation.sql, statements.operation.params);
}

test("0077 orders new accepted Operations atomically and leaves historical order unknown", () => {
  const db = new Database(":memory:");
  try {
    db.exec(migration("0070_takoform_v2.sql"));
    insertOperation(db, "historical");
    db.exec(migration("0077_v2_operation_acceptance_order.sql"));
    expect(
      db.query("SELECT acceptance_order FROM tf_v2_operations WHERE id = 'historical'").get(),
    ).toEqual({ acceptance_order: null });

    insertOperation(db, "first");
    insertOperation(db, "second");
    expect(
      db
        .query(
          "SELECT id, acceptance_order FROM tf_v2_operations WHERE acceptance_order IS NOT NULL ORDER BY acceptance_order",
        )
        .all(),
    ).toEqual([
      { id: "first", acceptance_order: 1 },
      { id: "second", acceptance_order: 2 },
    ]);
    expect(() =>
      db.exec("UPDATE tf_v2_operations SET acceptance_order = 3 WHERE id = 'historical'"),
    ).toThrow("tf_v2_operation_acceptance_order_immutable");
    expect(() =>
      db.exec("UPDATE tf_v2_operations SET acceptance_order = 4 WHERE id = 'first'"),
    ).toThrow("tf_v2_operation_acceptance_order_immutable");
    expect(() => insertOperation(db, "supplied", 99)).toThrow(
      "tf_v2_operation_acceptance_order_supplied",
    );

    db.exec(`CREATE TRIGGER fixture_reject_order BEFORE UPDATE ON tf_v2_operation_acceptance_counter
      WHEN NEW.last_operation_id = 'failed'
      BEGIN SELECT RAISE(ABORT, 'fixture_allocator_failure'); END`);
    expect(() => insertOperation(db, "failed")).toThrow("fixture_allocator_failure");
    expect(db.query("SELECT 1 FROM tf_v2_operations WHERE id = 'failed'").get()).toBeNull();
    expect(db.query("SELECT last_order FROM tf_v2_operation_acceptance_counter").get()).toEqual({
      last_order: 2,
    });
    db.exec("DROP TRIGGER fixture_reject_order");
    insertOperation(db, "third");
    db.exec("VACUUM");
    expect(
      db
        .query(
          "SELECT id, acceptance_order FROM tf_v2_operations WHERE acceptance_order IS NOT NULL ORDER BY acceptance_order",
        )
        .all(),
    ).toEqual([
      { id: "first", acceptance_order: 1 },
      { id: "second", acceptance_order: 2 },
      { id: "third", acceptance_order: 3 },
    ]);
  } finally {
    db.close();
  }
});

test("local Miniflare D1 preserves 0077 acceptance order and failed-insert atomicity", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "v2-operation-order-d1-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "v2-operation-order-d1-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    for (const previous of MIGRATIONS.filter(({ name }) => /^007[0-6]_/.test(name))) {
      for (const statement of splitMigration(previous.sql)) await database.prepare(statement).run();
    }
    const sql = createD1Sql(database);
    await insertD1Operation(sql, "historical");
    for (const statement of splitMigration(migration("0077_v2_operation_acceptance_order.sql")))
      await database.prepare(statement).run();
    expect(
      await sql.query("SELECT acceptance_order FROM tf_v2_operations WHERE id = 'historical'"),
    ).toEqual([{ acceptance_order: null }]);
    await insertD1Operation(sql, "first");
    await insertD1Operation(sql, "second");
    await expect(
      sql.run("UPDATE tf_v2_operations SET acceptance_order = 3 WHERE id = 'historical'"),
    ).rejects.toThrow("tf_v2_operation_acceptance_order_immutable");
    await expect(insertD1Operation(sql, "supplied", 99)).rejects.toThrow(
      "tf_v2_operation_acceptance_order_supplied",
    );
    await sql.run(`CREATE TRIGGER fixture_reject_order BEFORE UPDATE ON tf_v2_operation_acceptance_counter
      WHEN NEW.last_operation_id = 'failed'
      BEGIN SELECT RAISE(ABORT, 'fixture_allocator_failure'); END`);
    await expect(insertD1Operation(sql, "failed")).rejects.toThrow("fixture_allocator_failure");
    expect(await sql.query("SELECT 1 FROM tf_v2_operations WHERE id = 'failed'")).toEqual([]);
    expect(await sql.query("SELECT last_order FROM tf_v2_operation_acceptance_counter")).toEqual([
      { last_order: 2 },
    ]);
    await sql.run("DROP TRIGGER fixture_reject_order");
    await insertD1Operation(sql, "third");
    expect(
      await sql.query(
        "SELECT id, acceptance_order FROM tf_v2_operations WHERE acceptance_order IS NOT NULL ORDER BY acceptance_order",
      ),
    ).toEqual([
      { id: "first", acceptance_order: 1 },
      { id: "second", acceptance_order: 2 },
      { id: "third", acceptance_order: 3 },
    ]);
  } finally {
    await runtime.dispose();
  }
});

function splitMigration(source: string): readonly string[] {
  const statements: string[] = [];
  let rest = source.replace(/^\s*--.*$/gmu, "").trim();
  while (rest.length > 0) {
    if (/^CREATE\s+(?:TEMP\s+)?TRIGGER\b/iu.test(rest)) {
      const end = /^END\s*;/imu.exec(rest);
      if (!end || end.index === undefined) throw new Error("incomplete migration trigger");
      const boundary = end.index + end[0].length;
      statements.push(rest.slice(0, boundary).trim());
      rest = rest.slice(boundary).trim();
      continue;
    }
    const boundary = rest.indexOf(";");
    if (boundary < 0) {
      statements.push(rest);
      break;
    }
    const statement = rest.slice(0, boundary).trim();
    if (statement) statements.push(statement);
    rest = rest.slice(boundary + 1).trim();
  }
  return statements;
}
