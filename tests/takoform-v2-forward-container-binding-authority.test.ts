import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CONTAINER_CONTRACT as C } from "../src/container-contract.ts";
import type { JsonObject, Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  OBJECT_BUCKET_EOF_COUNTED_FORM_URL,
  OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL,
} from "../src/takoform-v2/forms/object-bucket-binding-profile.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import {
  fixedReferencesForForwardWorkerVersion,
  prepareForwardWorkerVersionReferences,
} from "../src/takoform-v2/forms/worker-references.ts";
import {
  FORWARD_WORKER_VERSION_FORM_URL,
  MODULE_WORKER_FORM_URL,
  parseForwardWorkerVersionSpec,
  validateForwardWorkerVersionUpdate,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createV2ForwardContainerBindingReader } from "../src/takoform-v2/index.ts";
import {
  V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME,
  V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_SQL,
} from "../src/takoform-v2/operation-generation-index.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
import { MAX_FAILED_TAIL } from "../src/takoform-v2/worker-publication-state.ts";

const PRINCIPAL = "alice";
const SPACE = "space";
const TARGET = "private-hosted-target";
const WORKER_BACKEND = "private-hosted-forward-version";
const CONTAINER_BACKEND = "private-hosted-container";
type UpdateOutcome = "complete" | "none" | "partial" | "unknown";

/** Core acceptance mechanics only: these backends are not native qualification. */
async function fixture(options: { installIndex?: boolean } = {}) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "0070_takoform_v2.sql",
    "0071_v2_sqlite_migration_set_custody.sql",
    "0073_v2_reference_acceptance.sql",
    "0081_v2_private_inputs.sql",
  ])
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  const sql = createSqliteSql(db);
  if (options.installIndex !== false)
    await sql.run(V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_SQL);
  let containerUpdateOutcome: UpdateOutcome = "complete";
  let versionUpdateOutcome: UpdateOutcome = "complete";
  const backend = (id: string, observed: JsonObject = {}) => ({
    id,
    targetKey: TARGET,
    execute: async (input: V2Execution) => {
      const outcome =
        input.action === "update"
          ? id === CONTAINER_BACKEND
            ? containerUpdateOutcome
            : id === WORKER_BACKEND
              ? versionUpdateOutcome
              : "complete"
          : "complete";
      if (outcome === "none")
        return { kind: "no_effect" as const, code: "fixture_no_effect", message: "fixture" };
      if (outcome === "unknown")
        return { kind: "unknown" as const, code: "fixture_unknown", message: "fixture" };
      if (outcome === "partial")
        return {
          kind: "partial" as const,
          code: "fixture_partial",
          message: "fixture",
          observed: id === CONTAINER_BACKEND ? { ready: true, servingGeneration: 1 } : observed,
        };
      return {
        kind: "complete" as const,
        observed:
          id === CONTAINER_BACKEND
            ? { ready: true, servingGeneration: input.generation }
            : observed,
        output: {},
      };
    },
    reconcile: async () => ({ kind: "unknown" as const }),
  });
  const metadata = (id: string, observed: JsonObject = {}) => ({
    validateCreate: () => undefined,
    validateUpdate: () => undefined,
    backend: backend(id, observed),
  });
  const engine = createTakoformV2Engine({
    sql,
    now: () => new Date("2026-10-22T00:00:00.000Z"),
    replayWindowSeconds: 3600,
    authorize: async () => true,
    forms: {
      [MODULE_WORKER_FORM_URL]: metadata("fixture-worker"),
      [WORKER_BUNDLE_FORM_URL]: metadata("fixture-bundle"),
      [C.formUrl]: metadata(CONTAINER_BACKEND),
      [OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL]: metadata("fixture-bucket-a", { ready: true }),
      [OBJECT_BUCKET_EOF_COUNTED_FORM_URL]: metadata("fixture-bucket-b", { ready: true }),
      [FORWARD_WORKER_VERSION_FORM_URL]: {
        validateCreate: parseForwardWorkerVersionSpec,
        validateUpdate: validateForwardWorkerVersionUpdate,
        references: (spec) =>
          fixedReferencesForForwardWorkerVersion(parseForwardWorkerVersionSpec(spec)),
        prepareAdmission: prepareForwardWorkerVersionReferences,
        backend: backend(WORKER_BACKEND, {
          ready: true,
          resolvedBindings: true,
          bundleVerified: true,
        }),
      },
    },
  });
  let serial = 0;
  const create = async (form: string, name: string, spec: JsonObject = {}) => {
    const op = await engine.acceptCreate({
      principal: PRINCIPAL,
      key: `forward-container-${++serial}-create-key`,
      input: { form, space: SPACE, name, spec },
    });
    expect((await engine.runNext())?.status).toBe("succeeded");
    return op;
  };
  const worker = await create(MODULE_WORKER_FORM_URL, "worker");
  const bundle = await create(WORKER_BUNDLE_FORM_URL, "bundle");
  const container = await create(C.formUrl, "container");
  const bucketA = await create(OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL, "bucket-a");
  const bucketB = await create(OBJECT_BUCKET_EOF_COUNTED_FORM_URL, "bucket-b");
  const extraBucket = await create(OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL, "extra-bucket");
  const spec = {
    worker: { resourceUid: worker.resourceUid },
    bundle: { resourceUid: bundle.resourceUid },
    handlers: ["fetch"],
    bucketBindings: [
      { name: "A", resource: { resourceUid: bucketA.resourceUid } },
      { name: "B", resource: { resourceUid: bucketB.resourceUid } },
    ],
    containerBindings: [{ name: "APP", resource: { resourceUid: container.resourceUid } }],
  };
  const version = await create(FORWARD_WORKER_VERSION_FORM_URL, "version", spec);
  const claim = {
    principal: PRINCIPAL,
    space: SPACE,
    workerVersionUid: version.resourceUid,
    workerVersionGeneration: 1,
    operationId: version.id,
    bindingName: "APP",
    targetUid: container.resourceUid,
  };
  let allowed = true;
  let graphLookups = 0;
  let indexedTailQueries = 0;
  const readerSql: Sql = {
    ...sql,
    async query(statement, params) {
      if (statement.includes("FROM tf_v2_resources")) graphLookups += 1;
      if (
        statement.includes("COUNT(DISTINCT generation)") &&
        statement.includes(`INDEXED BY ${V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME}`)
      )
        indexedTailQueries += 1;
      return sql.query(statement, params);
    },
  };
  const reader = createV2ForwardContainerBindingReader({
    sql: readerSql,
    targetKey: TARGET,
    workerBackendId: WORKER_BACKEND,
    containerBackendId: CONTAINER_BACKEND,
    authorize: async () => allowed,
  });
  return {
    db,
    sql,
    engine,
    reader,
    claim,
    spec,
    version,
    container,
    bucketA,
    extraBucket,
    create,
    setContainerUpdateOutcome(value: UpdateOutcome) {
      containerUpdateOutcome = value;
    },
    setVersionUpdateOutcome(value: UpdateOutcome) {
      versionUpdateOutcome = value;
    },
    setAllowed(value: boolean) {
      allowed = value;
    },
    graphLookups() {
      return graphLookups;
    },
    indexedTailQueries() {
      return indexedTailQueries;
    },
    close() {
      db.close();
    },
  };
}

test("accepted Forward version with mixed sealed references returns detached Container original", async () => {
  const f = await fixture();
  try {
    const refs = await f.sql.query(
      "SELECT form_url FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid",
      [f.version.id],
    );
    expect(refs).toHaveLength(5);
    expect(refs.map((row) => row.form_url)).toContain(OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL);
    expect(refs.map((row) => row.form_url)).toContain(OBJECT_BUCKET_EOF_COUNTED_FORM_URL);
    expect(await f.reader(f.claim)).toEqual({
      principal: PRINCIPAL,
      space: SPACE,
      targetKey: TARGET,
      workerVersionUid: f.version.resourceUid,
      workerVersionFormUrl: FORWARD_WORKER_VERSION_FORM_URL,
      workerVersionGeneration: 1,
      sourceOperationId: f.version.id,
      targetUid: f.container.resourceUid,
      targetFormUrl: C.formUrl,
      targetGeneration: 1,
      targetSourceOperationId: f.container.id,
    });
    f.setAllowed(false);
    expect(await f.reader(f.claim)).toBeNull();
  } finally {
    f.close();
  }
});

test("physical operation-generation index is required before graph lookup on every call", async () => {
  const absent = await fixture({ installIndex: false });
  try {
    expect(await absent.reader(absent.claim)).toBeNull();
    expect(absent.graphLookups()).toBe(0);
    absent.db.exec(
      `CREATE INDEX ${V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME} ON tf_v2_operations(generation,resource_uid)`,
    );
    expect(await absent.reader(absent.claim)).toBeNull();
    expect(absent.graphLookups()).toBe(0);
  } finally {
    absent.close();
  }
  const present = await fixture();
  try {
    expect(await present.reader(present.claim)).not.toBeNull();
    const before = present.graphLookups();
    present.db.exec(`DROP INDEX ${V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME}`);
    expect(await present.reader(present.claim)).toBeNull();
    expect(present.graphLookups()).toBe(before);
  } finally {
    present.close();
  }
});

test("tail query uses the physical resource and generation index range", async () => {
  const f = await fixture();
  try {
    f.setContainerUpdateOutcome("none");
    await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      uid: f.container.resourceUid,
      key: "forward-container-indexed-tail-key",
      expectedGeneration: 1,
      spec: { revision: "next" },
    });
    expect((await f.engine.runNext())?.status).toBe("failed");
    expect(await f.reader(f.claim)).not.toBeNull();
    expect(f.indexedTailQueries()).toBeGreaterThan(0);
    const plan = await f.sql.query(
      `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM tf_v2_operations
       INDEXED BY ${V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME}
       WHERE resource_uid = ? AND generation > ? AND generation <= ?`,
      [f.container.resourceUid, 1, 2],
    );
    const details = plan.map((row) => String(row.detail));
    expect(
      details.some((detail) =>
        detail.includes(V2_FORWARD_CONTAINER_OPERATION_GENERATION_INDEX_NAME),
      ),
    ).toBe(true);
    expect(details.some((detail) => detail.includes("resource_uid=?"))).toBe(true);
    expect(details.some((detail) => detail.includes("generation>?"))).toBe(true);
  } finally {
    f.close();
  }
});

test("failed-none history is bounded by the existing Core tail limit", async () => {
  const f = await fixture();
  try {
    f.setContainerUpdateOutcome("none");
    for (let generation = 2; generation <= MAX_FAILED_TAIL + 1; generation += 1) {
      await f.engine.acceptUpdate({
        principal: PRINCIPAL,
        uid: f.container.resourceUid,
        key: `forward-container-indexed-tail-${generation}-key`,
        expectedGeneration: generation - 1,
        spec: { revision: `r${generation}` },
      });
      expect((await f.engine.runNext())?.status).toBe("failed");
    }
    expect((await f.reader(f.claim))?.targetGeneration).toBe(1);
    await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      uid: f.container.resourceUid,
      key: "forward-container-indexed-tail-pending-key",
      expectedGeneration: MAX_FAILED_TAIL + 1,
      spec: { revision: "pending" },
    });
    expect((await f.reader(f.claim))?.targetGeneration).toBe(1);
    expect((await f.engine.runNext())?.status).toBe("failed");
    expect(await f.reader(f.claim)).toBeNull();
  } finally {
    f.close();
  }
});

test("claim and constructor values require exact owner, target, backend, operation, generation and binding", async () => {
  const f = await fixture();
  try {
    for (const change of [
      { principal: "bob" },
      { space: "other" },
      { targetUid: "other" },
      { workerVersionUid: "other" },
      { operationId: "other" },
      { workerVersionGeneration: 2 },
      { workerVersionGeneration: 1.5 },
      { bindingName: "OTHER" },
    ])
      expect(await f.reader({ ...f.claim, ...change })).toBeNull();
    for (const change of [
      { targetKey: "other" },
      { workerBackendId: "other" },
      { containerBackendId: "other" },
    ]) {
      const reader = createV2ForwardContainerBindingReader({
        sql: f.sql,
        targetKey: TARGET,
        workerBackendId: WORKER_BACKEND,
        containerBackendId: CONTAINER_BACKEND,
        authorize: async () => true,
        ...change,
      });
      expect(await reader(f.claim)).toBeNull();
    }
  } finally {
    f.close();
  }
});

test("post-acceptance reader refuses incomplete, unready, deleted and altered graphs on every call", async () => {
  const mutations: readonly {
    name: string;
    change: (db: Database, claim: Awaited<ReturnType<typeof fixture>>["claim"]) => void;
  }[] = [
    {
      name: "version readiness",
      change: (db, claim) =>
        db
          .query("UPDATE tf_v2_resources SET observed_json = '{}' WHERE uid = ?")
          .run(claim.workerVersionUid),
    },
    {
      name: "container readiness",
      change: (db, claim) =>
        db
          .query("UPDATE tf_v2_resources SET observed_json = '{}' WHERE uid = ?")
          .run(claim.targetUid),
    },
    {
      name: "container deleting",
      change: (db, claim) =>
        db
          .query("UPDATE tf_v2_resources SET phase = 'deleting' WHERE uid = ?")
          .run(claim.targetUid),
    },
    {
      name: "missing active edge",
      change: (db, claim) =>
        db
          .query("DELETE FROM tf_v2_resource_references WHERE referrer_uid = ? AND target_uid = ?")
          .run(claim.workerVersionUid, claim.targetUid),
    },
  ];
  for (const mutation of mutations) {
    const f = await fixture();
    try {
      expect(await f.reader(f.claim)).not.toBeNull();
      mutation.change(f.db, f.claim);
      expect(await f.reader(f.claim)).toBeNull();
    } finally {
      f.close();
    }
  }
});

test("target returns its committed source during pending replacement and failed no-effect tail", async () => {
  for (const fail of [false, true]) {
    const f = await fixture();
    try {
      const original = await f.reader(f.claim);
      expect(original?.targetSourceOperationId).toBe(f.container.id);
      f.setContainerUpdateOutcome(fail ? "none" : "complete");
      const tail = await f.engine.acceptUpdate({
        principal: PRINCIPAL,
        uid: f.container.resourceUid,
        key: "forward-container-replacement-key",
        expectedGeneration: 1,
        spec: { revision: "next" },
      });
      expect((await f.reader(f.claim))?.targetSourceOperationId).toBe(f.container.id);
      expect((await f.reader(f.claim))?.targetGeneration).toBe(1);
      if (fail) {
        expect((await f.engine.runNext())?.status).toBe("failed");
        const after = await f.reader(f.claim);
        expect(after?.targetGeneration).toBe(1);
        expect(after?.targetSourceOperationId).toBe(f.container.id);
        expect(after?.targetSourceOperationId).not.toBe(tail.id);
      }
    } finally {
      f.close();
    }
  }
});

test("settled Container update changes only the committed target source", async () => {
  const f = await fixture();
  try {
    const replacement = await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      uid: f.container.resourceUid,
      key: "forward-container-settled-replacement-key",
      expectedGeneration: 1,
      spec: { revision: "next" },
    });
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    const current = await f.reader(f.claim);
    expect(current?.sourceOperationId).toBe(f.version.id);
    expect(current?.targetGeneration).toBe(2);
    expect(current?.targetSourceOperationId).toBe(replacement.id);
  } finally {
    f.close();
  }
});

test("partial and unknown current Operations never inherit an older ready observation", async () => {
  for (const owner of ["container", "version"] as const) {
    for (const outcome of ["partial", "unknown"] as const) {
      const f = await fixture();
      try {
        const uid = owner === "container" ? f.container.resourceUid : f.version.resourceUid;
        if (owner === "container") f.setContainerUpdateOutcome(outcome);
        else f.setVersionUpdateOutcome(outcome);
        await f.engine.acceptUpdate({
          principal: PRINCIPAL,
          uid,
          key: `forward-container-${owner}-${outcome}-key`,
          expectedGeneration: 1,
          spec: owner === "container" ? { revision: "next" } : f.spec,
        });
        expect((await f.engine.runNext())?.status).toBe(
          outcome === "partial" ? "failed" : "reconciling",
        );
        // The partial fixture preserves ready fields deliberately; tail state,
        // rather than a superficial ready flag, must make the reader refuse.
        expect(await f.reader(f.claim)).toBeNull();
      } finally {
        f.close();
      }
    }
  }
});

test("an earlier partial effect cannot be hidden by a later failed no-effect update", async () => {
  for (const owner of ["container", "version"] as const) {
    const f = await fixture();
    try {
      const uid = owner === "container" ? f.container.resourceUid : f.version.resourceUid;
      if (owner === "container") f.setContainerUpdateOutcome("partial");
      else f.setVersionUpdateOutcome("partial");
      await f.engine.acceptUpdate({
        principal: PRINCIPAL,
        uid,
        key: `forward-container-${owner}-partial-first-key`,
        expectedGeneration: 1,
        spec: owner === "container" ? { revision: "two" } : f.spec,
      });
      expect((await f.engine.runNext())?.status).toBe("failed");
      if (owner === "container") f.setContainerUpdateOutcome("none");
      else f.setVersionUpdateOutcome("none");
      await f.engine.acceptUpdate({
        principal: PRINCIPAL,
        uid,
        key: `forward-container-${owner}-none-last-key`,
        expectedGeneration: 2,
        spec: owner === "container" ? { revision: "three" } : f.spec,
      });
      expect((await f.engine.runNext())?.status).toBe("failed");
      expect(await f.reader(f.claim)).toBeNull();
    } finally {
      f.close();
    }
  }
});

test("a superficially ready observation differing from the successful source is refused", async () => {
  for (const owner of ["container", "version"] as const) {
    const f = await fixture();
    try {
      const uid = owner === "container" ? f.container.resourceUid : f.version.resourceUid;
      const ready =
        owner === "container"
          ? { ready: true, servingGeneration: 1, extra: true }
          : { ready: true, resolvedBindings: true, bundleVerified: true, extra: true };
      f.db
        .query("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?")
        .run(JSON.stringify(ready), uid);
      expect(await f.reader(f.claim)).toBeNull();
    } finally {
      f.close();
    }
  }
});

test("constructor and caller values are snapped before authorization awaits", async () => {
  const f = await fixture();
  try {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const options = {
      sql: f.sql,
      targetKey: TARGET,
      workerBackendId: WORKER_BACKEND,
      containerBackendId: CONTAINER_BACKEND,
      authorize: async () => {
        entered();
        await blocked;
        return true;
      },
    };
    const reader = createV2ForwardContainerBindingReader(options);
    const claim = { ...f.claim };
    const pending = reader(claim);
    await started;
    claim.targetUid = "other";
    options.targetKey = "other";
    options.workerBackendId = "other";
    options.containerBackendId = "other";
    release();
    expect((await pending)?.targetUid).toBe(f.container.resourceUid);
    expect((await reader(f.claim))?.targetUid).toBe(f.container.resourceUid);
  } finally {
    f.close();
  }
});

test("a successful later Version generation revokes the old accepted source", async () => {
  const f = await fixture();
  try {
    const replacement = await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      uid: f.version.resourceUid,
      key: "forward-container-version-replacement-key",
      expectedGeneration: 1,
      spec: f.spec,
    });
    expect((await f.reader(f.claim))?.sourceOperationId).toBe(f.version.id);
    expect(
      await f.reader({ ...f.claim, operationId: replacement.id, workerVersionGeneration: 2 }),
    ).toBeNull();
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    expect(await f.reader(f.claim)).toBeNull();
    expect(
      (await f.reader({ ...f.claim, operationId: replacement.id, workerVersionGeneration: 2 }))
        ?.sourceOperationId,
    ).toBe(replacement.id);
  } finally {
    f.close();
  }
});

test("a same-spec Version update that fails with no effect retains the observed source", async () => {
  const f = await fixture();
  try {
    f.setVersionUpdateOutcome("none");
    await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      uid: f.version.resourceUid,
      key: "forward-container-version-none-key",
      expectedGeneration: 1,
      spec: f.spec,
    });
    expect((await f.reader(f.claim))?.sourceOperationId).toBe(f.version.id);
    expect((await f.engine.runNext())?.status).toBe("failed");
    expect((await f.reader(f.claim))?.sourceOperationId).toBe(f.version.id);
  } finally {
    f.close();
  }
});

test("sealed rows and live edges must match the entire accepted Forward reference set", async () => {
  const corruptions = [
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.db.exec("DROP TRIGGER tf_v2_operation_reference_set_immutable");
      f.db
        .query("UPDATE tf_v2_operation_reference_sets SET sealed = 0 WHERE operation_id = ?")
        .run(f.version.id);
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.db.exec("DROP TRIGGER tf_v2_operation_reference_no_delete");
      f.db
        .query("DELETE FROM tf_v2_operation_references WHERE operation_id = ? AND target_uid = ?")
        .run(f.version.id, f.container.resourceUid);
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.db.exec("DROP TRIGGER tf_v2_operation_reference_guard");
      f.db
        .query(
          "INSERT INTO tf_v2_operation_references (operation_id,target_uid,form_url,readiness) VALUES (?,?,?,'observed')",
        )
        .run(f.version.id, f.extraBucket.resourceUid, OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL);
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.db.exec("DROP TRIGGER tf_v2_operation_reference_immutable");
      f.db
        .query(
          "UPDATE tf_v2_operation_references SET form_url = ? WHERE operation_id = ? AND target_uid = ?",
        )
        .run(
          "https://forms.example.test/UnknownBucket/1.0.0/",
          f.version.id,
          f.bucketA.resourceUid,
        );
    },
  ];
  for (const corrupt of corruptions) {
    const f = await fixture();
    try {
      expect(await f.reader(f.claim)).not.toBeNull();
      corrupt(f);
      expect(await f.reader(f.claim)).toBeNull();
    } finally {
      f.close();
    }
  }
});

test("the Core schema rejects a duplicate accepted reference UID", async () => {
  const f = await fixture();
  try {
    expect(() =>
      f.db
        .query(
          "INSERT INTO tf_v2_operation_references (operation_id,target_uid,form_url,readiness) VALUES (?,?,?,'observed')",
        )
        .run(f.version.id, f.container.resourceUid, C.formUrl),
    ).toThrow();
    expect(await f.reader(f.claim)).not.toBeNull();
  } finally {
    f.close();
  }
});

test("live Form, deletion, observed source and accepted spec must remain exact", async () => {
  const corruptions = [
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.db.exec("DROP TRIGGER tf_v2_resource_identity_immutable");
      f.db
        .query("UPDATE tf_v2_resources SET form_url = ? WHERE uid = ?")
        .run("https://forms.example.test/Other/1.0.0/", f.container.resourceUid);
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.db.exec("DROP TRIGGER tf_v2_resource_identity_immutable");
      f.db
        .query("UPDATE tf_v2_resources SET form_url = ? WHERE uid = ?")
        .run(C.workerVersionUrl, f.version.resourceUid);
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.db
        .query("UPDATE tf_v2_resources SET deleted_at = ?, active_name = NULL WHERE uid = ?")
        .run("2026-10-22T00:00:00.000Z", f.container.resourceUid);
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.db
        .query("UPDATE tf_v2_resources SET observed_generation = 0 WHERE uid = ?")
        .run(f.container.resourceUid);
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.db
        .query("UPDATE tf_v2_resources SET spec_json = '{}' WHERE uid = ?")
        .run(f.version.resourceUid);
    },
  ];
  for (const corrupt of corruptions) {
    const f = await fixture();
    try {
      expect(await f.reader(f.claim)).not.toBeNull();
      corrupt(f);
      expect(await f.reader(f.claim)).toBeNull();
    } finally {
      f.close();
    }
  }
});
