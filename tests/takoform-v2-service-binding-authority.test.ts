import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bytesDigest } from "../src/json.ts";
import type { Sql, SqlParam, SqlStatement, SqlWrite } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import {
  createV2ServiceBindingAuthority,
  type V2ServiceBindingClaim,
} from "../src/takoform-v2/service-binding-authority.ts";
import { createV2ServiceBindingAuthority as exportedAuthority } from "../src/takoform-v2/index.ts";

test("public v2 extension entrypoint exposes the logical service binding authority", () => {
  expect(exportedAuthority).toBe(createV2ServiceBindingAuthority);
});

const TARGET_KEY = "service-authority-target";
const CALLER_UID = "caller-worker";
const TARGET_UID = "target-worker";
const VERSION_UID = "service-version";
const VERSION_OPERATION_ID = "op-service-version";
const BUNDLE_UID = "service-bundle";
const BUNDLE_FORM_URL = "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/";

async function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "0070_takoform_v2.sql",
    "0071_v2_sqlite_migration_set_custody.sql",
    "0073_v2_reference_acceptance.sql",
    "0081_v2_private_inputs.sql",
  ]) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const sql = createSqliteSql(db);
  settleResource(db, {
    uid: CALLER_UID,
    formUrl: MODULE_WORKER_FORM_URL,
    name: "caller",
    backendId: "fixture-module-worker",
    spec: "{}",
    observed: '{"ready":true}',
  });
  settleResource(db, {
    uid: TARGET_UID,
    formUrl: MODULE_WORKER_FORM_URL,
    name: "target",
    backendId: "fixture-module-worker",
    spec: "{}",
    observed: '{"ready":true}',
  });
  settleResource(db, {
    uid: BUNDLE_UID,
    formUrl: BUNDLE_FORM_URL,
    name: "bundle",
    backendId: "fixture-worker-bundle",
    spec: "{}",
    observed: '{"ready":true}',
  });
  const spec = JSON.stringify({
    worker: { resourceUid: CALLER_UID },
    bundle: { resourceUid: BUNDLE_UID },
    handlers: ["fetch"],
    serviceBindings: [{ name: "UPSTREAM", resource: { resourceUid: TARGET_UID } }],
  });
  seedAcceptedVersion(db, spec);
  const nativeVersionId = `v2-${(await bytesDigest(new TextEncoder().encode(`${VERSION_UID}\u00001`))).slice("sha256:".length)}`;
  const claim: V2ServiceBindingClaim = {
    principal: "alice",
    space: "default",
    targetKey: TARGET_KEY,
    workerUid: CALLER_UID,
    workerVersionUid: VERSION_UID,
    workerVersionOperationId: VERSION_OPERATION_ID,
    nativeVersionId,
    incarnationId: "native-incarnation",
    servingSourceOperationId: "serving-operation",
    bindings: [{ name: "UPSTREAM", resourceUid: TARGET_UID }],
  };
  return { db, sql, claim };
}

test("accepted service bindings resolve the logical Worker UID without pinning a Deployment", async () => {
  const { db, sql, claim } = await fixture();
  try {
    const authority = createV2ServiceBindingAuthority({ sql, targetKey: TARGET_KEY });
    const resolution = await authority.resolveCurrentBinding(claim, "UPSTREAM");
    expect(resolution?.identity).toEqual({
      targetKey: TARGET_KEY,
      principal: "alice",
      space: "default",
      resourceUid: TARGET_UID,
    });
    expect(typeof resolution?.vector).toBe("string");
    expect(await resolution?.stillCurrent()).toBe(true);
    // The authority proves the logical target identity. Deployment selection is
    // deliberately left to the native Worker router at invocation time.
    expect(
      db
        .query("SELECT uid FROM tf_v2_resources WHERE form_url = ?")
        .all(WORKER_DEPLOYMENT_FORM_URL),
    ).toEqual([]);
  } finally {
    db.close();
  }
});

test("an accepted source Version remains valid during a later pending same-spec PUT", async () => {
  const { db, sql, claim } = await fixture();
  try {
    const spec = db
      .query("SELECT spec_json FROM tf_v2_resources WHERE uid = ?")
      .get(VERSION_UID) as { spec_json: string };
    db.prepare(`UPDATE tf_v2_resources SET generation = 2, phase = 'pending',
      busy_operation = 'op-service-version-update', last_operation = 'op-service-version-update'
      WHERE uid = ?`).run(VERSION_UID);
    db.prepare(`INSERT INTO tf_v2_operations
      (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,status,effect,
       created_at,updated_at,retain_until,backend_id,target_key,backend_key,accepted_spec_json)
      VALUES ('op-service-version-update',?,'alice','replay-update','fp','update',2,'queued','none',
       '2026-10-07T00:00:00Z','2026-10-07T00:00:00Z','2026-10-08T00:00:00Z',
       'fixture-worker-version',?,'key-update',?)`).run(VERSION_UID, TARGET_KEY, spec.spec_json);

    const authority = createV2ServiceBindingAuthority({ sql, targetKey: TARGET_KEY });
    expect(await authority.resolveCurrentBinding(claim, "UPSTREAM")).not.toBeNull();
  } finally {
    db.close();
  }
});

test("binding authority refuses stale operation, native identity, declaration, owner, and sealed reference claims", async () => {
  const cases: readonly {
    readonly name: string;
    readonly alter: (db: Database, claim: V2ServiceBindingClaim) => V2ServiceBindingClaim;
  }[] = [
    {
      name: "wrong accepted source operation",
      alter: (_db, claim) => ({ ...claim, workerVersionOperationId: "op-stale" }),
    },
    {
      name: "wrong native Version identity",
      alter: (_db, claim) => ({ ...claim, nativeVersionId: `v2-${"0".repeat(64)}` }),
    },
    {
      name: "undeclared binding name",
      alter: (_db, claim) => ({
        ...claim,
        bindings: claim.bindings.map((binding, index) =>
          index === 0 ? { ...binding, name: "OTHER" } : binding,
        ),
      }),
    },
    {
      name: "substituted target UID",
      alter: (_db, claim) => ({
        ...claim,
        bindings: claim.bindings.map((binding, index) =>
          index === 0 ? { ...binding, resourceUid: "other-worker" } : binding,
        ),
      }),
    },
    {
      name: "foreign principal",
      alter: (_db, claim) => ({ ...claim, principal: "mallory" }),
    },
    {
      name: "foreign Space",
      alter: (_db, claim) => ({ ...claim, space: "other-space" }),
    },
    {
      name: "tampered sealed reference",
      alter: (db, claim) => {
        // Model corrupt persisted state; the production trigger correctly
        // prevents this update after acceptance.
        db.exec("DROP TRIGGER tf_v2_operation_reference_immutable");
        db.prepare(`UPDATE tf_v2_operation_references SET form_url = 'https://wrong.invalid/'
          WHERE operation_id = ? AND target_uid = ?`).run(VERSION_OPERATION_ID, TARGET_UID);
        return claim;
      },
    },
    {
      name: "unsealed source reference set",
      alter: (db, claim) => {
        // Model an impossible persisted state after acceptance; production
        // prevents changing a sealed set.
        db.exec("DROP TRIGGER tf_v2_operation_reference_set_immutable");
        db.prepare(
          "UPDATE tf_v2_operation_reference_sets SET sealed = 0 WHERE operation_id = ?",
        ).run(VERSION_OPERATION_ID);
        return claim;
      },
    },
  ];

  for (const item of cases) {
    const { db, sql, claim } = await fixture();
    try {
      const authority = createV2ServiceBindingAuthority({ sql, targetKey: TARGET_KEY });
      const offered = item.alter(db, claim);
      expect(await authority.resolveCurrentBinding(offered, "UPSTREAM"), item.name).toBeNull();
    } finally {
      db.close();
    }
  }
});

test("a previously captured resolution becomes stale when the logical target changes", async () => {
  const { db, sql, claim } = await fixture();
  try {
    const authority = createV2ServiceBindingAuthority({ sql, targetKey: TARGET_KEY });
    const resolution = await authority.resolveCurrentBinding(claim, "UPSTREAM");
    expect(resolution).not.toBeNull();
    db.prepare("UPDATE tf_v2_resources SET spec_json = '{\"changed\":true}' WHERE uid = ?").run(
      TARGET_UID,
    );
    expect(await resolution?.stillCurrent()).toBe(false);
  } finally {
    db.close();
  }
});

test("a logical target change during asynchronous capture cannot yield a current resolution", async () => {
  const { db, sql, claim } = await fixture();
  try {
    let changed = false;
    const racingSql: Sql = {
      async query(statement: string, params?: readonly SqlParam[]) {
        const rows = await sql.query(statement, params);
        if (!changed && statement.includes("WHERE uid IN (?, ?)")) {
          changed = true;
          db.prepare(
            "UPDATE tf_v2_resources SET spec_json = '{\"changed\":true}' WHERE uid = ?",
          ).run(TARGET_UID);
        }
        return rows;
      },
      run(statement: string, params?: readonly SqlParam[]): Promise<SqlWrite> {
        return sql.run(statement, params);
      },
      batch(statements: readonly SqlStatement[]): Promise<readonly SqlWrite[]> {
        return sql.batch(statements);
      },
    };
    const authority = createV2ServiceBindingAuthority({ sql: racingSql, targetKey: TARGET_KEY });
    expect(await authority.resolveCurrentBinding(claim, "UPSTREAM")).toBeNull();
    expect(changed).toBe(true);
  } finally {
    db.close();
  }
});

function settleResource(
  db: Database,
  input: {
    readonly uid: string;
    readonly formUrl: string;
    readonly name: string;
    readonly backendId: string;
    readonly spec: string;
    readonly observed: string;
  },
): void {
  const operationId = `op-${input.uid}`;
  db.prepare(`INSERT INTO tf_v2_resources
    (uid,principal,form_url,space,name,backend_id,target_key,active_name,generation,
     observed_generation,phase,spec_json,observed_json,output_json,last_operation)
    VALUES (?,'alice',?,'default',?,?,?, ?,1,1,'idle',?,?,'{}',?)`).run(
    input.uid,
    input.formUrl,
    input.name,
    input.backendId,
    TARGET_KEY,
    input.name,
    input.spec,
    input.observed,
    operationId,
  );
  db.prepare(`INSERT INTO tf_v2_operations
    (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,status,effect,
     created_at,updated_at,retain_until,backend_id,target_key,backend_key,accepted_spec_json)
    VALUES (?,?,'alice',?,'fp','create',1,'succeeded','complete',
      '2026-10-07T00:00:00Z','2026-10-07T00:00:00Z','2026-10-08T00:00:00Z',?, ?,?,'{}')`).run(
    operationId,
    input.uid,
    `replay-${input.uid}`,
    input.backendId,
    TARGET_KEY,
    `key-${input.uid}`,
  );
}

function seedAcceptedVersion(db: Database, spec: string): void {
  db.prepare(`INSERT INTO tf_v2_resources
    (uid,principal,form_url,space,name,backend_id,target_key,active_name,generation,
     observed_generation,phase,spec_json,observed_json,output_json,last_operation,busy_operation)
    VALUES (?,'alice',?,'default','version','fixture-worker-version',?,'version',1,0,
      'pending',?, '{}', '{}', ?, ?)`).run(
    VERSION_UID,
    WORKER_VERSION_FORM_URL,
    TARGET_KEY,
    spec,
    VERSION_OPERATION_ID,
    VERSION_OPERATION_ID,
  );
  db.prepare(`INSERT INTO tf_v2_operations
    (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,status,effect,
     created_at,updated_at,retain_until,backend_id,target_key,backend_key,accepted_spec_json)
    VALUES (?,?,'alice','replay-version','fp','create',1,'queued','none',
      '2026-10-07T00:00:00Z','2026-10-07T00:00:00Z','2026-10-08T00:00:00Z',
      'fixture-worker-version',?,'key-version',?)`).run(
    VERSION_OPERATION_ID,
    VERSION_UID,
    TARGET_KEY,
    spec,
  );
  db.prepare("INSERT INTO tf_v2_operation_reference_sets (operation_id,sealed) VALUES (?,0)").run(
    VERSION_OPERATION_ID,
  );
  const refs: readonly (readonly [string, string])[] = [
    [CALLER_UID, MODULE_WORKER_FORM_URL],
    [BUNDLE_UID, BUNDLE_FORM_URL],
    [TARGET_UID, MODULE_WORKER_FORM_URL],
  ];
  for (const [uid, formUrl] of refs) {
    db.prepare(`INSERT INTO tf_v2_operation_references
      (operation_id,target_uid,form_url,readiness) VALUES (?,?,?,'observed')`).run(
      VERSION_OPERATION_ID,
      uid,
      formUrl,
    );
  }
  db.prepare("UPDATE tf_v2_operation_reference_sets SET sealed = 1 WHERE operation_id = ?").run(
    VERSION_OPERATION_ID,
  );
  db.prepare("UPDATE tf_v2_operations SET status = 'running' WHERE id = ?").run(
    VERSION_OPERATION_ID,
  );
  db.prepare(`UPDATE tf_v2_operations SET status = 'reconciling', effect = 'unknown'
    WHERE id = ?`).run(VERSION_OPERATION_ID);
  db.prepare(`UPDATE tf_v2_operations SET status = 'succeeded', effect = 'complete',
    result_observed_json = '{"ready":true,"resolvedBindings":true,"bundleVerified":true}'
    WHERE id = ?`).run(VERSION_OPERATION_ID);
  db.prepare(`UPDATE tf_v2_resources SET phase = 'idle', observed_generation = 1,
    observed_json = '{"ready":true,"resolvedBindings":true,"bundleVerified":true}',
    busy_operation = NULL WHERE uid = ?`).run(VERSION_UID);
}
