import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";

const MIGRATION = "0057_cloudflare_managed_worker_version_execution_material.sql";
const PREDECESSOR = "0056_vector_index_storage.sql";
const PROVIDER = "cloudflare.wfp.integration";
const INSTALLATION = "cloudflare.wfp.installation";
const ACCOUNT = "account-test";
const NAMESPACE = "namespace-test";
const TENANT = "tenant-test";
const WORKER_UID = "worker-uid";
const VERSION_UID = "version-uid";
const NATIVE_ID = "version:worker:tsr-test";
const WORKER = "worker";
const OPERATION = "release-operation";
const PROTOCOL = "takoserver.managed-worker-release@v4";
const DESCRIPTOR = sha("d");
const PREPARATION = "preparation-test";
const COMMITMENT = sha("c");
const FORMAT = "takoserver.managed-worker-version-execution-material@v1";

const DOMAIN_MIGRATION = "0058_cloudflare_managed_worker_domain_receipts.sql";
const APPLY_PROVIDER_SELECTION_MIGRATION = "0059_takoform_apply_provider_selection.sql";
const OPERATION_GENERATION_MIGRATION = "0060_takoform_operation_generation.sql";
const ACCEPTED_AUTHORITY_CONTINUITY_MIGRATION = "0061_takoform_accepted_authority_continuity.sql";
const PRESERVED_TABLES = [
  "cloudflare_managed_worker_receipts",
  "cloudflare_managed_worker_version_execution_material",
  "cloudflare_managed_worker_version_execution_secrets",
  "cloudflare_managed_worker_version_execution_provider_proofs",
] as const;

for (const phase of ["pending", "committed", "deleting", "deleted"] as const) {
  test(`0058 preserves ${phase} receipt material, ciphertext, and every existing trigger`, () => {
    const database = domainPredecessor();
    insertReceipt(database);
    insertMaterial(database);
    insertSecret(database, "API_KEY");
    insertProof(database, "object:MEDIA:runtime-proof");
    if (phase !== "pending") commitReceipt(database);
    if (phase === "deleting") {
      database
        .query(`UPDATE cloudflare_managed_worker_receipts
        SET state = 'deleting', operation_id = 'delete-operation', generation = 2,
            previous_json = ? WHERE resource_uid = ?`)
        .run(committedReceiptJson(), VERSION_UID);
    }
    if (phase === "deleted") {
      database.exec(`UPDATE cloudflare_managed_worker_receipts
        SET state = 'deleted', provider_etag = NULL, observed_json = '{"deleted":true}'`);
    }
    const rows = preservedRows(database);
    const triggers = database
      .query("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name")
      .all();
    database.transaction(() => database.exec(domainMigrationSql()))();
    expect(preservedRows(database)).toEqual(rows);
    expect(
      database
        .query("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name")
        .all(),
    ).toEqual(triggers);
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(
      database.query("SELECT name FROM sqlite_schema WHERE name LIKE 'migration_0058_%'").all(),
    ).toEqual([]);
    expect(() => replaceSecret(database, "API_KEY")).toThrow();
    if (phase !== "deleted") {
      expect(() =>
        database.exec(
          "UPDATE cloudflare_managed_worker_version_execution_material SET tenant_ref = 'foreign'",
        ),
      ).toThrow("managed_worker_version_execution_material_immutable");
    }
    database.close();
  });
}

test("0058 adds domain without dropping receipt state, identity, or kind constraints", () => {
  const database = domainPredecessor();
  const insert = (kind: string, uid: string) =>
    database
      .query(
        `INSERT INTO cloudflare_managed_worker_receipts
       (provider_id, resource_uid, native_id, kind, logical_worker_id,
        operation_id, generation, descriptor_digest, state, observed_json)
     VALUES (?, ?, ?, ?, 'worker', ?, 1, ?, 'pending', '{}')`,
      )
      .run(PROVIDER, uid, `domain:${uid}`, kind, `create-${uid}`, DESCRIPTOR);
  expect(() => insert("domain", "new-domain")).toThrow();
  database.transaction(() => database.exec(domainMigrationSql()))();
  insert("domain", "new-domain");
  expect(() => insert("unknown", "unknown-domain")).toThrow();
  expect(() => insert("domain", "new-domain")).toThrow();
  expect(() =>
    database.exec("UPDATE cloudflare_managed_worker_receipts SET state = 'deleting'"),
  ).toThrow();
  database.close();
});

test("0058 interrupted receipt rebuild rolls back with exact ciphertext and lineage intact", () => {
  const database = domainPredecessor();
  insertReceipt(database);
  insertMaterial(database);
  insertSecret(database, "API_KEY");
  insertProof(database, "object:MEDIA:runtime-proof");
  const rows = preservedRows(database);
  database.exec("CREATE TABLE applied_migrations (name TEXT PRIMARY KEY, applied_at TEXT)");
  for (const migration of MIGRATIONS.filter(({ name }) => name < DOMAIN_MIGRATION)) {
    database.query("INSERT INTO applied_migrations VALUES (?, 'fixture')").run(migration.name);
  }
  expect(() =>
    migrateSqlite({
      exec(sql) {
        if (sql.startsWith("INSERT INTO cloudflare_managed_worker_receipts SELECT")) {
          throw new Error("injected rebuild interruption");
        }
        return database.exec(sql);
      },
      query: (sql) => database.query(sql),
    }),
  ).toThrow("injected rebuild interruption");
  expect(preservedRows(database)).toEqual(rows);
  expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(
    database.query("SELECT name FROM applied_migrations WHERE name = ?").get(DOMAIN_MIGRATION),
  ).toBeNull();
  expect(migrateSqlite(database).applied).toEqual([
    DOMAIN_MIGRATION,
    APPLY_PROVIDER_SELECTION_MIGRATION,
    OPERATION_GENERATION_MIGRATION,
    ACCEPTED_AUTHORITY_CONTINUITY_MIGRATION,
    "0062_takoform_import_provider_selection.sql",
  ]);
  expect(preservedRows(database)).toEqual(rows);
  database.close();
});

function domainMigrationSql(): string {
  const sql = MIGRATIONS.find(({ name }) => name === DOMAIN_MIGRATION)?.sql;
  if (!sql) throw new Error("domain receipt migration is missing");
  return sql;
}

function domainPredecessor(): Database {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS.filter(({ name }) => name < DOMAIN_MIGRATION)) {
    database.exec(migration.sql);
  }
  return database;
}

function preservedRows(database: Database): readonly unknown[] {
  return PRESERVED_TABLES.map((table) => database.query(`SELECT * FROM ${table}`).all());
}

test("0057 is additive and creates only the receipt-coupled execution-material schema", () => {
  const index = migrationIndex();
  expect(MIGRATIONS[index - 1]?.name).toBe(PREDECESSOR);
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS.slice(0, index)) database.exec(migration.sql);
  insertReceipt(database, { marked: false, resourceUid: "preserved-version" });

  database.exec(MIGRATIONS[index]?.sql ?? "");

  expect(
    database
      .query(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name LIKE
           'cloudflare_managed_worker_version_execution_%'
         ORDER BY name`,
      )
      .all(),
  ).toEqual([
    { name: "cloudflare_managed_worker_version_execution_material" },
    { name: "cloudflare_managed_worker_version_execution_provider_proofs" },
    { name: "cloudflare_managed_worker_version_execution_secrets" },
  ]);
  expect(
    database
      .query(
        `SELECT state, observed_json FROM cloudflare_managed_worker_receipts
         WHERE provider_id = ? AND resource_uid = 'preserved-version'`,
      )
      .get(PROVIDER),
  ).toEqual({ state: "pending", observed_json: "{}" });
});

test("0057 admits only an exact marked pending receipt and immutable declared ciphertext rows", () => {
  const database = migratedDatabase();
  insertReceipt(database);
  insertMaterial(database);
  insertSecret(database, "API_KEY");
  insertProof(database, "object:MEDIA:runtime-proof");

  expect(() =>
    database
      .query(
        `INSERT OR REPLACE INTO cloudflare_managed_worker_version_execution_material
         SELECT * FROM cloudflare_managed_worker_version_execution_material
         WHERE provider_id = ? AND resource_uid = ?`,
      )
      .run(PROVIDER, VERSION_UID),
  ).toThrow("managed_worker_version_execution_material_already_exists");

  expect(() => insertSecret(database, "UNDECLARED")).toThrow(
    "managed_worker_version_execution_secret_not_admissible",
  );
  expect(() => insertProof(database, "object:OTHER:runtime-proof")).toThrow(
    "managed_worker_version_execution_proof_not_admissible",
  );
  expect(() =>
    database
      .query(
        `UPDATE cloudflare_managed_worker_version_execution_material
         SET tenant_ref = 'another-tenant'`,
      )
      .run(),
  ).toThrow("managed_worker_version_execution_material_immutable");
  expect(() =>
    database
      .query(
        `UPDATE cloudflare_managed_worker_version_execution_secrets
         SET ciphertext = ?`,
      )
      .run(new Uint8Array(17)),
  ).toThrow("managed_worker_version_execution_secret_immutable");
  expect(() =>
    database.query("DELETE FROM cloudflare_managed_worker_version_execution_secrets").run(),
  ).toThrow("managed_worker_version_execution_secret_durable");
  expect(() =>
    database.query("DELETE FROM cloudflare_managed_worker_version_execution_material").run(),
  ).toThrow("managed_worker_version_execution_material_receipt_required");

  const other = "version-other";
  insertReceipt(database, {
    resourceUid: other,
    nativeId: "version:worker:other",
    operationId: "other-operation",
  });
  expect(() =>
    insertMaterial(database, {
      resourceUid: other,
      nativeId: "version:worker:other",
      operationId: "other-operation",
      tenantRef: "wrong-tenant",
    }),
  ).toThrow("managed_worker_version_execution_material_receipt_not_exact");

  expect(() =>
    insertMaterial(database, {
      resourceUid: other,
      nativeId: "version:worker:other",
      operationId: "other-operation",
      descriptorJson: JSON.stringify(
        executionDescriptorPublication({
          resourceUid: other,
          nativeId: "version:worker:other",
          operationId: "other-operation",
          tenantRef: "descriptor-tenant-drift",
        }),
      ),
    }),
  ).toThrow("managed_worker_version_execution_material_receipt_not_exact");
});

test("0057 supports a complete zero-secret carrier but refuses an old unmarked receipt", () => {
  const database = migratedDatabase();
  insertReceipt(database, {
    resourceUid: "carrier-version",
    nativeId: "version:worker:carrier",
    operationId: "carrier-operation",
    descriptorDigest: sha("e"),
    secretNames: [],
  });
  insertMaterial(database, {
    resourceUid: "carrier-version",
    nativeId: "version:worker:carrier",
    operationId: "carrier-operation",
    descriptorDigest: sha("e"),
    preparationKind: "none",
    secretNames: [],
    proofNames: ["object:MEDIA:runtime-proof"],
  });
  insertProof(database, "object:MEDIA:runtime-proof", "carrier-version");
  expect(
    database
      .query(
        `SELECT preparation_kind, secret_names_json, provider_proof_names_json
         FROM cloudflare_managed_worker_version_execution_material
         WHERE provider_id = ? AND resource_uid = 'carrier-version'`,
      )
      .get(PROVIDER),
  ).toEqual({
    preparation_kind: "none",
    secret_names_json: "[]",
    provider_proof_names_json: JSON.stringify(["object:MEDIA:runtime-proof"]),
  });

  insertReceipt(database, {
    marked: false,
    resourceUid: "old-version",
    nativeId: "version:worker:old",
    operationId: "old-operation",
    descriptorDigest: sha("f"),
  });
  expect(() =>
    insertMaterial(database, {
      resourceUid: "old-version",
      nativeId: "version:worker:old",
      operationId: "old-operation",
      descriptorDigest: sha("f"),
    }),
  ).toThrow("managed_worker_version_execution_material_receipt_not_exact");
});

test("0057 commits marked receipts only with a complete exact ciphertext set", () => {
  const database = migratedDatabase();
  insertReceipt(database);
  insertMaterial(database);

  expect(() => commitReceipt(database)).toThrow(
    "managed_worker_version_execution_material_incomplete",
  );
  insertSecret(database, "API_KEY");
  expect(() => commitReceipt(database)).toThrow(
    "managed_worker_version_execution_material_incomplete",
  );
  insertProof(database, "object:MEDIA:runtime-proof");
  commitReceipt(database);
  expect(receiptState(database)).toBe("committed");

  const missing = migratedDatabase();
  insertReceipt(missing);
  expect(() => commitReceipt(missing)).toThrow(
    "managed_worker_version_execution_material_incomplete",
  );

  const historical = migratedDatabase();
  insertReceipt(historical, { marked: false });
  commitReceipt(historical);
  expect(receiptState(historical)).toBe("committed");
});

test("0057 refuses late ciphertext inserts and INSERT OR REPLACE in every terminal phase", () => {
  const database = migratedDatabase();
  insertReceipt(database);
  insertMaterial(database);
  insertSecret(database, "API_KEY");
  insertProof(database, "object:MEDIA:runtime-proof");

  expect(() => replaceSecret(database, "API_KEY")).toThrow(
    "managed_worker_version_execution_secret_not_admissible",
  );
  expect(() => replaceProof(database, "object:MEDIA:runtime-proof")).toThrow(
    "managed_worker_version_execution_proof_not_admissible",
  );
  commitReceipt(database);
  for (const operation of [
    () => insertSecret(database, "API_KEY"),
    () => replaceSecret(database, "API_KEY"),
    () => insertProof(database, "object:MEDIA:runtime-proof"),
    () => replaceProof(database, "object:MEDIA:runtime-proof"),
  ]) {
    expect(operation).toThrow("not_admissible");
  }

  const previous = committedReceiptJson();
  database
    .query(
      `UPDATE cloudflare_managed_worker_receipts
       SET state = 'deleting', operation_id = 'delete-operation', generation = 2,
           previous_json = ?
       WHERE provider_id = ? AND resource_uid = ? AND state = 'committed'`,
    )
    .run(previous, PROVIDER, VERSION_UID);
  expect(() => replaceSecret(database, "API_KEY")).toThrow("not_admissible");
  expect(() => replaceProof(database, "object:MEDIA:runtime-proof")).toThrow("not_admissible");

  database
    .query(
      `UPDATE cloudflare_managed_worker_receipts
       SET state = 'deleted', provider_etag = NULL, observed_json = '{"deleted":true}',
           previous_json = NULL
       WHERE provider_id = ? AND resource_uid = ? AND state = 'deleting'`,
    )
    .run(PROVIDER, VERSION_UID);
  expect(materialCounts(database)).toEqual({ headers: 0, secrets: 0, proofs: 0 });
  expect(() => insertSecret(database, "API_KEY")).toThrow("not_admissible");
  expect(() => insertProof(database, "object:MEDIA:runtime-proof")).toThrow("not_admissible");
});

test("0057 removes replacement material in the same predecessor-restore UPDATE", () => {
  const database = migratedDatabase();
  insertReceipt(database, { marked: false });
  database
    .query(
      `UPDATE cloudflare_managed_worker_receipts
       SET state = 'committed', provider_etag = 'etag-one'
       WHERE provider_id = ? AND resource_uid = ?`,
    )
    .run(PROVIDER, VERSION_UID);

  const previous = committedReceiptJson({});
  const replacementNativeId = "version:worker:replacement";
  const replacementOperation = "replacement-operation";
  const replacementDigest = sha("e");
  const replacementObserved = receiptObserved({
    operationId: replacementOperation,
    generation: 2,
  });
  database
    .query(
      `UPDATE cloudflare_managed_worker_receipts
       SET native_id = ?, operation_id = ?, generation = 2, descriptor_digest = ?,
           state = 'pending', provider_etag = NULL, observed_json = ?, previous_json = ?
       WHERE provider_id = ? AND resource_uid = ? AND state = 'committed'`,
    )
    .run(
      replacementNativeId,
      replacementOperation,
      replacementDigest,
      JSON.stringify(replacementObserved),
      previous,
      PROVIDER,
      VERSION_UID,
    );
  insertMaterial(database, {
    nativeId: replacementNativeId,
    operationId: replacementOperation,
    descriptorDigest: replacementDigest,
    generation: 2,
  });
  insertSecret(database, "API_KEY");
  insertProof(database, "object:MEDIA:runtime-proof");
  expect(materialCounts(database)).toEqual({ headers: 1, secrets: 1, proofs: 1 });

  database
    .query(
      `UPDATE cloudflare_managed_worker_receipts
       SET native_id = ?, operation_id = ?, generation = 1, descriptor_digest = ?,
           state = 'committed', provider_etag = 'etag-one', observed_json = ?,
           previous_json = NULL
       WHERE provider_id = ? AND resource_uid = ? AND state = 'pending'
         AND previous_json = ?`,
    )
    .run(NATIVE_ID, OPERATION, DESCRIPTOR, "{}", PROVIDER, VERSION_UID, previous);
  expect(materialCounts(database)).toEqual({ headers: 0, secrets: 0, proofs: 0 });
  expect(receiptState(database)).toBe("committed");
});

test("0057 couples abort and terminal delete to the receipt mutation and fences late writes", () => {
  const aborted = migratedDatabase();
  insertReceipt(aborted);
  insertMaterial(aborted);
  insertSecret(aborted, "API_KEY");
  insertProof(aborted, "object:MEDIA:runtime-proof");
  aborted
    .query(
      `DELETE FROM cloudflare_managed_worker_receipts
       WHERE provider_id = ? AND resource_uid = ? AND state = 'pending'`,
    )
    .run(PROVIDER, VERSION_UID);
  expect(materialCounts(aborted)).toEqual({ headers: 0, secrets: 0, proofs: 0 });
  expect(() => insertMaterial(aborted)).toThrow(
    "managed_worker_version_execution_material_receipt_not_exact",
  );

  const deleted = migratedDatabase();
  insertReceipt(deleted);
  insertMaterial(deleted);
  insertSecret(deleted, "API_KEY");
  insertProof(deleted, "object:MEDIA:runtime-proof");
  deleted
    .query(
      `UPDATE cloudflare_managed_worker_receipts
       SET state = 'committed', provider_etag = 'etag-one'
       WHERE provider_id = ? AND resource_uid = ?`,
    )
    .run(PROVIDER, VERSION_UID);
  expect(materialCounts(deleted)).toEqual({ headers: 1, secrets: 1, proofs: 1 });
  const previous = JSON.stringify({
    resourceUid: VERSION_UID,
    nativeId: NATIVE_ID,
    kind: "version",
    logicalWorkerId: WORKER,
    operationId: OPERATION,
    generation: 1,
    descriptorDigest: DESCRIPTOR,
    state: "committed",
    providerEtag: "etag-one",
    observed: receiptObserved(),
  });
  deleted
    .query(
      `UPDATE cloudflare_managed_worker_receipts
       SET state = 'deleting', operation_id = 'delete-operation', generation = 2,
           previous_json = ?
       WHERE provider_id = ? AND resource_uid = ? AND state = 'committed'`,
    )
    .run(previous, PROVIDER, VERSION_UID);
  expect(materialCounts(deleted)).toEqual({ headers: 1, secrets: 1, proofs: 1 });
  deleted
    .query(
      `UPDATE cloudflare_managed_worker_receipts
       SET state = 'deleted', provider_etag = NULL, observed_json = '{"deleted":true}',
           previous_json = NULL
       WHERE provider_id = ? AND resource_uid = ? AND state = 'deleting'`,
    )
    .run(PROVIDER, VERSION_UID);
  expect(materialCounts(deleted)).toEqual({ headers: 0, secrets: 0, proofs: 0 });
  expect(() => insertMaterial(deleted)).toThrow(
    "managed_worker_version_execution_material_receipt_not_exact",
  );
});

test("0057 enforces canonical bounded name sets and the one-MiB descriptor ceiling", () => {
  const database = migratedDatabase();
  insertReceipt(database);
  expect(() => insertMaterial(database, { secretNames: ["SECOND", "API_KEY"] })).toThrow(
    "managed_worker_version_execution_material_name_set_invalid",
  );
  expect(() =>
    insertMaterial(database, {
      descriptorJson: JSON.stringify(
        executionDescriptorPublication({ padding: "x".repeat(1_048_576) }),
      ),
    }),
  ).toThrow();
  expect(materialCounts(database)).toEqual({ headers: 0, secrets: 0, proofs: 0 });
});

function migrationIndex(): number {
  const index = MIGRATIONS.findIndex(({ name }) => name === MIGRATION);
  expect(index).toBe(56);
  return index;
}

function migratedDatabase(): Database {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS) database.exec(migration.sql);
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function insertReceipt(
  database: Database,
  options: {
    readonly marked?: boolean;
    readonly resourceUid?: string;
    readonly nativeId?: string;
    readonly operationId?: string;
    readonly descriptorDigest?: string;
    readonly secretNames?: readonly string[];
    readonly generation?: number;
  } = {},
): void {
  const resourceUid = options.resourceUid ?? VERSION_UID;
  const nativeId = options.nativeId ?? NATIVE_ID;
  const operationId = options.operationId ?? OPERATION;
  const descriptorDigest = options.descriptorDigest ?? DESCRIPTOR;
  const observed =
    options.marked === false
      ? {}
      : receiptObserved({
          resourceUid,
          operationId,
          secretNames: options.secretNames ?? ["API_KEY"],
          ...(options.generation === undefined ? {} : { generation: options.generation }),
        });
  database
    .query(
      `INSERT INTO cloudflare_managed_worker_receipts
         (provider_id, resource_uid, native_id, kind, logical_worker_id,
          operation_id, generation, descriptor_digest, state, observed_json)
       VALUES (?, ?, ?, 'version', ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      PROVIDER,
      resourceUid,
      nativeId,
      WORKER,
      operationId,
      options.generation ?? 1,
      descriptorDigest,
      JSON.stringify(observed),
    );
}

function receiptObserved(
  options: {
    readonly resourceUid?: string;
    readonly operationId?: string;
    readonly secretNames?: readonly string[];
    readonly generation?: number;
  } = {},
): Readonly<Record<string, unknown>> {
  const secretNames = options.secretNames ?? ["API_KEY"];
  return {
    executionMaterial: { format: FORMAT, publicationGeneration: options.generation ?? 1 },
    releaseProtocol: PROTOCOL,
    ...(secretNames.length === 0
      ? {}
      : {
          releaseProof: {
            providerInstallationId: INSTALLATION,
            accountId: ACCOUNT,
            tenantRef: TENANT,
            dispatchNamespace: NAMESPACE,
            operationId: options.operationId ?? OPERATION,
            resourceUid: options.resourceUid ?? VERSION_UID,
            preparationId: PREPARATION,
            preparationCommitment: COMMITMENT,
            logicalWorkerId: WORKER,
            workerResourceUid: WORKER_UID,
            secretNames,
          },
        }),
  };
}

function insertMaterial(
  database: Database,
  options: {
    readonly resourceUid?: string;
    readonly nativeId?: string;
    readonly operationId?: string;
    readonly descriptorDigest?: string;
    readonly tenantRef?: string;
    readonly preparationKind?: "none" | "runtime_input";
    readonly secretNames?: readonly string[];
    readonly proofNames?: readonly string[];
    readonly descriptorJson?: string;
    readonly generation?: number;
  } = {},
): void {
  const preparationKind = options.preparationKind ?? "runtime_input";
  database
    .query(
      `INSERT INTO cloudflare_managed_worker_version_execution_material
         (provider_id, resource_uid, native_id, provider_installation_id, account_id,
          dispatch_namespace, tenant_ref, worker_resource_uid, logical_worker_id,
          publication_operation_id, publication_generation, release_protocol,
          descriptor_digest, execution_descriptor_digest, preparation_kind, preparation_id,
          preparation_commitment, secret_names_json, provider_proof_names_json,
          descriptor_json, seal_key_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'version-key')`,
    )
    .run(
      PROVIDER,
      options.resourceUid ?? VERSION_UID,
      options.nativeId ?? NATIVE_ID,
      INSTALLATION,
      ACCOUNT,
      NAMESPACE,
      options.tenantRef ?? TENANT,
      WORKER_UID,
      WORKER,
      options.operationId ?? OPERATION,
      options.generation ?? 1,
      PROTOCOL,
      options.descriptorDigest ?? DESCRIPTOR,
      sha("a"),
      preparationKind,
      preparationKind === "runtime_input" ? PREPARATION : null,
      preparationKind === "runtime_input" ? COMMITMENT : null,
      JSON.stringify(options.secretNames ?? (preparationKind === "none" ? [] : ["API_KEY"])),
      JSON.stringify(options.proofNames ?? ["object:MEDIA:runtime-proof"]),
      options.descriptorJson ??
        JSON.stringify(
          executionDescriptorPublication({
            ...(options.resourceUid === undefined ? {} : { resourceUid: options.resourceUid }),
            ...(options.nativeId === undefined ? {} : { nativeId: options.nativeId }),
            ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
            ...(options.descriptorDigest === undefined
              ? {}
              : { descriptorDigest: options.descriptorDigest }),
            ...(options.tenantRef === undefined ? {} : { tenantRef: options.tenantRef }),
            ...(options.generation === undefined ? {} : { generation: options.generation }),
          }),
        ),
    );
}

function insertSecret(database: Database, name: string): void {
  database
    .query(
      `INSERT INTO cloudflare_managed_worker_version_execution_secrets
         (provider_id, resource_uid, name, nonce, ciphertext)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(PROVIDER, VERSION_UID, name, new Uint8Array(12), new Uint8Array(17));
}

function insertProof(database: Database, name: string, resourceUid = VERSION_UID): void {
  database
    .query(
      `INSERT INTO cloudflare_managed_worker_version_execution_provider_proofs
         (provider_id, resource_uid, name, nonce, ciphertext)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(PROVIDER, resourceUid, name, new Uint8Array(12), new Uint8Array(17));
}

function replaceSecret(database: Database, name: string): void {
  database
    .query(
      `INSERT OR REPLACE INTO cloudflare_managed_worker_version_execution_secrets
         (provider_id, resource_uid, name, nonce, ciphertext)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(PROVIDER, VERSION_UID, name, new Uint8Array(12), new Uint8Array(17).fill(1));
}

function replaceProof(database: Database, name: string): void {
  database
    .query(
      `INSERT OR REPLACE INTO cloudflare_managed_worker_version_execution_provider_proofs
         (provider_id, resource_uid, name, nonce, ciphertext)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(PROVIDER, VERSION_UID, name, new Uint8Array(12), new Uint8Array(17).fill(1));
}

function commitReceipt(database: Database): void {
  database
    .query(
      `UPDATE cloudflare_managed_worker_receipts
       SET state = 'committed', provider_etag = 'etag-one'
       WHERE provider_id = ? AND resource_uid = ? AND state = 'pending'`,
    )
    .run(PROVIDER, VERSION_UID);
}

function receiptState(database: Database): string | null {
  return (
    (
      database
        .query(
          `SELECT state FROM cloudflare_managed_worker_receipts
         WHERE provider_id = ? AND resource_uid = ?`,
        )
        .get(PROVIDER, VERSION_UID) as { readonly state: string } | null
    )?.state ?? null
  );
}

function committedReceiptJson(
  observed: Readonly<Record<string, unknown>> = receiptObserved(),
): string {
  return JSON.stringify({
    resourceUid: VERSION_UID,
    nativeId: NATIVE_ID,
    kind: "version",
    logicalWorkerId: WORKER,
    operationId: OPERATION,
    generation: 1,
    descriptorDigest: DESCRIPTOR,
    state: "committed",
    providerEtag: "etag-one",
    observed,
  });
}

function materialCounts(database: Database): {
  readonly headers: number;
  readonly secrets: number;
  readonly proofs: number;
} {
  return database
    .query(
      `SELECT
         (SELECT count(*) FROM cloudflare_managed_worker_version_execution_material) AS headers,
         (SELECT count(*) FROM cloudflare_managed_worker_version_execution_secrets) AS secrets,
         (SELECT count(*) FROM cloudflare_managed_worker_version_execution_provider_proofs) AS proofs`,
    )
    .get() as { headers: number; secrets: number; proofs: number };
}

function sha(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function executionDescriptorPublication(
  options: {
    readonly resourceUid?: string;
    readonly nativeId?: string;
    readonly operationId?: string;
    readonly descriptorDigest?: string;
    readonly tenantRef?: string;
    readonly padding?: string;
    readonly generation?: number;
  } = {},
): Readonly<Record<string, unknown>> {
  return {
    format: "test-descriptor",
    publication: {
      providerId: PROVIDER,
      providerInstallationId: INSTALLATION,
      accountId: ACCOUNT,
      dispatchNamespace: NAMESPACE,
      tenantRef: options.tenantRef ?? TENANT,
      workerResourceUid: WORKER_UID,
      resourceUid: options.resourceUid ?? VERSION_UID,
      nativeId: options.nativeId ?? NATIVE_ID,
      logicalWorkerId: WORKER,
      releaseOperationId: options.operationId ?? OPERATION,
      publicationGeneration: options.generation ?? 1,
      releaseProtocol: PROTOCOL,
      receiptDescriptorDigest: options.descriptorDigest ?? DESCRIPTOR,
    },
    ...(options.padding === undefined ? {} : { padding: options.padding }),
  };
}
