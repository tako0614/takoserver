import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { v2ContainerOwnerMigrationCandidate } from "../scripts/deploy/v2-container-owner-migration-candidate.ts";
import { CONTAINER_CONTRACT as C } from "../src/container-contract.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  createV2ContainerHostAcceptance,
  inspectV2ContainerOwnerSchema,
  V2_CONTAINER_OWNER_RECIPE as recipe,
  V2_CONTAINER_OWNER_READY,
} from "../src/takoform-v2/container-owner-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  redeemV2HostAcceptance,
  type V2HostAcceptanceContext,
  type V2PreparedHostAcceptance,
} from "../src/takoform-v2/host-acceptance.ts";
import type { V2Backend, V2Form } from "../src/takoform-v2/types.ts";
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
      status: "accepted",
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
      status: "accepted",
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
  expect(fixed.guard.params).toHaveLength(9);
  expect(fixed.guard.params?.[8]).toBe(1);
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
