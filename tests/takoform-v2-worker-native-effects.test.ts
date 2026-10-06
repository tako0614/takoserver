import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { WORKER_VERSION_FORM_URL } from "../src/takoform-v2/forms/worker-specs.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
import {
  createV2NativeEffectCustody,
  type V2NativeEffectIdentity,
} from "../src/takoform-v2/worker-native-effects.ts";

const DIGEST = `sha256:${"a".repeat(64)}` as const;

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
