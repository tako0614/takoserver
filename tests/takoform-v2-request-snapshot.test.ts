import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2PrivateInputCustody } from "../src/takoform-v2/private-inputs.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const FORM = "https://forms.example.test/Snapshot/1.0.0";

function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    async wait() {
      enter();
      await released;
    },
  };
}

function fixture(privateInputCustody?: V2PrivateInputCustody) {
  const db = new Database(":memory:");
  migrateSqlite(db);
  let paused: ReturnType<typeof barrier> | undefined;
  const form: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    ...(privateInputCustody ? { privateInputs: { validateCreate() {}, validateUpdate() {} } } : {}),
    backend: {
      id: "snapshot-backend",
      targetKey: "snapshot-target",
      async execute() {
        return { kind: "complete", observed: {}, output: {} };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    },
  };
  const engine = createTakoformV2Engine({
    sql: createSqliteSql(db),
    replayWindowSeconds: 120,
    ...(privateInputCustody ? { privateInputCustody } : {}),
    forms: { [FORM]: form },
    async authorize(principal, space) {
      const held = paused;
      paused = undefined;
      if (held) await held.wait();
      return principal === "alice" && space === "allowed";
    },
  });
  return {
    db,
    engine,
    pause() {
      const held = barrier();
      paused = held;
      return held;
    },
    async create(name: string) {
      const operation = await engine.acceptCreate({
        principal: "alice",
        key: `snapshot-create-${name}-00000001`,
        input: { form: FORM, space: "allowed", name, spec: { nested: { value: "original" } } },
      });
      expect((await engine.runNext())?.status).toBe("succeeded");
      return operation.resourceUid;
    },
  };
}

test("acceptance fixes the authorized Space and nested spec before awaiting authorization", async () => {
  const { db, engine, pause } = fixture();
  try {
    const request = {
      principal: "alice",
      key: "snapshot-create-race-00000001",
      input: {
        form: FORM,
        space: "allowed",
        name: "original",
        spec: { nested: { value: "original" } },
      },
    };
    const held = pause();
    const pending = engine.acceptCreate(request);
    await held.entered;
    request.input.space = "denied";
    request.input.name = "changed";
    request.input.spec.nested.value = "changed";
    held.release();
    const accepted = await pending;
    const resource = await engine.getResource({ principal: "alice", uid: accepted.resourceUid });
    expect(resource).toMatchObject({
      space: "allowed",
      name: "original",
      spec: { nested: { value: "original" } },
    });
    const replay = await engine.acceptCreate({
      principal: "alice",
      key: "snapshot-create-race-00000001",
      input: {
        form: FORM,
        space: "allowed",
        name: "original",
        spec: { nested: { value: "original" } },
      },
    });
    expect(replay.id).toBe(accepted.id);
  } finally {
    db.close();
  }
});

test("update retains the requested UID, key, generation and nested spec across authorization", async () => {
  const { db, engine, pause, create } = fixture();
  try {
    const first = await create("first");
    const second = await create("second");
    const request = {
      principal: "alice",
      key: "snapshot-update-race-00000001",
      uid: first,
      expectedGeneration: 1,
      spec: { nested: { value: "updated" } },
    };
    const held = pause();
    const pending = engine.acceptUpdate(request);
    await held.entered;
    request.uid = second;
    request.key = "snapshot-update-changed-000001";
    request.spec.nested.value = "changed";
    held.release();
    const accepted = await pending;
    expect(accepted.resourceUid).toBe(first);
    expect(await engine.getResource({ principal: "alice", uid: first })).toMatchObject({
      generation: 2,
      spec: { nested: { value: "updated" } },
    });
    expect(await engine.getResource({ principal: "alice", uid: second })).toMatchObject({
      generation: 1,
      spec: { nested: { value: "original" } },
    });
    expect(
      (
        await engine.acceptUpdate({
          principal: "alice",
          key: "snapshot-update-race-00000001",
          uid: first,
          expectedGeneration: 1,
          spec: { nested: { value: "updated" } },
        })
      ).id,
    ).toBe(accepted.id);
  } finally {
    db.close();
  }
});

test("delete cannot switch to another Resource after the original Resource was authorized", async () => {
  const { db, engine, pause, create } = fixture();
  try {
    const first = await create("first");
    const second = await create("second");
    const request = {
      principal: "alice",
      key: "snapshot-delete-race-00000001",
      uid: first,
      expectedGeneration: 1,
    };
    const held = pause();
    const pending = engine.acceptDelete(request);
    await held.entered;
    request.uid = second;
    request.key = "snapshot-delete-changed-000001";
    held.release();
    const accepted = await pending;
    expect(accepted.resourceUid).toBe(first);
    expect((await engine.runNext())?.status).toBe("succeeded");
    await expect(engine.getResource({ principal: "alice", uid: first })).rejects.toMatchObject({
      code: "gone",
    });
    expect(await engine.getResource({ principal: "alice", uid: second })).toMatchObject({
      generation: 1,
      phase: "idle",
    });
    expect(
      (
        await engine.acceptDelete({
          principal: "alice",
          key: "snapshot-delete-race-00000001",
          uid: first,
          expectedGeneration: 1,
        })
      ).id,
    ).toBe(accepted.id);
  } finally {
    db.close();
  }
});

test("known-key replay compares an owned private map after authorization yields", async () => {
  const [transfer, comparison] = await Promise.all([
    crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
    crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
  ]);
  const { db, engine, pause } = fixture({
    transfer: { current: { id: "snapshot-transfer", key: transfer } },
    comparison: { current: { id: "snapshot-comparison", key: comparison } },
    transferTtlSeconds: 60,
  });
  try {
    const body = {
      form: FORM,
      space: "allowed",
      name: "secret",
      spec: {},
      privateInputs: { password: "fixture-only-original" },
    };
    const accepted = await engine.acceptCreate({
      principal: "alice",
      key: "snapshot-secret-replay-000001",
      input: structuredClone(body),
    });
    const held = pause();
    const pending = engine.replayExistingCreate({
      principal: "alice",
      key: "snapshot-secret-replay-000001",
      body,
    });
    await held.entered;
    body.privateInputs.password = "fixture-only-changed";
    held.release();
    expect((await pending)?.id).toBe(accepted.id);
  } finally {
    db.close();
  }
});
