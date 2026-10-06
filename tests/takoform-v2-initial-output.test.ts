import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2BackendResult, V2Execution } from "../src/takoform-v2/types.ts";

// Synthetic Form exercises the engine seam, not Endpoint/TLS support.
const FORM = "https://forms.example.test/AssignedAddress/1.0.0/";
const KEY = "initial-output-create-0001";
const requested = { form: FORM, space: "default", name: "address", spec: {} };

function fixture(path = ":memory:", initialize?: (uid: string) => JsonObject) {
  const db = new Database(path);
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name = 'tf_v2_resources'").get()) {
    for (const migration of ["0070_takoform_v2.sql", "0071_v2_sqlite_migration_set_custody.sql"]) {
      db.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
  }
  let calls = 0;
  let now = Date.parse("2026-10-06T00:00:00Z");
  let outcome: V2BackendResult = { kind: "unknown" };
  const execute = async (input: V2Execution): Promise<V2BackendResult> =>
    outcome.kind === "complete" ? { ...outcome, output: input.previousOutput } : outcome;
  const form = {
    validateCreate() {},
    validateUpdate() {},
    initialOutput({ resourceUid }: { resourceUid: string }) {
      calls += 1;
      return (
        initialize?.(resourceUid) ?? {
          hostname: `${resourceUid}.example.invalid`,
          url: `https://${resourceUid}.example.invalid/`,
        }
      );
    },
    backend: { id: "assigned-address-fixture", targetKey: "fixture", execute, reconcile: execute },
  };
  const engine = createTakoformV2Engine({
    sql: createSqliteSql(db),
    forms: { [FORM]: form },
    replayWindowSeconds: 3600,
    leaseMilliseconds: 1000,
    now: () => new Date(now),
    authorize: async (principal, space) => principal === "owner" && space === "default",
  });
  return {
    db,
    engine,
    calls: () => calls,
    setOutcome(value: V2BackendResult) {
      outcome = value;
    },
    advance() {
      now += 2000;
    },
    create: () => engine.acceptCreate({ principal: "owner", key: KEY, input: requested }),
  };
}

test("assigned output is committed at acceptance and preserved across replay and SQL reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "v2-initial-output-"));
  const path = join(directory, "state.sqlite");
  const first = fixture(path);
  try {
    const [a, b] = await Promise.all([first.create(), first.create()]);
    expect(b).toEqual(a);
    const resource = await first.engine.getResource({ principal: "owner", uid: a.resourceUid });
    expect(resource).toMatchObject({ phase: "pending", observed: {}, observedGeneration: 0 });
    expect(resource.output).toEqual({
      hostname: `${a.resourceUid}.example.invalid`,
      url: `https://${a.resourceUid}.example.invalid/`,
    });
    expect(
      (await first.engine.listResources({ principal: "owner", limit: 10 }))[0]?.output,
    ).toEqual(resource.output);
    first.db.close();
    const reopened = fixture(path, () => {
      throw new Error("must not allocate again");
    });
    try {
      expect(await reopened.create()).toEqual(a);
      expect(reopened.calls()).toBe(0);
      expect(
        (await reopened.engine.getResource({ principal: "owner", uid: a.resourceUid })).output,
      ).toEqual(resource.output);
      expect(reopened.db.query("SELECT count(*) AS n FROM tf_v2_resources").get()).toEqual({
        n: 1,
      });
    } finally {
      reopened.db.close();
    }
  } finally {
    first.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unknown and failed execution retain assigned output for an explicit same-UID repair", async () => {
  const f = fixture();
  try {
    const created = await f.create();
    const read = () => f.engine.getResource({ principal: "owner", uid: created.resourceUid });
    const output = (await read()).output;
    expect(Object.keys(output)).toEqual(["hostname", "url"]);
    expect(await f.engine.runNext()).toMatchObject({ status: "reconciling", effect: "unknown" });
    expect((await read()).output).toEqual(output);
    f.advance();
    f.setOutcome({ kind: "partial", code: "route_incomplete", message: "Route incomplete" });
    expect(await f.engine.runNext()).toMatchObject({ status: "failed", effect: "partial" });
    expect(await read()).toMatchObject({ phase: "error", output, observed: {} });
    await f.engine.acceptUpdate({
      principal: "owner",
      key: "initial-output-repair-0001",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: {},
    });
    f.setOutcome({ kind: "complete", observed: { ready: true }, output: {} });
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded" });
    expect(await read()).toMatchObject({ generation: 2, output });
    expect(f.calls()).toBe(1);
    await f.engine.acceptDelete({
      principal: "owner",
      key: "initial-output-delete-0001",
      uid: created.resourceUid,
      expectedGeneration: 2,
    });
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded" });
    await expect(read()).rejects.toMatchObject({ status: 410 });
    expect(f.calls()).toBe(1);
  } finally {
    f.db.close();
  }
});

test("failed assignment or failed operation insertion leaves neither Resource nor Operation", async () => {
  const rejected = fixture(":memory:", () => {
    throw new Error("no address allocation");
  });
  const aborted = fixture();
  try {
    await expect(rejected.create()).rejects.toThrow("no address allocation");
    aborted.db.exec(`CREATE TRIGGER reject_operation BEFORE INSERT ON tf_v2_operations
      BEGIN SELECT RAISE(ABORT, 'fixture reject operation'); END;`);
    await expect(aborted.create()).rejects.toThrow();
    for (const f of [rejected, aborted]) {
      expect(f.db.query("SELECT count(*) AS n FROM tf_v2_resources").get()).toEqual({ n: 0 });
      expect(f.db.query("SELECT count(*) AS n FROM tf_v2_operations").get()).toEqual({ n: 0 });
    }
  } finally {
    rejected.db.close();
    aborted.db.close();
  }
});
