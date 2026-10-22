import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import {
  createForwardWorkerNative106Recipe,
  forwardWorkerNativeSchemaReady,
} from "../src/takoform-v2/forward-worker-native-schema.ts";
import {
  createV2WorkerNativeIdentityMigrationRecipe,
  v2WorkerNativeIdentityDomainReady,
} from "../src/takoform-v2/worker-native-identity-schema.ts";

function apply(db: Database, recipe: ReturnType<typeof createForwardWorkerNative106Recipe>) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const step of recipe.steps) for (const statement of step.statements) db.exec(statement);
    db.exec("COMMIT");
  } catch {
    try {
      db.exec("ROLLBACK");
    } catch {
      // INSERT OR ROLLBACK may already have ended the transaction.
    }
    throw new Error("candidate failed");
  }
}

function predecessor(): Database {
  const db = new Database(":memory:");
  migrateSqlite(db);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const step of createV2WorkerNativeIdentityMigrationRecipe().steps)
      for (const statement of step.statements) db.exec(statement);
    db.exec("COMMIT");
  } catch {
    db.exec("ROLLBACK");
    throw new Error("native identity predecessor failed");
  }
  return db;
}

test("Forward106 changes the exact protected native guard closure atomically", () => {
  const db = predecessor();
  expect(
    db.query(`SELECT 1 WHERE ${v2WorkerNativeIdentityDomainReady("opaque255")}`).all(),
  ).toHaveLength(1);
  expect(db.query(`SELECT 1 WHERE ${forwardWorkerNativeSchemaReady()}`).all()).toHaveLength(0);
  apply(db, createForwardWorkerNative106Recipe());
  expect(db.query(`SELECT 1 WHERE ${forwardWorkerNativeSchemaReady()}`).all()).toHaveLength(1);
  expect(db.query("SELECT count(*) AS n FROM pragma_foreign_key_check").get()).toEqual({ n: 0 });
  expect(
    db
      .query(
        "SELECT count(*) AS n FROM sqlite_schema WHERE name = '_tf_forward_worker_native106_assert'",
      )
      .get(),
  ).toEqual({ n: 0 });
  db.close();
});

test("Forward106 rejects unknown predecessor catalog without partial replacement", () => {
  const db = predecessor();
  db.exec(
    "CREATE TRIGGER unknown_native_guard BEFORE INSERT ON tf_v2_worker_native_effects BEGIN SELECT 1; END",
  );
  expect(() => apply(db, createForwardWorkerNative106Recipe())).toThrow("candidate failed");
  expect(
    db.query("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'unknown_native_guard'").get(),
  ).toEqual({ n: 1 });
  expect(db.query(`SELECT 1 WHERE ${forwardWorkerNativeSchemaReady()}`).all()).toHaveLength(0);
  db.close();
});

test("Forward106 successor seal refuses later unknown guards and incoming foreign keys", () => {
  const db = predecessor();
  apply(db, createForwardWorkerNative106Recipe());
  db.exec(
    "CREATE TRIGGER unknown_native_guard BEFORE INSERT ON tf_v2_worker_native_effects BEGIN SELECT 1; END",
  );
  expect(db.query(`SELECT 1 WHERE ${forwardWorkerNativeSchemaReady()}`).all()).toHaveLength(0);
  db.exec("DROP TRIGGER unknown_native_guard");
  db.exec(
    "CREATE TABLE unknown_native_child(id INTEGER PRIMARY KEY, deletion_id TEXT REFERENCES tf_v2_worker_native_deletions(delete_operation_id))",
  );
  expect(db.query(`SELECT 1 WHERE ${forwardWorkerNativeSchemaReady()}`).all()).toHaveLength(0);
  db.close();
});
