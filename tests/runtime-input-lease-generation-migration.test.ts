import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";

const MIGRATION = "0065_worker_runtime_input_lease_generation.sql";
const GENERATION = "abcdefghijklmnop";

test("0065 preserves live preparations and refuses to invent a terminal generation", () => {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  try {
    const candidate = MIGRATIONS.find((migration) => migration.name === MIGRATION);
    expect(candidate).toBeDefined();
    for (const migration of MIGRATIONS) {
      if (migration.name === MIGRATION) break;
      database.exec(migration.sql);
    }
    const insert = database.query(
      `INSERT INTO worker_runtime_input_preparations
         (organization_id, operation_key, preparation_id, apply_commitment,
          canonical_public_origin, binding_names_json, sealed_payload,
          seal_nonce, seal_key_id, state, fence, host_operation_id,
          claimed_resource_uid, space, worker_name, worker_resource_uid,
          bundle_name, expires_at, created_at, updated_at)
       VALUES ('org-test', ?, ?, ?, 'https://api.takoserver.test', '["SECRET"]',
               ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, 10000, 100, 100)`,
    );
    insert.run(
      "prepared-operation",
      "prep-prepared",
      `sha256:${"a".repeat(64)}`,
      "sealed-ciphertext",
      GENERATION,
      "key-id",
      "prepared",
      null,
      null,
      null,
      null,
      null,
      null,
    );
    insert.run(
      "dispatched-operation",
      "prep-dispatched",
      `sha256:${"b".repeat(64)}`,
      null,
      null,
      null,
      "dispatched",
      "op-version",
      "uid-version",
      "default",
      "worker",
      "uid-worker",
      "bundle",
    );
    database.exec(candidate?.sql ?? "");
    expect(
      database
        .query(
          "SELECT operation_key, lease_generation FROM worker_runtime_input_preparations ORDER BY operation_key",
        )
        .all(),
    ).toEqual([
      { operation_key: "dispatched-operation", lease_generation: null },
      { operation_key: "prepared-operation", lease_generation: GENERATION },
    ]);
    expect(() =>
      database.exec(
        "UPDATE worker_runtime_input_preparations SET lease_generation = 'malformed' WHERE operation_key = 'prepared-operation'",
      ),
    ).toThrow();
  } finally {
    database.close();
  }
});
