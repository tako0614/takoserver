import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2Backend, V2BackendResult, V2Execution } from "../src/takoform-v2/types.ts";

const FORM = "https://forms.example.test/bounded/1.0.0/";

function fixture(backend: Pick<V2Backend, "execute" | "reconcile">) {
  const db = new Database(":memory:");
  db.exec(readFileSync(new URL("../migrations/0070_takoform_v2.sql", import.meta.url), "utf8"));
  db.exec(
    readFileSync(new URL("../migrations/0081_v2_private_inputs.sql", import.meta.url), "utf8"),
  );
  let milliseconds = Date.now();
  const engine = () =>
    createTakoformV2Engine({
      sql: createSqliteSql(db),
      now: () => new Date(milliseconds),
      replayWindowSeconds: 120,
      authorize: async (principal, space) => principal === "owner" && space === "default",
      forms: {
        [FORM]: {
          validateCreate() {},
          validateUpdate() {},
          backend: { id: "bounded-fixture", targetKey: "fixture-sql", ...backend },
        },
      },
    });
  return {
    db,
    engine,
    advance(amount: number) {
      milliseconds += amount;
    },
    accept(core: ReturnType<typeof engine>) {
      return core.acceptCreate({
        principal: "owner",
        key: "bounded-checkpoint-operation-0001",
        input: { form: FORM, space: "default", name: "artifact", spec: {} },
      });
    },
  };
}

test("a completed bounded step resumes the same Operation on the next tick, not after the lease timeout", async () => {
  const calls: { method: string; execution: V2Execution }[] = [];
  const f = fixture({
    async execute(execution) {
      calls.push({ method: "execute", execution });
      return { kind: "continue" };
    },
    async reconcile(execution) {
      calls.push({ method: "reconcile", execution });
      return { kind: "complete", observed: { ready: true }, output: {} };
    },
  });
  try {
    const initial = f.engine();
    const accepted = await f.accept(initial);
    const yielded = await initial.runNext();
    expect(yielded).toMatchObject({ id: accepted.id, status: "reconciling", effect: "unknown" });
    const checkpoint = f.db
      .query("SELECT next_attempt_at_ms, updated_at FROM tf_v2_operations WHERE id = ?")
      .get(accepted.id) as { next_attempt_at_ms: number; updated_at: string };
    expect(checkpoint.next_attempt_at_ms - Date.parse(checkpoint.updated_at)).toBe(1_000);
    expect(yielded?.error).toBeUndefined();
    expect(
      await initial.getResource({ principal: "owner", uid: accepted.resourceUid }),
    ).toMatchObject({
      phase: "pending",
      observedGeneration: 0,
      observed: {},
    });
    const restartedEngine = f.engine();
    expect(await restartedEngine.runNext()).toBeNull();
    f.advance(999);
    expect(await restartedEngine.runNext()).toBeNull();
    f.advance(1);
    expect(await restartedEngine.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
    expect(calls.map((call) => call.method)).toEqual(["execute", "reconcile"]);
    expect(calls[1]?.execution.backendKey).toBe(calls[0]?.execution.backendKey);
    expect(calls[1]?.execution.leaseToken).not.toBe(calls[0]?.execution.leaseToken);
    expect((await f.accept(restartedEngine)).id).toBe(accepted.id);
    expect(await restartedEngine.runNext()).toBeNull();
  } finally {
    f.db.close();
  }
});

test("unknown effects retain their existing reconciliation backoff", async () => {
  let reconciles = 0;
  const f = fixture({
    async execute() {
      return { kind: "unknown" };
    },
    async reconcile() {
      reconciles += 1;
      return { kind: "complete", observed: {}, output: {} };
    },
  });
  try {
    const core = f.engine();
    await f.accept(core);
    expect(await core.runNext()).toMatchObject({ error: { code: "outcome_unconfirmed" } });
    f.advance(1_000);
    expect(await f.engine().runNext()).toBeNull();
    f.advance(58_999);
    expect(await core.runNext()).toBeNull();
    expect(reconciles).toBe(0);
    f.advance(1);
    expect(await core.runNext()).toMatchObject({ status: "succeeded" });
    expect(reconciles).toBe(1);
  } finally {
    f.db.close();
  }
});

test("a due continuation yields its scheduling turn to older unserved work", async () => {
  const f = fixture({
    async execute(input) {
      return input.name === "artifact"
        ? { kind: "continue" }
        : { kind: "complete", observed: {}, output: {} };
    },
    async reconcile() {
      return { kind: "continue" };
    },
  });
  try {
    const core = f.engine();
    const first = await f.accept(core);
    f.advance(1);
    const other = await core.acceptCreate({
      principal: "owner",
      key: "other-bounded-operation-00001",
      input: { form: FORM, space: "default", name: "other", spec: {} },
    });
    f.advance(1);
    expect(await core.runNext()).toMatchObject({ id: first.id, status: "reconciling" });
    f.advance(1_000);
    expect(await core.runNext()).toMatchObject({ id: other.id, status: "succeeded" });
    expect(await core.runNext()).toMatchObject({ id: first.id, status: "reconciling" });
  } finally {
    f.db.close();
  }
});

test("a stale continuation cannot reopen an Operation settled by its successor", async () => {
  let release!: (result: V2BackendResult) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = fixture({
    execute() {
      return new Promise((resolve) => {
        release = resolve;
        entered();
      });
    },
    async reconcile() {
      return { kind: "complete", observed: { ready: true }, output: {} };
    },
  });
  try {
    const core = f.engine();
    const accepted = await f.accept(core);
    const oldRun = core.runNext();
    await started;
    f.advance(60_001);
    expect(await f.engine().runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
    release({ kind: "continue" });
    expect(await oldRun).toMatchObject({ id: accepted.id, status: "succeeded" });
    f.advance(1_000);
    expect(await core.runNext()).toBeNull();
  } finally {
    f.db.close();
  }
});
