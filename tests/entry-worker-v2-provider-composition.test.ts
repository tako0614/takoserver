import { expect, test } from "bun:test";
import { createWorkerEntry, type WorkerEnv } from "@takoserver/core/worker-entry";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { bytesDigest } from "../src/json.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const ORIGIN = "https://api.worker-composition.test";
const BASE = `${ORIGIN}/apis/forms.takoform.com/v2`;
const FORM = "https://forms.example.test/fixture/WorkerEntryResource/1.0.0";
const ORG = "org-worker-composition";
const TOKEN = "worker-composition-fixture-token";

function splitMigration(source: string): readonly string[] {
  const statements: string[] = [];
  let rest = source.replace(/^\s*--.*$/gmu, "").trim();
  while (rest.length > 0) {
    if (/^CREATE\s+(?:TEMP\s+)?TRIGGER\b/iu.test(rest)) {
      const end = /^END\s*;/imu.exec(rest);
      if (!end || end.index === undefined) throw new Error("incomplete migration trigger");
      const boundary = end.index + end[0].length;
      statements.push(rest.slice(0, boundary).trim());
      rest = rest.slice(boundary).trim();
      continue;
    }
    const boundary = rest.indexOf(";");
    if (boundary < 0) {
      statements.push(rest);
      break;
    }
    const statement = rest.slice(0, boundary).trim();
    if (statement) statements.push(statement);
    rest = rest.slice(boundary + 1).trim();
  }
  return statements;
}

async function fixture(name: string): Promise<{ runtime: Miniflare; env: WorkerEnv }> {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name,
          type: "worker",
          compatibilityDate: "2026-08-17",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('fixture') } }",
              },
            },
          },
          env: {
            STATE_DB: { type: "d1", id: name },
            OBJECTS: { type: "r2", name },
          },
          triggers: [],
        },
      },
    ],
  });
  const database = await runtime.getD1Database("STATE_DB");
  for (const migration of MIGRATIONS) {
    for (const statement of splitMigration(migration.sql)) await database.prepare(statement).run();
  }
  const sql = createD1Sql(database);
  const now = new Date().toISOString();
  await sql.run("INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)", [
    ORG,
    "Worker composition",
    "principal-worker-composition",
    now,
  ]);
  await sql.run(
    "INSERT INTO auth_tokens (secret_digest, id, kind, principal_id, org_id, name, scopes_json, created_at, expires_at, revoked_at) VALUES (?, ?, 'api_key', ?, ?, ?, ?, ?, ?, NULL)",
    [
      await bytesDigest(new TextEncoder().encode(TOKEN)),
      "key-worker-composition",
      "principal-worker-composition",
      ORG,
      "writer",
      JSON.stringify(["resources:write"]),
      now,
      new Date(Date.now() + 3_600_000).toISOString(),
    ],
  );
  const env = {
    STATE_DB: database,
    OBJECTS: await runtime.getR2Bucket("OBJECTS"),
    WORKER_VERSION: { id: "00000000-0000-4000-8000-0000000000a1" },
    PUBLIC_ORIGIN: ORIGIN,
    TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
    }),
    TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: "A".repeat(43),
  } as WorkerEnv;
  return { runtime, env };
}

const request = (
  entry: ReturnType<typeof createWorkerEntry>,
  env: WorkerEnv,
  path: string,
  init: RequestInit = {},
) =>
  entry.fetch(
    new Request(`${BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    }),
    env,
  );

function completeForm(): V2Form {
  return {
    validateCreate() {},
    validateUpdate() {},
    backend: {
      id: "fixture-worker-entry-backend",
      targetKey: "fixture-worker-entry-target",
      async execute() {
        return { kind: "complete", observed: {}, output: {} };
      },
      async reconcile() {
        return { kind: "complete", observed: {}, output: {} };
      },
    },
  };
}

test("selected v2 Form uses the normal Worker fetch and scheduled Host executor", async () => {
  const { runtime, env } = await fixture("v2-entry-composed-form");
  try {
    let compositions = 0;
    let effects = 0;
    const form: V2Form = {
      validateCreate(spec) {
        if (typeof spec.value !== "string") throw new TypeError("value is required");
      },
      validateUpdate(_previous, spec) {
        if (typeof spec.value !== "string") throw new TypeError("value is required");
      },
      backend: {
        id: "fixture-worker-entry-backend",
        targetKey: "fixture-worker-entry-target",
        async execute(input) {
          effects += 1;
          return { kind: "complete", observed: { value: input.spec.value ?? null }, output: {} };
        },
        async reconcile(input) {
          return { kind: "complete", observed: { value: input.spec.value ?? null }, output: {} };
        },
      },
    };
    const entry = createWorkerEntry({
      async composeV2Forms(context) {
        compositions += 1;
        expect(context.env).toBe(env);
        expect((await context.sql.query("SELECT name FROM orgs WHERE id = ?", [ORG]))[0]).toEqual({
          name: "Worker composition",
        });
        return { [FORM]: form };
      },
    });
    const support = await request(entry, env, `/support?form=${encodeURIComponent(FORM)}`);
    expect(support.status).toBe(200);
    expect(await support.json()).toMatchObject({ form: FORM, supported: true });
    expect(compositions).toBe(1);
    expect(effects).toBe(0);
    const created = await request(entry, env, "/resources", {
      method: "POST",
      headers: { "idempotency-key": "worker-composed-create-0001" },
      body: JSON.stringify({ form: FORM, space: ORG, name: "composed", spec: { value: "one" } }),
    });
    expect(created.status).toBe(202);
    const accepted = (await created.json()) as { id: string; resourceUid: string };
    expect(effects).toBe(0);
    await entry.scheduled({}, env);
    expect(effects).toBe(1);
    const operation = await request(entry, env, `/operations/${accepted.id}`);
    expect(await operation.json()).toMatchObject({ status: "succeeded", effect: "complete" });
    const resource = await request(entry, env, `/resources/${accepted.resourceUid}`);
    expect(await resource.json()).toMatchObject({ observed: { value: "one" } });
    const updated = await request(entry, env, `/resources/${accepted.resourceUid}`, {
      method: "PUT",
      headers: {
        "idempotency-key": "worker-composed-update-0001",
        "takoform-expected-generation": "1",
      },
      body: JSON.stringify({ spec: { value: "two" } }),
    });
    expect(updated.status).toBe(202);
    const updateOperation = (await updated.json()) as { id: string };
    await entry.scheduled({}, env);
    expect(
      await (await request(entry, env, `/operations/${updateOperation.id}`)).json(),
    ).toMatchObject({
      status: "succeeded",
      effect: "complete",
    });
    expect(
      await (await request(entry, env, `/resources/${accepted.resourceUid}`)).json(),
    ).toMatchObject({
      observed: { value: "two" },
    });
    const deleted = await request(entry, env, `/resources/${accepted.resourceUid}`, {
      method: "DELETE",
      headers: {
        "idempotency-key": "worker-composed-delete-0001",
        "takoform-expected-generation": "2",
      },
    });
    expect(deleted.status).toBe(202);
    const deleteOperation = (await deleted.json()) as { id: string };
    await entry.scheduled({}, env);
    expect(
      await (await request(entry, env, `/operations/${deleteOperation.id}`)).json(),
    ).toMatchObject({
      status: "succeeded",
      effect: "complete",
    });
    expect((await request(entry, env, `/resources/${accepted.resourceUid}`)).status).toBe(410);
    expect(effects).toBe(3);
    expect(compositions).toBe(1);
  } finally {
    await runtime.dispose();
  }
}, 120_000);

test("Worker entry composes retained-only Forms without claiming public support", async () => {
  const { runtime, env } = await fixture("v2-entry-retained-form");
  try {
    const full = createWorkerEntry({ composeV2Forms: () => ({ [FORM]: completeForm() }) });
    const body = { form: FORM, space: ORG, name: "retained", spec: { value: "one" } };
    const created = await request(full, env, "/resources", {
      method: "POST",
      headers: { "idempotency-key": "worker-retained-create-0001" },
      body: JSON.stringify(body),
    });
    expect(created.status).toBe(202);
    const accepted = (await created.json()) as { id: string; resourceUid: string };

    const retained = createWorkerEntry({
      composeV2Forms: () => ({
        forms: {},
        retainedForms: {
          [FORM]: {
            ...completeForm(),
            validateCreate() {
              throw new Error("retained Form cannot accept a fresh create");
            },
            validateUpdate() {
              throw new Error("retained Form cannot accept a fresh update");
            },
          },
        },
      }),
    });
    const support = await request(retained, env, `/support?form=${encodeURIComponent(FORM)}`);
    expect(await support.json()).toEqual({
      form: FORM,
      supported: false,
      operations: [],
      privateInputs: false,
    });
    const replay = await request(retained, env, "/resources", {
      method: "POST",
      headers: { "idempotency-key": "worker-retained-create-0001" },
      body: JSON.stringify(body),
    });
    expect((await replay.json()).id).toBe(accepted.id);
    const fresh = await request(retained, env, "/resources", {
      method: "POST",
      headers: { "idempotency-key": "worker-retained-create-0002" },
      body: JSON.stringify({ ...body, name: "new" }),
    });
    expect(fresh.status).toBe(422);
    expect((await fresh.json()).code).toBe("unsupported_form");
    await retained.scheduled({}, env);
    expect(await (await request(retained, env, `/operations/${accepted.id}`)).json()).toMatchObject(
      {
        status: "succeeded",
      },
    );
    expect((await request(retained, env, `/resources/${accepted.resourceUid}`)).status).toBe(200);
  } finally {
    await runtime.dispose();
  }
}, 120_000);

test("Worker entry factories do not share Form maps for the same Env", async () => {
  const { runtime, env } = await fixture("v2-entry-instance-isolation");
  try {
    const selected: Record<string, V2Form> = { [FORM]: completeForm() };
    const options: { composeV2Forms: () => Readonly<Record<string, V2Form>> } = {
      composeV2Forms: () => selected,
    };
    const withForm = createWorkerEntry(options);
    options.composeV2Forms = () => ({});
    const withoutForm = createWorkerEntry();
    const first = await request(withForm, env, `/support?form=${encodeURIComponent(FORM)}`);
    expect(await first.json()).toMatchObject({ supported: true });
    delete selected[FORM];
    const again = await request(withForm, env, `/support?form=${encodeURIComponent(FORM)}`);
    expect(await again.json()).toMatchObject({ supported: true });
    const other = await request(withoutForm, env, `/support?form=${encodeURIComponent(FORM)}`);
    expect(await other.json()).toMatchObject({ supported: false });
  } finally {
    await runtime.dispose();
  }
}, 120_000);

test("concurrent fetch and scheduled startup share one Form snapshot", async () => {
  const { runtime, env } = await fixture("v2-entry-concurrent-startup");
  try {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const entry = createWorkerEntry({
      async composeV2Forms() {
        calls += 1;
        await gate;
        return { [FORM]: completeForm() };
      },
    });
    const fetchPromise = request(entry, env, `/support?form=${encodeURIComponent(FORM)}`);
    const scheduledPromise = entry.scheduled({}, env);
    await Bun.sleep(0);
    expect(calls).toBe(1);
    release?.();
    const [support] = await Promise.all([fetchPromise, scheduledPromise]);
    expect(await support.json()).toMatchObject({ supported: true });
    expect(calls).toBe(1);
  } finally {
    await runtime.dispose();
  }
}, 120_000);

test("a failed Form composition is not cached and does not disclose its exception", async () => {
  const { runtime, env } = await fixture("v2-entry-failed-composition");
  try {
    let attempts = 0;
    const entry = createWorkerEntry({
      composeV2Forms() {
        attempts += 1;
        if (attempts === 1) throw new Error("private fixture diagnostic must not be returned");
        return { [FORM]: completeForm() };
      },
    });
    const first = await request(entry, env, `/support?form=${encodeURIComponent(FORM)}`);
    expect(first.status).toBe(503);
    const refusal = await first.text();
    expect(refusal).toContain("runtime-configuration");
    expect(refusal).not.toContain("private fixture diagnostic");
    const retry = await request(entry, env, `/support?form=${encodeURIComponent(FORM)}`);
    expect(await retry.json()).toMatchObject({ supported: true });
    expect(attempts).toBe(2);
    const typedFailure = createWorkerEntry({
      composeV2Forms() {
        throw new TypeError("private type diagnostic must not be returned");
      },
    });
    const typed = await request(typedFailure, env, `/support?form=${encodeURIComponent(FORM)}`);
    expect(typed.status).toBe(503);
    expect(await typed.text()).not.toContain("private type diagnostic");
  } finally {
    await runtime.dispose();
  }
}, 120_000);

test("malformed and duplicate selected Form maps refuse startup", async () => {
  const { runtime, env } = await fixture("v2-entry-invalid-form-map");
  try {
    const malformed = createWorkerEntry({
      composeV2Forms: () => new Map() as unknown as Record<string, V2Form>,
    });
    const invalid = await request(malformed, env, `/support?form=${encodeURIComponent(FORM)}`);
    expect(invalid.status).toBe(503);
    const invalidRefusal = await invalid.text();
    expect(invalidRefusal).toContain("runtime-configuration");
    expect(invalidRefusal).not.toContain("plain exact Form map");
    const missing = createWorkerEntry({
      composeV2Forms: () => undefined as unknown as Record<string, V2Form>,
    });
    const absent = await request(missing, env, `/support?form=${encodeURIComponent(FORM)}`);
    expect(absent.status).toBe(503);
    const getter = createWorkerEntry({
      composeV2Forms: () => ({
        [FORM]: {
          get validateCreate(): V2Form["validateCreate"] {
            throw new TypeError("private-secret-must-not-leak");
          },
          validateUpdate() {},
          backend: completeForm().backend,
        },
      }),
    });
    const getterFailure = await request(getter, env, `/support?form=${encodeURIComponent(FORM)}`);
    expect(getterFailure.status).toBe(503);
    expect(await getterFailure.text()).not.toContain("private-secret-must-not-leak");
    const withBuiltin = {
      ...env,
      TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
        workerBundle: { targetKey: "built-in-worker-bundle", heldArtifacts: [] },
      }),
    } as WorkerEnv;
    const duplicate = createWorkerEntry({
      composeV2Forms: () => ({ [WORKER_BUNDLE_FORM_URL]: completeForm() }),
    });
    const rejected = await request(
      duplicate,
      withBuiltin,
      `/support?form=${encodeURIComponent(WORKER_BUNDLE_FORM_URL)}`,
    );
    expect(rejected.status).toBe(503);
    const duplicateRefusal = await rejected.text();
    expect(duplicateRefusal).toContain("runtime-configuration");
    expect(duplicateRefusal).not.toContain("duplicate v2 Form URL");
    const overlap = createWorkerEntry({
      composeV2Forms: () => ({
        forms: { [FORM]: completeForm() },
        retainedForms: { [FORM]: completeForm() },
      }),
    });
    expect((await request(overlap, env, `/support?form=${encodeURIComponent(FORM)}`)).status).toBe(
      503,
    );
    const extra = createWorkerEntry({
      composeV2Forms: () =>
        ({ forms: {}, retainedForms: {}, unexpected: completeForm() }) as unknown as Record<
          string,
          V2Form
        >,
    });
    expect((await request(extra, env, `/support?form=${encodeURIComponent(FORM)}`)).status).toBe(
      503,
    );
    const invalidRetainedUrl = createWorkerEntry({
      composeV2Forms: () => ({
        forms: {},
        retainedForms: { "not-a-form-url": completeForm() },
      }),
    });
    expect(
      (await request(invalidRetainedUrl, env, `/support?form=${encodeURIComponent(FORM)}`)).status,
    ).toBe(503);
  } finally {
    await runtime.dispose();
  }
}, 120_000);
