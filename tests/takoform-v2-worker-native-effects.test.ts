import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql, SqlParam } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { WORKER_VERSION_FORM_URL } from "../src/takoform-v2/forms/worker-specs.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
import {
  createV2NativeEffectCustody,
  type V2NativeEffectIdentity,
} from "../src/takoform-v2/worker-native-effects.ts";
import {
  inspectV2WorkerNativeIdentityDomain,
  v2WorkerNativeIdentityDomainReady,
} from "../src/takoform-v2/worker-native-identity-schema.ts";

const DIGEST = `sha256:${"a".repeat(64)}` as const;
// Static expansion of the unchanged grant at public 83e031be/94f60b3f,
// including its original whitespace, DB clock expressions and CLAIM.
const DEFAULT_GRANT_SHA256 = "485888d03cc5d2acaf79ed37ba869b3626d8fe2fea8aaf26f06498596971bd6d";
const GRANT_INSERT = "INSERT INTO tf_v2_worker_native_effects";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "v2-native-effect-"));
  const path = join(directory, "db.sqlite");
  const db = new Database(path);
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  let nowMs = Date.now();
  const now = () => new Date(nowMs);
  const backend = {
    id: "fixture-native-backend-v1",
    targetKey: "target-a",
    async execute() {
      return { kind: "unknown" as const };
    },
    async reconcile() {
      return { kind: "unknown" as const };
    },
  };
  const engine = createTakoformV2Engine({
    sql,
    now,
    replayWindowSeconds: 3600,
    leaseMilliseconds: 60_000,
    authorize: async () => true,
    forms: {
      [WORKER_VERSION_FORM_URL]: {
        validateCreate() {},
        validateUpdate() {},
        backend,
      },
    },
  });
  const accepted = await engine.acceptCreate({
    principal: "org-a",
    key: "worker-native-effect-create-key",
    input: {
      form: WORKER_VERSION_FORM_URL,
      space: "production",
      name: "version-a",
      spec: { worker: { resourceUid: "worker-a" }, handlers: [] },
    },
  });
  const store = createV2Store(sql);
  const operation = await store.operation(accepted.id);
  const resource = operation && (await store.resource(operation.resource_uid));
  if (!operation || !resource) throw new Error("missing accepted Operation");
  const leaseToken = "lease-first";
  expect(await store.claim(operation.id, leaseToken, nowMs, nowMs + 60_000)).toBe(true);
  expect(await store.markDispatch(operation.id, leaseToken, now().toISOString())).toBe(true);
  const execution: V2Execution = {
    operationId: operation.id,
    resourceUid: resource.uid,
    principal: operation.principal,
    action: operation.action,
    generation: operation.generation,
    form: resource.form_url,
    space: resource.space,
    name: resource.name,
    spec: JSON.parse(operation.accepted_spec_json),
    previousObserved: JSON.parse(resource.observed_json),
    previousOutput: JSON.parse(resource.output_json),
    backendKey: operation.backend_key,
    backendId: operation.backend_id,
    targetKey: operation.target_key,
    leaseToken,
  };
  const identity: V2NativeEffectIdentity = {
    execution,
    nativeIdentity: "native-script-a",
    closureDigest: DIGEST,
  };
  return {
    path,
    directory,
    db,
    sql,
    store,
    identity,
    custody: createV2NativeEffectCustody({ sql, now }),
    advance(ms: number) {
      nowMs += ms;
    },
    nowMs: () => nowMs,
    now,
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

type NativeEffectFixture = Awaited<ReturnType<typeof fixture>>;

function captureGrant(f: NativeEffectFixture) {
  const statements: { readonly sql: string; readonly params: readonly SqlParam[] }[] = [];
  const sql: Sql = {
    query: f.sql.query,
    batch: f.sql.batch,
    async run(statement, params) {
      if (statement.startsWith(GRANT_INSERT))
        statements.push({ sql: statement, params: [...(params ?? [])] });
      return await f.sql.run(statement, params);
    },
  };
  return { sql, statements };
}

/**
 * Disposable component model, NOT canonical migration0102 or its application.
 * Reuses the real canonical fixture and changes only the empty deletion table's
 * native_identity CHECK; its actual stored index and eight guards are retained.
 */
async function widenEmptyNativeIdentityTable(f: NativeEffectFixture) {
  expect(await inspectV2WorkerNativeIdentityDomain(f.sql)).toBe("legacy_v2w52");
  expect(
    await f.sql.query("SELECT count(*) AS count FROM main.tf_v2_worker_native_deletions"),
  ).toEqual([{ count: 0 }]);
  const closure = await f.sql.query(
    "SELECT type, name, sql FROM main.sqlite_schema WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type, name",
    ["tf_v2_worker_native_deletions"],
  );
  const tables = closure.filter((row) => row.type === "table");
  const guards = closure.filter((row) => row.type === "trigger");
  const indexes = closure.filter((row) => row.type === "index");
  expect(tables).toHaveLength(1);
  expect(guards).toHaveLength(8);
  expect(indexes).toHaveLength(1);
  const tableSql = tables[0]?.sql;
  if (typeof tableSql !== "string") throw new Error("missing actual deletion table DDL");
  const legacyCheck = `length(native_identity) = 52 AND substr(native_identity, 1, 4) = 'v2w-' AND
    substr(native_identity, 5) NOT GLOB '*[^0-9a-f]*'`;
  expect(tableSql.split(legacyCheck)).toHaveLength(2);
  const opaqueTable = tableSql.replace(legacyCheck, "length(native_identity) BETWEEN 1 AND 255");
  const retained = [...indexes, ...guards].map((row) => {
    if (typeof row.sql !== "string") throw new Error("missing actual deletion guard/index DDL");
    return row.sql;
  });
  f.db.exec("BEGIN");
  try {
    f.db.exec("DROP TABLE main.tf_v2_worker_native_deletions");
    f.db.exec(opaqueTable);
    for (const ddl of retained) f.db.exec(ddl);
    f.db.exec("COMMIT");
  } catch (error) {
    f.db.exec("ROLLBACK");
    throw error;
  }
  expect(await inspectV2WorkerNativeIdentityDomain(f.sql)).toBe("opaque255");
}

async function expectNoNativeGrant(f: NativeEffectFixture) {
  expect(await f.sql.query("SELECT * FROM main.tf_v2_worker_native_effects")).toHaveLength(0);
}

async function expectedGrantParams(f: NativeEffectFixture): Promise<readonly SqlParam[]> {
  const e = f.identity.execution;
  const accepted = await f.store.operation(e.operationId);
  if (!accepted) throw new Error("missing real accepted Operation");
  return [
    f.identity.nativeIdentity,
    f.identity.closureDigest,
    e.operationId,
    e.resourceUid,
    e.principal,
    e.action,
    e.generation,
    e.backendKey,
    e.backendId,
    e.targetKey,
    accepted.accepted_spec_json,
    e.leaseToken,
    f.nowMs(),
    e.form,
    e.space,
    e.name,
  ];
}

test("native identity domain rejects unknown selectors synchronously", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const sql: Sql = {
      async query(statement, params) {
        calls++;
        return await f.sql.query(statement, params);
      },
      async run(statement, params) {
        calls++;
        return await f.sql.run(statement, params);
      },
      async batch(statements) {
        calls++;
        return await f.sql.batch(statements);
      },
    };
    for (const invalid of ["legacy_v2w52", "opaque254", null, false, 0, {}, []])
      expect(() =>
        Reflect.apply(createV2NativeEffectCustody, undefined, [
          { sql, now: f.now, requiredNativeIdentityDomain: invalid },
        ]),
      ).toThrow(TypeError);
    expect(calls).toBe(0);
    await expectNoNativeGrant(f);
  } finally {
    f.close();
  }
});

test("default native grant preserves frozen SQL and typed bindings", async () => {
  const f = await fixture();
  try {
    const captured = captureGrant(f);
    const options: {
      sql: Sql;
      now: () => Date;
      requiredNativeIdentityDomain?: "opaque255";
    } = { sql: captured.sql, now: f.now };
    const custody = createV2NativeEffectCustody(options);
    options.requiredNativeIdentityDomain = "opaque255";
    const params = await expectedGrantParams(f);
    expect(await custody.grant(f.identity)).toBe("granted");
    expect(captured.statements).toHaveLength(1);
    const statement = captured.statements[0];
    if (!statement) throw new Error("missing actual grant statement");
    expect(Buffer.byteLength(statement.sql)).toBe(1412);
    expect(createHash("sha256").update(statement.sql).digest("hex")).toBe(DEFAULT_GRANT_SHA256);
    expect(statement.params).toEqual(params);
    expect(statement.params).toHaveLength(16);
    expect(statement.sql).not.toContain("pragma_table_xinfo");
  } finally {
    f.close();
  }
});

test("opaque native grant captures selection and admits only one accepted Operation", async () => {
  const f = await fixture();
  let secondDb: Database | undefined;
  try {
    await widenEmptyNativeIdentityTable(f);
    const captured = captureGrant(f);
    const options: {
      sql: Sql;
      now: () => Date;
      requiredNativeIdentityDomain?: "opaque255";
    } = { sql: captured.sql, now: f.now, requiredNativeIdentityDomain: "opaque255" };
    const custody = createV2NativeEffectCustody(options);
    delete options.requiredNativeIdentityDomain;
    const params = await expectedGrantParams(f);
    expect(await custody.grant(f.identity)).toBe("granted");
    const statement = captured.statements[0];
    if (!statement) throw new Error("missing actual selected grant statement");
    const ready = v2WorkerNativeIdentityDomainReady("opaque255");
    expect(Buffer.byteLength(ready)).toBeLessThanOrEqual(24_000);
    expect(Buffer.byteLength(statement.sql)).toBeLessThanOrEqual(26_000);
    expect(statement.sql.split(` AND ${ready}`)).toHaveLength(2);
    expect(
      createHash("sha256")
        .update(statement.sql.replace(` AND ${ready}`, ""))
        .digest("hex"),
    ).toBe(DEFAULT_GRANT_SHA256);
    expect(statement.params).toEqual(params);
    expect(statement.params).toHaveLength(16);
    secondDb = new Database(f.path);
    const second = createV2NativeEffectCustody({
      sql: createSqliteSql(secondDb),
      now: f.now,
      requiredNativeIdentityDomain: "opaque255",
    });
    expect(await second.grant(f.identity)).toBe("already_granted");
    expect(await custody.grant(f.identity)).toBe("already_granted");
    expect(await custody.inspect(f.identity)).toEqual({ kind: "sent" });
    expect(await f.sql.query("SELECT * FROM main.tf_v2_worker_native_effects")).toHaveLength(1);
  } finally {
    secondDb?.close();
    f.close();
  }
});

test("opaque native grant refuses legacy missing weakened and shadow contracts", async () => {
  for (const contract of ["legacy", "missing", "weakened", "shadow"] as const) {
    const f = await fixture();
    try {
      if (contract !== "legacy") await widenEmptyNativeIdentityTable(f);
      if (contract === "missing") f.db.exec("DROP TABLE main.tf_v2_worker_native_deletions");
      if (contract === "weakened") {
        f.db.exec("DROP TRIGGER main.tf_v2_worker_native_deletion_source_guard");
        f.db.exec(`CREATE TRIGGER tf_v2_worker_native_deletion_source_guard
BEFORE UPDATE OF qualified_source_receipt ON tf_v2_worker_native_deletions
BEGIN SELECT 1; END`);
      }
      if (contract === "shadow")
        f.db.exec("CREATE TEMP TABLE tf_v2_worker_native_deletions (native_identity TEXT)");
      const captured = captureGrant(f);
      const custody = createV2NativeEffectCustody({
        sql: captured.sql,
        now: f.now,
        requiredNativeIdentityDomain: "opaque255",
      });
      expect(await custody.grant(f.identity)).toBe("conflict");
      expect(captured.statements).toHaveLength(1);
      await expectNoNativeGrant(f);
      expect(await f.custody.inspect(f.identity)).toEqual({ kind: "never_granted" });
    } finally {
      f.close();
    }
  }
});

test("opaque native grant rechecks its schema at actual INSERT after an await", async () => {
  const f = await fixture();
  try {
    await widenEmptyNativeIdentityTable(f);
    let drifted = false;
    let attempts = 0;
    const sql: Sql = {
      query: f.sql.query,
      batch: f.sql.batch,
      async run(statement, params) {
        if (statement.startsWith(GRANT_INSERT)) {
          attempts++;
          await Promise.resolve();
          f.db.exec("DROP TRIGGER main.tf_v2_worker_native_deletion_source_guard");
          drifted = true;
        }
        return await f.sql.run(statement, params);
      },
    };
    const custody = createV2NativeEffectCustody({
      sql,
      now: f.now,
      requiredNativeIdentityDomain: "opaque255",
    });
    expect(await custody.grant(f.identity)).toBe("conflict");
    expect(drifted).toBe(true);
    expect(attempts).toBe(1);
    await expectNoNativeGrant(f);
    expect(await inspectV2WorkerNativeIdentityDomain(f.sql)).toBeNull();
  } finally {
    f.close();
  }
});

test("opaque native grant retains accepted identity and database lease fences", async () => {
  const f = await fixture();
  try {
    await widenEmptyNativeIdentityTable(f);
    const custody = createV2NativeEffectCustody({
      sql: f.sql,
      now: f.now,
      requiredNativeIdentityDomain: "opaque255",
    });
    const mismatches: readonly V2Execution[] = [
      { ...f.identity.execution, principal: "other-org" },
      { ...f.identity.execution, spec: { changed: true } },
      { ...f.identity.execution, backendId: "other-backend" },
    ];
    for (const execution of mismatches)
      expect(
        await custody.grant({
          ...f.identity,
          execution,
        }),
      ).toBe("conflict");
    let delayed = false;
    const sql: Sql = {
      query: f.sql.query,
      batch: f.sql.batch,
      async run(statement, params) {
        if (statement.startsWith(GRANT_INSERT)) {
          await Promise.resolve();
          const expired = Date.now() - 1000;
          expect(expired).toBeGreaterThan(0);
          await f.sql.run("UPDATE tf_v2_operations SET lease_until_ms = ? WHERE id = ?", [
            expired,
            f.identity.execution.operationId,
          ]);
          delayed = true;
        }
        return await f.sql.run(statement, params);
      },
    };
    const delayedCustody = createV2NativeEffectCustody({
      sql,
      // Keep the captured host clock strictly below the expired database lease.
      // Only the statement's current database clock can refuse that lease.
      now: () => new Date(0),
      requiredNativeIdentityDomain: "opaque255",
    });
    expect(await delayedCustody.grant(f.identity)).toBe("conflict");
    expect(delayed).toBe(true);
    await expectNoNativeGrant(f);
  } finally {
    f.close();
  }
});

test("opaque native grant preserves sent confirmed and ACK-loss reconciliation after drift", async () => {
  const f = await fixture();
  let reopenedDb: Database | undefined;
  try {
    await widenEmptyNativeIdentityTable(f);
    const custody = createV2NativeEffectCustody({
      sql: f.sql,
      now: f.now,
      requiredNativeIdentityDomain: "opaque255",
    });
    expect(await custody.grant(f.identity)).toBe("granted");
    f.db.exec("DROP TRIGGER main.tf_v2_worker_native_deletion_source_guard");
    reopenedDb = new Database(f.path);
    const reopened = createV2NativeEffectCustody({
      sql: createSqliteSql(reopenedDb),
      now: f.now,
      requiredNativeIdentityDomain: "opaque255",
    });
    expect(await reopened.inspect(f.identity)).toEqual({ kind: "sent" });
    expect(await reopened.grant(f.identity)).toBe("already_granted");
    expect(await reopened.confirm({ ...f.identity, receipt: '"etag-a"' })).toBe(true);
    expect(await reopened.acknowledge({ ...f.identity, receipt: '"etag-a"' })).toBe(true);
    expect(await reopened.confirm({ ...f.identity, receipt: '"etag-b"' })).toBe(false);
    expect(await reopened.inspect(f.identity)).toEqual({
      kind: "confirmed",
      receipt: '"etag-a"',
      acknowledgedReceipt: '"etag-a"',
    });
    expect(await reopened.grant(f.identity)).toBe("already_granted");
    expect(await f.sql.query("SELECT * FROM main.tf_v2_worker_native_effects")).toHaveLength(1);
  } finally {
    reopenedDb?.close();
    f.close();
  }
});

test("one atomic grant survives duplicate and cross-connection contention", async () => {
  const f = await fixture();
  const secondDb = new Database(f.path);
  const second = createV2NativeEffectCustody({ sql: createSqliteSql(secondDb), now: f.now });
  try {
    const results = await Promise.all([f.custody.grant(f.identity), second.grant(f.identity)]);
    expect(results.sort()).toEqual(["already_granted", "granted"]);
    expect(await f.custody.grant(f.identity)).toBe("already_granted");
    expect(await f.custody.inspect(f.identity)).toEqual({ kind: "sent" });
    const rows = await f.sql.query("SELECT * FROM tf_v2_worker_native_effects");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operation_id: f.identity.execution.operationId,
      native_identity: "native-script-a",
      closure_digest: DIGEST,
      grant_lease_token: "lease-first",
    });
  } finally {
    secondDb.close();
    f.close();
  }
});

test("grant and inspect refuse stale claim, mismatched accepted identity and altered closure", async () => {
  const f = await fixture();
  try {
    expect(await f.custody.inspect(f.identity)).toEqual({ kind: "never_granted" });
    expect(await f.custody.grant({ ...f.identity, nativeIdentity: "" })).toBe("conflict");
    expect(
      await f.custody.grant({ ...f.identity, closureDigest: `sha256:${"F".repeat(64)}` }),
    ).toBe("conflict");
    expect(
      await f.custody.grant({
        ...f.identity,
        execution: { ...f.identity.execution, principal: "other-org" },
      }),
    ).toBe("conflict");
    expect(
      await f.custody.grant({
        ...f.identity,
        execution: { ...f.identity.execution, space: "other-space" },
      }),
    ).toBe("conflict");
    expect(
      await f.custody.grant({
        ...f.identity,
        execution: { ...f.identity.execution, backendKey: "other-key" },
      }),
    ).toBe("conflict");
    expect(
      await f.custody.grant({
        ...f.identity,
        execution: { ...f.identity.execution, spec: { different: true } },
      }),
    ).toBe("conflict");
    expect(await f.sql.query("SELECT * FROM tf_v2_worker_native_effects")).toHaveLength(0);
    f.advance(60_001);
    expect(await f.custody.grant(f.identity)).toBe("conflict");
    expect(await f.custody.inspect(f.identity)).toEqual({ kind: "conflict" });
    expect(await f.sql.query("SELECT * FROM tf_v2_worker_native_effects")).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("atomic grant rechecks the lease at SQL execution after an asynchronous delay", async () => {
  const f = await fixture();
  try {
    let delayed = false;
    const sql: Sql = {
      query: f.sql.query,
      batch: f.sql.batch,
      async run(statement, params) {
        if (statement.startsWith("INSERT INTO tf_v2_worker_native_effects")) {
          delayed = true;
          await Promise.resolve();
          // The caller's captured clock remains old. The database statement
          // must see the actual expired lease rather than trust that snapshot.
          await f.sql.run("UPDATE tf_v2_operations SET lease_until_ms = ? WHERE id = ?", [
            Date.now() - 1000,
            f.identity.execution.operationId,
          ]);
        }
        return await f.sql.run(statement, params);
      },
    };
    const custody = createV2NativeEffectCustody({ sql, now: f.now });
    expect(await custody.grant(f.identity)).toBe("conflict");
    expect(delayed).toBe(true);
    expect(await f.sql.query("SELECT * FROM tf_v2_worker_native_effects")).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("a reclaimed lease can inspect but can never get a second send grant", async () => {
  const f = await fixture();
  try {
    expect(await f.custody.grant(f.identity)).toBe("granted");
    f.advance(60_001);
    const freshToken = "lease-second";
    expect(
      await f.store.claim(
        f.identity.execution.operationId,
        freshToken,
        f.nowMs(),
        f.nowMs() + 60_000,
      ),
    ).toBe(true);
    const reclaimed = {
      ...f.identity,
      execution: { ...f.identity.execution, leaseToken: freshToken },
    };
    expect(await f.custody.inspect(reclaimed)).toEqual({ kind: "sent" });
    expect(await f.custody.grant(reclaimed)).toBe("already_granted");
    expect(await f.custody.grant({ ...reclaimed, nativeIdentity: "other-script" })).toBe(
      "conflict",
    );
    expect(await f.custody.grant({ ...reclaimed, closureDigest: `sha256:${"b".repeat(64)}` })).toBe(
      "conflict",
    );
    expect(await f.custody.inspect(f.identity)).toEqual({ kind: "conflict" });
    expect(await f.sql.query("SELECT * FROM tf_v2_worker_native_effects")).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("ACK loss before persistence remains sent after process reopen; exact readback can confirm", async () => {
  const f = await fixture();
  try {
    expect(await f.custody.grant(f.identity)).toBe("granted");
    const reopenedDb = new Database(f.path);
    try {
      const reopened = createV2NativeEffectCustody({
        sql: createSqliteSql(reopenedDb),
        now: f.now,
      });
      expect(await reopened.inspect(f.identity)).toEqual({ kind: "sent" });
      expect(await reopened.grant(f.identity)).toBe("already_granted");
      expect(await reopened.confirm({ ...f.identity, receipt: '"etag-a"' })).toBe(true);
      expect(await reopened.inspect(f.identity)).toEqual({
        kind: "confirmed",
        receipt: '"etag-a"',
      });
      expect(await reopened.acknowledge({ ...f.identity, receipt: '"etag-a"' })).toBe(true);
      expect(await reopened.confirm({ ...f.identity, receipt: '"etag-b"' })).toBe(false);
    } finally {
      reopenedDb.close();
    }
  } finally {
    f.close();
  }
});

test("ACK persisted before restart is monotonic and never self-confirms", async () => {
  const f = await fixture();
  try {
    expect(await f.custody.grant(f.identity)).toBe("granted");
    expect(await f.custody.acknowledge({ ...f.identity, receipt: '"etag-a"' })).toBe(true);
    const reopenedDb = new Database(f.path);
    try {
      const reopened = createV2NativeEffectCustody({
        sql: createSqliteSql(reopenedDb),
        now: f.now,
      });
      expect(await reopened.inspect(f.identity)).toEqual({
        kind: "sent",
        acknowledgedReceipt: '"etag-a"',
      });
      expect(await reopened.acknowledge({ ...f.identity, receipt: '"etag-a"' })).toBe(true);
      expect(await reopened.acknowledge({ ...f.identity, receipt: '"etag-b"' })).toBe(false);
      expect(await reopened.confirm({ ...f.identity, receipt: '"etag-b"' })).toBe(false);
      expect(await reopened.confirm({ ...f.identity, receipt: '"etag-a"' })).toBe(true);
      expect(await reopened.inspect(f.identity)).toEqual({
        kind: "confirmed",
        acknowledgedReceipt: '"etag-a"',
        receipt: '"etag-a"',
      });
    } finally {
      reopenedDb.close();
    }
  } finally {
    f.close();
  }
});

test("durable grant and receipts cannot be deleted or rewritten by a later writer", async () => {
  const f = await fixture();
  try {
    expect(await f.custody.grant(f.identity)).toBe("granted");
    expect(await f.custody.confirm({ ...f.identity, receipt: '"etag-a"' })).toBe(true);
    expect(
      f.sql.run(
        "UPDATE tf_v2_worker_native_effects SET native_identity = 'replacement' WHERE operation_id = ?",
        [f.identity.execution.operationId],
      ),
    ).rejects.toThrow();
    expect(
      f.sql.run("DELETE FROM tf_v2_worker_native_effects WHERE operation_id = ?", [
        f.identity.execution.operationId,
      ]),
    ).rejects.toThrow();
    expect(await f.custody.inspect(f.identity)).toMatchObject({ kind: "confirmed" });
  } finally {
    f.close();
  }
});
