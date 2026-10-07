import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2BackendResult, V2Form, V2ReferenceRequirement } from "../src/takoform-v2/types.ts";

const TARGET_FORM = "https://forms.example.test/unit/Target/1.0.0/";
const REFERRER_FORM = "https://forms.example.test/unit/Referrer/1.0.0/";
const OTHER_FORM = "https://forms.example.test/unit/Other/1.0.0/";

function fixture(options?: {
  path?: string;
  references?: (spec: JsonObject) => readonly V2ReferenceRequirement[];
  authorize?: (principal: string, space: string, access: "read" | "write") => boolean;
}) {
  const db = new Database(options?.path ?? ":memory:");
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'tf_v2_resources'").get()) {
    for (const name of [
      "0070_takoform_v2.sql",
      "0071_v2_sqlite_migration_set_custody.sql",
      "0073_v2_reference_acceptance.sql",
      "0081_v2_private_inputs.sql",
    ]) {
      db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
  }
  const sql = createSqliteSql(db);
  let referrerResult: V2BackendResult | null = null;
  const backend = {
    id: "fixture-reference-backend-v1",
    targetKey: "fixture-sqlite",
    async execute(input: { form: string; spec: { ready?: boolean } }) {
      if (input.form === REFERRER_FORM && referrerResult) return referrerResult;
      return {
        kind: "complete" as const,
        observed: { ready: input.spec.ready ?? true },
        output: {},
      };
    },
    async reconcile() {
      return { kind: "unknown" as const };
    },
  };
  const target: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    backend,
  };
  const referrer: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    references(spec) {
      return (
        options?.references?.(spec) ?? [
          { resourceUid: spec.targetUid as string, formUrl: TARGET_FORM, readiness: "ready" },
        ]
      );
    },
    backend,
  };
  const engine = () =>
    createTakoformV2Engine({
      sql,
      replayWindowSeconds: 3600,
      authorize: async (principal, space, access) =>
        options?.authorize?.(principal, space, access) ?? true,
      forms: { [TARGET_FORM]: target, [REFERRER_FORM]: referrer, [OTHER_FORM]: target },
    });
  return {
    db,
    engine,
    setReferrerResult(result: V2BackendResult | null) {
      referrerResult = result;
    },
  };
}

type Engine = ReturnType<ReturnType<typeof fixture>["engine"]>;

async function createTarget(
  engine: Engine,
  input: {
    principal?: string;
    space?: string;
    name?: string;
    form?: string;
    spec?: JsonObject;
    key?: string;
  } = {},
) {
  const admitted = await engine.acceptCreate({
    principal: input.principal ?? "alice",
    key: input.key ?? "target-create-key-0001",
    input: {
      form: input.form ?? TARGET_FORM,
      space: input.space ?? "default",
      name: input.name ?? "target",
      spec: input.spec ?? {},
    },
  });
  expect(await engine.runNext()).toMatchObject({ id: admitted.id, status: "succeeded" });
  return admitted;
}

function createReferrer(engine: Engine, targetUid: string, key = "referrer-create-key-0001") {
  return engine.acceptCreate({
    principal: "alice",
    key,
    input: {
      form: REFERRER_FORM,
      space: "default",
      name: "referrer",
      spec: { targetUid },
    },
  });
}

test("an accepted referrer protects its exact target before backend execution", async () => {
  const f = fixture();
  try {
    const engine = f.engine();
    const target = await createTarget(engine);
    const other = await createTarget(engine, {
      name: "other-target",
      key: "other-target-key-0001",
    });
    const referrer = await createReferrer(engine, target.resourceUid);
    expect(referrer.status).toBe("queued");
    expect(
      f.db
        .query("SELECT sealed FROM tf_v2_operation_reference_sets WHERE operation_id = ?")
        .get(referrer.id),
    ).toEqual({ sealed: 1 });
    expect(() =>
      f.db
        .query(
          `INSERT INTO tf_v2_operation_references
           (operation_id, target_uid, form_url, readiness)
         VALUES (?, ?, ?, 'ready')`,
        )
        .run(referrer.id, other.resourceUid, TARGET_FORM),
    ).toThrow();
    expect(
      f.db
        .query("SELECT 1 FROM tf_v2_resource_references WHERE target_uid = ?")
        .all(other.resourceUid),
    ).toHaveLength(0);
    await expect(
      engine.acceptDelete({
        principal: "alice",
        key: "target-delete-key-0001",
        uid: target.resourceUid,
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
  } finally {
    f.db.close();
  }
});

test("reference admission rejects another owner, Space, Form, or unready observation without an Operation", async () => {
  const cases = [
    { principal: "bob", space: "default", form: TARGET_FORM, spec: {} },
    { principal: "alice", space: "other", form: TARGET_FORM, spec: {} },
    { principal: "alice", space: "default", form: OTHER_FORM, spec: {} },
    { principal: "alice", space: "default", form: TARGET_FORM, spec: { ready: false } },
  ];
  for (const [index, candidate] of cases.entries()) {
    const f = fixture();
    try {
      const engine = f.engine();
      const target = await createTarget(engine, {
        ...candidate,
        key: `target-case-key-${index}-0001`,
      });
      const before = (
        f.db.query("SELECT count(*) AS n FROM tf_v2_operations").get() as { n: number }
      ).n;
      await expect(createReferrer(engine, target.resourceUid)).rejects.toMatchObject({
        code: "dependency_conflict",
        status: 409,
      });
      expect(
        (f.db.query("SELECT count(*) AS n FROM tf_v2_operations").get() as { n: number }).n,
      ).toBe(before);
      expect(f.db.query("SELECT 1 FROM tf_v2_resource_references").all()).toHaveLength(0);
    } finally {
      f.db.close();
    }
  }
});

test("reference admission requires a current read grant and exact target spec relation", async () => {
  const f = fixture({
    references: (spec) => [
      {
        resourceUid: spec.targetUid as string,
        formUrl: TARGET_FORM,
        readiness: "observed",
        targetSpecMatch: { path: ["worker", "resourceUid"], equals: "expected-worker" },
      },
    ],
    authorize: (_principal, _space, access) => access === "write",
  });
  try {
    const engine = f.engine();
    const target = await createTarget(engine, {
      spec: { worker: { resourceUid: "other-worker" } },
    });
    await expect(createReferrer(engine, target.resourceUid)).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
  } finally {
    f.db.close();
  }

  const mismatch = fixture({
    references: (spec) => [
      {
        resourceUid: spec.targetUid as string,
        formUrl: TARGET_FORM,
        readiness: "observed",
        targetSpecMatch: { path: ["worker", "resourceUid"], equals: "expected-worker" },
      },
    ],
  });
  try {
    const engine = mismatch.engine();
    const target = await createTarget(engine, {
      spec: { worker: { resourceUid: "other-worker" } },
    });
    await expect(createReferrer(engine, target.resourceUid)).rejects.toMatchObject({
      code: "dependency_conflict",
      status: 409,
    });
    const changed = await engine.acceptUpdate({
      principal: "alice",
      key: "target-worker-change-key-0001",
      uid: target.resourceUid,
      expectedGeneration: 1,
      spec: { worker: { resourceUid: "expected-worker" } },
    });
    expect(await engine.runNext()).toMatchObject({ id: changed.id, status: "succeeded" });
    expect(await createReferrer(engine, target.resourceUid)).toMatchObject({ status: "queued" });
  } finally {
    mismatch.db.close();
  }
});

test("update protects old and pending targets through failure, then replaces edges only on success", async () => {
  for (const result of [
    { kind: "partial" as const, code: "partial", message: "partial effect" },
    { kind: "no_effect" as const, code: "not_sent", message: "confirmed no effect" },
  ]) {
    const f = fixture();
    try {
      const engine = f.engine();
      const oldTarget = await createTarget(engine, {
        name: "old-target",
        key: "old-target-key-0001",
      });
      const newTarget = await createTarget(engine, {
        name: "new-target",
        key: "new-target-key-0001",
      });
      const referrer = await createReferrer(engine, oldTarget.resourceUid);
      expect(await engine.runNext()).toMatchObject({ id: referrer.id, status: "succeeded" });

      const update = await engine.acceptUpdate({
        principal: "alice",
        key: "referrer-update-key-0001",
        uid: referrer.resourceUid,
        expectedGeneration: 1,
        spec: { targetUid: newTarget.resourceUid },
      });
      expect(
        await engine.acceptUpdate({
          principal: "alice",
          key: "referrer-update-key-0001",
          uid: referrer.resourceUid,
          expectedGeneration: 1,
          spec: { targetUid: newTarget.resourceUid },
        }),
      ).toMatchObject({ id: update.id });
      const deletion = (uid: string, key: string) =>
        engine.acceptDelete({ principal: "alice", key, uid, expectedGeneration: 1 });
      await expect(deletion(oldTarget.resourceUid, "old-delete-key-0001")).rejects.toMatchObject({
        code: "dependency_conflict",
      });
      await expect(deletion(newTarget.resourceUid, "new-delete-key-0001")).rejects.toMatchObject({
        code: "dependency_conflict",
      });
      f.setReferrerResult(result);
      expect(await engine.runNext()).toMatchObject({
        id: update.id,
        status: "failed",
        effect: result.kind === "partial" ? "partial" : "none",
      });
      await expect(deletion(oldTarget.resourceUid, "old-delete-key-0001")).rejects.toMatchObject({
        code: "dependency_conflict",
      });
      await expect(deletion(newTarget.resourceUid, "new-delete-key-0001")).rejects.toMatchObject({
        code: "dependency_conflict",
      });

      f.setReferrerResult(null);
      const replacement = await engine.acceptUpdate({
        principal: "alice",
        key: "referrer-replace-key-0001",
        uid: referrer.resourceUid,
        expectedGeneration: 2,
        spec: { targetUid: newTarget.resourceUid },
      });
      expect(await engine.runNext()).toMatchObject({ id: replacement.id, status: "succeeded" });
      expect(await deletion(oldTarget.resourceUid, "old-delete-key-0001")).toMatchObject({
        status: "queued",
      });
      await expect(deletion(newTarget.resourceUid, "new-delete-key-0001")).rejects.toMatchObject({
        code: "dependency_conflict",
      });
      const referrerDelete = await engine.acceptDelete({
        principal: "alice",
        key: "referrer-delete-key-0001",
        uid: referrer.resourceUid,
        expectedGeneration: 3,
      });
      const settled = [await engine.runNext(), await engine.runNext()];
      expect(settled.every((operation) => operation?.status === "succeeded")).toBe(true);
      expect(settled.some((operation) => operation?.id === referrerDelete.id)).toBe(true);
      expect(await deletion(newTarget.resourceUid, "new-delete-key-0001")).toMatchObject({
        status: "queued",
      });
    } finally {
      f.db.close();
    }
  }
});

test("an unknown update keeps both reference claims through a fresh SQLite handle and replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-reference-reopen-"));
  const path = join(root, "control.sqlite");
  let first: ReturnType<typeof fixture> | undefined;
  let reopened: ReturnType<typeof fixture> | undefined;
  try {
    const initial = fixture({ path });
    first = initial;
    const engine = initial.engine();
    const oldTarget = await createTarget(engine, {
      name: "old-target",
      key: "old-target-key-0001",
    });
    const newTarget = await createTarget(engine, {
      name: "new-target",
      key: "new-target-key-0001",
    });
    const referrer = await createReferrer(engine, oldTarget.resourceUid);
    expect(await engine.runNext()).toMatchObject({ id: referrer.id, status: "succeeded" });
    const updateInput = {
      principal: "alice",
      key: "referrer-update-key-0001",
      uid: referrer.resourceUid,
      expectedGeneration: 1,
      spec: { targetUid: newTarget.resourceUid },
    };
    const update = await engine.acceptUpdate(updateInput);
    initial.setReferrerResult({ kind: "unknown" });
    expect(await engine.runNext()).toMatchObject({
      id: update.id,
      status: "reconciling",
      effect: "unknown",
    });
    initial.db.close();
    first = undefined;

    reopened = fixture({ path });
    const restarted = reopened.engine();
    expect(await restarted.acceptUpdate(updateInput)).toMatchObject({ id: update.id });
    for (const [uid, key] of [
      [oldTarget.resourceUid, "old-delete-key-0001"],
      [newTarget.resourceUid, "new-delete-key-0001"],
    ] as const) {
      await expect(
        restarted.acceptDelete({ principal: "alice", key, uid, expectedGeneration: 1 }),
      ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
    }
    expect(
      reopened.db
        .query("SELECT target_uid FROM tf_v2_resource_references WHERE referrer_uid = ?")
        .all(referrer.resourceUid),
    ).toHaveLength(2);
  } finally {
    first?.db.close();
    reopened?.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent independent SQLite handles cannot accept both a reference and target delete", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-reference-race-"));
  const path = join(root, "control.sqlite");
  const first = fixture({ path });
  const second = fixture({ path });
  try {
    const owner = first.engine();
    const contender = second.engine();
    const target = await createTarget(owner);
    const outcomes = await Promise.allSettled([
      createReferrer(owner, target.resourceUid),
      contender.acceptDelete({
        principal: "alice",
        key: "target-delete-key-0001",
        uid: target.resourceUid,
        expectedGeneration: 1,
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "dependency_conflict", status: 409 });
    const acceptedReferrer = outcomes[0]?.status === "fulfilled";
    const targetRow = first.db
      .query("SELECT busy_operation FROM tf_v2_resources WHERE uid = ?")
      .get(target.resourceUid) as { busy_operation: string | null };
    expect(
      acceptedReferrer ? targetRow.busy_operation === null : targetRow.busy_operation !== null,
    ).toBe(true);
  } finally {
    first.db.close();
    second.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate roles reserve one UID while contradictory Form declarations fail before acceptance", async () => {
  const duplicate = fixture({
    references: (spec) => [
      { resourceUid: spec.targetUid as string, formUrl: TARGET_FORM, readiness: "observed" },
      { resourceUid: spec.targetUid as string, formUrl: TARGET_FORM, readiness: "ready" },
    ],
  });
  try {
    const engine = duplicate.engine();
    const target = await createTarget(engine);
    const referrer = await createReferrer(engine, target.resourceUid);
    expect(referrer.status).toBe("queued");
    expect(
      duplicate.db
        .query("SELECT * FROM tf_v2_operation_references WHERE operation_id = ?")
        .all(referrer.id),
    ).toHaveLength(1);
  } finally {
    duplicate.db.close();
  }

  const contradictory = fixture({
    references: (spec) => [
      { resourceUid: spec.targetUid as string, formUrl: TARGET_FORM, readiness: "observed" },
      { resourceUid: spec.targetUid as string, formUrl: OTHER_FORM, readiness: "ready" },
    ],
  });
  try {
    const engine = contradictory.engine();
    const target = await createTarget(engine);
    await expect(createReferrer(engine, target.resourceUid)).rejects.toMatchObject({
      code: "invalid_spec",
      status: 422,
    });
    expect(
      (contradictory.db.query("SELECT count(*) AS n FROM tf_v2_operations").get() as { n: number })
        .n,
    ).toBe(1);
  } finally {
    contradictory.db.close();
  }

  const malformedUid = fixture({
    references: () => [{ resourceUid: "invalid:uid", formUrl: TARGET_FORM, readiness: "observed" }],
  });
  try {
    const engine = malformedUid.engine();
    const target = await createTarget(engine);
    await expect(createReferrer(engine, target.resourceUid)).rejects.toMatchObject({
      code: "invalid_spec",
      status: 422,
    });
    expect(
      (malformedUid.db.query("SELECT count(*) AS n FROM tf_v2_operations").get() as { n: number })
        .n,
    ).toBe(1);
  } finally {
    malformedUid.db.close();
  }
});
