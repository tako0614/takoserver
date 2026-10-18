import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { CONTAINER_CONTRACT as C } from "../src/container-contract.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMoneyCutoverSql } from "../src/money-cutover-sql.ts";
import type { Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { readV2ConfiguredPrivateInputs } from "../src/takoform-v2/configured-private-inputs.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../src/takoform-v2/configured-update-inputs-schema.ts";
import {
  createV2ContainerHostAcceptance,
  inspectV2ContainerOwnerSchema,
  V2_CONTAINER_OWNER_RECIPE as recipe,
  V2_CONTAINER_F2_FORM,
  V2_CONTAINER_OWNER_READY,
} from "../src/takoform-v2/container-owner-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  redeemV2HostAcceptance,
  type V2HostAcceptanceContext,
  type V2PreparedHostAcceptance,
} from "../src/takoform-v2/host-acceptance.ts";
import { TakoformV2Error, type V2Backend, type V2Form } from "../src/takoform-v2/types.ts";
import { currentAuditedSchemaMigrations } from "./helpers/audited-schema-fixture.ts";

// These domain-history seeds live ONLY in the five new owned tables, before
// guards are installed. They are NOT accepted Core rows or native grants. We
// deliberately create no pretend full100/Core table. The full100 Core batch
// coverage below uses the canonical migration and audited source fixture.
const UID = "resource-a";
const INCARNATION = "a".repeat(64);
const CLAIM = "b".repeat(64);
const NATIVE = "c".repeat(64);
const at = "2026-10-15T21:00:00.000Z";
const spec = JSON.stringify({
  image: `registry.example/image@sha256:${"d".repeat(64)}`,
  httpPort: 8080,
  healthPath: "/",
  workloadRevision: "v1",
  requiredSensitiveVars: [],
  outboundInternet: true,
});

function seed(
  db: Database,
  options: { uid?: string; incarnation?: string; deletion?: boolean } = {},
) {
  const uid = options.uid ?? UID;
  const incarnation = options.incarnation ?? INCARNATION;
  db.query(`INSERT INTO tf_v2_container_instances
    (resource_uid, installation_id, principal, space, name, form_url, backend_id, target_key,
      incarnation_id, create_operation_id, desired_generation, management_epoch, serving_generation, runtime_epoch, created_at)
    VALUES (?, 'installation', 'principal', 'space', 'same-name', ?, 'backend', 'target', ?, ?, 2, 2, 1, 1, ?)`).run(
    uid,
    C.formUrl,
    incarnation,
    `${uid}-create`,
    at,
  );
  for (const generation of options.deletion ? [1, 2, 3] : [1, 2]) {
    const action = generation === 1 ? "create" : generation === 2 ? "update" : "delete";
    const operation = `${uid}-${action}`;
    db.query(`INSERT INTO tf_v2_container_acceptances
      (operation_id, resource_uid, installation_id, incarnation_id, principal, space, name, form_url, backend_id, target_key,
       action, generation, backend_key, replay_key, fingerprint, accepted_spec_json, accepted_output_json,
       references_json, configured_private_inputs_json, accepted_at, retain_until, revision)
      VALUES (?, ?, 'installation', ?, 'principal', 'space', 'same-name', ?, 'backend', 'target', ?, ?, ?, ?,
        'fingerprint', ?, '{}', NULL, NULL, ?, '2027-01-01T00:00:00.000Z', ?)`).run(
      operation,
      uid,
      incarnation,
      C.formUrl,
      action,
      generation,
      operation,
      operation,
      spec,
      at,
      `${generation}-v1`,
    );
    if (action === "delete") continue; // Domain-only accepted DELETE anchor, not a CREATE revision.
    db.query(`INSERT INTO tf_v2_container_revisions
      (resource_uid, generation, operation_id, revision, retention) VALUES (?, ?, ?, ?, ?)`).run(
      uid,
      generation,
      operation,
      `${generation}-v1`,
      generation === 1 ? "serving" : "accepted",
    );
  }
}
function fixture(options: { seed?: boolean; extraSeed?: boolean; deletion?: boolean } = {}) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON");
  for (const object of [...recipe.tables, ...recipe.indexes]) db.exec(object.sql);
  if (options.seed !== false) {
    seed(db, { ...(options.deletion === undefined ? {} : { deletion: options.deletion }) });
  }
  if (options.extraSeed) seed(db, { uid: "resource-b", incarnation: "e".repeat(64) });
  for (const guard of recipe.guards) db.exec(guard.sql);
  return db;
}
function intent(generation = 1, overrides: Record<string, unknown> = {}) {
  return {
    installationId: "installation",
    resourceUid: UID,
    incarnationId: INCARNATION,
    revision: `${generation}-v1`,
    nativeName: `owned-${generation}`,
    identityLabel: "owned-label",
    revisionLabel: `revision-${generation}`,
    policy: {
      tenantRef: "tenant",
      generation,
      policyDigest: `sha256:${"f".repeat(64)}`,
      outboundInternet: true,
    },
    requiredSecretNames: [],
    ...overrides,
  };
}
function prepareIntent(db: Database, generation = 1, value = intent(generation)) {
  db.query(`UPDATE tf_v2_container_revisions SET intent_json = ?, native_name = ?
    WHERE resource_uid = ? AND generation = ?`).run(
    JSON.stringify(value),
    value.nativeName,
    UID,
    generation,
  );
}
function claim(db: Database, generation = 1, claimId = CLAIM) {
  db.query(`INSERT INTO tf_v2_container_create_claims
    (resource_uid, generation, installation_id, claim_id, state, claimed_at_ms)
    VALUES (?, ?, 'installation', ?, 'pending', 10)`).run(UID, generation, claimId);
}
function bind(db: Database, generation = 1, native = NATIVE) {
  db.query(`UPDATE tf_v2_container_create_claims SET state = 'bound', native_id = ?, bound_at_ms = 11
    WHERE resource_uid = ? AND generation = ?`).run(native, UID, generation);
}
function start(db: Database, attempt = 1, generation = 1, native = NATIVE, claimId = CLAIM) {
  db.query(`INSERT INTO tf_v2_container_start_attempts
    (resource_uid, generation, attempt, create_claim_id, native_id, state, claimed_at_ms)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(
    UID,
    generation,
    attempt,
    claimId,
    native,
    20 + attempt * 10,
  );
}
function running(db: Database, generation = 1, attempt = 1) {
  db.query(`UPDATE tf_v2_container_start_attempts SET state = 'running', confirmed_running_at_ms = ?
    WHERE resource_uid = ? AND generation = ? AND attempt = ?`).run(
    21 + attempt * 10,
    UID,
    generation,
    attempt,
  );
}
function exited(db: Database, generation = 1, attempt = 1) {
  db.query(`UPDATE tf_v2_container_start_attempts SET state = 'exited', confirmed_exited_at_ms = ?
    WHERE resource_uid = ? AND generation = ? AND attempt = ?`).run(
    22 + attempt * 10,
    UID,
    generation,
    attempt,
  );
}

const context = (overrides: Partial<V2HostAcceptanceContext> = {}): V2HostAcceptanceContext => ({
  action: "create",
  principal: "principal",
  key: "key",
  fingerprint: "fingerprint",
  operationId: "operation",
  resourceUid: UID,
  generation: 1,
  at,
  retainUntil: "2027-01-01T00:00:00.000Z",
  form: C.formUrl,
  space: "space",
  name: "same-name",
  backendId: "backend",
  targetKey: "target",
  specJson: spec,
  outputJson: "{}",
  referencesJson: null,
  ...overrides,
});
const noIO: Sql = {
  async query() {
    throw new Error("no Core fixture or database operation permitted");
  },
  async run() {
    throw new Error("no database operation permitted");
  },
  async batch() {
    throw new Error("no database operation permitted");
  },
};
const issuer = (sql = noIO) =>
  createV2ContainerHostAcceptance({
    sql,
    installationId: "installation",
    backendId: "backend",
    targetKey: "target",
  });

test("closed owning schema rejects partial, changed and foreign dependency shapes", async () => {
  const db = fixture();
  try {
    const sql = createSqliteSql(db);
    expect(await inspectV2ContainerOwnerSchema(sql)).toBe(true);
    db.exec("CREATE TABLE unrelated_fixture(value TEXT)");
    expect(await inspectV2ContainerOwnerSchema(sql)).toBe(true);
    db.exec("CREATE TABLE foreign_input(value REFERENCES TF_V2_CONTAINER_INSTANCES(resource_uid))");
    expect(await inspectV2ContainerOwnerSchema(sql)).toBe(false);
  } finally {
    db.close();
  }
  const partial = fixture();
  try {
    partial.exec(`DROP TRIGGER ${recipe.guards[0]!.name}`);
    expect(await inspectV2ContainerOwnerSchema(createSqliteSql(partial))).toBe(false);
  } finally {
    partial.close();
  }
});

test("same historical name has independent UID/incarnation; birth and scope cannot change", () => {
  const db = fixture({ extraSeed: true });
  try {
    expect(
      db.query("SELECT count(DISTINCT incarnation_id) AS n FROM tf_v2_container_instances").get(),
    ).toEqual({ n: 2 });
    for (const [column, value] of [
      ["principal", "foreign"],
      ["space", "foreign"],
      ["installation_id", "foreign"],
      ["target_key", "foreign"],
      ["name", "new"],
      ["incarnation_id", "9".repeat(64)],
      ["create_operation_id", "other"],
    ]) {
      expect(() =>
        db
          .query(`UPDATE tf_v2_container_instances SET ${column} = ? WHERE resource_uid = ?`)
          .run(value!, UID),
      ).toThrow();
    }
    expect(() => db.exec("DELETE FROM tf_v2_container_instances")).toThrow();
    expect(() =>
      db.exec("UPDATE tf_v2_container_acceptances SET retain_until = 'expired'"),
    ).toThrow();
  } finally {
    db.close();
  }
});

test("intent is closed, scope-fixed and immutable, including before CREATE claim", () => {
  const db = fixture();
  try {
    for (const value of [
      intent(1, { incarnationId: "0".repeat(64) }),
      intent(1, { resourceUid: "foreign" }),
      intent(1, { environment: { TOKEN: "secret-canary" } }),
      intent(1, { requiredSecretNames: ["TOKEN"] }),
      intent(1, { policy: {} }),
    ]) {
      expect(() => prepareIntent(db, 1, value)).toThrow();
    }
    prepareIntent(db);
    expect(() => prepareIntent(db, 1, intent(1, { nativeName: "mutated" }))).toThrow();
    claim(db);
    expect(() =>
      db.exec(
        "UPDATE tf_v2_container_revisions SET intent_json = NULL, native_name = NULL WHERE generation = 1",
      ),
    ).toThrow();
  } finally {
    db.close();
  }
});

test("durable pending CREATE is consumed: duplicate, unknown, rearm and foreign claim refuse", () => {
  const db = fixture();
  try {
    expect(() => claim(db)).toThrow(); // No prepared intent, never send.
    prepareIntent(db);
    claim(db);
    expect(() => claim(db)).toThrow();
    expect(() => db.exec("UPDATE tf_v2_container_create_claims SET state = 'removed'")).toThrow();
    expect(() => db.exec("DELETE FROM tf_v2_container_create_claims")).toThrow();
    expect(() =>
      db.exec("UPDATE tf_v2_container_create_claims SET installation_id = 'foreign'"),
    ).toThrow();
    expect(db.query("SELECT state, native_id FROM tf_v2_container_create_claims").get()).toEqual({
      state: "pending",
      native_id: null,
    });
    bind(db);
    expect(() => bind(db, 1, "0".repeat(64))).toThrow();
    db.exec("UPDATE tf_v2_container_create_claims SET state = 'removed', removed_at_ms = 50");
    expect(() => claim(db)).toThrow();
    expect(() =>
      db.exec(
        "UPDATE tf_v2_container_create_claims SET state = 'pending', native_id = NULL, bound_at_ms = NULL, removed_at_ms = NULL",
      ),
    ).toThrow();
  } finally {
    db.close();
  }
});

test("START has separate consumed pending history; only running then exited permits successor", () => {
  const db = fixture();
  try {
    prepareIntent(db);
    claim(db);
    bind(db);
    start(db);
    expect(() => start(db, 2)).toThrow();
    expect(() => exited(db)).toThrow(); // Stopped/404/timeout cannot forge running->exit.
    expect(() =>
      db.exec("UPDATE tf_v2_container_create_claims SET state = 'removed', removed_at_ms = 100"),
    ).toThrow();
    expect(() => db.exec("DELETE FROM tf_v2_container_start_attempts")).toThrow();
    running(db);
    exited(db);
    start(db, 2);
    expect(() => start(db, 3)).toThrow();
    expect(() =>
      db.exec("UPDATE tf_v2_container_start_attempts SET native_id = 'wrong'"),
    ).toThrow();
    expect(
      db.query("SELECT attempt, state FROM tf_v2_container_start_attempts ORDER BY attempt").all(),
    ).toEqual([
      { attempt: 1, state: "exited" },
      { attempt: 2, state: "pending" },
    ]);
  } finally {
    db.close();
  }
});

test("failed desiredG2 retains historicalG1 restart; cutover drains old generation permanently", () => {
  const db = fixture();
  try {
    prepareIntent(db);
    claim(db);
    bind(db);
    start(db);
    running(db);
    exited(db);
    start(db, 2);
    expect(
      db
        .query(
          "SELECT desired_generation, serving_generation, runtime_epoch FROM tf_v2_container_instances",
        )
        .get(),
    ).toEqual({ desired_generation: 2, serving_generation: 1, runtime_epoch: 1 });
    prepareIntent(db, 2);
    claim(db, 2, "1".repeat(64));
    bind(db, 2, "2".repeat(64));
    expect(() =>
      db.exec("UPDATE tf_v2_container_instances SET serving_generation = 2, runtime_epoch = 2"),
    ).toThrow();
    start(db, 1, 2, "2".repeat(64), "1".repeat(64));
    running(db, 2);
    db.exec(
      "UPDATE tf_v2_container_instances SET serving_generation = 2, runtime_epoch = 2 WHERE runtime_epoch = 1",
    );
    expect(
      db
        .query(
          "UPDATE tf_v2_container_instances SET serving_generation = 2, runtime_epoch = 2 WHERE runtime_epoch = 1",
        )
        .run().changes,
    ).toBe(0);
    expect(
      db
        .query("SELECT generation, retention FROM tf_v2_container_revisions ORDER BY generation")
        .all(),
    ).toEqual([
      { generation: 1, retention: "draining" },
      { generation: 2, retention: "serving" },
    ]);
    running(db, 1, 2);
    exited(db, 1, 2);
    expect(() => start(db, 3)).toThrow();
    expect(() =>
      db.exec("UPDATE tf_v2_container_instances SET serving_generation = 1, runtime_epoch = 3"),
    ).toThrow();
    expect(() => db.exec("UPDATE tf_v2_container_instances SET runtime_epoch = 0")).toThrow();
  } finally {
    db.close();
  }
});

test("synthetic accepted DELETE anchor retires storage without resurrecting retained runtime", () => {
  const db = fixture({ deletion: true });
  try {
    prepareIntent(db);
    claim(db);
    bind(db);
    start(db);
    running(db);
    db.exec(`UPDATE tf_v2_container_instances SET desired_generation = 3, management_epoch = 3,
      serving_generation = NULL, runtime_epoch = 2, retire_operation_id = 'resource-a-delete', retired_at_ms = 100
      WHERE resource_uid = 'resource-a' AND management_epoch = 2`);
    expect(
      db.query("SELECT retention FROM tf_v2_container_revisions ORDER BY generation").all(),
    ).toEqual([{ retention: "retired" }, { retention: "retired" }]);
    expect(() =>
      db.exec("UPDATE tf_v2_container_instances SET serving_generation = 1, runtime_epoch = 3"),
    ).toThrow();
    expect(() =>
      db.exec(
        "UPDATE tf_v2_container_instances SET retired_at_ms = NULL, retire_operation_id = NULL",
      ),
    ).toThrow();
    exited(db); // Record actual late completion; this is not another native START.
    expect(() => start(db, 2)).toThrow();
    db.exec("UPDATE tf_v2_container_create_claims SET state = 'removed', removed_at_ms = 101");
    expect(() => claim(db)).toThrow();
    expect(db.query("SELECT count(*) AS n FROM tf_v2_container_acceptances").get()).toEqual({
      n: 3,
    });
  } finally {
    db.close();
  }
});

test("all durable histories retain rows and have no Core TTL/cascade foreign keys", () => {
  const db = fixture();
  try {
    prepareIntent(db);
    claim(db);
    bind(db);
    start(db);
    for (const table of recipe.tables) {
      expect(() => db.exec(`DELETE FROM ${table.name}`)).toThrow();
      const foreign = db.query(`PRAGMA foreign_key_list('${table.name}')`).all() as {
        table: string;
        on_delete: string;
      }[];
      for (const row of foreign) {
        expect(row.table.startsWith("tf_v2_container_")).toBe(true);
        expect(row.on_delete).toBe("NO ACTION");
      }
    }
    expect(
      db
        .query(
          "SELECT name FROM main.sqlite_schema WHERE name IN ('tf_v2_resources', 'tf_v2_operations')",
        )
        .all(),
    ).toEqual([]);
  } finally {
    db.close();
  }
});

test("compiler seals exact Sql/context and captures fixed source bytes without IO", async () => {
  const issue = issuer();
  issue.assertSql(noIO);
  expect(() => issue.assertSql({ ...noIO })).toThrow();
  expect(
    issue.initialOutput({ form: C.formUrl, backendId: "backend", targetKey: "target", name: "n" }),
  ).toBeUndefined();
  const c = context();
  const pending = issue.prepare(c);
  Object.assign(c, { principal: "changed", specJson: "{}", operationId: "changed" });
  const prepared = await pending;
  expect(prepared).toBeDefined();
  const fixed = redeemV2HostAcceptance(prepared!, noIO, c);
  expect(fixed.terminal.params).toContain("principal");
  expect(fixed.terminal.params).toContain(spec);
  expect(fixed.terminal.params).not.toContain("changed");
  expect(fixed.terminal.sql).toContain("op.backend_key");
  expect(fixed.terminal.sql).toContain("INSERT INTO main.tf_v2_container_acceptances");
  expect(fixed.terminal.sql).not.toContain("OR IGNORE");
  expect(() => redeemV2HostAcceptance(prepared!, noIO, { ...c })).toThrow();
  expect(() => redeemV2HostAcceptance({} as V2PreparedHostAcceptance, noIO, c)).toThrow();
  expect(issue.prepare(context({ form: "https://other.invalid/form/" }))).toBeUndefined();
});

test("F2 CREATE UPDATE and DELETE readiness reaches the actual Money guarded batch", async () => {
  let rawBatches = 0;
  const raw: Sql = {
    ...noIO,
    async batch(statements) {
      rawBatches++;
      expect(statements).toHaveLength(3);
      throw new Error("F2 guard reached raw batch");
    },
  };
  const sql = createMoneyCutoverSql(raw, `sha256:${"a".repeat(64)}`);
  const issue = issuer(sql);
  const create = Object.freeze(context({ form: V2_CONTAINER_F2_FORM }));
  const update = Object.freeze(
    context({
      form: V2_CONTAINER_F2_FORM,
      action: "update",
      generation: 2,
    }),
  );
  const deletion = Object.freeze({
    ...context({ form: V2_CONTAINER_F2_FORM }),
    action: "delete" as const,
    generation: 2,
    referencesJson: null,
  });
  const cases = [
    { context: create, prepared: await issue.prepare(create), scope: [create.resourceUid] },
    {
      context: update,
      prepared: await issue.prepare(update),
      scope: [
        update.resourceUid,
        "installation",
        update.principal,
        update.space,
        update.name,
        update.form,
        "backend",
        "target",
        1,
      ],
    },
    {
      context: deletion,
      prepared: await issue.prepareDelete!(deletion),
      scope: [
        deletion.resourceUid,
        "installation",
        deletion.principal,
        deletion.space,
        deletion.name,
        deletion.form,
        "backend",
        "target",
        1,
      ],
    },
  ];
  for (const [index, entry] of cases.entries()) {
    if (!entry.prepared) throw new TypeError("F2 acceptance missing");
    const fixed = redeemV2HostAcceptance(entry.prepared, sql, entry.context);
    const guardParams = fixed.guard.params;
    if (!guardParams) throw new TypeError("F2 guard bindings missing");
    await expect(
      sql.batch([{ sql: `SELECT 1 WHERE (${fixed.guard.sql})`, params: guardParams }]),
    ).rejects.toThrow("F2 guard reached raw batch");
    expect(rawBatches).toBe(index + 1);
    expect(guardParams[0]).toBe(
      JSON.stringify(recipe.objects.map(({ type, name, table, sql }) => [type, name, table, sql])),
    );
    expect(guardParams.slice(1)).toEqual(entry.scope);
  }
});

test("frozen0.1 compiler rejects sensitive/private custody but preserves validated true egress", async () => {
  const issue = issuer();
  expect(await issue.prepare(context())).toBeDefined();
  expect(() =>
    issue.prepare(
      context({
        specJson: JSON.stringify({ ...JSON.parse(spec), requiredSensitiveVars: ["TOKEN"] }),
      }),
    ),
  ).toThrow();
  expect(() =>
    issue.prepare(context({ specJson: '{"workloadRevision":"v1","workloadRevision":"v2"}' })),
  ).toThrow();
  expect(() =>
    issue.prepare(
      context({ configuredPrivateInputs: { keyId: "k", nonce: "n", ciphertext: "secret-canary" } }),
    ),
  ).toThrow();
  expect(() =>
    issue.prepare(
      context({
        privateInputs: {
          namesJson: '["TOKEN"]',
          comparisonKeyId: "k",
          comparisonTag: "tag",
          transferKeyId: "k",
          transferNonce: "n",
          transferCiphertext: "secret-canary",
          transferExpiresAtMs: 20,
        },
      }),
    ),
  ).toThrow();
  for (const patch of [
    { principal: "" },
    { targetKey: "foreign" },
    { backendId: "foreign" },
    { generation: 2 },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    expect(() => issue.prepare(context(patch))).toThrow();
  }
  expect(() =>
    issue.prepare({ ...context(), action: "delete" } as unknown as V2HostAcceptanceContext),
  ).toThrow();
  const update = context({ action: "update", generation: 2 });
  const prepared = await issue.prepare(update);
  expect(redeemV2HostAcceptance(prepared!, noIO, update).terminal.sql).toContain(
    "SELECT incarnation_id FROM main.tf_v2_container_instances",
  );
});

test("domain-only additive candidate conserves unrelated schema/data and leaves no assertion", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE unrelated_fixture(value TEXT); INSERT INTO unrelated_fixture VALUES ('preserve')",
    );
    const sql = createSqliteSql(db);
    const statements = v2ContainerOwnerMigrationCandidate();
    expect(Object.isFrozen(statements)).toBe(true);
    await sql.batch(statements);
    expect(await inspectV2ContainerOwnerSchema(sql)).toBe(true);
    expect(db.query("SELECT value FROM unrelated_fixture").all()).toEqual([{ value: "preserve" }]);
    expect(
      db
        .query(
          "SELECT name FROM main.sqlite_schema WHERE name = 'v2_container_owner_candidate_assertion'",
        )
        .all(),
    ).toEqual([]);
    expect(
      db
        .query(
          "SELECT name FROM main.sqlite_schema WHERE name IN ('tf_v2_operations', 'tf_v2_resources')",
        )
        .all(),
    ).toEqual([]);
    const before = db.query("SELECT type, name, sql FROM main.sqlite_schema ORDER BY name").all();
    await expect(sql.batch(v2ContainerOwnerMigrationCandidate())).rejects.toThrow();
    expect(db.query("SELECT type, name, sql FROM main.sqlite_schema ORDER BY name").all()).toEqual(
      before,
    );
  } finally {
    db.close();
  }
});

test("candidate refuses case-insensitive incoming FK, partial namespace and assertion collision atomically", async () => {
  for (const collision of [
    "CREATE TABLE foreign_input(value REFERENCES TF_V2_CONTAINER_INSTANCES(resource_uid))",
    "CREATE TABLE tf_v2_container_unknown(value TEXT)",
    "CREATE TABLE v2_container_owner_candidate_assertion(value TEXT)",
  ]) {
    const db = new Database(":memory:");
    try {
      db.exec(collision);
      const before = db.query("SELECT type, name, sql FROM main.sqlite_schema ORDER BY name").all();
      await expect(
        createSqliteSql(db).batch(v2ContainerOwnerMigrationCandidate()),
      ).rejects.toThrow();
      expect(
        db.query("SELECT type, name, sql FROM main.sqlite_schema ORDER BY name").all(),
      ).toEqual(before);
    } finally {
      db.close();
    }
  }
});

test("every injected candidate failure rolls back all newly owned objects", async () => {
  const statements = v2ContainerOwnerMigrationCandidate();
  for (let offset = 1; offset <= statements.length; offset += 1) {
    const db = new Database(":memory:");
    try {
      db.exec(
        "CREATE TABLE unrelated_fixture(value TEXT); INSERT INTO unrelated_fixture VALUES ('preserve')",
      );
      const before = db.query("SELECT type, name, sql FROM main.sqlite_schema ORDER BY name").all();
      await expect(
        createSqliteSql(db).batch([
          ...statements.slice(0, offset),
          { sql: "SELECT missing_owner_failure_injection()" },
          ...statements.slice(offset),
        ]),
      ).rejects.toThrow("missing_owner_failure_injection");
      expect(
        db.query("SELECT type, name, sql FROM main.sqlite_schema ORDER BY name").all(),
      ).toEqual(before);
      expect(db.query("SELECT value FROM unrelated_fixture").all()).toEqual([
        { value: "preserve" },
      ]);
    } finally {
      db.close();
    }
  }
});

test("readiness and terminal use main even when same-named TEMP objects exist", async () => {
  const db = fixture();
  try {
    db.exec("CREATE TEMP TABLE tf_v2_container_instances(resource_uid TEXT)");
    expect(await inspectV2ContainerOwnerSchema(createSqliteSql(db))).toBe(true);
    expect(V2_CONTAINER_OWNER_READY).toContain("main.sqlite_schema");
    const c = context();
    const prepared = await issuer().prepare(c);
    expect(redeemV2HostAcceptance(prepared!, noIO, c).terminal.sql).toContain("INSERT INTO main.");
  } finally {
    db.close();
  }
});

function full100ContainerEngine(db: Database, wrapSql: (sql: Sql) => Sql = (sql) => sql) {
  // This helper compares the generated migration set and each generated SQL
  // value with the exact audited source artifact before canonical migration.
  const audited = currentAuditedSchemaMigrations();
  expect(audited.length).toBe(100);
  migrateSqlite(db);
  const sql = wrapSql(createSqliteSql(db));
  return sql.batch(v2ContainerOwnerMigrationCandidate()).then(() => {
    const host = createV2ContainerHostAcceptance({
      sql,
      installationId: "test-installation",
      backendId: "test-container-backend",
      targetKey: "test-container-target",
    });
    const backend: V2Backend = {
      id: "test-container-backend",
      targetKey: "test-container-target",
      async execute() {
        return { kind: "no_effect", code: "fixture_no_effect", message: "No effect" };
      },
      async reconcile() {
        return { kind: "no_effect", code: "fixture_no_effect", message: "No effect" };
      },
    };
    const form: V2Form = {
      validateCreate() {},
      validateUpdate() {},
      backend,
    };
    const engine = createTakoformV2Engine(
      {
        sql,
        replayWindowSeconds: 120,
        now: () => new Date("2026-10-16T00:00:00.000Z"),
        async authorize(principal, space) {
          return principal === "container-owner-test" && space === "default";
        },
        forms: { [C.formUrl]: form },
      },
      host,
    );
    return { engine, sql };
  });
}

function refuseSecondOwnerTerminal(original: Sql) {
  let terminalCount = 0;
  let injected = false;
  const sql: Sql = {
    query(statement, params) {
      return original.query(statement, params);
    },
    run(statement, params) {
      return original.run(statement, params);
    },
    batch(statements) {
      const faulted = statements.map((statement) => {
        if (
          !statement.sql.startsWith(
            "WITH host_form_admission AS (SELECT 1 AS permitted) INSERT INTO main.tf_v2_container_acceptances ",
          )
        ) {
          return statement;
        }
        terminalCount += 1;
        if (terminalCount !== 2) return statement;
        const params = [...(statement.params ?? [])];
        if (params[10] !== "create") return statement;
        injected = true;
        // action is parameter 11 in the compiler's exact terminal INSERT. Let
        // the owner graph trigger reject it inside the real same-batch transaction.
        params[10] = "__test_invalid_action__";
        return { sql: statement.sql, params };
      });
      return original.batch(faulted);
    },
  };
  return { sql, injected: () => injected };
}

const coreContainerSpec = (workloadRevision: string) => ({
  image: `registry.example/image@sha256:${"d".repeat(64)}`,
  httpPort: 8080,
  healthPath: "/",
  workloadRevision,
  requiredSensitiveVars: [],
  outboundInternet: true,
});

function mainSchemaFingerprint(db: Database) {
  const rows = db
    .query("SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name")
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  return {
    count: rows.length,
    objects: rows.map(({ type, name, tbl_name, sql }) => ({
      type,
      name,
      tbl_name,
      sqlLength: sql?.length ?? null,
      sqlSha256: sql === null ? null : createHash("sha256").update(sql).digest("hex"),
    })),
  };
}

test("audited full100 Core CREATE and UPDATE atomically publish owner rows from real operation IDs", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON");
  try {
    const { engine, sql } = await full100ContainerEngine(db);
    const created = await engine.acceptCreate({
      principal: "container-owner-test",
      key: "container-owner-full100-create-01",
      input: {
        form: C.formUrl,
        space: "default",
        name: "container-full100",
        spec: coreContainerSpec("v1"),
      },
    });
    const createOperation = await engine.getOperation({
      principal: "container-owner-test",
      id: created.id,
    });
    const createResource = await engine.getResource({
      principal: "container-owner-test",
      uid: created.resourceUid,
    });
    expect(createOperation.id).toBe(created.id);
    expect(createResource.uid).toBe(created.resourceUid);
    const createCoreRow = db
      .query("SELECT backend_key FROM tf_v2_operations WHERE id = ?")
      .get(createOperation.id) as { backend_key: string };
    expect(
      db
        .query(
          "SELECT operation_id, resource_uid, backend_key, generation FROM tf_v2_container_acceptances",
        )
        .all(),
    ).toEqual([
      {
        operation_id: createOperation.id,
        resource_uid: createResource.uid,
        backend_key: createCoreRow.backend_key,
        generation: 1,
      },
    ]);
    const instance = db
      .query(
        "SELECT create_operation_id, incarnation_id FROM tf_v2_container_instances WHERE resource_uid = ?",
      )
      .get(createResource.uid) as { create_operation_id: string; incarnation_id: string };
    expect(instance.create_operation_id).toBe(createOperation.id);
    expect(instance.incarnation_id).toMatch(/^[0-9a-f]{64}$/u);

    // The portable fixture backend confirms no native effect. Core settlement
    // releases the pending operation so the real update admission can proceed.
    expect((await engine.runNext())?.status).toBe("failed");
    const updated = await engine.acceptUpdate({
      principal: "container-owner-test",
      key: "container-owner-full100-update-01",
      uid: createResource.uid,
      expectedGeneration: 1,
      spec: coreContainerSpec("v2"),
    });
    const updateOperation = await engine.getOperation({
      principal: "container-owner-test",
      id: updated.id,
    });
    const updateCoreRow = db
      .query("SELECT backend_key FROM tf_v2_operations WHERE id = ?")
      .get(updateOperation.id) as { backend_key: string };
    const acceptances = db
      .query(
        "SELECT operation_id, resource_uid, backend_key, action, generation FROM tf_v2_container_acceptances ORDER BY generation",
      )
      .all();
    expect(acceptances).toEqual([
      {
        operation_id: createOperation.id,
        resource_uid: createResource.uid,
        backend_key: createCoreRow.backend_key,
        action: "create",
        generation: 1,
      },
      {
        operation_id: updateOperation.id,
        resource_uid: createResource.uid,
        backend_key: updateCoreRow.backend_key,
        action: "update",
        generation: 2,
      },
    ]);
    expect(
      db
        .query(
          "SELECT generation, operation_id FROM tf_v2_container_revisions WHERE resource_uid = ? ORDER BY generation",
        )
        .all(createResource.uid),
    ).toEqual([
      { generation: 1, operation_id: createOperation.id },
      { generation: 2, operation_id: updateOperation.id },
    ]);
    expect(
      db
        .query(
          "SELECT incarnation_id, desired_generation FROM tf_v2_container_instances WHERE resource_uid = ?",
        )
        .get(createResource.uid),
    ).toEqual({ incarnation_id: instance.incarnation_id, desired_generation: 2 });
    expect(await inspectV2ContainerOwnerSchema(sql)).toBe(true);
  } finally {
    db.close();
  }
});

test("full100 Core CREATE refusal at the owner terminal rolls back Core and owner state together", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON");
  try {
    const terminalFault = refuseSecondOwnerTerminal(createSqliteSql(db));
    const { engine, sql } = await full100ContainerEngine(db, () => terminalFault.sql);
    const baseline = await engine.acceptCreate({
      principal: "container-owner-test",
      key: "container-owner-full100-baseline-01",
      input: {
        form: C.formUrl,
        space: "default",
        name: "container-full100-baseline",
        spec: coreContainerSpec("v1"),
      },
    });
    expect(db.query("SELECT operation_id FROM tf_v2_container_acceptances").all()).toEqual([
      { operation_id: baseline.id },
    ]);
    expect(await inspectV2ContainerOwnerSchema(sql)).toBe(true);
    const beforeSchema = mainSchemaFingerprint(db);
    const beforeCore = {
      resources: db.query("SELECT * FROM tf_v2_resources ORDER BY uid").all(),
      operations: db.query("SELECT * FROM tf_v2_operations ORDER BY id").all(),
      referenceSets: db
        .query("SELECT * FROM tf_v2_operation_reference_sets ORDER BY operation_id")
        .all(),
      references: db
        .query("SELECT * FROM tf_v2_operation_references ORDER BY operation_id, target_uid")
        .all(),
      configuredPrivateInputs: db
        .query("SELECT * FROM tf_v2_configured_private_inputs ORDER BY resource_uid")
        .all(),
      privateInputs: db.query("SELECT * FROM tf_v2_private_inputs ORDER BY operation_id").all(),
    };
    const beforeOwner = Object.fromEntries(
      recipe.tables.map(({ name }) => [name, db.query(`SELECT * FROM ${name} ORDER BY 1`).all()]),
    );
    await expect(
      engine.acceptCreate({
        principal: "container-owner-test",
        key: "container-owner-full100-refused-01",
        input: {
          form: C.formUrl,
          space: "default",
          name: "container-full100-refused",
          spec: coreContainerSpec("v1"),
        },
      }),
    ).rejects.toThrow("container_owner_invariant");
    expect(terminalFault.injected()).toBe(true);
    expect({
      resources: db.query("SELECT * FROM tf_v2_resources ORDER BY uid").all(),
      operations: db.query("SELECT * FROM tf_v2_operations ORDER BY id").all(),
      referenceSets: db
        .query("SELECT * FROM tf_v2_operation_reference_sets ORDER BY operation_id")
        .all(),
      references: db
        .query("SELECT * FROM tf_v2_operation_references ORDER BY operation_id, target_uid")
        .all(),
      configuredPrivateInputs: db
        .query("SELECT * FROM tf_v2_configured_private_inputs ORDER BY resource_uid")
        .all(),
      privateInputs: db.query("SELECT * FROM tf_v2_private_inputs ORDER BY operation_id").all(),
    }).toEqual(beforeCore);
    expect(
      Object.fromEntries(
        recipe.tables.map(({ name }) => [name, db.query(`SELECT * FROM ${name} ORDER BY 1`).all()]),
      ),
    ).toEqual(beforeOwner);
    expect(mainSchemaFingerprint(db)).toEqual(beforeSchema);
    expect(await inspectV2ContainerOwnerSchema(sql)).toBe(true);
  } finally {
    db.close();
  }
});

function containerDeleteSnapshot(db: Database) {
  return {
    core: {
      resources: db.query("SELECT * FROM tf_v2_resources ORDER BY uid").all(),
      operations: db.query("SELECT * FROM tf_v2_operations ORDER BY id").all(),
      referenceSets: db
        .query("SELECT * FROM tf_v2_operation_reference_sets ORDER BY operation_id")
        .all(),
      references: db
        .query("SELECT * FROM tf_v2_operation_references ORDER BY operation_id, target_uid")
        .all(),
      configuredPrivateInputs: db
        .query("SELECT * FROM tf_v2_configured_private_inputs ORDER BY resource_uid")
        .all(),
      privateInputs: db.query("SELECT * FROM tf_v2_private_inputs ORDER BY operation_id").all(),
    } as Record<string, readonly Record<string, unknown>[]>,
    owner: Object.fromEntries(
      recipe.tables.map(({ name }) => [name, db.query(`SELECT * FROM ${name} ORDER BY 1`).all()]),
    ) as Record<string, readonly Record<string, unknown>[]>,
    schema: mainSchemaFingerprint(db),
  };
}

function observeContainerDeleteBatch(original: Sql, fault?: "action" | "missing-operation") {
  const deleteBatches: Parameters<Sql["batch"]>[0][] = [];
  let injected = false;
  const sql: Sql = {
    query(statement, params) {
      return original.query(statement, params);
    },
    run(statement, params) {
      return original.run(statement, params);
    },
    batch(statements) {
      const terminal = statements.at(-1);
      if (
        !terminal?.sql.startsWith(
          "WITH host_form_admission AS (SELECT 1 AS permitted) INSERT OR ABORT INTO main.tf_v2_container_acceptances ",
        ) ||
        terminal.params?.[10] !== "delete"
      ) {
        return original.batch(statements);
      }
      deleteBatches.push(statements);
      if (fault === undefined) return original.batch(statements);
      const params = [...terminal.params];
      injected = true;
      if (fault === "action") params[10] = "invalid-container-delete-action";
      else params[12] = "missing-container-delete-core-operation";
      return original.batch([...statements.slice(0, -1), { sql: terminal.sql, params }]);
    },
  };
  return { sql, deleteBatches, injected: () => injected };
}

async function settledContainerForDelete(
  engine: Awaited<ReturnType<typeof full100ContainerEngine>>["engine"],
) {
  const created = await engine.acceptCreate({
    principal: "container-owner-test",
    key: "container-delete-create",
    input: {
      form: C.formUrl,
      space: "default",
      name: "container-delete-source",
      spec: coreContainerSpec("r1"),
    },
  });
  expect((await engine.runNext())?.status).toBe("failed");
  const updated = await engine.acceptUpdate({
    principal: "container-owner-test",
    key: "container-delete-update",
    uid: created.resourceUid,
    expectedGeneration: 1,
    spec: coreContainerSpec("r2"),
  });
  expect((await engine.runNext())?.status).toBe("failed");
  return { created, updated };
}

test("genuine Core DELETE retires the durable Container owner in the same acceptance batch", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  try {
    const observed = observeContainerDeleteBatch(createSqliteSql(db));
    const { engine, sql } = await full100ContainerEngine(db, () => observed.sql);
    const { created, updated } = await settledContainerForDelete(engine);
    const before = containerDeleteSnapshot(db);
    const beforeInstance = before.owner[recipe.tables[0].name]!;
    expect(beforeInstance).toHaveLength(1);
    expect(beforeInstance[0]).toMatchObject({
      resource_uid: created.resourceUid,
      desired_generation: 2,
      retire_operation_id: null,
      retired_at_ms: null,
    });
    const deleted = await engine.acceptDelete({
      principal: "container-owner-test",
      key: "container-delete-accept",
      uid: created.resourceUid,
      expectedGeneration: 2,
    });
    expect(deleted).toMatchObject({
      action: "delete",
      generation: 3,
      resourceUid: created.resourceUid,
      status: "queued",
    });
    expect(observed.deleteBatches).toHaveLength(1);
    const batch = observed.deleteBatches[0]!;
    const ownerTerminals = batch.filter((item) =>
      item.sql.startsWith(
        "WITH host_form_admission AS (SELECT 1 AS permitted) INSERT OR ABORT INTO main.tf_v2_container_acceptances ",
      ),
    );
    expect(ownerTerminals).toHaveLength(1);
    expect(batch.at(-1)).toBe(ownerTerminals[0]);
    expect(ownerTerminals[0]!.params?.[0]).toBe(deleted.id);
    expect(ownerTerminals[0]!.params?.[10]).toBe("delete");
    expect(ownerTerminals[0]!.params?.[12]).toBe(deleted.id);
    const after = containerDeleteSnapshot(db);
    expect(after.schema).toEqual(before.schema);
    expect(after.core.resources).toHaveLength(1);
    expect(after.core.resources![0]).toMatchObject({
      uid: created.resourceUid,
      generation: 3,
      phase: "deleting",
      busy_operation: deleted.id,
      deleted_at: null,
    });
    const coreOperation = after.core.operations!.find((row) => row.id === deleted.id);
    expect(coreOperation).toMatchObject({
      id: deleted.id,
      action: "delete",
      generation: 3,
      resource_uid: created.resourceUid,
      status: "queued",
    });
    const actualCoreBackend = db
      .query("SELECT backend_key FROM tf_v2_operations WHERE id = ?")
      .get(deleted.id) as { backend_key: string };
    const acceptances = after.owner[recipe.tables[1].name]!;
    expect(acceptances).toHaveLength(3);
    expect(acceptances.find((row) => row.operation_id === deleted.id)).toMatchObject({
      operation_id: deleted.id,
      resource_uid: created.resourceUid,
      action: "delete",
      generation: 3,
      backend_key: actualCoreBackend.backend_key,
    });
    const retainedInstance = after.owner[recipe.tables[0].name]!;
    expect(retainedInstance).toHaveLength(1);
    expect(retainedInstance[0]).toMatchObject({
      resource_uid: created.resourceUid,
      incarnation_id: beforeInstance[0]!.incarnation_id,
      desired_generation: 3,
      retire_operation_id: deleted.id,
      retired_at_ms: expect.any(Number),
    });
    expect(
      after.owner[recipe.tables[2].name]!.map((row) => ({
        generation: row.generation,
        operation_id: row.operation_id,
        retention: row.retention,
      })),
    ).toEqual([
      { generation: 1, operation_id: created.id, retention: "retired" },
      { generation: 2, operation_id: updated.id, retention: "retired" },
    ]);
    expect(after.owner[recipe.tables[3].name]).toEqual(before.owner[recipe.tables[3].name]);
    expect(after.owner[recipe.tables[4].name]).toEqual(before.owner[recipe.tables[4].name]);
    expect(await inspectV2ContainerOwnerSchema(sql)).toBe(true);
  } finally {
    db.close();
  }
});

for (const fault of ["action", "missing-operation"] as const) {
  test(
    "genuine Core DELETE terminal failure conserves every Core and owner row: " + fault,
    async () => {
      const db = new Database(":memory:");
      db.exec("PRAGMA foreign_keys=ON");
      try {
        const observed = observeContainerDeleteBatch(createSqliteSql(db), fault);
        const { engine, sql } = await full100ContainerEngine(db, () => observed.sql);
        const { created } = await settledContainerForDelete(engine);
        const before = containerDeleteSnapshot(db);
        const pending = engine.acceptDelete({
          principal: "container-owner-test",
          key: "container-delete-rollback",
          uid: created.resourceUid,
          expectedGeneration: 2,
        });
        if (fault === "action") await expect(pending).rejects.toThrow("container_owner_invariant");
        else await expect(pending).rejects.toThrow();
        expect(observed.injected()).toBe(true);
        expect(observed.deleteBatches).toHaveLength(1);
        expect(containerDeleteSnapshot(db)).toEqual(before);
        expect(await inspectV2ContainerOwnerSchema(sql)).toBe(true);
      } finally {
        db.close();
      }
    },
  );
}

test("Container DELETE preparation owns its callable and binds exact Sql and original context", async () => {
  const issue = issuer();
  const descriptor = Object.getOwnPropertyDescriptor(issue, "prepareDelete");
  expect(descriptor).toBeDefined();
  expect(Object.hasOwn(descriptor!, "value")).toBe(true);
  expect(typeof descriptor!.value).toBe("function");
  const c = Object.freeze({
    ...context(),
    action: "delete" as const,
    generation: 2,
    referencesJson: null,
  });
  const prepared = await issue.prepareDelete!(c);
  expect(prepared).toBeDefined();
  const fixed = redeemV2HostAcceptance(prepared!, noIO, c);
  expect(fixed.guard.params).toHaveLength(10);
  expect(fixed.guard.params?.[0]).toBe(
    JSON.stringify(recipe.objects.map(({ type, name, table, sql }) => [type, name, table, sql])),
  );
  expect(fixed.guard.params?.slice(1)).toEqual([
    c.resourceUid,
    "installation",
    c.principal,
    c.space,
    c.name,
    c.form,
    "backend",
    "target",
    c.generation - 1,
  ]);
  expect(fixed.guard.params?.slice(1)[8]).toBe(1);
  expect(fixed.terminal.params).toHaveLength(21);
  expect(fixed.terminal.params?.[0]).toBe(c.operationId);
  expect(fixed.terminal.params?.[12]).toBe(c.operationId);
  expect(() => redeemV2HostAcceptance(prepared!, { ...noIO }, c)).toThrow();
  expect(() => redeemV2HostAcceptance(prepared!, noIO, { ...c })).toThrow();
  expect(() => redeemV2HostAcceptance({} as V2PreparedHostAcceptance, noIO, c)).toThrow();
  expect(
    issue.prepareDelete!({ ...c, form: "https://example.test/noncanonical-container" }),
  ).toBeUndefined();
  for (const patch of [
    { backendId: "wrong-backend" },
    { targetKey: "wrong-target" },
    { generation: 1 },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
    { principal: "" },
  ]) {
    expect(() => issue.prepareDelete!({ ...c, ...patch })).toThrow();
  }
});

test("provider catalog category 1 cannot hide an ordinary inbound foreign key", async () => {
  const db = new Database(":memory:");
  try {
    const { sql } = await full100ContainerEngine(db);
    expect(await inspectV2ContainerOwnerSchema(sql)).toBe(true);
    db.exec('CREATE TABLE "_cf_kv"(value REFERENCES TF_V2_CONTAINER_INSTANCES(resource_uid))');
    expect(await inspectV2ContainerOwnerSchema(sql)).toBe(false);
  } finally {
    db.close();
  }
});

test("provider catalog category 2 cannot hide an ordinary inbound foreign key", async () => {
  const db = new Database(":memory:");
  try {
    const { sql } = await full100ContainerEngine(db);
    expect(await inspectV2ContainerOwnerSchema(sql)).toBe(true);
    db.exec(
      'CREATE TABLE "_cf_metadata"(value REFERENCES TF_V2_CONTAINER_INSTANCES(resource_uid))',
    );
    expect(await inspectV2ContainerOwnerSchema(sql)).toBe(false);
  } finally {
    db.close();
  }
});

async function f2CorePrivateInputKeys(
  previous?: import("../src/takoform-v2/private-inputs.ts").V2PrivateInputCustody,
): Promise<import("../src/takoform-v2/private-inputs.ts").V2PrivateInputCustody> {
  const [transfer, comparison] = await Promise.all([
    crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
    crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
  ]);
  return {
    transfer: {
      current: { id: previous ? "transfer-next" : "transfer-first", key: transfer },
      ...(previous ? { previous: [previous.transfer.current] } : {}),
    },
    comparison: {
      current: { id: previous ? "comparison-next" : "comparison-first", key: comparison },
      ...(previous ? { previous: [previous.comparison.current] } : {}),
    },
    transferTtlSeconds: 2,
  };
}

async function full100F2ConfiguredContainerEngine(
  db: Database,
  wrapSql: (sql: Sql) => Sql = (sql) => sql,
  formUrlOverride?: string,
  requireSensitive = true,
  mapMode = false,
  emptyCreateMapScenario = false,
) {
  const { V2_CONTAINER_F2_FORM } = await import("../src/takoform-v2/container-owner-schema.ts");
  const selectedForm = formUrlOverride === undefined ? V2_CONTAINER_F2_FORM : formUrlOverride;
  if (selectedForm !== C.formUrl && selectedForm !== V2_CONTAINER_F2_FORM)
    throw new TypeError("Unsupported fixture Form");

  // This helper compares the generated migration set and each generated SQL
  // value with the exact audited source artifact before canonical migration.
  const audited = currentAuditedSchemaMigrations();
  expect(audited.length).toBe(100);
  migrateSqlite(db);
  const baseSql = createSqliteSql(db);
  if (mapMode) {
    await baseSql.batch(
      frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((statement) => ({
        sql: statement,
      })),
    );
    expect(
      db
        .query("SELECT name FROM sqlite_master WHERE name = ?")
        .all("tf_v2_operation_configured_private_inputs").length,
    ).toBe(1);
  }
  const sql = wrapSql(baseSql);
  const privateInputCustody = await f2CorePrivateInputKeys();
  return sql.batch(v2ContainerOwnerMigrationCandidate()).then(async () => {
    const host = createV2ContainerHostAcceptance({
      sql,
      installationId: "test-installation",
      backendId: "test-container-backend",
      targetKey: "test-container-target",
    });
    const backend: V2Backend = {
      id: "test-container-backend",
      targetKey: "test-container-target",
      async execute() {
        return { kind: "no_effect", code: "fixture_no_effect", message: "No effect" };
      },
      async reconcile() {
        return { kind: "no_effect", code: "fixture_no_effect", message: "No effect" };
      },
    };
    const sealing: {
      calls: number;
      updateCalls: number;
      emptyCreateCalls: number;
      emptyUpdateCalls: number;
      operationId: string | undefined;
      resourceUid: string | undefined;
      envelope:
        | { readonly keyId: string; readonly nonce: string; readonly ciphertext: string }
        | undefined;
      priorEnvelope:
        | { readonly keyId: string; readonly nonce: string; readonly ciphertext: string }
        | undefined;
      submittedMap: Readonly<Record<string, string>> | undefined;
      configuredMap: Readonly<Record<string, string>> | undefined;
      ownerContextNullGenerations: number[];
      binding:
        | { form: string; resourceUid: string; operationId: string; generation: number }
        | undefined;
    } = {
      calls: 0,
      updateCalls: 0,
      emptyCreateCalls: 0,
      emptyUpdateCalls: 0,
      operationId: undefined,
      resourceUid: undefined,
      envelope: undefined,
      priorEnvelope: undefined,
      submittedMap: undefined,
      configuredMap: undefined,
      ownerContextNullGenerations: [],
      binding: undefined,
    };
    const mapKey = mapMode
      ? await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
          "encrypt",
          "decrypt",
        ])
      : undefined;
    function requiredNames(spec: Record<string, unknown>): string[] {
      const names = spec[C.fields.requiredSensitiveVars];
      if (!Array.isArray(names) || !names.every((name) => typeof name === "string"))
        throw new TakoformV2Error("invalid_spec", 422);
      return names;
    }
    function validateMap(names: readonly string[], inputs: Readonly<Record<string, string>>): void {
      if (
        names.length > 64 ||
        JSON.stringify([...names].sort()) !== JSON.stringify(Object.keys(inputs).sort()) ||
        Object.values(inputs).some(
          (value) =>
            typeof value !== "string" || [...value].length < 1 || [...value].length > 16384,
        ) ||
        new TextEncoder().encode(Object.values(inputs).join("")).length > 65536
      )
        throw new TakoformV2Error("invalid_spec", 422);
    }
    async function sealMap(input: {
      form: string;
      resourceUid: string;
      operationId: string;
      generation: number;
      privateInputs: Readonly<Record<string, string>>;
    }) {
      if (!mapKey) throw new Error("map fixture key missing");
      const binding = {
        form: input.form,
        resourceUid: input.resourceUid,
        operationId: input.operationId,
        generation: input.generation,
      };
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = new TextEncoder().encode(JSON.stringify(input.privateInputs));
      try {
        const ciphertext = await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: nonce,
            additionalData: new TextEncoder().encode(JSON.stringify(binding)),
          },
          mapKey,
          plaintext,
        );
        const opened = new Uint8Array(
          await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: nonce,
              additionalData: new TextEncoder().encode(JSON.stringify(binding)),
            },
            mapKey,
            ciphertext,
          ),
        );
        try {
          expect(Array.from(opened)).toEqual(Array.from(plaintext));
        } finally {
          opened.fill(0);
        }
        const envelope = Object.freeze({
          keyId: "owner-f2-map-fixture-key",
          nonce: btoa(String.fromCharCode(...nonce)),
          ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
        });
        sealing.priorEnvelope = sealing.envelope;
        sealing.envelope = envelope;
        sealing.binding = binding;
        sealing.operationId = input.operationId;
        sealing.resourceUid = input.resourceUid;
        sealing.calls++;
        return envelope;
      } finally {
        plaintext.fill(0);
      }
    }
    async function openMap(envelope: {
      readonly keyId: string;
      readonly nonce: string;
      readonly ciphertext: string;
    }) {
      if (!mapKey || !sealing.binding) throw new Error("map fixture context missing");
      const opened = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: Uint8Array.from(atob(envelope.nonce), (c) => c.charCodeAt(0)),
            additionalData: new TextEncoder().encode(JSON.stringify(sealing.binding)),
          },
          mapKey,
          Uint8Array.from(atob(envelope.ciphertext), (c) => c.charCodeAt(0)),
        ),
      );
      try {
        return JSON.parse(new TextDecoder().decode(opened)) as Readonly<Record<string, string>>;
      } finally {
        opened.fill(0);
      }
    }
    const form: V2Form = {
      validateCreate() {},
      validateUpdate() {},
      backend,

      privateInputs: {
        ...(requireSensitive ? { requiredForEveryInstance: true as const } : {}),
        validateCreate(_spec, inputs) {
          if (!requireSensitive) {
            expect(inputs).toBeUndefined();
            return;
          }
          if (mapMode) {
            if (emptyCreateMapScenario && requiredNames(_spec).length === 0 && inputs === undefined)
              return;
            if (inputs === undefined) throw new TakoformV2Error("invalid_spec", 422);
            validateMap(requiredNames(_spec), inputs);
            return;
          }
          if (inputs === undefined || inputs.TOKEN !== "owner-f2-fixture-value")
            throw new TypeError("F2 fixture input unavailable");
        },
        validateUpdate(_previous, _next, inputs) {
          if (mapMode) {
            const previousNames = requiredNames(_previous);
            const nextNames = requiredNames(_next);
            if (inputs !== undefined) validateMap(nextNames, inputs);
            else if (nextNames.some((name) => !previousNames.includes(name)))
              throw new TakoformV2Error("invalid_spec", 422);
            return;
          }
          if (inputs !== undefined)
            throw new TypeError("F2 fixture replacement is outside this check");
        },
        async prepareCreate(input) {
          expect(input.form).toBe(selectedForm);
          expect(input.generation).toBe(1);
          if (!requireSensitive) {
            expect(input.privateInputs).toBeUndefined();
            sealing.emptyCreateCalls++;
            return null;
          }
          if (mapMode) {
            if (emptyCreateMapScenario && requiredNames(input.spec).length === 0) {
              if (input.privateInputs !== undefined)
                throw new TypeError("unexpected empty CREATE map");
              sealing.emptyCreateCalls++;
              return null;
            }
            if (input.privateInputs === undefined) throw new TakoformV2Error("invalid_spec", 422);
            validateMap(requiredNames(input.spec), input.privateInputs);
            sealing.submittedMap = input.privateInputs;
            return sealMap({ ...input, privateInputs: input.privateInputs });
          }
          if (
            input.privateInputs === undefined ||
            input.privateInputs.TOKEN !== "owner-f2-fixture-value"
          )
            throw new TypeError("F2 fixture input unavailable");
          const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
            "encrypt",
            "decrypt",
          ]);
          const nonce = crypto.getRandomValues(new Uint8Array(12));
          const plaintext = new TextEncoder().encode(JSON.stringify(input.privateInputs));
          const aad = new TextEncoder().encode(
            JSON.stringify({
              form: input.form,
              resourceUid: input.resourceUid,
              operationId: input.operationId,
              generation: input.generation,
            }),
          );
          try {
            const encrypted = await crypto.subtle.encrypt(
              { name: "AES-GCM", iv: nonce, additionalData: aad },
              key,
              plaintext,
            );
            const opened = new Uint8Array(
              await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: nonce, additionalData: aad },
                key,
                encrypted,
              ),
            );
            try {
              expect(Array.from(opened)).toEqual(Array.from(plaintext));
            } finally {
              opened.fill(0);
            }
            const envelope = Object.freeze({
              keyId: "owner-f2-fixture-key",
              nonce: btoa(String.fromCharCode(...nonce)),
              ciphertext: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
            });
            sealing.calls++;
            sealing.operationId = input.operationId;
            sealing.resourceUid = input.resourceUid;
            sealing.envelope = envelope;
            return envelope;
          } finally {
            plaintext.fill(0);
          }
        },
        async prepareUpdate(input) {
          if (emptyCreateMapScenario) {
            expect(input.configured).toBeNull();
            sealing.updateCalls++;
            if (input.privateInputs !== undefined) {
              validateMap(requiredNames(input.spec), input.privateInputs);
              return sealMap({ ...input, privateInputs: input.privateInputs });
            }
            const prior = (
              await sql.query(
                `SELECT operation_id, generation FROM tf_v2_container_acceptances
               WHERE resource_uid = ? AND principal = ? AND space = ? AND name = ? AND form_url = ?
                 AND action = 'update' AND configured_private_inputs_json IS NOT NULL
                 AND generation < ? ORDER BY generation DESC LIMIT 1`,
                [
                  input.resourceUid,
                  input.principal,
                  input.space,
                  input.name,
                  input.form,
                  input.generation,
                ],
              )
            )[0];
            if (
              !prior ||
              typeof prior.operation_id !== "string" ||
              typeof prior.generation !== "number"
            )
              throw new TypeError("accepted UPDATE map source missing");
            const material = await readV2ConfiguredPrivateInputs(
              sql,
              {
                principal: input.principal,
                space: input.space,
                name: input.name,
                form: input.form,
                resourceUid: input.resourceUid,
              },
              { operationId: prior.operation_id, generation: prior.generation },
            );
            if (!material) throw new TypeError("accepted UPDATE map missing");
            if (!sealing.envelope) throw new TypeError("fixture map missing");
            expect(material).toEqual(sealing.envelope);
            return;
          }
          if (!requireSensitive) {
            expect(input.privateInputs).toBeUndefined();
            expect(input.configured).toBeNull();
            sealing.emptyUpdateCalls++;
            return;
          }
          if (sealing.envelope === undefined) throw new Error("fixture envelope missing");
          if (mapMode && JSON.stringify(input.configured) !== JSON.stringify(sealing.envelope)) {
            console.info(
              JSON.stringify({
                event: "owner-f2-map-configured-selection",
                generation: input.generation,
                matchesPrior:
                  JSON.stringify(input.configured) === JSON.stringify(sealing.priorEnvelope),
                isNull: input.configured === null,
              }),
            );
          }
          if (mapMode)
            expect(JSON.stringify(input.configured) === JSON.stringify(sealing.envelope)).toBe(
              true,
            );
          else expect(input.configured).toEqual(sealing.envelope);
          sealing.updateCalls++;
          if (mapMode) {
            sealing.configuredMap = await openMap(sealing.envelope);
            sealing.submittedMap = input.privateInputs;
            if (input.privateInputs !== undefined) {
              validateMap(requiredNames(input.spec), input.privateInputs);
              return sealMap({ ...input, privateInputs: input.privateInputs });
            }
            const retainedNames = requiredNames(input.spec);
            const configuredMap = sealing.configuredMap;
            if (Object.keys(configuredMap).some((name) => !retainedNames.includes(name))) {
              const projected = Object.freeze(
                Object.fromEntries(
                  Object.entries(configuredMap).filter(([name]) => retainedNames.includes(name)),
                ),
              );
              validateMap(retainedNames, projected);
              return sealMap({ ...input, privateInputs: projected });
            }
            return;
          }
        },
      },
    };
    const observedHost = emptyCreateMapScenario
      ? {
          ...host,
          prepare(context: V2HostAcceptanceContext) {
            if (context.action === "update" && context.configuredPrivateInputs === undefined)
              sealing.ownerContextNullGenerations.push(context.generation);
            return host.prepare(context);
          },
        }
      : host;
    const engine = createTakoformV2Engine(
      {
        sql,
        replayWindowSeconds: 120,
        now: () => new Date("2026-10-16T00:00:00.000Z"),
        async authorize(principal, space) {
          return principal === "container-owner-test" && space === "default";
        },
        privateInputCustody,
        forms: { [selectedForm]: form },
      },
      observedHost,
    );
    return { engine, sql, sealing, formUrl: selectedForm };
  });
}

function observeF2ContainerDeleteBatch(original: Sql, fault?: "action" | "missing-operation") {
  const deleteBatches: Parameters<Sql["batch"]>[0][] = [];
  let injected = false;
  const sql: Sql = {
    query(statement, params) {
      return original.query(statement, params);
    },
    run(statement, params) {
      return original.run(statement, params);
    },
    batch(statements) {
      const terminal = statements.at(-1);
      if (
        !terminal?.sql.startsWith(
          "WITH host_form_admission AS (SELECT 1 AS permitted) INSERT OR ABORT INTO main.tf_v2_container_acceptances ",
        ) ||
        terminal.params?.[10] !== "delete"
      ) {
        return original.batch(statements);
      }
      deleteBatches.push(statements);
      if (fault === undefined) return original.batch(statements);
      const params = [...terminal.params];
      injected = true;
      if (fault === "action") params[10] = "invalid-container-delete-action";
      else params[12] = "missing-container-delete-core-operation";
      return original.batch([...statements.slice(0, -1), { sql: terminal.sql, params }]);
    },
  };
  return { sql, deleteBatches, injected: () => injected };
}

test("genuine F2 full100 nonempty CREATE, retained UPDATE and key-free DELETE", async () => {
  const db = new Database(":memory:");
  try {
    const f = await full100F2ConfiguredContainerEngine(db);
    const desired = Object.freeze({
      ...coreContainerSpec("1".repeat(64)),
      [C.fields.image]: "registry.example.test/owner/f2@sha256:" + "a".repeat(64),
      [C.fields.workloadRevision]: "1".repeat(64),
      [C.fields.requiredSensitiveVars]: Object.freeze(["TOKEN"]),
    });
    const created = await f.engine.acceptCreate({
      principal: "container-owner-test",
      key: "f2-create-canonical-source",
      input: {
        form: f.formUrl,
        space: "default",
        name: "f2-secret",
        spec: desired,
        privateInputs: { TOKEN: "owner-f2-fixture-value" },
      },
    });
    expect(created.generation).toBe(1);
    expect(f.sealing.calls).toBe(1);
    expect(f.sealing.operationId).toBe(created.id);
    expect(f.sealing.resourceUid).toBe(created.resourceUid);
    const afterCreate = await containerDeleteSnapshot(db);
    const createAcceptance = Object.values(afterCreate.owner)
      .flat()
      .find((row) => row.operation_id === created.id);
    expect(createAcceptance).toBeDefined();
    expect(createAcceptance?.configured_private_inputs_json).toBe(
      JSON.stringify(f.sealing.envelope),
    );
    expect(typeof createAcceptance?.configured_private_inputs_json).toBe("string");
    const configuredCreate = createAcceptance?.configured_private_inputs_json;
    if (typeof configuredCreate !== "string") throw new TypeError("F2 sealed terminal missing");
    expect(configuredCreate.length).toBeGreaterThan(0);
    console.info(
      JSON.stringify({
        event: "owner-f2-controlled-stage",
        stage: "nonempty_create_terminal",
        generation: 1,
        sealCalls: f.sealing.calls,
      }),
    );
    expect((await f.engine.runNext())?.status).toBe("failed");
    const updated = await f.engine.acceptUpdate({
      principal: "container-owner-test",
      key: "f2-update-canonical-source",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: Object.freeze({ ...desired, [C.fields.workloadRevision]: "2".repeat(64) }),
    });
    expect(updated.generation).toBe(2);
    expect(f.sealing.calls).toBe(1);
    expect(f.sealing.updateCalls).toBe(1);
    expect((await f.engine.runNext())?.status).toBe("failed");
    const deleted = await f.engine.acceptDelete({
      principal: "container-owner-test",
      key: "f2-delete-canonical-source",
      uid: created.resourceUid,
      expectedGeneration: 2,
    });
    expect(deleted.generation).toBe(3);
    const afterDelete = await containerDeleteSnapshot(db);
    const rows = Object.values(afterDelete.owner).flat();
    const deleteAcceptance = rows.find((row) => row.operation_id === deleted.id);
    const instance = rows.find((row) => row.retire_operation_id === deleted.id);
    expect(deleteAcceptance?.action).toBe("delete");
    expect(deleteAcceptance?.references_json).toBeNull();
    expect(deleteAcceptance?.configured_private_inputs_json).toBeNull();
    expect(instance?.desired_generation).toBe(3);
    expect(typeof instance?.retired_at_ms).toBe("number");
    expect(f.sealing.calls).toBe(1);
    expect(f.sealing.updateCalls).toBe(1);
    console.info(
      JSON.stringify({
        event: "owner-f2-controlled-stage",
        stage: "retained_update_key_free_delete",
        generation: 3,
        sealCalls: f.sealing.calls,
        updateCalls: f.sealing.updateCalls,
      }),
    );
  } finally {
    db.close();
  }
});

test("genuine F2 full100 replaces a complete two-name map through Core and owner", async () => {
  const db = new Database(":memory:");
  try {
    const f = await full100F2ConfiguredContainerEngine(db, undefined, undefined, true, true);
    const initialMap = Object.freeze({ TOKEN: "fixture-first-alpha", OTHER: "fixture-first-beta" });
    const replacementMap = Object.freeze({
      TOKEN: "fixture-next-alpha",
      OTHER: "fixture-next-beta",
    });
    const desired = Object.freeze({
      ...coreContainerSpec("1".repeat(64)),
      [C.fields.image]: "registry.example.test/owner/f2@sha256:" + "a".repeat(64),
      [C.fields.requiredSensitiveVars]: Object.freeze(["TOKEN", "OTHER"]),
    });
    const created = await f.engine.acceptCreate({
      principal: "container-owner-test",
      key: "f2-map-create-canonical-source",
      input: {
        form: f.formUrl,
        space: "default",
        name: "f2-map-replace",
        spec: desired,
        privateInputs: initialMap,
      },
    });
    const firstEnvelope = f.sealing.envelope;
    expect(firstEnvelope).toBeDefined();
    expect(f.sealing.calls).toBe(1);
    expect((await f.engine.runNext())?.status).toBe("failed");
    const updated = await f.engine.acceptUpdate({
      principal: "container-owner-test",
      key: "f2-map-update-canonical-source",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: desired,
      privateInputs: replacementMap,
    });
    expect(updated.generation).toBe(2);
    expect(updated.resourceUid).toBe(created.resourceUid);
    expect(f.sealing.calls).toBe(2);
    expect(f.sealing.updateCalls).toBe(1);
    expect(f.sealing.configuredMap).toEqual(initialMap);
    expect(f.sealing.submittedMap).toEqual(replacementMap);
    expect(f.sealing.priorEnvelope).toEqual(firstEnvelope);
    expect(f.sealing.envelope).not.toEqual(firstEnvelope);
    expect(f.sealing.binding).toEqual({
      form: f.formUrl,
      resourceUid: created.resourceUid,
      operationId: updated.id,
      generation: 2,
    });
    const state = await containerDeleteSnapshot(db);
    const rows = Object.values(state.owner).flat();
    const first = rows.find((row) => row.operation_id === created.id);
    const second = rows.find((row) => row.operation_id === updated.id);
    expect(first?.configured_private_inputs_json).toBe(JSON.stringify(firstEnvelope));
    expect(second?.configured_private_inputs_json).toBe(JSON.stringify(f.sealing.envelope));
    expect(second?.generation).toBe(2);
    expect(second?.resource_uid).toBe(created.resourceUid);
    expect(second?.form_url).toBe(f.formUrl);
    expect(JSON.stringify(state)).not.toContain("fixture-first-alpha");
    expect(JSON.stringify(state)).not.toContain("fixture-first-beta");
    expect(JSON.stringify(state)).not.toContain("fixture-next-alpha");
    expect(JSON.stringify(state)).not.toContain("fixture-next-beta");
    expect((await f.engine.runNext())?.status).toBe("failed");
  } finally {
    db.close();
  }
});

test("genuine F2 full100 rejects a partial map before writes and accepts a complete name addition", async () => {
  const db = new Database(":memory:");
  try {
    const f = await full100F2ConfiguredContainerEngine(db, undefined, undefined, true, true);
    const desired = Object.freeze({
      ...coreContainerSpec("1".repeat(64)),
      [C.fields.image]: "registry.example.test/owner/f2@sha256:" + "a".repeat(64),
      [C.fields.requiredSensitiveVars]: Object.freeze(["TOKEN"]),
    });
    const created = await f.engine.acceptCreate({
      principal: "container-owner-test",
      key: "f2-map-add-create-canonical-source",
      input: {
        form: f.formUrl,
        space: "default",
        name: "f2-map-add",
        spec: desired,
        privateInputs: { TOKEN: "fixture-original-alpha" },
      },
    });
    expect((await f.engine.runNext())?.status).toBe("failed");
    const next = Object.freeze({
      ...desired,
      [C.fields.requiredSensitiveVars]: Object.freeze(["TOKEN", "OTHER"]),
    });
    const before = await containerDeleteSnapshot(db);
    await expect(
      f.engine.acceptUpdate({
        principal: "container-owner-test",
        key: "f2-map-add-partial-canonical-source",
        uid: created.resourceUid,
        expectedGeneration: 1,
        spec: next,
        privateInputs: { TOKEN: "fixture-next-alpha" },
      }),
    ).rejects.toMatchObject({ code: "invalid_spec" });
    expect(await containerDeleteSnapshot(db)).toEqual(before);
    expect(f.sealing.calls).toBe(1);
    expect(f.sealing.updateCalls).toBe(0);
    const added = await f.engine.acceptUpdate({
      principal: "container-owner-test",
      key: "f2-map-add-complete-canonical-source",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: next,
      privateInputs: { TOKEN: "fixture-next-alpha", OTHER: "fixture-new-beta" },
    });
    expect(added.generation).toBe(2);
    expect(f.sealing.calls).toBe(2);
    expect(f.sealing.updateCalls).toBe(1);
    expect(f.sealing.configuredMap).toEqual({ TOKEN: "fixture-original-alpha" });
    expect(f.sealing.submittedMap).toEqual({
      TOKEN: "fixture-next-alpha",
      OTHER: "fixture-new-beta",
    });
    const rows = Object.values((await containerDeleteSnapshot(db)).owner).flat();
    const acceptance = rows.find((row) => row.operation_id === added.id);
    expect(acceptance?.configured_private_inputs_json).toBe(JSON.stringify(f.sealing.envelope));
  } finally {
    db.close();
  }
});

test("genuine F2 full100 DELETE terminal fault preserves complete Core owner and schema", async () => {
  const db = new Database(":memory:");
  try {
    let observation: ReturnType<typeof observeF2ContainerDeleteBatch> | undefined;
    const f = await full100F2ConfiguredContainerEngine(db, (sql) => {
      observation = observeF2ContainerDeleteBatch(sql, "missing-operation");
      return observation.sql;
    });
    const desired = Object.freeze({
      ...coreContainerSpec("1".repeat(64)),
      [C.fields.image]: "registry.example.test/owner/f2@sha256:" + "a".repeat(64),
      [C.fields.workloadRevision]: "3".repeat(64),
      [C.fields.requiredSensitiveVars]: Object.freeze(["TOKEN"]),
    });
    const created = await f.engine.acceptCreate({
      principal: "container-owner-test",
      key: "f2-fault-create-canonical-source",
      input: {
        form: f.formUrl,
        space: "default",
        name: "f2-fault",
        spec: desired,
        privateInputs: { TOKEN: "owner-f2-fixture-value" },
      },
    });
    expect((await f.engine.runNext())?.status).toBe("failed");
    const updated = await f.engine.acceptUpdate({
      principal: "container-owner-test",
      key: "f2-fault-update-canonical-source",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: Object.freeze({ ...desired, [C.fields.workloadRevision]: "4".repeat(64) }),
    });
    expect(updated.generation).toBe(2);
    expect((await f.engine.runNext())?.status).toBe("failed");
    const before = await containerDeleteSnapshot(db);
    await expect(
      f.engine.acceptDelete({
        principal: "container-owner-test",
        key: "f2-fault-delete-canonical-source",
        uid: created.resourceUid,
        expectedGeneration: 2,
      }),
    ).rejects.toThrow();
    expect(observation?.injected()).toBe(true);
    expect(observation?.deleteBatches.length).toBe(1);
    expect(await containerDeleteSnapshot(db)).toEqual(before);
    expect(f.sealing.calls).toBe(1);
    expect(f.sealing.updateCalls).toBe(1);
    console.info(
      JSON.stringify({
        event: "owner-f2-controlled-stage",
        stage: "delete_terminal_fault_conservation",
        generation: 2,
        injected: 1,
        conservation: true,
      }),
    );
  } finally {
    db.close();
  }
});

test("genuine legacy Container rejects prepared nonNULL configured inputs without mutation", async () => {
  const db = new Database(":memory:");
  try {
    const f = await full100F2ConfiguredContainerEngine(db, undefined, C.formUrl);
    const before = await containerDeleteSnapshot(db);
    await expect(
      f.engine.acceptCreate({
        principal: "container-owner-test",
        key: "legacy-configured-reject-canonical-source",
        input: {
          form: C.formUrl,
          space: "default",
          name: "legacy-configured",
          spec: coreContainerSpec("1".repeat(64)),
          privateInputs: { TOKEN: "owner-f2-fixture-value" },
        },
      }),
    ).rejects.toThrow();
    expect(f.sealing.calls).toBe(1);
    expect(await containerDeleteSnapshot(db)).toEqual(before);
    console.info(
      JSON.stringify({
        event: "owner-f2-controlled-stage",
        stage: "legacy_configured_rejected",
        sealCalls: 1,
        conservation: true,
      }),
    );
  } finally {
    db.close();
  }
});

test("F2 no-sensitive Core create then update retains null owner envelope", async () => {
  const db = new Database(":memory:");
  try {
    const f = await full100F2ConfiguredContainerEngine(db, undefined, undefined, false);
    const desired = Object.freeze({
      ...coreContainerSpec("1".repeat(64)),
      [C.fields.image]: "registry.example.test/owner/f2@sha256:" + "a".repeat(64),
      [C.fields.workloadRevision]: "1".repeat(64),
      [C.fields.requiredSensitiveVars]: Object.freeze([]),
    });
    const created = await f.engine.acceptCreate({
      principal: "container-owner-test",
      key: "f2-create-canonical-source",
      input: {
        form: f.formUrl,
        space: "default",
        name: "f2-secret",
        spec: desired,
      },
    });
    expect(created.generation).toBe(1);
    expect(f.sealing.calls).toBe(0);
    expect(f.sealing.emptyCreateCalls).toBe(1);
    const createRows = Object.values((await containerDeleteSnapshot(db)).owner).flat();
    const createAcceptance = createRows.find((row) => row.operation_id === created.id);
    expect(createAcceptance?.action).toBe("create");
    expect(createAcceptance?.configured_private_inputs_json).toBeNull();
    expect((await f.engine.runNext())?.status).toBe("failed");
    const updated = await f.engine.acceptUpdate({
      principal: "container-owner-test",
      key: "f2-update-canonical-source",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: Object.freeze({ ...desired, [C.fields.workloadRevision]: "2".repeat(64) }),
    });
    expect(updated.generation).toBe(2);
    expect(f.sealing.calls).toBe(0);
    expect(f.sealing.updateCalls).toBe(0);
    expect(f.sealing.emptyUpdateCalls).toBe(1);
    const updateRows = Object.values((await containerDeleteSnapshot(db)).owner).flat();
    const updateAcceptance = updateRows.find((row) => row.operation_id === updated.id);
    expect(updateAcceptance?.action).toBe("update");
    expect(updateAcceptance?.configured_private_inputs_json).toBeNull();
    expect(updateRows.some((row) => row.desired_generation === 2)).toBe(true);
    expect((await f.engine.runNext())?.status).toBe("failed");
  } finally {
    db.close();
  }
});

test("genuine F2 empty CREATE map retains accepted UPDATE material through omitted updates", async () => {
  const db = new Database(":memory:");
  const terminals: {
    action: unknown;
    generation: unknown;
    configured: unknown;
    firstOperationId: unknown;
    lastOperationId: unknown;
    last: boolean;
    count: number;
  }[] = [];
  const guardProbes: Record<string, boolean> = {};
  let maxBatchParams = 0;
  let omittedAdmissionParams = 0;
  const wrapSql = (original: Sql): Sql => ({
    query: (statement, params) => original.query(statement, params),
    run: (statement, params) => original.run(statement, params),
    async batch(statements) {
      const terminal = statements.at(-1);
      if (
        terminal?.sql.startsWith(
          "WITH host_form_admission AS (SELECT 1 AS permitted) INSERT INTO main.tf_v2_container_acceptances ",
        )
      ) {
        maxBatchParams = Math.max(
          maxBatchParams,
          ...statements.map((statement) => statement.params?.length ?? 0),
        );
        terminals.push({
          action: terminal.params?.[10],
          generation: terminal.params?.[11],
          configured: terminal.params?.[17],
          firstOperationId: terminal.params?.[0],
          lastOperationId: terminal.params?.[21],
          last: statements.at(-1) === terminal,
          count: statements.filter((statement) =>
            statement.sql.includes("INSERT INTO main.tf_v2_container_acceptances "),
          ).length,
        });
        if (terminal.params?.[11] === 3) {
          const admission = statements.find((statement) =>
            statement.sql.startsWith("SELECT 1 AS permitted WHERE"),
          );
          if (!admission?.params) throw new TypeError("missing owner admission guard");
          omittedAdmissionParams = admission.params.length;
          const retainedMarker = "AND EXISTS (SELECT 1 FROM main.tf_v2_container_acceptances prior";
          const retainedLocation = admission.sql.indexOf(retainedMarker);
          if (retainedLocation < 0) throw new TypeError("missing retained material guard");
          const retainedBindingStart = [...admission.sql.slice(0, retainedLocation)].filter(
            (character) => character === "?",
          ).length;
          expect(admission.params[retainedBindingStart]).toBe(2);
          const check = async (index?: number, value?: string | number) => {
            const params = [...admission.params!];
            if (index !== undefined) params[index] = value!;
            return (await original.query(admission.sql, params)).length === 1;
          };
          guardProbes.valid = await check();
          // The retained proof's first binding follows the captured SQL prefix.
          for (const [name, offset, value] of [
            ["resource", 1, "other-resource"],
            ["future", 2, 2],
            ["installation", 3, "other-installation"],
            ["principal", 4, "other-principal"],
            ["space", 5, "other-space"],
            ["name", 6, "other-name"],
            ["form", 7, C.formUrl],
            ["backend", 8, "other-backend"],
            ["target", 9, "other-target"],
            ["currentGeneration", 10, 1],
            ["undeclaredName", 11, '["TOKEN","OTHER"]'],
          ] as const)
            guardProbes[name] = await check(retainedBindingStart + offset, value);
        }
      }
      return original.batch(statements);
    },
  });
  try {
    const f = await full100F2ConfiguredContainerEngine(db, wrapSql, undefined, false, true, true);
    const empty = Object.freeze({
      ...coreContainerSpec("1".repeat(64)),
      [C.fields.image]: "registry.example.test/owner/f2@sha256:" + "a".repeat(64),
      [C.fields.workloadRevision]: "1".repeat(64),
      [C.fields.requiredSensitiveVars]: Object.freeze([]),
    });
    const created = await f.engine.acceptCreate({
      principal: "container-owner-test",
      key: "f2-empty-map-create",
      input: { form: f.formUrl, space: "default", name: "f2-empty-map", spec: empty },
    });
    expect((await f.engine.runNext())?.status).toBe("failed");
    const named = Object.freeze({
      ...empty,
      [C.fields.workloadRevision]: "2".repeat(64),
      [C.fields.requiredSensitiveVars]: Object.freeze(["TOKEN"]),
    });
    const supplied = await f.engine.acceptUpdate({
      principal: "container-owner-test",
      key: "f2-empty-map-supplied",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: named,
      privateInputs: { TOKEN: "synthetic-map-value" },
    });
    expect(supplied.generation).toBe(2);
    expect((await f.engine.runNext())?.status).toBe("failed");
    const omitted = await f.engine.acceptUpdate({
      principal: "container-owner-test",
      key: "f2-empty-map-omitted",
      uid: created.resourceUid,
      expectedGeneration: 2,
      spec: Object.freeze({ ...named, [C.fields.workloadRevision]: "3".repeat(64) }),
    });
    expect(omitted.generation).toBe(3);
    const accepted = db
      .query(
        "SELECT action, generation, configured_private_inputs_json FROM tf_v2_container_acceptances WHERE operation_id = ?",
      )
      .get(omitted.id) as {
      action: string;
      generation: number;
      configured_private_inputs_json: string | null;
    };
    expect(accepted).toEqual({
      action: "update",
      generation: 3,
      configured_private_inputs_json: null,
    });
    expect(guardProbes).toEqual({
      valid: true,
      resource: false,
      future: false,
      installation: false,
      principal: false,
      space: false,
      name: false,
      form: false,
      backend: false,
      target: false,
      currentGeneration: false,
      undeclaredName: false,
    });
    expect(omittedAdmissionParams).toBe(23);
    expect(maxBatchParams).toBeLessThanOrEqual(100);
    expect((await f.engine.runNext())?.status).toBe("failed");
    const repeated = await f.engine.acceptUpdate({
      principal: "container-owner-test",
      key: "f2-empty-map-omitted-again",
      uid: created.resourceUid,
      expectedGeneration: 3,
      spec: Object.freeze({ ...named, [C.fields.workloadRevision]: "4".repeat(64) }),
    });
    expect(repeated.generation).toBe(4);
    expect(f.sealing.ownerContextNullGenerations).toEqual([3, 4]);
    expect(f.sealing.updateCalls).toBe(3);
    expect(
      db
        .query(
          "SELECT configured_private_inputs_json FROM tf_v2_container_acceptances WHERE operation_id = ?",
        )
        .get(repeated.id),
    ).toEqual({ configured_private_inputs_json: null });
    expect(
      terminals.map(
        ({ action, generation, configured, firstOperationId, lastOperationId, last, count }) => ({
          action,
          generation,
          configured: configured === null,
          firstOperationId,
          lastOperationId,
          last,
          count,
        }),
      ),
    ).toEqual([
      {
        action: "create",
        generation: 1,
        configured: true,
        firstOperationId: created.id,
        lastOperationId: created.id,
        last: true,
        count: 1,
      },
      {
        action: "update",
        generation: 2,
        configured: false,
        firstOperationId: supplied.id,
        lastOperationId: supplied.id,
        last: true,
        count: 1,
      },
      {
        action: "update",
        generation: 3,
        configured: true,
        firstOperationId: omitted.id,
        lastOperationId: omitted.id,
        last: true,
        count: 1,
      },
      {
        action: "update",
        generation: 4,
        configured: true,
        firstOperationId: repeated.id,
        lastOperationId: repeated.id,
        last: true,
        count: 1,
      },
    ]);
  } finally {
    db.close();
  }
});

test("genuine F2 empty CREATE rejects an unprovided first map without writes", async () => {
  const db = new Database(":memory:");
  try {
    const f = await full100F2ConfiguredContainerEngine(db, undefined, undefined, false, true, true);
    const empty = Object.freeze({
      ...coreContainerSpec("1".repeat(64)),
      [C.fields.requiredSensitiveVars]: Object.freeze([]),
    });
    const created = await f.engine.acceptCreate({
      principal: "container-owner-test",
      key: "f2-empty-no-map-create",
      input: { form: f.formUrl, space: "default", name: "f2-empty-no-map", spec: empty },
    });
    expect((await f.engine.runNext())?.status).toBe("failed");
    const before = await containerDeleteSnapshot(db);
    await expect(
      f.engine.acceptUpdate({
        principal: "container-owner-test",
        key: "f2-empty-no-map-update",
        uid: created.resourceUid,
        expectedGeneration: 1,
        spec: Object.freeze({
          ...empty,
          [C.fields.requiredSensitiveVars]: Object.freeze(["TOKEN"]),
        }),
      }),
    ).rejects.toMatchObject({ code: "invalid_spec" });
    expect(await containerDeleteSnapshot(db)).toEqual(before);
    expect(f.sealing.updateCalls).toBe(0);
  } finally {
    db.close();
  }
});

test("genuine F2 retained 64-name map stays below the Host SQL binding cap", async () => {
  const db = new Database(":memory:");
  let omittedGuardBindings = 0;
  let omittedMaxStatementBindings = 0;
  const wrapSql = (original: Sql): Sql => ({
    query: (statement, params) => original.query(statement, params),
    run: (statement, params) => original.run(statement, params),
    batch(statements) {
      const terminal = statements.at(-1);
      if (
        terminal?.sql.startsWith(
          "WITH host_form_admission AS (SELECT 1 AS permitted) INSERT INTO main.tf_v2_container_acceptances ",
        ) &&
        terminal.params?.[11] === 3
      ) {
        const guard = statements.find((statement) =>
          statement.sql.startsWith("SELECT 1 AS permitted WHERE"),
        );
        omittedGuardBindings = guard?.params?.length ?? 0;
        omittedMaxStatementBindings = Math.max(
          ...statements.map((statement) => statement.params?.length ?? 0),
        );
      }
      return original.batch(statements);
    },
  });
  try {
    const f = await full100F2ConfiguredContainerEngine(db, wrapSql, undefined, false, true, true);
    const empty = Object.freeze({
      ...coreContainerSpec("1".repeat(64)),
      [C.fields.requiredSensitiveVars]: Object.freeze([]),
    });
    const created = await f.engine.acceptCreate({
      principal: "container-owner-test",
      key: "f2-64-name-create",
      input: { form: f.formUrl, space: "default", name: "f2-64", spec: empty },
    });
    expect((await f.engine.runNext())?.status).toBe("failed");
    const names = Object.freeze(
      Array.from({ length: 64 }, (_, index) => `TOKEN_${index.toString().padStart(2, "0")}`),
    );
    const named = Object.freeze({ ...empty, [C.fields.requiredSensitiveVars]: names });
    const privateInputs = Object.freeze(
      Object.fromEntries(names.map((name) => [name, "synthetic-value"])),
    );
    const supplied = await f.engine.acceptUpdate({
      principal: "container-owner-test",
      key: "f2-64-name-supplied",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: named,
      privateInputs,
    });
    expect(supplied.generation).toBe(2);
    expect((await f.engine.runNext())?.status).toBe("failed");
    const omitted = await f.engine.acceptUpdate({
      principal: "container-owner-test",
      key: "f2-64-name-omitted",
      uid: created.resourceUid,
      expectedGeneration: 2,
      spec: named,
    });
    expect(omitted.generation).toBe(3);
    expect(omittedGuardBindings).toBe(23);
    expect(omittedMaxStatementBindings).toBeLessThanOrEqual(100);
    expect(
      db
        .query(
          "SELECT configured_private_inputs_json FROM tf_v2_container_acceptances WHERE operation_id = ?",
        )
        .get(omitted.id),
    ).toEqual({ configured_private_inputs_json: null });
  } finally {
    db.close();
  }
});

test("genuine F2 retained guard scope fault leaves Core and owner unchanged", async () => {
  const db = new Database(":memory:");
  let injected = 0;
  const wrapSql = (original: Sql): Sql => ({
    query: (statement, params) => original.query(statement, params),
    run: (statement, params) => original.run(statement, params),
    batch(statements) {
      const terminal = statements.at(-1);
      if (
        terminal?.sql.startsWith(
          "WITH host_form_admission AS (SELECT 1 AS permitted) INSERT INTO main.tf_v2_container_acceptances ",
        ) &&
        terminal.params?.[11] === 3
      ) {
        const marker = "AND EXISTS (SELECT 1 FROM main.tf_v2_container_acceptances prior";
        const faulted = statements.map((statement) => {
          const location = statement.sql.indexOf(marker);
          if (location < 0 || !statement.params) return statement;
          const prefixBindings = [...statement.sql.slice(0, location)].filter(
            (character) => character === "?",
          ).length;
          const params = [...statement.params];
          params[prefixBindings + 4] = "other-principal";
          injected++;
          return { sql: statement.sql, params };
        });
        return original.batch(faulted);
      }
      return original.batch(statements);
    },
  });
  try {
    const f = await full100F2ConfiguredContainerEngine(db, wrapSql, undefined, false, true, true);
    const empty = Object.freeze({
      ...coreContainerSpec("1".repeat(64)),
      [C.fields.requiredSensitiveVars]: Object.freeze([]),
    });
    const created = await f.engine.acceptCreate({
      principal: "container-owner-test",
      key: "f2-retained-fault-create",
      input: { form: f.formUrl, space: "default", name: "f2-retained-fault", spec: empty },
    });
    expect((await f.engine.runNext())?.status).toBe("failed");
    const named = Object.freeze({
      ...empty,
      [C.fields.requiredSensitiveVars]: Object.freeze(["TOKEN"]),
    });
    const supplied = await f.engine.acceptUpdate({
      principal: "container-owner-test",
      key: "f2-retained-fault-supplied",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: named,
      privateInputs: { TOKEN: "synthetic-value" },
    });
    expect(supplied.generation).toBe(2);
    expect((await f.engine.runNext())?.status).toBe("failed");
    const before = await containerDeleteSnapshot(db);
    await expect(
      f.engine.acceptUpdate({
        principal: "container-owner-test",
        key: "f2-retained-fault-omitted",
        uid: created.resourceUid,
        expectedGeneration: 2,
        spec: named,
      }),
    ).rejects.toThrow();
    expect(injected).toBe(2);
    expect(await containerDeleteSnapshot(db)).toEqual(before);
  } finally {
    db.close();
  }
});

test("genuine F2 omitted map cannot revive a removed name", async () => {
  const db = new Database(":memory:");
  try {
    const f = await full100F2ConfiguredContainerEngine(db, undefined, undefined, false, true, true);
    const empty = Object.freeze({
      ...coreContainerSpec("1".repeat(64)),
      [C.fields.requiredSensitiveVars]: Object.freeze([]),
    });
    const created = await f.engine.acceptCreate({
      principal: "container-owner-test",
      key: "f2-revival-create",
      input: { form: f.formUrl, space: "default", name: "f2-revival", spec: empty },
    });
    expect((await f.engine.runNext())?.status).toBe("failed");
    const named = Object.freeze({
      ...empty,
      [C.fields.requiredSensitiveVars]: Object.freeze(["TOKEN"]),
    });
    const supplied = await f.engine.acceptUpdate({
      principal: "container-owner-test",
      key: "f2-revival-supplied",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: named,
      privateInputs: { TOKEN: "synthetic-map-value" },
    });
    expect(supplied.generation).toBe(2);
    expect((await f.engine.runNext())?.status).toBe("failed");
    const removed = await f.engine.acceptUpdate({
      principal: "container-owner-test",
      key: "f2-revival-removed",
      uid: created.resourceUid,
      expectedGeneration: 2,
      spec: empty,
    });
    expect(removed.generation).toBe(3);
    expect((await f.engine.runNext())?.status).toBe("failed");
    const before = await containerDeleteSnapshot(db);
    await expect(
      f.engine.acceptUpdate({
        principal: "container-owner-test",
        key: "f2-revival-refused",
        uid: created.resourceUid,
        expectedGeneration: 3,
        spec: named,
      }),
    ).rejects.toMatchObject({ code: "invalid_spec" });
    expect(await containerDeleteSnapshot(db)).toEqual(before);
  } finally {
    db.close();
  }
});
