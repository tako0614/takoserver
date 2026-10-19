import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { JsonObject, Sql, SqlStatement } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2ExactReferenceTarget, V2Form, V2Operation } from "../src/takoform-v2/types.ts";

const TARGET = "https://forms.example.test/CapacityTarget/1.0.0/";
const PREPARED = "https://forms.example.test/CapacityPrepared/1.0.0/";
const PURE = "https://forms.example.test/CapacityPure/1.0.0/";

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

function fixture() {
  const db = new Database(":memory:");
  for (const name of [
    "0070_takoform_v2.sql",
    "0071_v2_sqlite_migration_set_custody.sql",
    "0073_v2_reference_acceptance.sql",
    "0081_v2_private_inputs.sql",
  ])
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  const raw = createSqliteSql(db);
  let gate:
    | { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
    | undefined;
  let lookups = 0;
  let readAllowed = true;
  let admissionBatches = 0;
  let lastAcceptance: readonly SqlStatement[] = [];
  const sql: Sql = {
    async query(query, params) {
      if (query.includes("WHERE uid = ? AND principal = ? AND space = ?")) lookups++;
      return raw.query(query, params);
    },
    run: raw.run,
    async batch(statements) {
      if (accepting(statements)) {
        admissionBatches++;
        lastAcceptance = statements;
        if (gate) {
          const held = gate;
          gate = undefined;
          held.entered.resolve();
          await held.release.promise;
        }
      }
      return raw.batch(statements);
    },
  };
  const backend: V2Form["backend"] = {
    id: "capacity-fixture",
    targetKey: "sqlite",
    async execute() {
      return { kind: "complete", observed: { ready: true }, output: {} };
    },
    async reconcile() {
      return { kind: "unknown" };
    },
  };
  const plain: V2Form = { validateCreate() {}, validateUpdate() {}, backend };
  const pure: V2Form = {
    ...plain,
    references(spec) {
      return (spec.pure as readonly string[]).map((resourceUid) => ({
        resourceUid,
        formUrl: TARGET,
        readiness: "ready" as const,
      }));
    },
  };
  const prepared: V2Form = {
    ...pure,
    async prepareAdmission(input) {
      if (!input.prepareExactReferences) throw new Error("missing Core preparation");
      return input.prepareExactReferences(async (lookup) => {
        const declarations = input.spec.prepared as readonly string[];
        const requested = input.spec.lookups as readonly string[] | undefined;
        const selected = new Map<string, V2ExactReferenceTarget>();
        for (const uid of new Set([...(requested ?? []), ...declarations])) {
          const target = await lookup(uid);
          if (!target) return null;
          selected.set(uid, target);
        }
        return declarations.map((uid) => {
          const target = selected.get(uid);
          if (!target) throw new Error("fixture did not look up its declaration");
          return { ...target, readiness: "ready" as const };
        });
      });
    },
  };
  const engine = createTakoformV2Engine({
    sql,
    replayWindowSeconds: 3600,
    authorize: async (_principal, _space, access) => access === "write" || readAllowed,
    forms: { [TARGET]: plain, [PURE]: pure, [PREPARED]: prepared },
  });
  return {
    db,
    engine,
    counts: () => ({ lookups, admissionBatches }),
    acceptance: () => lastAcceptance,
    allowRead(allowed: boolean) {
      readAllowed = allowed;
    },
    pause() {
      const held = { entered: deferred(), release: deferred() };
      gate = held;
      return held;
    },
    async seed() {
      const targets: string[] = [];
      for (let index = 0; index < 516; index++) {
        const op = await engine.acceptCreate({
          principal: "alice",
          key: `capacity-target-${index}-0001`,
          input: { form: TARGET, space: "space", name: `target-${index}`, spec: {} },
        });
        const settled = await engine.runNext();
        if (!settled || settled.id !== op.id || settled.status !== "succeeded")
          throw new Error(`genuine target fixture did not settle: ${index}`);
        targets.push(op.resourceUid);
      }
      return targets;
    },
    create(label: string, spec: JsonObject, legacy = false) {
      return engine.acceptCreate({
        principal: "alice",
        key: `capacity-${label}-0001`,
        input: { form: legacy ? PURE : PREPARED, space: "space", name: label, spec },
      });
    },
  };
}

const f = fixture();
let targets: readonly string[] = [];
beforeAll(async () => {
  targets = await f.seed();
});
afterAll(() => {
  f.db.close();
});

function absent(label: string) {
  expect(f.db.query("SELECT 1 FROM tf_v2_resources WHERE name = ?").all(label)).toEqual([]);
  expect(
    f.db.query("SELECT 1 FROM tf_v2_operations WHERE replay_key = ?").all(`capacity-${label}-0001`),
  ).toEqual([]);
  expect(
    f.db
      .query(
        "SELECT 1 FROM tf_v2_operation_reference_sets s JOIN tf_v2_operations o ON o.id = s.operation_id WHERE o.replay_key = ?",
      )
      .all(`capacity-${label}-0001`),
  ).toEqual([]);
}

async function sealed(op: V2Operation, expected: readonly string[]) {
  expect(
    f.db
      .query("SELECT sealed FROM tf_v2_operation_reference_sets WHERE operation_id = ?")
      .get(op.id),
  ).toEqual({ sealed: 1 });
  const rows = f.db
    .query(
      "SELECT target_uid,form_url FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid",
    )
    .all(op.id);
  expect(rows).toEqual(
    [...expected].sort().map((target_uid) => ({ target_uid, form_url: TARGET })),
  );
  expect(
    f.db
      .query("SELECT count(*) AS n FROM tf_v2_resource_references WHERE referrer_uid = ?")
      .get(op.resourceUid),
  ).toEqual({ n: expected.length });
  expect(await f.engine.runNext()).toMatchObject({ id: op.id, status: "succeeded" });
}

test("combined515 admits451 pure plus64 prepared references as genuine sealed SQLite rows", async () => {
  expect(targets).toHaveLength(516);
  const before = f.counts();
  const op = await f.create("combined-family-max", {
    pure: targets.slice(0, 451),
    prepared: targets.slice(451, 515),
  });
  expect(f.counts().lookups - before.lookups).toBe(64);
  expect(f.acceptance()[0]?.params).toHaveLength(3);
  expect(f.acceptance().every((statement) => (statement.params?.length ?? 0) <= 100)).toBe(true);
  await sealed(op, targets.slice(0, 515));
});

test("combined515 preserves the independent pure512 and prepared512 maxima", async () => {
  const pureMax = await f.create("combined-pure-max", {
    pure: targets.slice(0, 512),
    prepared: targets.slice(512, 515),
  });
  await sealed(pureMax, targets.slice(0, 515));
  const before = f.counts();
  const preparedMax = await f.create("combined-prepared-max", {
    pure: targets.slice(512, 515),
    prepared: targets.slice(0, 512),
  });
  expect(f.counts().lookups - before.lookups).toBe(512);
  await sealed(preparedMax, targets.slice(0, 515));
});

test("combined516 refuses before any acceptance batch or replay key", async () => {
  const before = f.counts();
  await expect(
    f.create("combined-overflow", {
      pure: targets.slice(0, 512),
      prepared: targets.slice(512, 516),
    }),
  ).rejects.toMatchObject({ code: "invalid_spec", status: 422 });
  expect(f.counts().admissionBatches).toBe(before.admissionBatches);
  absent("combined-overflow");
});

test("legacy pure512 still accepts while pure513 refuses without prepared activation", async () => {
  const before = f.counts();
  const op = await f.create("legacy-pure-max", { pure: targets.slice(0, 512) }, true);
  await sealed(op, targets.slice(0, 512));
  await expect(
    f.create("legacy-pure-overflow", { pure: targets.slice(0, 513) }, true),
  ).rejects.toMatchObject({ code: "invalid_spec", status: 422 });
  expect(f.counts().lookups).toBe(before.lookups);
  absent("legacy-pure-overflow");
});

test("prepared raw513 remains invalid even when all declarations use one captured UID", async () => {
  const before = f.counts();
  const uid = targets[0];
  if (!uid) throw new Error("missing genuine target");
  await expect(
    f.create("prepared-raw-overflow", {
      pure: [],
      prepared: Array.from({ length: 513 }, () => uid),
    }),
  ).rejects.toMatchObject({ code: "invalid_spec", status: 422 });
  expect(f.counts().lookups - before.lookups).toBe(1);
  expect(f.counts().admissionBatches).toBe(before.admissionBatches);
  absent("prepared-raw-overflow");
});

test("lookup513 refuses before its513th query and leaves no partial acceptance", async () => {
  const before = f.counts();
  await expect(
    f.create("lookup-overflow", { pure: [], prepared: [], lookups: targets.slice(0, 513) }),
  ).rejects.toMatchObject({ code: "invalid_spec", status: 422 });
  expect(f.counts().lookups - before.lookups).toBe(512);
  expect(f.counts().admissionBatches).toBe(before.admissionBatches);
  absent("lookup-overflow");
});

test("combined515 retains read admission and the atomic ready-again target preimage fence", async () => {
  const spec = { pure: targets.slice(0, 451), prepared: targets.slice(451, 515) };
  const before = f.counts();
  f.allowRead(false);
  await expect(f.create("capacity-read-denied", spec)).rejects.toMatchObject({
    code: "forbidden",
    status: 403,
  });
  expect(f.counts()).toEqual(before);
  absent("capacity-read-denied");
  f.allowRead(true);
  const selected = targets[451];
  if (!selected) throw new Error("missing captured target");
  const held = f.pause();
  const pending = f.create("capacity-preimage-race", spec);
  await held.entered.promise;
  const moved = await f.engine.acceptUpdate({
    principal: "alice",
    key: "capacity-target-race-0001",
    uid: selected,
    expectedGeneration: 1,
    spec: { revision: 2 },
  });
  expect(await f.engine.runNext()).toMatchObject({ id: moved.id, status: "succeeded" });
  expect(
    f.db
      .query(
        "SELECT generation,observed_generation,phase,busy_operation FROM tf_v2_resources WHERE uid = ?",
      )
      .get(selected),
  ).toEqual({ generation: 2, observed_generation: 2, phase: "idle", busy_operation: null });
  held.release.resolve();
  await expect(pending).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
  absent("capacity-preimage-race");
  await sealed(await f.create("capacity-preimage-race", spec), targets.slice(0, 515));
});
