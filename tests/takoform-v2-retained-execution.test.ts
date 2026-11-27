import { expect, test } from "bun:test";
import type { Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type {
  V2EngineOptions,
  V2Form,
  V2RetainedExecutionActions,
} from "../src/takoform-v2/types.ts";
import { migrateSqliteDatabase } from "./helpers/migrated-database.ts";

const FORM = "https://forms.example.test/retained-execution/1.0.0";
const PRINCIPAL = "org:retained-execution";

function fixture() {
  const database = migrateSqliteDatabase();
  const backing = createSqliteSql(database);
  const candidateBindCounts: number[] = [];
  const sql: Sql = {
    ...backing,
    query: (text, params) => {
      if (text.startsWith("SELECT * FROM tf_v2_operations WHERE next_attempt_at_ms"))
        candidateBindCounts.push(params?.length ?? 0);
      return backing.query(text, params);
    },
  };
  let time = Date.parse("2026-11-09T00:00:00Z");
  let uncertain = false;
  const effects: string[] = [];
  const form: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    backend: {
      id: "retained-fixture",
      targetKey: "retained-target",
      async execute(input) {
        effects.push(`execute:${input.operationId}`);
        return uncertain ? { kind: "unknown" } : { kind: "complete", observed: {}, output: {} };
      },
      async reconcile(input) {
        effects.push(`reconcile:${input.operationId}`);
        return { kind: "complete", observed: {}, output: {} };
      },
    },
  };
  const options: V2EngineOptions = {
    sql,
    now: () => new Date(time),
    replayWindowSeconds: 3600,
    leaseMilliseconds: 1000,
    authorize: async () => true,
    forms: { [FORM]: form },
  };
  const engine = createTakoformV2Engine(options);
  return {
    database,
    sql,
    effects,
    engine,
    options,
    form,
    candidateBindCounts,
    retained: (retainedExecutionActions?: V2RetainedExecutionActions) =>
      createTakoformV2Engine({
        ...options,
        forms: {},
        retainedForms: { [FORM]: form },
        ...(retainedExecutionActions === undefined ? {} : { retainedExecutionActions }),
        allowFreshCreateAndUpdate: false,
      }),
    create: (name: string) =>
      engine.acceptCreate({
        principal: PRINCIPAL,
        key: `retained-create-${name}`,
        input: { form: FORM, name, space: "fixture", spec: {} },
      }),
    delete: (uid: string) =>
      engine.acceptDelete({
        principal: PRINCIPAL,
        key: `delete-${uid}`,
        uid,
        expectedGeneration: 1,
      }),
    advance: () => {
      time += 2000;
    },
    loseAck: () => {
      uncertain = true;
    },
    snapshot: async (id: string, uid: string) => ({
      operation: await sql.query("SELECT * FROM tf_v2_operations WHERE id = ?", [id]),
      resource: await sql.query("SELECT * FROM tf_v2_resources WHERE uid = ?", [uid]),
    }),
  };
}

test("retained execution: held queued rows stay byte-for-byte unchanged without starving DELETE", async () => {
  const f = fixture();
  try {
    const ready = await f.create("ready");
    await f.engine.runNext();
    const held = [];
    for (let i = 0; i < 105; i++) {
      f.advance();
      held.push(await f.create(`held-${i}`));
    }
    const before = await Promise.all(held.map((op) => f.snapshot(op.id, op.resourceUid)));
    f.advance();
    const deleted = await f.delete(ready.resourceUid);
    const selected = f.retained({ [FORM]: ["delete"] });
    expect(await selected.runNext()).toMatchObject({ id: deleted.id, status: "succeeded" });
    expect(await selected.runNext()).toBeNull();
    expect(await Promise.all(held.map((op) => f.snapshot(op.id, op.resourceUid)))).toEqual(before);
    expect(f.effects).toEqual([`execute:${ready.id}`, `execute:${deleted.id}`]);
    const first = held[0];
    if (!first) throw new Error("fixture held operation missing");
    await expect(f.delete(first.resourceUid)).rejects.toMatchObject({ code: "resource_busy" });
  } finally {
    f.database.close();
  }
});

test("retained execution: uncertain UPDATE stays unchanged, then reconciles after selection removal", async () => {
  const f = fixture();
  try {
    const created = await f.create("uncertain");
    await f.engine.runNext();
    f.loseAck();
    const update = await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "update-uncertain",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: { value: "changed" },
    });
    expect(await f.engine.runNext()).toMatchObject({ id: update.id, effect: "unknown" });
    f.advance();
    const before = await f.snapshot(update.id, update.resourceUid);
    const allowed: ("create" | "update" | "delete")[] = ["delete"];
    const selection = { [FORM]: allowed };
    const selected = f.retained(selection);
    allowed.push("update");
    selection[FORM] = ["create", "update", "delete"];
    expect(await selected.runNext()).toBeNull();
    expect(await f.snapshot(update.id, update.resourceUid)).toEqual(before);
    expect(f.effects).toEqual([`execute:${created.id}`, `execute:${update.id}`]);
    expect(await f.retained().runNext()).toMatchObject({ id: update.id, status: "succeeded" });
    expect(f.effects.at(-1)).toBe(`reconcile:${update.id}`);
  } finally {
    f.database.close();
  }
});

test("retained execution: selection cannot refer to public or absent Forms", () => {
  const f = fixture();
  try {
    expect(() =>
      createTakoformV2Engine({ ...f.options, retainedExecutionActions: { [FORM]: ["delete"] } }),
    ).toThrow();
    expect(() => f.retained({ "https://forms.example.test/absent": [] })).toThrow();
  } finally {
    f.database.close();
  }
});

test("retained execution: absent, empty and all-actions preserve accepted execution", async () => {
  for (const policy of [undefined, {}, { [FORM]: ["create", "update", "delete"] as const }]) {
    const f = fixture();
    try {
      const created = await f.create("ordinary");
      expect(await f.retained(policy).runNext()).toMatchObject({
        id: created.id,
        status: "succeeded",
      });
      expect(f.candidateBindCounts).toEqual([2]);
    } finally {
      f.database.close();
    }
  }
});

test("retained execution: selection size does not grow D1 bind count; held backend identities are captured", async () => {
  const f = fixture();
  try {
    const held = await f.create("many-selections");
    const retainedForms = Object.fromEntries(
      Array.from({ length: 150 }, (_, i) => [
        `https://forms.example.test/retained-${i}/1.0.0`,
        f.form,
      ]),
    );
    retainedForms[FORM] = f.form;
    const policy = Object.fromEntries(Object.keys(retainedForms).map((url) => [url, []]));
    const engine = createTakoformV2Engine({
      ...f.options,
      forms: {},
      retainedForms,
      retainedExecutionActions: policy,
    });
    const before = await f.snapshot(held.id, held.resourceUid);
    f.form.backend.targetKey = "later-code-target";
    delete retainedForms[FORM];
    expect(await engine.runNext()).toBeNull();
    expect(await f.snapshot(held.id, held.resourceUid)).toEqual(before);
    expect(f.candidateBindCounts).toEqual([3]);
  } finally {
    f.database.close();
  }
});

test("retained execution: exact target mismatch preserves existing unavailable-adapter deferral", async () => {
  const f = fixture();
  try {
    const held = await f.create("different-target");
    f.form.backend.targetKey = "different-selected-target";
    const engine = f.retained({ [FORM]: [] });
    await expect(engine.runNext()).rejects.toMatchObject({ code: "temporarily_unavailable" });
    const rows = await f.sql.query(
      "SELECT status, dispatch_possible, next_attempt_at_ms FROM tf_v2_operations WHERE id = ?",
      [held.id],
    );
    expect(rows).toEqual([
      {
        status: "queued",
        dispatch_possible: 0,
        next_attempt_at_ms: Date.parse("2026-11-09T00:00:01Z"),
      },
    ]);
    expect(f.effects).toEqual([]);
  } finally {
    f.database.close();
  }
});

test("retained execution: missing comparison custody cannot terminalize held private inputs", async () => {
  const f = fixture();
  try {
    const form: V2Form = { ...f.form, privateInputs: { validateCreate() {}, validateUpdate() {} } };
    // Ephemeral local fixture keys, never operator/provider custody.
    const privateInputCustody = {
      transfer: {
        current: {
          id: "local-transfer",
          key: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
            "encrypt",
            "decrypt",
          ]),
        },
      },
      comparison: {
        current: {
          id: "local-comparison",
          key: await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
            "sign",
            "verify",
          ]),
        },
      },
      transferTtlSeconds: 300,
    };
    const setup = createTakoformV2Engine({
      ...f.options,
      forms: { [FORM]: form },
      privateInputCustody,
    });
    const created = await setup.acceptCreate({
      principal: PRINCIPAL,
      key: "retained-private-create",
      input: {
        form: FORM,
        name: "private",
        space: "fixture",
        spec: {},
        privateInputs: { TOKEN: "local-fixture-only" },
      },
    });
    const snapshot = () =>
      Promise.all([
        f.snapshot(created.id, created.resourceUid),
        f.sql.query("SELECT * FROM tf_v2_private_inputs"),
      ]);
    const before = await snapshot();
    expect(await f.retained({ [FORM]: ["delete"] }).runNext()).toBeNull();
    expect(await snapshot()).toEqual(before);
    expect(f.effects).toEqual([]);
    expect(await f.retained().runNext()).toMatchObject({
      id: created.id,
      status: "failed",
      error: { code: "private_inputs_unverifiable" },
    });
  } finally {
    f.database.close();
  }
});

test("retained execution: malformed policy is rejected without evaluating getters", () => {
  const f = fixture();
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, FORM, {
    enumerable: true,
    get() {
      getterCalls++;
      return ["delete"];
    },
  });
  const arrayAccessor = Object.defineProperty(["delete"], "0", {
    get() {
      getterCalls++;
      return "delete";
    },
  });
  try {
    for (const value of [
      null,
      false,
      [],
      accessor,
      { [FORM]: ["read"] },
      { [FORM]: ["delete", "delete"] },
      { [FORM]: new Array(1) },
      { [FORM]: arrayAccessor },
    ]) {
      expect(() => f.retained(value as V2RetainedExecutionActions)).toThrow();
    }
    expect(getterCalls).toBe(0);
  } finally {
    f.database.close();
  }
});

test("retained execution: post-construction target drift cannot run another accepted target", async () => {
  const f = fixture();
  try {
    const old = await f.create("old-target");
    const selected = f.retained({ [FORM]: ["delete"] });
    const before = await f.snapshot(old.id, old.resourceUid);
    f.form.backend.targetKey = "later-target";
    const later = await f.create("later-target");
    await expect(selected.runNext()).rejects.toMatchObject({ code: "temporarily_unavailable" });
    expect(await f.snapshot(old.id, old.resourceUid)).toEqual(before);
    expect(
      await f.sql.query("SELECT status, dispatch_possible FROM tf_v2_operations WHERE id = ?", [
        later.id,
      ]),
    ).toEqual([{ status: "queued", dispatch_possible: 0 }]);
    expect(f.effects).toEqual([]);
  } finally {
    f.database.close();
  }
});
