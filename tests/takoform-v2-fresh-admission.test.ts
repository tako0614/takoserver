import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject, Sql, SqlStatement } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2Backend, V2EngineOptions, V2Execution, V2Form } from "../src/takoform-v2/types.ts";

const FORM = "https://fresh-admission.example.test/fixture";
const PRINCIPAL = "org:fixture";
const SPACE = "fixture";
const ORIGIN = "https://host.example.test";

async function fixture(
  input: { admission?: boolean; loseAck?: boolean; privateInputs?: boolean } = {},
) {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const backing = createSqliteSql(database);
  const batches: (readonly SqlStatement[])[] = [];
  const sql: Sql = {
    query: (text, params) => backing.query(text, params),
    run: (text, params) => backing.run(text, params),
    batch: async (statements) => {
      batches.push(structuredClone(statements));
      return await backing.batch(statements);
    },
  };
  let nowMs = Date.now();
  const effects: {
    mode: "execute" | "reconcile";
    operation: string;
    action: string;
  }[] = [];
  const finish = (execution: V2Execution) => ({
    kind: "complete" as const,
    observed: { value: execution.spec.value ?? null },
    output: {},
  });
  const backend: V2Backend = {
    id: "fresh-admission-fixture-backend",
    targetKey: "fresh-admission-fixture-target",
    async execute(execution) {
      effects.push({ mode: "execute", operation: execution.operationId, action: execution.action });
      return input.loseAck && execution.action === "create"
        ? { kind: "unknown" }
        : finish(execution);
    },
    async reconcile(execution) {
      effects.push({
        mode: "reconcile",
        operation: execution.operationId,
        action: execution.action,
      });
      return finish(execution);
    },
  };
  const validateSpec = (spec: JsonObject) => {
    if (typeof spec.value !== "string") throw new Error("fixture value must be a string");
  };
  const validatePrivate = (
    _spec: JsonObject,
    inputs: Readonly<Record<string, string>> | undefined,
  ) => {
    if (inputs !== undefined && (Object.keys(inputs).join() !== "TOKEN" || !inputs.TOKEN))
      throw new Error("fixture private input must contain TOKEN only");
  };
  const form: V2Form = {
    validateCreate: validateSpec,
    validateUpdate: (_previous, spec) => validateSpec(spec),
    references: (spec) =>
      typeof spec.dependency === "string"
        ? [{ resourceUid: spec.dependency, formUrl: FORM, readiness: "observed" }]
        : [],
    privateInputs: {
      validateCreate: validatePrivate,
      validateUpdate: (_previous, spec, inputs) => validatePrivate(spec, inputs),
    },
    backend,
  };
  const privateInputCustody = input.privateInputs
    ? {
        transfer: {
          current: {
            id: "fixture-transfer",
            key: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
              "encrypt",
              "decrypt",
            ]),
          },
        },
        comparison: {
          current: {
            id: "fixture-comparison",
            key: await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
              "sign",
              "verify",
            ]),
          },
        },
        transferTtlSeconds: 300,
      }
    : undefined;
  const options: V2EngineOptions = {
    sql,
    now: () => new Date(nowMs),
    replayWindowSeconds: 3_600,
    leaseMilliseconds: 1_000,
    authorize: async (principal, space) => principal === PRINCIPAL && space === SPACE,
    forms: { [FORM]: form },
    ...(input.admission === undefined ? {} : { allowFreshCreateAndUpdate: input.admission }),
    ...(privateInputCustody === undefined ? {} : { privateInputCustody }),
  };
  const engine = createTakoformV2Engine(options);
  return {
    database,
    sql,
    batches,
    effects,
    options,
    engine,
    reopen: (admission: boolean, selected: V2Form = form) =>
      createTakoformV2Engine({
        ...options,
        forms: { [FORM]: selected },
        allowFreshCreateAndUpdate: admission,
      }),
    reopenRetained: () =>
      createTakoformV2Engine({
        ...options,
        forms: {},
        retainedForms: { [FORM]: form },
        allowFreshCreateAndUpdate: false,
      }),
    create: (name: string, spec: JsonObject = { value: "original" }) =>
      engine.acceptCreate({
        principal: PRINCIPAL,
        key: `fresh-fixture-create-${name}`,
        input: { form: FORM, name, space: SPACE, spec },
      }),
    advance: (milliseconds = 2_000) => {
      nowMs += milliseconds;
    },
    setTime: (milliseconds: number) => {
      nowMs = milliseconds;
    },
    close: () => database.close(),
  };
}

test("fresh admission core: absent and true preserve complete SQLite batches", async () => {
  const traces = [];
  for (const admission of [undefined, true]) {
    let sequence = 0;
    const ids = spyOn(crypto, "randomUUID").mockImplementation(
      () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    );
    const f = await fixture(admission === undefined ? {} : { admission });
    f.setTime(Date.parse("2026-10-14T20:00:00.000Z"));
    try {
      const created = await f.create("default");
      expect(await f.engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
      const updated = await f.engine.acceptUpdate({
        principal: PRINCIPAL,
        key: "fresh-fixture-default-update",
        uid: created.resourceUid,
        expectedGeneration: 1,
        spec: { value: "updated" },
      });
      expect(await f.engine.runNext()).toMatchObject({ id: updated.id, status: "succeeded" });
      const deleted = await f.engine.acceptDelete({
        principal: PRINCIPAL,
        key: "fresh-fixture-default-delete",
        uid: created.resourceUid,
        expectedGeneration: 2,
      });
      expect(await f.engine.runNext()).toMatchObject({ id: deleted.id, status: "succeeded" });
      traces.push(JSON.stringify(f.batches));
      expect(f.engine.supportsForm(FORM)).toBe(true);
    } finally {
      f.close();
      ids.mockRestore();
    }
  }
  expect(traces[0]).toBe(traces[1]);
  expect(JSON.parse(traces[0] ?? "[]").length).toBeGreaterThan(0);
});

test("fresh admission core: captured policy refuses fresh CREATE/UPDATE", async () => {
  const f = await fixture({ privateInputs: true });
  try {
    const created = await f.create("existing");
    expect(await f.engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
    const options = { ...f.options, allowFreshCreateAndUpdate: false };
    const closed = createTakoformV2Engine(options);
    options.allowFreshCreateAndUpdate = true;
    const before = f.batches.length;
    expect(closed.supportsForm(FORM)).toBe(false);
    expect(closed.supportsPrivateInputs(FORM)).toBe(false);
    expect(await closed.supportsPrivateInputsForUpdate(PRINCIPAL, created.resourceUid)).toBe(false);
    let admissionReads = 0;
    const captured = createTakoformV2Engine({
      ...f.options,
      get allowFreshCreateAndUpdate() {
        admissionReads += 1;
        return admissionReads > 1;
      },
    });
    expect(captured.supportsForm(FORM)).toBe(false);
    expect(captured.supportsPrivateInputs(FORM)).toBe(false);
    expect(admissionReads).toBe(1);
    await expect(
      closed.acceptCreate({
        principal: PRINCIPAL,
        key: "fresh-fixture-refused-create",
        input: { form: FORM, name: "new", space: SPACE, spec: { value: "new" } },
      }),
    ).rejects.toMatchObject({ code: "unsupported_form", status: 422 });
    await expect(
      closed.acceptUpdate({
        principal: PRINCIPAL,
        key: "fresh-fixture-refused-update",
        uid: created.resourceUid,
        expectedGeneration: 1,
        spec: { value: "original" },
      }),
    ).rejects.toMatchObject({ code: "unsupported_form", status: 422 });
    expect(f.batches).toHaveLength(before);
    expect(
      await closed.getResource({ principal: PRINCIPAL, uid: created.resourceUid }),
    ).toMatchObject({ generation: 1, lastOperation: created.id });
    for (const invalid of [null, "false", 0, {}, () => false]) {
      expect(() =>
        createTakoformV2Engine({
          ...f.options,
          allowFreshCreateAndUpdate: invalid,
        } as unknown as V2EngineOptions),
      ).toThrow("allowFreshCreateAndUpdate must be a boolean");
    }
  } finally {
    f.close();
  }
});

test("fresh admission core: retained replay and lost-ACK recovery keep identity", async () => {
  const f = await fixture({ loseAck: true });
  try {
    const request = {
      principal: PRINCIPAL,
      key: "fresh-fixture-original-create",
      input: { form: FORM, name: "lost-ack", space: SPACE, spec: { value: "original" } },
    };
    const accepted = await f.engine.acceptCreate(request);
    expect(await f.engine.runNext()).toMatchObject({ id: accepted.id, status: "reconciling" });
    const closed = f.reopenRetained();
    const before = f.batches.length;
    expect(await closed.acceptCreate(request)).toMatchObject({
      id: accepted.id,
      resourceUid: accepted.resourceUid,
    });
    expect(f.batches).toHaveLength(before);
    await expect(
      closed.acceptCreate({ ...request, input: { ...request.input, spec: { value: "drift" } } }),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    f.advance();
    expect(await closed.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
    const update = {
      principal: PRINCIPAL,
      key: "fresh-fixture-original-update",
      uid: accepted.resourceUid,
      expectedGeneration: 1,
      spec: { value: "original" },
    };
    const updated = await f.engine.acceptUpdate(update);
    expect(await closed.acceptUpdate(update)).toMatchObject({ id: updated.id });
    await expect(
      closed.acceptUpdate({ ...update, spec: { value: "drift" } }),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(await closed.runNext()).toMatchObject({ id: updated.id, status: "succeeded" });
    expect(f.effects.filter(({ operation }) => operation === accepted.id)).toEqual([
      { mode: "execute", operation: accepted.id, action: "create" },
      { mode: "reconcile", operation: accepted.id, action: "create" },
    ]);
  } finally {
    f.close();
  }
});

test("fresh admission core: retained DELETE keeps dependency and backend fences", async () => {
  const f = await fixture();
  try {
    const target = await f.create("target");
    await f.engine.runNext();
    const referrer = await f.create("referrer", {
      value: "referrer",
      dependency: target.resourceUid,
    });
    await f.engine.runNext();
    const closed = f.reopenRetained();
    await expect(
      closed.acceptDelete({
        principal: PRINCIPAL,
        key: "fresh-fixture-fenced-delete",
        uid: target.resourceUid,
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
    const form = f.options.forms[FORM];
    if (!form) throw new Error("fixture Form missing");
    const changedBackend = f.reopen(false, {
      ...form,
      backend: { ...form.backend, targetKey: "replacement-target" },
    });
    await expect(
      changedBackend.acceptDelete({
        principal: PRINCIPAL,
        key: "fresh-fixture-wrong-target-delete",
        uid: referrer.resourceUid,
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "temporarily_unavailable", status: 503 });
    const changedIdentity = f.reopen(false, {
      ...form,
      backend: { ...form.backend, id: "replacement-backend" },
    });
    await expect(
      changedIdentity.acceptDelete({
        principal: PRINCIPAL,
        key: "fresh-fixture-wrong-backend-delete",
        uid: referrer.resourceUid,
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "temporarily_unavailable", status: 503 });
    const deletion = {
      principal: PRINCIPAL,
      key: "fresh-fixture-referrer-delete",
      uid: referrer.resourceUid,
      expectedGeneration: 1,
    };
    const removed = await closed.acceptDelete(deletion);
    expect(await closed.runNext()).toMatchObject({ id: removed.id, status: "succeeded" });
    expect(await closed.acceptDelete(deletion)).toMatchObject({ id: removed.id });
    const targetRemoved = await closed.acceptDelete({
      principal: PRINCIPAL,
      key: "fresh-fixture-target-delete",
      uid: target.resourceUid,
      expectedGeneration: 1,
    });
    expect(await closed.runNext()).toMatchObject({ id: targetRemoved.id, status: "succeeded" });
  } finally {
    f.close();
  }
});

test("fresh admission core: original private input replenishment remains available", async () => {
  const f = await fixture({ privateInputs: true });
  try {
    const request = {
      principal: PRINCIPAL,
      key: "fresh-fixture-private-create",
      input: {
        form: FORM,
        name: "private",
        space: SPACE,
        spec: { value: "original" },
        privateInputs: { TOKEN: "fixture-only-original-value" },
      },
    };
    const accepted = await f.engine.acceptCreate(request);
    f.advance(301_000);
    const closed = f.reopenRetained();
    expect(await closed.acceptCreate(request)).toMatchObject({ id: accepted.id });
    await expect(
      closed.acceptCreate({
        ...request,
        input: {
          ...request.input,
          privateInputs: { TOKEN: "different-fixture-value" },
        },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(await closed.runNext()).toMatchObject({ id: accepted.id, status: "waiting_input" });
    await expect(
      closed.replenishPrivateInputs({
        principal: PRINCIPAL,
        id: accepted.id,
        privateInputs: { TOKEN: "different-fixture-value" },
      }),
    ).rejects.toMatchObject({ code: "private_inputs_conflict", status: 409 });
    expect(
      await closed.replenishPrivateInputs({
        principal: PRINCIPAL,
        id: accepted.id,
        privateInputs: { TOKEN: "fixture-only-original-value" },
      }),
    ).toMatchObject({ id: accepted.id });
    expect(await closed.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
    expect(f.effects).toEqual([{ mode: "execute", operation: accepted.id, action: "create" }]);
  } finally {
    f.close();
  }
});

test("fresh admission application: automatic artifact Forms honor policy", async () => {
  const { createTakoformV2Application } = await import("../src/takoform-v2/application.ts");
  const { createMemoryObjectStore } = await import("../src/objects-mem.ts");
  const { WORKER_BUNDLE_FORM_URL } = await import("../src/takoform-v2/forms/worker-bundle.ts");
  const { STATIC_ASSET_BUNDLE_FORM_URL } = await import(
    "../src/takoform-v2/forms/static-asset-bundle.ts"
  );
  const { SQLITE_MIGRATION_SET_FORM_URL, SQLITE_MIGRATION_SET_FORM_URL_0_2_0 } = await import(
    "../src/takoform-v2/forms/sqlite-migration-set.ts"
  );
  for (const admission of [undefined, true, false]) {
    const database = new Database(":memory:");
    migrateSqlite(database);
    const memory = createMemoryObjectStore();
    let objectReads = 0;
    const objects = {
      ...memory,
      get: async (key: string) => {
        objectReads += 1;
        return await memory.get(key);
      },
    };
    try {
      const host = createTakoformV2Application({
        sql: createSqliteSql(database),
        objects,
        accounts: {
          authenticate: async () => ({
            kind: "api_key",
            principalId: "fixture-owner",
            hostPrincipalId: "fixture-key",
            organizationId: SPACE,
            scopes: ["resources:write"],
          }),
          requireOwner: async () => {
            throw new Error("API key fixture must not require session ownership");
          },
        },
        publicOrigin: ORIGIN,
        config: {
          cursorSigningKey: new Uint8Array(32).fill(0x42),
          documentation: "https://docs.example.test/forms",
          authenticationDocumentation: "https://docs.example.test/auth",
          workerBundle: { targetKey: "fixture-bundle", heldArtifacts: [] },
          staticAssetBundle: { targetKey: "fixture-assets", heldArtifacts: [] },
          sqliteMigrationSet: { targetKey: "fixture-migrations", heldArtifacts: [] },
        },
        clock: () => new Date(),
        ...(admission === undefined ? {} : { allowFreshCreateAndUpdate: admission }),
      });
      const forms = [
        WORKER_BUNDLE_FORM_URL,
        STATIC_ASSET_BUNDLE_FORM_URL,
        SQLITE_MIGRATION_SET_FORM_URL,
      ];
      const retainedSupport = await host.fetch(
        new Request(
          `${ORIGIN}/apis/forms.takoform.com/v2/support?form=${encodeURIComponent(SQLITE_MIGRATION_SET_FORM_URL_0_2_0)}`,
        ),
      );
      expect(await retainedSupport?.json()).toMatchObject({
        form: SQLITE_MIGRATION_SET_FORM_URL_0_2_0,
        supported: false,
      });
      for (const [index, form] of forms.entries()) {
        const support = await host.fetch(
          new Request(
            `${ORIGIN}/apis/forms.takoform.com/v2/support?form=${encodeURIComponent(form)}`,
          ),
        );
        expect(await support?.json()).toMatchObject({ form, supported: admission !== false });
        const result = await host.fetch(
          new Request(`${ORIGIN}/apis/forms.takoform.com/v2/resources`, {
            method: "POST",
            headers: {
              authorization: "Bearer fixture-only",
              "content-type": "application/json",
              "idempotency-key": `fresh-artifact-fixture-${index}`,
              "x-environment": "integration",
            },
            body: JSON.stringify({
              form,
              space: SPACE,
              name: `artifact-${index}`,
              spec: {
                artifact: {
                  url: "https://artifacts.example.test/manifest.json",
                  sha256: "a".repeat(64),
                },
              },
            }),
          }),
        );
        expect(result?.status).toBe(admission === false ? 422 : 202);
        if (admission === false)
          expect(await result?.json()).toMatchObject({ code: "unsupported_form" });
      }
      expect(objectReads).toBe(0);
    } finally {
      database.close();
    }
  }
});
