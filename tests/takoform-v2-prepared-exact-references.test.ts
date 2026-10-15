import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { JsonObject, Sql, SqlStatement } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type {
  V2AdmissionPredicate,
  V2ExactReferenceTarget,
  V2Form,
  V2PrepareExactReferences,
  V2ReferenceRequirement,
} from "../src/takoform-v2/types.ts";

const TARGET_A = "https://forms.example.test/ExactTarget/1.0.0/";
const TARGET_B = "https://forms.example.test/ExactTarget/2.0.0/";
const CONSUMER = "https://forms.example.test/ExactConsumer/1.0.0/";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function accepting(statements: readonly SqlStatement[]) {
  return statements.some((statement) => /INSERT INTO tf_v2_operations\b/u.test(statement.sql));
}

function fixture(
  options: {
    prepare?: NonNullable<V2Form["prepareAdmission"]>;
    references?: V2Form["references"];
  } = {},
) {
  const db = new Database(":memory:");
  for (const name of [
    "0070_takoform_v2.sql",
    "0071_v2_sqlite_migration_set_custody.sql",
    "0073_v2_reference_acceptance.sql",
    "0081_v2_private_inputs.sql",
  ])
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  const raw = createSqliteSql(db);
  let batchGate:
    | { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
    | undefined;
  let readAllowed = true;
  let writeAllowed = true;
  let hooks = 0;
  let choosers = 0;
  let lookups = 0;
  const sql: Sql = {
    async query(query, params) {
      if (query.includes("WHERE uid = ? AND principal = ? AND space = ?")) lookups++;
      return raw.query(query, params);
    },
    run: raw.run,
    async batch(statements) {
      if (batchGate && accepting(statements)) {
        const gate = batchGate;
        batchGate = undefined;
        gate.entered.resolve();
        await gate.release.promise;
      }
      return raw.batch(statements);
    },
  };
  const backend = {
    id: "exact-reference-consumer-v1",
    targetKey: "consumer-target",
    async execute(input: { spec: JsonObject }) {
      return {
        kind: "complete" as const,
        observed: { ready: input.spec.ready !== false },
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
    backend: { ...backend, id: "different-target-backend", targetKey: "different-host-supply" },
  };
  const consumer: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    ...(options.references ? { references: options.references } : {}),
    async prepareAdmission(input) {
      hooks++;
      if (options.prepare) return options.prepare(input);
      if (!input.prepareExactReferences) throw new Error("missing Core preparation");
      return input.prepareExactReferences(async (lookup) => {
        choosers++;
        const requirements: V2ReferenceRequirement[] = [];
        for (const uid of input.spec.targets as readonly string[]) {
          const selected = await lookup(uid);
          if (!selected) return null;
          expect(Object.isFrozen(selected)).toBe(true);
          expect(Object.keys(selected).sort()).toEqual(["formUrl", "resourceUid"]);
          requirements.push({ ...selected, readiness: "ready" });
        }
        return requirements;
      });
    },
    backend,
  };
  const engine = createTakoformV2Engine({
    sql,
    replayWindowSeconds: 3600,
    authorize: async (_principal, _space, access) =>
      access === "read" ? readAllowed : writeAllowed,
    forms: { [TARGET_A]: target, [TARGET_B]: target, [CONSUMER]: consumer },
  });
  let serial = 0;
  return {
    db,
    engine,
    consumer,
    counts: () => ({ hooks, choosers, lookups }),
    allow(read: boolean, write = true) {
      readAllowed = read;
      writeAllowed = write;
    },
    pause() {
      const gate = { entered: deferred(), release: deferred() };
      batchGate = gate;
      return gate;
    },
    async target(
      input: { principal?: string; space?: string; form?: string; spec?: JsonObject } = {},
    ) {
      serial++;
      const op = await engine.acceptCreate({
        principal: input.principal ?? "alice",
        key: `exact-target-create-${serial}-0001`,
        input: {
          form: input.form ?? TARGET_A,
          space: input.space ?? "space",
          name: `target-${serial}`,
          spec: input.spec ?? {},
        },
      });
      expect(await engine.runNext()).toMatchObject({ id: op.id, status: "succeeded" });
      return op.resourceUid;
    },
    create(targets: readonly string[], key = "exact-consumer-create-0001", name = "consumer") {
      return engine.acceptCreate({
        principal: "alice",
        key,
        input: { form: CONSUMER, space: "space", name, spec: { targets } },
      });
    },
  };
}

async function refusal(promise: Promise<unknown>, code = "dependency_conflict") {
  try {
    await promise;
    throw new Error("expected refusal");
  } catch (error) {
    expect(error).toMatchObject({ code, status: code === "forbidden" ? 403 : 409 });
    return error;
  }
}

test("prepared mixed exact Forms add to pure references and seal only the chosen rows", async () => {
  let pureTarget = "";
  const f = fixture({
    references: () => [{ resourceUid: pureTarget, formUrl: TARGET_A, readiness: "observed" }],
  });
  try {
    pureTarget = await f.target();
    const other = await f.target({ form: TARGET_B });
    const unused = await f.target();
    const op = await f.create([other, pureTarget, pureTarget]);
    expect(f.counts().lookups).toBe(2);
    expect(
      f.db
        .query("SELECT sealed FROM tf_v2_operation_reference_sets WHERE operation_id = ?")
        .get(op.id),
    ).toEqual({ sealed: 1 });
    expect(
      f.db
        .query(
          "SELECT target_uid,form_url,readiness FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid",
        )
        .all(op.id),
    ).toEqual(
      [
        { target_uid: pureTarget, form_url: TARGET_A, readiness: "ready" },
        { target_uid: other, form_url: TARGET_B, readiness: "ready" },
      ].sort((a, b) => a.target_uid.localeCompare(b.target_uid)),
    );
    expect(
      f.db.query("SELECT 1 FROM tf_v2_operation_references WHERE target_uid = ?").all(unused),
    ).toEqual([]);
    expect(await f.engine.runNext()).toMatchObject({ id: op.id, status: "succeeded" });
    expect(
      f.db
        .query(
          "SELECT target_uid FROM tf_v2_resource_references WHERE referrer_uid = ? ORDER BY target_uid",
        )
        .all(op.resourceUid),
    ).toEqual([pureTarget, other].sort().map((target_uid) => ({ target_uid })));
  } finally {
    f.db.close();
  }
});

test("write authorization precedes the hook and read authorization precedes chooser/lookup", async () => {
  const f = fixture();
  try {
    const target = await f.target();
    f.allow(false, false);
    await refusal(f.create([target]), "forbidden");
    expect(f.counts()).toEqual({ hooks: 0, choosers: 0, lookups: 0 });
    f.allow(false);
    await refusal(f.create([target]), "forbidden");
    expect(f.counts()).toEqual({ hooks: 1, choosers: 0, lookups: 0 });
    expect(
      f.db
        .query("SELECT 1 FROM tf_v2_operations WHERE replay_key = ?")
        .all("exact-consumer-create-0001"),
    ).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("lookup never exposes a target from another principal or Space", async () => {
  const f = fixture();
  try {
    const foreign = await f.target({ principal: "bob" });
    const elsewhere = await f.target({ space: "elsewhere" });
    await refusal(f.create([foreign]));
    await refusal(f.create([elsewhere]));
    expect(f.db.query("SELECT 1 FROM tf_v2_resources WHERE form_url = ?").all(CONSUMER)).toEqual(
      [],
    );
  } finally {
    f.db.close();
  }
});

test("original CREATE and UPDATE replay skips chooser/lookup after target changes and read revocation", async () => {
  const f = fixture();
  try {
    const target = await f.target();
    const created = await f.create([target]);
    expect(await f.engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
    const update = {
      principal: "alice",
      key: "exact-consumer-update-0001",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: { targets: [target] },
    };
    const changed = await f.engine.acceptUpdate(update);
    expect(await f.engine.runNext()).toMatchObject({ id: changed.id, status: "succeeded" });
    const moved = await f.engine.acceptUpdate({
      principal: "alice",
      key: "exact-target-update-0001",
      uid: target,
      expectedGeneration: 1,
      spec: { ready: false },
    });
    expect(await f.engine.runNext()).toMatchObject({ id: moved.id, status: "succeeded" });
    const before = f.counts();
    f.allow(false);
    expect((await f.create([target])).id).toBe(created.id);
    expect((await f.engine.acceptUpdate(update)).id).toBe(changed.id);
    expect(f.counts()).toEqual(before);
  } finally {
    f.db.close();
  }
});

test("a target changed and settled ready again between lookup and batch refuses with no consumed key", async () => {
  const f = fixture();
  try {
    const target = await f.target();
    const gate = f.pause();
    const pending = f.create([target]);
    await gate.entered.promise;
    const moved = await f.engine.acceptUpdate({
      principal: "alice",
      key: "exact-target-race-0001",
      uid: target,
      expectedGeneration: 1,
      spec: { revision: 2 },
    });
    expect(await f.engine.runNext()).toMatchObject({ id: moved.id, status: "succeeded" });
    gate.release.resolve();
    await refusal(pending);
    expect(
      f.db
        .query(
          "SELECT generation,observed_generation,phase,busy_operation FROM tf_v2_resources WHERE uid = ?",
        )
        .get(target),
    ).toEqual({ generation: 2, observed_generation: 2, phase: "idle", busy_operation: null });
    expect(f.db.query("SELECT 1 FROM tf_v2_resources WHERE form_url = ?").all(CONSUMER)).toEqual(
      [],
    );
    expect(
      f.db
        .query("SELECT 1 FROM tf_v2_operations WHERE replay_key = ?")
        .all("exact-consumer-create-0001"),
    ).toEqual([]);
    // The same key is still fresh; a new capture can accept the new exact preimage.
    expect((await f.create([target])).status).toBe("queued");
  } finally {
    f.db.close();
  }
});

test("failed prepared UPDATE preserves the old spec, generation and active edges", async () => {
  const f = fixture();
  try {
    const old = await f.target();
    const next = await f.target({ form: TARGET_B });
    const created = await f.create([old]);
    await f.engine.runNext();
    const before = f.db
      .query("SELECT generation,spec_json,last_operation FROM tf_v2_resources WHERE uid = ?")
      .get(created.resourceUid);
    const gate = f.pause();
    const pending = f.engine.acceptUpdate({
      principal: "alice",
      key: "exact-consumer-race-0001",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: { targets: [next] },
    });
    await gate.entered.promise;
    const moved = await f.engine.acceptUpdate({
      principal: "alice",
      key: "exact-next-target-race-0001",
      uid: next,
      expectedGeneration: 1,
      spec: { revision: 2 },
    });
    expect(await f.engine.runNext()).toMatchObject({ id: moved.id, status: "succeeded" });
    gate.release.resolve();
    await refusal(pending);
    expect(
      f.db
        .query("SELECT generation,spec_json,last_operation FROM tf_v2_resources WHERE uid = ?")
        .get(created.resourceUid),
    ).toEqual(before);
    expect(
      f.db
        .query("SELECT target_uid FROM tf_v2_resource_references WHERE referrer_uid = ?")
        .all(created.resourceUid),
    ).toEqual([{ target_uid: old }]);
    expect(
      f.db
        .query(
          "SELECT 1 FROM tf_v2_operation_reference_sets WHERE operation_id IN (SELECT id FROM tf_v2_operations WHERE replay_key = ?)",
        )
        .all("exact-consumer-race-0001"),
    ).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("0073 still refuses busy, unready, deleted and mismatched-spec targets", async () => {
  for (const state of ["busy", "unready", "deleted", "spec"] as const) {
    const f = fixture({
      prepare: async (input) => {
        if (!input.prepareExactReferences) throw new Error("missing preparation");
        return input.prepareExactReferences(async (lookup) => {
          const selected = await lookup((input.spec.targets as readonly string[])[0] ?? "");
          if (!selected) return null;
          return [
            {
              ...selected,
              readiness: "ready",
              ...(state === "spec"
                ? {
                    targetSpecMatch: { path: ["worker", "resourceUid"], equals: "expected-worker" },
                  }
                : {}),
            },
          ];
        });
      },
    });
    try {
      const target = await f.target({ spec: state === "unready" ? { ready: false } : {} });
      if (state === "busy")
        await f.engine.acceptUpdate({
          principal: "alice",
          key: "exact-busy-target-0001",
          uid: target,
          expectedGeneration: 1,
          spec: {},
        });
      if (state === "deleted") {
        await f.engine.acceptDelete({
          principal: "alice",
          key: "exact-deleted-target-0001",
          uid: target,
          expectedGeneration: 1,
        });
        await f.engine.runNext();
      }
      await refusal(f.create([target]));
      expect(f.db.query("SELECT 1 FROM tf_v2_resources WHERE form_url = ?").all(CONSUMER)).toEqual(
        [],
      );
      expect(f.db.query("SELECT 1 FROM tf_v2_operation_references").all()).toEqual([]);
    } finally {
      f.db.close();
    }
  }
});

test("reference refusal is independent of domain resource_busy and dependency detail", async () => {
  for (const mode of ["busy", "detail", "both"] as const) {
    const f = fixture({
      prepare: async (input) => {
        if (!input.prepareExactReferences) throw new Error("missing preparation");
        return input.prepareExactReferences(
          async (lookup) => {
            const selected = await lookup((input.spec.targets as readonly string[])[0] ?? "");
            return selected ? [{ ...selected, readiness: "ready" }] : null;
          },
          {
            sql: "0",
            params: [],
            ...(mode === "detail"
              ? { detail: "Exact fixture domain requirement" }
              : { conflictCode: "resource_busy" }),
          },
        );
      },
    });
    try {
      const target = await f.target();
      let pending: ReturnType<typeof f.create>;
      if (mode === "both") {
        const gate = f.pause();
        pending = f.create([target]);
        await gate.entered.promise;
        const moved = await f.engine.acceptUpdate({
          principal: "alice",
          key: "exact-domain-race-0001",
          uid: target,
          expectedGeneration: 1,
          spec: {},
        });
        expect(await f.engine.runNext()).toMatchObject({ id: moved.id, status: "succeeded" });
        gate.release.resolve();
      } else pending = f.create([target]);
      const error = await refusal(
        pending,
        mode === "busy" ? "resource_busy" : "dependency_conflict",
      );
      expect(error).toHaveProperty(
        "detail",
        mode === "detail" ? "Exact fixture domain requirement" : undefined,
      );
    } finally {
      f.db.close();
    }
  }
});

test("domain binary parameters are captured before the chooser awaits", async () => {
  const entered = deferred();
  const release = deferred();
  const bytes = new Uint8Array([1, 2, 3]);
  const params = [bytes.buffer, new Uint8Array([1, 2, 3]).buffer];
  const f = fixture({
    prepare: async (input) => {
      if (!input.prepareExactReferences) throw new Error("missing preparation");
      return input.prepareExactReferences(
        async (lookup) => {
          entered.resolve();
          await release.promise;
          const selected = await lookup((input.spec.targets as readonly string[])[0] ?? "");
          return selected ? [{ ...selected, readiness: "ready" }] : null;
        },
        { sql: "? = ?", params },
      );
    },
  });
  try {
    const target = await f.target();
    const pending = f.create([target]);
    await entered.promise;
    bytes.fill(9);
    params.reverse();
    release.resolve();
    expect((await pending).status).toBe("queued");
  } finally {
    f.db.close();
  }
});

test("prepared results cannot be forged, copied or reused by a later request", async () => {
  let issued: V2AdmissionPredicate | null = null;
  let invocation = 0;
  const f = fixture({
    prepare: async (input) => {
      invocation++;
      if (!input.prepareExactReferences) throw new Error("missing preparation");
      if (invocation === 2) return issued;
      if (invocation === 3) return { sql: "1", params: [], preparedExactReferences: [] };
      issued = await input.prepareExactReferences(async (lookup) => {
        const selected = await lookup((input.spec.targets as readonly string[])[0] ?? "");
        return selected ? [{ ...selected, readiness: "ready" }] : null;
      });
      return invocation === 4 && issued ? { ...issued } : issued;
    },
  });
  try {
    const target = await f.target();
    expect((await f.create([target])).status).toBe("queued");
    for (let index = 2; index <= 4; index++) {
      await expect(
        f.create([target], `exact-forgery-key-${index}-0001`, `consumer-${index}`),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(
      f.db.query("SELECT uid FROM tf_v2_resources WHERE form_url = ?").all(CONSUMER),
    ).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("retained helper and lookup close after admission without additional reads", async () => {
  let retainedPrepare: V2PrepareExactReferences | undefined;
  let retainedLookup: ((uid: string) => Promise<V2ExactReferenceTarget | null>) | undefined;
  const f = fixture({
    prepare: async (input) => {
      retainedPrepare = input.prepareExactReferences;
      if (!retainedPrepare) throw new Error("missing preparation");
      return retainedPrepare(async (lookup) => {
        retainedLookup = lookup;
        const selected = await lookup((input.spec.targets as readonly string[])[0] ?? "");
        return selected ? [{ ...selected, readiness: "ready" }] : null;
      });
    },
  });
  try {
    const target = await f.target();
    await f.create([target]);
    const before = f.counts();
    if (!retainedPrepare || !retainedLookup) throw new Error("helper not captured");
    await expect(retainedPrepare(async () => [])).rejects.toBeInstanceOf(TypeError);
    await expect(retainedLookup(target)).rejects.toBeInstanceOf(TypeError);
    expect(f.counts()).toEqual(before);
  } finally {
    f.db.close();
  }
});

test("new declarations reject sparse, accessor and inherited data without executing getters", async () => {
  for (const shape of ["sparse", "accessor", "inherited", "unlooked"] as const) {
    let getters = 0;
    const f = fixture({
      prepare: async (input) => {
        if (!input.prepareExactReferences) throw new Error("missing preparation");
        return input.prepareExactReferences(async (lookup) => {
          const uid = (input.spec.targets as readonly string[])[0] ?? "";
          const selected = await lookup(uid);
          if (!selected) return null;
          const entry: V2ReferenceRequirement = { ...selected, readiness: "ready" };
          const entries: V2ReferenceRequirement[] = [entry];
          if (shape === "sparse") delete entries[0];
          if (shape === "accessor")
            Object.defineProperty(entry, "formUrl", {
              get() {
                getters++;
                return TARGET_A;
              },
            });
          if (shape === "inherited") {
            Object.setPrototypeOf(entry, {
              targetSpecMatch: { path: ["worker"], equals: "expected" },
            });
          }
          if (shape === "unlooked")
            return [{ resourceUid: "another-target", formUrl: TARGET_A, readiness: "ready" }];
          return entries;
        });
      },
    });
    try {
      const target = await f.target();
      if (shape === "unlooked") await expect(f.create([target])).rejects.toBeInstanceOf(TypeError);
      else
        await expect(f.create([target])).rejects.toMatchObject({
          code: "invalid_spec",
          status: 422,
        });
      expect(getters).toBe(0);
      expect(f.db.query("SELECT 1 FROM tf_v2_resources WHERE form_url = ?").all(CONSUMER)).toEqual(
        [],
      );
    } finally {
      f.db.close();
    }
  }
});

test("prepared requirements cannot replace pure requirements or exceed their combined bound", async () => {
  for (const mode of ["wrong-form", "wrong-spec", "limit"] as const) {
    let uid = "";
    const f = fixture({
      references: () =>
        mode === "limit"
          ? Array.from({ length: 512 }, (_, index) => ({
              resourceUid: `pure-${index}`,
              formUrl: TARGET_A,
              readiness: "ready" as const,
            }))
          : [
              {
                resourceUid: uid,
                formUrl: mode === "wrong-form" ? TARGET_B : TARGET_A,
                readiness: "ready",
                ...(mode === "wrong-spec"
                  ? { targetSpecMatch: { path: ["worker"], equals: "pure-worker" } }
                  : {}),
              },
            ],
      prepare: async (input) => {
        if (!input.prepareExactReferences) throw new Error("missing preparation");
        return input.prepareExactReferences(async (lookup) => {
          const selected = await lookup(uid);
          return selected
            ? [
                {
                  ...selected,
                  readiness: "ready",
                  ...(mode === "wrong-spec"
                    ? { targetSpecMatch: { path: ["worker"], equals: "other-worker" } }
                    : {}),
                },
              ]
            : null;
        });
      },
    });
    try {
      uid = await f.target();
      await expect(f.create([uid])).rejects.toMatchObject({ code: "invalid_spec", status: 422 });
      expect(f.db.query("SELECT 1 FROM tf_v2_resources WHERE form_url = ?").all(CONSUMER)).toEqual(
        [],
      );
    } finally {
      f.db.close();
    }
  }
});
