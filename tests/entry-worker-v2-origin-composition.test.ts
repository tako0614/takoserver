/**
 * Actual public createWorkerEntry with local Miniflare D1/R2 and account rows.
 * This fixture Form is not the private Endpoint/native publisher. Shared DDL is
 * UNALLOCATED test-only preparation, not migration/adoption/PR376 qualification.
 */
import { expect, test } from "bun:test";
import {
  createWorkerEntry,
  type WorkerEntryOptions,
  type WorkerEnv,
} from "@takoserver/core/worker-entry";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { bytesDigest } from "../src/json.ts";
import type { SqlParam, SqlStatement } from "../src/ports.ts";
import { createSharedAppLedgerD1 } from "../src/shared-app-ledger-d1.ts";
import { createD1Sql, type D1DatabaseLike, type D1StatementLike } from "../src/sql-d1.ts";
import { claimFreshStripeModeRealm } from "../src/stripe-mode-realm.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const ORIGIN = "https://api.worker-origin-composition.test";
const BASE = `${ORIGIN}/apis/forms.takoform.com/v2`;
const FORM = "https://forms.example.test/fixture/WorkerOriginComposition/1.0.0";
const BACKEND = "fixture-worker-origin-backend";
const TARGET = "fixture-worker-origin-target";
const ORG = "org-worker-origin-composition";
const TOKEN = "worker-origin-composition-public-test-token";
const BINDINGS = "shared_app_staging_endpoint_bindings";
type Composer = NonNullable<WorkerEntryOptions["composeV2WorkerEndpointOrigin"]>;
type Selection = Exclude<Awaited<ReturnType<Composer>>, undefined>;

// Same unchanged SQL fixture constraints, collected for actual D1 execution.
function sharedSchema(db: { exec(source: string): void }, includeBindings: boolean): void {
  // Preserve the stronger original ledger fixture checks, not the relaxed route fixture.
  for (const realm of ["staging", "production"]) {
    const prefix = `shared_app_${realm}`;
    db.exec(`CREATE TABLE ${prefix}_assignments (
      incarnation TEXT PRIMARY KEY
        CHECK(length(incarnation)=32 AND incarnation NOT GLOB '*[^0-9a-f]*'),
      name TEXT NOT NULL
        CHECK(length(name) BETWEEN 3 AND 32 AND name NOT GLOB '*[^a-z0-9-]*'),
      organization_id TEXT NOT NULL,
      product TEXT NOT NULL CHECK(product IN ('takoserver','takosumi-hosted')),
      reservation_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740990),
      state TEXT NOT NULL CHECK(state IN ('reserved','active','released')),
      script TEXT, released_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(organization_id,reservation_id), CHECK(updated_at>=created_at),
      CHECK((state='released')=(released_at IS NOT NULL)),
      CHECK(released_at IS NULL OR released_at>=created_at),
      CHECK(state<>'reserved' OR script IS NULL), CHECK(state<>'active' OR script IS NOT NULL))`);
    db.exec(`CREATE TABLE ${prefix}_names (
      normalized_name TEXT PRIMARY KEY
        CHECK(length(normalized_name) BETWEEN 3 AND 32
          AND normalized_name NOT GLOB '*[^a-z0-9-]*'),
      incarnation TEXT NOT NULL REFERENCES ${prefix}_assignments(incarnation),
      generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740990),
      state TEXT NOT NULL CHECK(state IN ('reserved','active','released')),
      released_at INTEGER, updated_at INTEGER NOT NULL,
      CHECK((state='released')=(released_at IS NOT NULL)))`);
  }
  if (!includeBindings) return;
  // Fixture-only operation FKs: current Core retains operation rows; it has no GC DELETE.
  // A future retention/GC policy must preserve the historical create witness explicitly.
  db.exec(`CREATE TABLE ${BINDINGS} (
    incarnation TEXT PRIMARY KEY REFERENCES shared_app_staging_assignments(incarnation),
    organization_id TEXT NOT NULL, product TEXT NOT NULL, reservation_id TEXT NOT NULL,
    name TEXT NOT NULL,
    endpoint_uid TEXT NOT NULL UNIQUE REFERENCES tf_v2_resources(uid),
    endpoint_generation INTEGER NOT NULL CHECK(endpoint_generation>=1),
    form_url TEXT NOT NULL, backend_id TEXT NOT NULL, target_key TEXT NOT NULL,
    create_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id),
    current_operation_id TEXT NOT NULL REFERENCES tf_v2_operations(id))`);
}

// Same trigger-aware canonical migration fixture mechanism as the existing
// Worker Form composition suite. It is not a custom schema writer or loader.
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

async function fixture(name: string, shared = true) {
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
          env: { STATE_DB: { type: "d1", id: name }, OBJECTS: { type: "r2", name } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    for (const migration of MIGRATIONS) {
      for (const statement of splitMigration(migration.sql))
        await database.prepare(statement).run();
    }
    const nativeStatements = new WeakMap<D1StatementLike, ReturnType<typeof database.prepare>>();
    const statementInputs = new WeakMap<D1StatementLike, SqlStatement>();
    const coreBatches: (readonly SqlStatement[])[] = [];
    let coreBatchError: unknown;
    const observe = (
      native: ReturnType<typeof database.prepare>,
      query: string,
      params: readonly SqlParam[] = [],
    ): D1StatementLike => {
      const statement: D1StatementLike = {
        bind(...values) {
          return observe(native.bind(...values), query, values);
        },
        async all() {
          return await native.all<Record<string, unknown>>();
        },
      };
      nativeStatements.set(statement, native);
      statementInputs.set(statement, { sql: query, params: [...params] });
      return statement;
    };
    // Transport observer only: every statement/result/error is delegated to
    // the real Miniflare D1 binding; it cannot fabricate a Core Sql result.
    const observedDatabase: D1DatabaseLike = {
      prepare: (query) => observe(database.prepare(query), query),
      async batch(statements) {
        const native = statements.map((statement) => {
          const value = nativeStatements.get(statement);
          if (!value) throw new Error("foreign fixture statement");
          return value;
        });
        coreBatches.push(
          statements.map((statement) => {
            const input = statementInputs.get(statement);
            if (!input) throw new Error("missing actual fixture statement input");
            return input;
          }),
        );
        coreBatchError = undefined;
        try {
          return await database.batch<Record<string, unknown>>(native);
        } catch (error) {
          coreBatchError = error;
          throw error;
        }
      },
    };
    const sql = createD1Sql(database);
    if (shared) {
      const statements: string[] = [];
      sharedSchema(
        {
          exec(source) {
            statements.push(source);
          },
        },
        true,
      );
      for (const statement of statements) await sql.run(statement);
    }
    await claimFreshStripeModeRealm(sql, "test");
    const now = new Date().toISOString();
    await sql.run(
      "INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)",
      [ORG, "Worker origin component", "principal-worker-origin-component", now],
    );
    // Real account access authenticates this actual digest row on every HTTP request.
    await sql.run(
      "INSERT INTO auth_tokens (secret_digest, id, kind, principal_id, org_id, name, scopes_json, created_at, expires_at, revoked_at) VALUES (?, ?, 'api_key', ?, ?, ?, ?, ?, ?, NULL)",
      [
        await bytesDigest(new TextEncoder().encode(TOKEN)),
        "key-worker-origin-component",
        "principal-worker-origin-component",
        ORG,
        "writer",
        JSON.stringify(["resources:write"]),
        now,
        new Date(Date.now() + 3_600_000).toISOString(),
      ],
    );
    const env = {
      STATE_DB: observedDatabase,
      OBJECTS: await runtime.getR2Bucket("OBJECTS"),
      WORKER_VERSION: { id: "00000000-0000-4000-8000-0000000000a2" },
      PUBLIC_ORIGIN: ORIGIN,
      TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
      }),
      TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: "A".repeat(43),
    } as WorkerEnv;
    // Genuine existing ledger adapter opens first-primary sessions; no fallback.
    const ledger = createSharedAppLedgerD1({ database, environment: "staging" });
    const selection: Selection = { formUrl: FORM, backendId: BACKEND, targetKey: TARGET, ledger };
    let effects = 0;
    const form: V2Form = {
      validateCreate() {},
      validateUpdate() {},
      initialOutput({ resourceUid }) {
        return { hostname: `ordinary-${resourceUid}.example.test` };
      },
      backend: {
        id: BACKEND,
        targetKey: TARGET,
        async execute(input) {
          effects++;
          return { kind: "complete", observed: {}, output: input.previousOutput };
        },
        async reconcile(input) {
          return { kind: "complete", observed: {}, output: input.previousOutput };
        },
      },
    };
    const owner = { organizationId: ORG, product: "takoserver" as const };
    return {
      runtime,
      env,
      sql,
      ledger,
      selection,
      form,
      owner,
      coreBatches,
      coreBatchError: () => coreBatchError,
      effects: () => effects,
      reserve: (name: string) =>
        ledger.forTrustedOwner(owner).reserve({ reservationId: `claim-${name}`, name }),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
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

const create = (
  entry: ReturnType<typeof createWorkerEntry>,
  env: WorkerEnv,
  name: string,
  key: string,
) =>
  request(entry, env, "/resources", {
    method: "POST",
    headers: { "idempotency-key": key },
    body: JSON.stringify({ form: FORM, space: ORG, name, spec: {} }),
  });

function deferred() {
  let release: () => void = () => {
    throw new Error("uninitialized fixture gate");
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

test("Worker captures code-only composer once and binds through real D1 on concurrent startup", async () => {
  const f = await fixture("entry-origin-construction");
  const entered = deferred();
  const gate = deferred();
  let starting: Promise<Response> | undefined;
  let scheduled: Promise<void> | undefined;
  try {
    const claim = await f.reserve("worker-bound");
    let optionReads = 0;
    let compositions = 0;
    let fieldReads = 0;
    let forbiddenReads = 0;
    const mutable = { ...f.selection };
    const selected = Object.defineProperties(
      {},
      Object.fromEntries(
        Object.keys(mutable).map((key) => [
          key,
          {
            enumerable: true,
            get() {
              fieldReads++;
              return mutable[key as keyof Selection];
            },
          },
        ]),
      ),
    ) as Selection;
    for (const key of ["sql", "prepare", "assertSql", "initialOutput", "result"]) {
      Object.defineProperty(selected, key, {
        get() {
          forbiddenReads++;
          throw new Error("not a permitted constructor field");
        },
      });
    }
    const compose: Composer = async (context) => {
      compositions++;
      expect(Object.keys(context).sort()).toEqual(["clock", "env"]);
      expect(Object.isFrozen(context)).toBe(true);
      expect(context.env).toBe(f.env);
      expect(context.clock()).toBeInstanceOf(Date);
      entered.release();
      await gate.promise;
      return selected;
    };
    const options: WorkerEntryOptions = {
      composeV2Forms: () => ({ [FORM]: f.form }),
      get composeV2WorkerEndpointOrigin() {
        optionReads++;
        return compose;
      },
    };
    const entry = createWorkerEntry(options);
    expect(optionReads).toBe(1);
    Object.defineProperty(options, "composeV2WorkerEndpointOrigin", {
      get() {
        throw new Error("options reread");
      },
    });
    starting = request(entry, f.env, `/support?form=${encodeURIComponent(FORM)}`);
    await Promise.race([
      entered.promise,
      starting.then(async (response) => {
        if (compositions === 0) {
          throw new Error(
            `public Worker startup settled before origin composition (${response.status}): ${await response.text()}`,
          );
        }
      }),
    ]);
    scheduled = entry.scheduled({}, f.env);
    gate.release();
    expect((await starting).status).toBe(200);
    await scheduled;
    expect(compositions).toBe(1);
    expect(fieldReads).toBe(4);
    mutable.formUrl = "https://forms.example.test/replaced/1.0.0";
    mutable.backendId = "replaced";
    mutable.targetKey = "replaced";
    const response = await create(entry, f.env, claim.name, "worker-origin-create-0001");
    expect(response.status).toBe(202);
    const operation = (await response.json()) as { id: string; resourceUid: string };
    expect(await f.sql.query(`SELECT * FROM ${BINDINGS}`)).toEqual([
      {
        incarnation: claim.incarnation,
        organization_id: ORG,
        product: "takoserver",
        reservation_id: claim.reservationId,
        name: claim.name,
        endpoint_uid: operation.resourceUid,
        endpoint_generation: 1,
        form_url: FORM,
        backend_id: BACKEND,
        target_key: TARGET,
        create_operation_id: operation.id,
        current_operation_id: operation.id,
      },
    ]);
    expect(
      await (await request(entry, f.env, `/resources/${operation.resourceUid}`)).json(),
    ).toMatchObject({
      output: {
        hostname: `${claim.name}.app-staging.takos.jp`,
        url: `https://${claim.name}.app-staging.takos.jp/`,
      },
    });
    expect(compositions).toBe(1);
    expect(fieldReads).toBe(4);
    expect(forbiddenReads).toBe(0);
    expect(f.effects()).toBe(0);
    expect(await f.ledger.forTrustedOwner(f.owner).readOriginal(claim.reservationId)).toEqual(
      claim,
    );
    const beforeRefusalBatches = f.coreBatches.length;
    const refused = await create(entry, f.env, "no-claim", "worker-origin-missing-0001");
    // Existing unselected internal proof-error propagation only. HTTP500 alone
    // does not prove nonacceptance or qualify public reservation error policy.
    expect(refused.status).toBe(500);
    expect(await refused.json()).toMatchObject({ code: "internal_error" });
    expect(f.coreBatches).toHaveLength(beforeRefusalBatches + 1);
    const constraint = f.coreBatchError();
    expect(constraint).toBeInstanceOf(Error);
    if (!(constraint instanceof Error)) throw new Error("missing actual D1 constraint error");
    expect(constraint.message).toContain(`${BINDINGS}.reservation_id`);
    const failedBatch = f.coreBatches.at(-1);
    expect(failedBatch?.at(-1)?.sql).toContain("WITH host_form_admission AS");
    expect(failedBatch?.at(-1)?.sql).toContain(`INSERT INTO ${BINDINGS}`);
    expect(failedBatch?.at(-1)?.params).toContain(ORG);
    expect(failedBatch?.every((statement) => (statement.params?.length ?? 0) <= 100)).toBe(true);
    for (const [table, count] of [
      ["tf_v2_resources", 1],
      ["tf_v2_operations", 1],
      [BINDINGS, 1],
      ["tf_v2_private_inputs", 0],
      ["tf_v2_configured_private_inputs", 0],
      ["tf_v2_operation_reference_sets", 0],
      ["tf_v2_operation_references", 0],
      ["tf_v2_resource_references", 0],
    ] as const) {
      expect(await f.sql.query(`SELECT count(*) AS n FROM ${table}`)).toEqual([{ n: count }]);
    }
    expect(
      await f.sql.query("SELECT id FROM tf_v2_operations WHERE replay_key = ?", [
        "worker-origin-missing-0001",
      ]),
    ).toEqual([]);
    expect(
      await f.sql.query("SELECT uid FROM tf_v2_resources WHERE name = ?", ["no-claim"]),
    ).toEqual([]);
    expect(
      await f.sql.query(`SELECT incarnation FROM ${BINDINGS} WHERE name = ?`, ["no-claim"]),
    ).toEqual([]);
    // A distinct entry on the same Env must not inherit the selected descriptor.
    const ordinary = createWorkerEntry({ composeV2Forms: () => ({ [FORM]: f.form }) });
    const ordinaryResponse = await create(
      ordinary,
      f.env,
      "ordinary-name",
      "worker-entry-isolated-0001",
    );
    expect(ordinaryResponse.status).toBe(202);
    const ordinaryOperation = (await ordinaryResponse.json()) as { resourceUid: string };
    expect(
      await (await request(ordinary, f.env, `/resources/${ordinaryOperation.resourceUid}`)).json(),
    ).toMatchObject({
      output: { hostname: `ordinary-${ordinaryOperation.resourceUid}.example.test` },
    });
    expect(await f.sql.query(`SELECT count(*) AS n FROM ${BINDINGS}`)).toEqual([{ n: 1 }]);
  } finally {
    gate.release();
    await Promise.allSettled([...(starting ? [starting] : []), ...(scheduled ? [scheduled] : [])]);
    await f.runtime.dispose();
  }
}, 60_000);

test("Worker omission and undefined result stay OFF even with similarly named environment/config values", async () => {
  const f = await fixture("entry-origin-omitted", false);
  try {
    Object.assign(f.env, {
      composeV2WorkerEndpointOrigin: () => f.selection,
      TAKOSERVER_V2_WORKER_ENDPOINT_ORIGIN: "enabled",
    });
    let compositions = 0;
    const entries = [
      createWorkerEntry({ composeV2Forms: () => ({ [FORM]: f.form }) }),
      createWorkerEntry({
        composeV2Forms: () => ({ [FORM]: f.form }),
        composeV2WorkerEndpointOrigin() {
          compositions++;
          return undefined;
        },
      }),
    ];
    for (const [index, entry] of entries.entries()) {
      const response = await create(
        entry,
        f.env,
        `ordinary-${index}`,
        `worker-origin-omitted-${index}-0001`,
      );
      expect(response.status).toBe(202);
      const operation = (await response.json()) as { resourceUid: string };
      expect(
        await (await request(entry, f.env, `/resources/${operation.resourceUid}`)).json(),
      ).toMatchObject({
        output: { hostname: `ordinary-${operation.resourceUid}.example.test` },
      });
    }
    expect(compositions).toBe(1);
    expect(
      await f.sql.query("SELECT name FROM sqlite_schema WHERE name LIKE 'shared_app_%'"),
    ).toEqual([]);
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_operations")).toEqual([{ n: 2 }]);
    expect(f.effects()).toBe(0);
  } finally {
    await f.runtime.dispose();
  }
}, 60_000);

test("Worker refuses malformed composition with safe diagnostics and zero real acceptance writes", async () => {
  const f = await fixture("entry-origin-refusal");
  try {
    const secretSentinel = "PRIVATE-COMPONENT-DIAGNOSTIC-MUST-NOT-ESCAPE";
    const cases: WorkerEntryOptions["composeV2WorkerEndpointOrigin"][] = [
      null as unknown as Composer,
      async () => {
        throw new TypeError(secretSentinel);
      },
      () =>
        ({
          get formUrl() {
            throw new TypeError(secretSentinel);
          },
        }) as unknown as Selection,
      () => ({}) as Selection,
      () =>
        ({
          ...f.selection,
          ledger: {
            get forTrustedOwner() {
              throw new TypeError(secretSentinel);
            },
          },
        }) as unknown as Selection,
    ];
    for (const compose of cases) {
      const entry = createWorkerEntry({
        composeV2Forms: () => ({ [FORM]: f.form }),
        ...(compose === undefined ? {} : { composeV2WorkerEndpointOrigin: compose }),
      });
      const response = await request(entry, f.env, "/resources");
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.text();
      expect(body).not.toContain(secretSentinel);
      expect(JSON.stringify([...response.headers])).not.toContain(secretSentinel);
      expect(JSON.parse(body)).toMatchObject({
        error: { code: "backend_unavailable", details: { reason: "runtime-configuration" } },
      });
    }
    for (const table of [
      "tf_v2_resources",
      "tf_v2_operations",
      BINDINGS,
      "shared_app_staging_assignments",
    ]) {
      expect(await f.sql.query(`SELECT count(*) AS n FROM ${table}`)).toEqual([{ n: 0 }]);
    }
    expect(f.effects()).toBe(0);
  } finally {
    await f.runtime.dispose();
  }
}, 60_000);

test("Worker does not cache or retry failed startup; repaired code selection is then cached", async () => {
  const f = await fixture("entry-origin-startup-repair");
  try {
    const claim = await f.reserve("repaired-name");
    let compositions = 0;
    const entry = createWorkerEntry({
      composeV2Forms: () => ({ [FORM]: f.form }),
      composeV2WorkerEndpointOrigin() {
        compositions++;
        if (compositions === 1) throw new Error("component first startup refusal");
        return f.selection;
      },
    });
    expect((await request(entry, f.env, `/support?form=${encodeURIComponent(FORM)}`)).status).toBe(
      503,
    );
    expect(compositions).toBe(1);
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_operations")).toEqual([{ n: 0 }]);
    expect((await request(entry, f.env, `/support?form=${encodeURIComponent(FORM)}`)).status).toBe(
      200,
    );
    expect(compositions).toBe(2);
    const created = await create(entry, f.env, claim.name, "worker-origin-repair-0001");
    expect(created.status).toBe(202);
    const operation = (await created.json()) as { id: string };
    const replay = await create(entry, f.env, claim.name, "worker-origin-repair-0001");
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ id: operation.id });
    expect(compositions).toBe(2);
    expect(await f.sql.query(`SELECT count(*) AS n FROM ${BINDINGS}`)).toEqual([{ n: 1 }]);
    expect(f.effects()).toBe(0);
  } finally {
    await f.runtime.dispose();
  }
}, 60_000);
