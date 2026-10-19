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
import { moneyFenceInstallSql } from "../scripts/deploy/schema-money-unit-cutover.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { HOSTED_EDGE_SUPPLIES_KIND } from "../src/hosted-edge-supplies.ts";
import { bytesDigest } from "../src/json.ts";
import {
  assertMoneyCutoverSqlOrigin,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_FREEZE_TABLE,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
  MONEY_CUTOVER_WRITER_POLICY,
} from "../src/money-cutover-sql.ts";
import type { Clock, Sql, SqlParam, SqlStatement } from "../src/ports.ts";
import type { CloudflareProviderExecutorRpc } from "../src/providers/cloudflare-provider-executor-port.ts";
import { createSharedAppLedgerD1 } from "../src/shared-app-ledger-d1.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "../src/shared-auth-oidc-client.ts";
import { createD1Sql, type D1DatabaseLike, type D1StatementLike } from "../src/sql-d1.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { claimFreshStripeModeRealm } from "../src/stripe-mode-realm.ts";
import { createV2ContainerHostAcceptance } from "../src/takoform-v2/container-owner-schema.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";
import { WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT } from "../src/worker-endpoint-origin-reservations.ts";
import {
  createWorkerPrimaryRequestSql,
  createWorkerRequestConsumers,
  createWorkerRequestSql,
  type WorkerRequestDatabase,
} from "../src/worker-request-composition.ts";

const ORIGIN = "https://api.worker-origin-composition.test";
const BASE = `${ORIGIN}/apis/forms.takoform.com/v2`;
const FORM = "https://forms.example.test/fixture/WorkerOriginComposition/1.0.0";
const BACKEND = "fixture-worker-origin-backend";
const TARGET = "fixture-worker-origin-target";
const ORG = "org-worker-origin-composition";
const TOKEN = "worker-origin-composition-public-test-token";
const BINDINGS = "shared_app_staging_endpoint_bindings";
const REQUEST_WRITER = `sha256:${"c".repeat(64)}`;
type Composer = NonNullable<WorkerEntryOptions["composeV2WorkerEndpointOrigin"]>;
type Selection = Exclude<Awaited<ReturnType<Composer>>, undefined>;

// Same unchanged SQL fixture constraints, collected for actual D1 execution.
function sharedSchema(
  db: { exec(source: string): void },
  includeBindings: boolean,
  typed = false,
): void {
  // Preserve the stronger original ledger fixture checks, not the relaxed route fixture.
  for (const realm of ["staging", "production"]) {
    const prefix = `shared_app_${realm}`;
    const variantChecks = typed
      ? `CHECK((binding_kind IS NULL AND binding_json IS NULL
          AND (state<>'reserved' OR script IS NULL) AND (state<>'active' OR script IS NOT NULL))
        OR (binding_kind IS 'form-v2@1' AND script IS NULL AND
          ((state IN ('reserved','released') AND binding_json IS NULL)
            OR (state='active' AND binding_json IS NOT NULL AND json_valid(binding_json)=1))))`
      : `CHECK(state<>'reserved' OR script IS NULL), CHECK(state<>'active' OR script IS NOT NULL)`;
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
      script TEXT, released_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL${typed ? ", binding_kind TEXT, binding_json TEXT" : ""},
      UNIQUE(organization_id,reservation_id), CHECK(updated_at>=created_at),
      CHECK((state='released')=(released_at IS NOT NULL)),
      CHECK(released_at IS NULL OR released_at>=created_at),
      ${variantChecks})`);
    db.exec(`CREATE TABLE ${prefix}_names (
      normalized_name TEXT PRIMARY KEY
        CHECK(length(normalized_name) BETWEEN 3 AND 32
          AND normalized_name NOT GLOB '*[^a-z0-9-]*'),
      incarnation TEXT NOT NULL REFERENCES ${prefix}_assignments(incarnation),
      generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740990),
      state TEXT NOT NULL CHECK(state IN ('reserved','active','released')),
      released_at INTEGER, updated_at INTEGER NOT NULL,
      CHECK((state='released')=(released_at IS NOT NULL)))`);
    db.exec(`CREATE TABLE ${prefix}_batch_assertions (
      witness TEXT PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1),
      apply_effects INTEGER NOT NULL CHECK(apply_effects IN (0,1)))`);
    if (typed)
      db.exec(`CREATE TABLE ${prefix}_route_commands (
        organization_id TEXT NOT NULL,product TEXT NOT NULL,reservation_id TEXT NOT NULL,name TEXT NOT NULL,
        incarnation TEXT NOT NULL REFERENCES ${prefix}_assignments(incarnation),
        action TEXT NOT NULL CHECK(action IN ('activate','advance','retire')),command_ref TEXT NOT NULL,
        prior_generation INTEGER NOT NULL,prior_state TEXT NOT NULL,prior_script TEXT,next_script TEXT,
        endpoint_uid TEXT NOT NULL,endpoint_generation INTEGER NOT NULL,worker_uid TEXT NOT NULL,
        deployment_uid TEXT NOT NULL,deployment_generation INTEGER NOT NULL,source_operation_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,target_key TEXT NOT NULL,next_generation INTEGER NOT NULL,next_state TEXT NOT NULL,
        created_at INTEGER NOT NULL,form_v2_original_json TEXT,
        PRIMARY KEY(organization_id,command_ref),UNIQUE(incarnation,next_generation),
        CHECK(next_generation=prior_generation+1),CHECK(next_generation BETWEEN 2 AND 9007199254740990))`);
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

async function fixture(name: string, shared = true, typed = false, carrier = false) {
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
    const rootQueries: string[] = [];
    const primaries: {
      readonly constraint: "first-primary";
      readonly native: ReturnType<typeof database.withSession>;
      readonly queries: string[];
    }[] = [];
    const observeDatabase = (
      nativeDatabase: Pick<typeof database, "prepare" | "batch">,
      queries: string[],
    ): D1DatabaseLike => ({
      prepare(query) {
        queries.push(query);
        return observe(nativeDatabase.prepare(query), query);
      },
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
          return await nativeDatabase.batch<Record<string, unknown>>(native);
        } catch (error) {
          coreBatchError = error;
          throw error;
        }
      },
    });
    const observedDatabase: WorkerRequestDatabase = {
      ...observeDatabase(database, rootQueries),
      withSession(constraint) {
        const native = database.withSession(constraint);
        const queries: string[] = [];
        primaries.push({ constraint, native, queries });
        return observeDatabase(native, queries);
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
        typed,
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
    let providerCalls = 0;
    const unexpectedProvider = async (): Promise<never> => {
      providerCalls++;
      throw new Error("reservation must not invoke native provider mutation or readback");
    };
    const executor: CloudflareProviderExecutorRpc = {
      apply: unexpectedProvider,
      recoverApply: unexpectedProvider,
      convergeApply: unexpectedProvider,
      concludeApplyNoEffect: unexpectedProvider,
      compensateApply: unexpectedProvider,
      poll: unexpectedProvider,
      observe: unexpectedProvider,
      delete: unexpectedProvider,
      recoverDelete: unexpectedProvider,
      convergeDelete: unexpectedProvider,
      adopt: unexpectedProvider,
      recoverAdopt: unexpectedProvider,
      verifyNativeAbsence: unexpectedProvider,
      verifyArtifactConsumption: unexpectedProvider,
      readSqliteMigrationLedger: unexpectedProvider,
      applySqliteMigrationSuffix: unexpectedProvider,
      readMeterUsage: unexpectedProvider,
    };
    // Existing business supply parser and real local Cloudflare origin derivation;
    // these controlled fixture terms do not stand in for deployed supply authority.
    const supplies = {
      kind: HOSTED_EDGE_SUPPLIES_KIND,
      providerInstallation: {
        id: "cloudflare.integration",
        providerPackRef: "cloudflare",
        supplyContractRef: "fixture:carrier-contract",
        state: "active",
        regions: [{ id: "global", capacity: "available" }],
      },
      supplyContract: {
        id: "fixture:carrier-contract",
        providerType: "cloudflare",
        permittedResourceClasses: ["compute.edge"],
        deliveryModes: ["embedded-binding"],
        customerAccess: "operator-only",
        whiteLabelAllowed: true,
        endUserTermsRequired: true,
        regions: ["global"],
        validFrom: "2026-01-01T00:00:00.000Z",
        evidenceRef: "fixture:carrier-contract",
      },
      offerings: [
        {
          formKind: "ModuleWorker",
          offeringId: "carrier.worker.integration",
          displayName: "Carrier Worker fixture",
          pricePlan: {
            id: "carrier.worker.integration.price",
            currency: "USD",
            provisioning: { meter: "resource.create", amountMinor: 0 },
            meters: [{ meter: "compute.worker.requests.million", amountMinor: 30 }],
          },
          placement: {
            deliveryMode: "embedded-binding",
            supportPolicyRef: "fixture:support",
            abusePolicyRef: "fixture:abuse",
            portability: {
              api: "portable",
              exportFormats: [],
              importFormats: [],
              migrationModes: ["offline"],
            },
            isolation: "dedicated-resource",
          },
        },
      ],
    };
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
      ...(carrier
        ? {
            TAKOSERVER_EDGE_SUPPLIES: JSON.stringify(supplies),
            TAKOSERVER_MANAGED_BASE_DOMAIN: "app-staging.takos.jp",
            CLOUDFLARE_PROVIDER_EXECUTOR: executor,
          }
        : {}),
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
      primaries,
      rootQueries,
      ledger,
      selection,
      form,
      owner,
      coreBatches,
      coreBatchError: () => coreBatchError,
      effects: () => effects,
      providerCalls: () => providerCalls,
      reserve: (name: string) =>
        ledger.forTrustedOwner(owner).reserve({ reservationId: `claim-${name}`, name }),
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

/** Existing owning Money setup on this fixture's real Miniflare database only. */
async function selectRequestWriter(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  for (const source of [
    MONEY_CUTOVER_FREEZE_DDL,
    MONEY_CUTOVER_PERMIT_DDL,
    MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
    MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
    moneyFenceInstallSql("0094"),
  ]) {
    for (const statement of frameHostMigrationSql(source)) await f.sql.run(statement);
  }
  await f.sql.run("INSERT INTO money_cutover_authorized_epoch VALUES (1, ?)", [REQUEST_WRITER]);
  Object.assign(f.env, {
    TAKOSERVER_ENVIRONMENT: "integration",
    TAKOSERVER_MONEY_CUTOVER_WRITER_POLICY: MONEY_CUTOVER_WRITER_POLICY,
    TAKOSERVER_MONEY_CUTOVER_WRITER_EPOCH: REQUEST_WRITER,
  });
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

test("Worker forwards a captured typed route selection through its actual App and D1", async () => {
  const f = await fixture("entry-typed-origin-construction", true, true);
  try {
    const claim = await f.reserve("typed-worker-name");
    // Reserved tagged fixture only; no serving/native publication is asserted.
    await f.sql.run(
      "UPDATE shared_app_staging_assignments SET binding_kind='form-v2@1' WHERE incarnation=?",
      [claim.incarnation],
    );
    let compositions = 0;
    let kindReads = 0;
    let ledgerReads = 0;
    const selected: Selection = {
      get kind(): "form-v2@1" {
        kindReads++;
        return "form-v2@1";
      },
      formUrl: FORM,
      backendId: BACKEND,
      targetKey: TARGET,
      get ledger() {
        ledgerReads++;
        return f.ledger;
      },
    };
    const entry = createWorkerEntry({
      composeV2Forms: () => ({ [FORM]: f.form }),
      composeV2WorkerEndpointOrigin(context) {
        compositions++;
        expect(Object.keys(context).sort()).toEqual(["clock", "env"]);
        return selected;
      },
    });
    expect((await request(entry, f.env, `/support?form=${encodeURIComponent(FORM)}`)).status).toBe(
      200,
    );
    expect(compositions).toBe(1);
    expect(kindReads).toBe(1);
    expect(ledgerReads).toBe(1);
    for (const field of ["kind", "ledger"])
      Object.defineProperty(selected, field, {
        get() {
          throw new Error("Worker typed selection must remain captured");
        },
      });
    Object.defineProperty(selected, "formUrl", { value: "https://foreign.example.test/form" });
    const created = await create(entry, f.env, claim.name, "worker-typed-create-0001");
    expect(created.status).toBe(202);
    const operation = (await created.json()) as { id: string; resourceUid: string };
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
    const replay = await create(entry, f.env, claim.name, "worker-typed-create-0001");
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({
      id: operation.id,
      resourceUid: operation.resourceUid,
    });
    expect(compositions).toBe(1);
    expect(
      await f.sql.query(
        "SELECT generation,state,binding_kind,binding_json FROM shared_app_staging_assignments",
      ),
    ).toEqual([
      { generation: 1, state: "reserved", binding_kind: "form-v2@1", binding_json: null },
    ]);
    expect(await f.ledger.readCurrentRoute(claim.name)).toBeNull();
    expect(f.effects()).toBe(0);
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_operations")).toEqual([{ n: 1 }]);
  } finally {
    await f.runtime.dispose();
  }
}, 60_000);

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
      () => ({ ...f.selection, kind: "form-v2@unknown" }) as unknown as Selection,
      () =>
        ({
          ...f.selection,
          get kind() {
            throw new TypeError(secretSentinel);
          },
        }) as Selection,
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
    expect(f.primaries).toHaveLength(0);
    expect(f.effects()).toBe(0);
  } finally {
    await f.runtime.dispose();
  }
}, 60_000);

test("Worker public carrier uses existing supply derivation and feeds the same original into real Core acceptance", async () => {
  const f = await fixture("entry-shared-carrier-original", true, true, true);
  try {
    const entry = createWorkerEntry({
      composeV2Forms: () => ({ [FORM]: f.form }),
      composeV2WorkerEndpointOrigin: () => ({ ...f.selection, kind: "form-v2@1" }),
    });
    const name = "integration-worker-carrier";
    const reservationId = "worker-carrier-original";
    const control = (method: string) =>
      entry.fetch(
        new Request(`${ORIGIN}/v1/worker-endpoint-origin-reservations/${reservationId}`, {
          method,
          headers: {
            authorization: `Bearer ${TOKEN}`,
            ...(method === "PUT" ? { "content-type": "application/json" } : {}),
          },
          ...(method === "PUT"
            ? {
                body: JSON.stringify({
                  format: WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
                  requestedSubdomain: name,
                  expiresInSeconds: 60,
                  offeringId: "carrier.worker.integration",
                }),
              }
            : {}),
        }),
        f.env,
      );
    const prepared = await control("PUT");
    expect(prepared.status).toBe(201);
    const projection: unknown = await prepared.json();
    if (
      typeof projection !== "object" ||
      projection === null ||
      !("expiresAt" in projection) ||
      typeof projection.expiresAt !== "string"
    )
      throw new Error("actual Worker carrier projection missing");
    expect(Number.isFinite(Date.parse(projection.expiresAt))).toBe(true);
    const expectedProjection = {
      format: WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
      reservationId,
      requestedSubdomain: name,
      canonicalPublicOrigin: `https://${name}.app-staging.takos.jp`,
      revision: "1",
      expiresAt: projection.expiresAt,
      status: "prepared",
    };
    expect(projection).toEqual(expectedProjection);
    expect(await (await control("GET")).json()).toEqual(projection);
    const original = await f.ledger.forTrustedOwner(f.owner).readOriginalRoute(reservationId);
    if (original?.kind !== "scalar") throw new Error("Worker carrier original absent");
    expect(original.value.name).toBe(name);
    expect(original.value.organizationId).toBe(ORG);
    const allocation = f.coreBatches.find((batch) =>
      batch.some((statement) =>
        statement.sql.includes("INSERT INTO worker_endpoint_origin_reservations"),
      ),
    );
    if (!allocation) throw new Error("actual Worker carrier batch absent");
    expect(
      allocation.some((statement) =>
        statement.sql.includes("INSERT INTO shared_app_staging_assignments"),
      ),
    ).toBe(true);
    const response = await create(entry, f.env, name, "worker-carrier-accepted-0001");
    expect(response.status).toBe(202);
    const operation: unknown = await response.json();
    if (
      typeof operation !== "object" ||
      operation === null ||
      !("id" in operation) ||
      typeof operation.id !== "string" ||
      !("resourceUid" in operation) ||
      typeof operation.resourceUid !== "string"
    )
      throw new Error("actual Worker Operation absent");
    expect(
      await f.sql.query(
        `SELECT incarnation,reservation_id,endpoint_uid,endpoint_generation,create_operation_id,current_operation_id FROM ${BINDINGS}`,
      ),
    ).toEqual([
      {
        incarnation: original.value.incarnation,
        reservation_id: reservationId,
        endpoint_uid: operation.resourceUid,
        endpoint_generation: 1,
        create_operation_id: operation.id,
        current_operation_id: operation.id,
      },
    ]);
    expect(
      await f.sql.query("SELECT principal,space,name FROM tf_v2_resources WHERE uid=?", [
        operation.resourceUid,
      ]),
    ).toEqual([{ principal: `org:${ORG}`, space: ORG, name }]);
    expect(
      await f.sql.query("SELECT count(*) AS n FROM shared_app_staging_route_commands"),
    ).toEqual([{ n: 0 }]);
    const batches = f.coreBatches.length;
    expect((await control("DELETE")).status).toBe(422);
    expect(f.coreBatches).toHaveLength(batches);
    expect(await f.ledger.forTrustedOwner(f.owner).readOriginalRoute(reservationId)).toEqual(
      original,
    );
    expect(await f.sql.query("SELECT * FROM shared_app_staging_batch_assertions")).toEqual([]);
    expect(f.providerCalls()).toBe(0);
    expect(f.effects()).toBe(0);
    // Losing the retained route history is unavailable authority, not permission
    // to cancel the held name, even when this Endpoint already fences release.
    await f.sql.run("DROP TABLE shared_app_staging_route_commands");
    expect((await control("DELETE")).status).toBe(503);
    expect(f.coreBatches).toHaveLength(batches);
    expect(await f.ledger.forTrustedOwner(f.owner).readOriginalRoute(reservationId)).toEqual(
      original,
    );
    expect(await f.sql.query("SELECT * FROM shared_app_staging_batch_assertions")).toEqual([]);
    expect(f.providerCalls()).toBe(0);
    expect(f.effects()).toBe(0);
  } finally {
    await f.runtime.dispose();
  }
}, 60_000);

test("Container code composer captures the final Worker Sql and clock without changing Endpoint-only admission", async () => {
  const f = await fixture("entry-container-composer-negative");
  try {
    await selectRequestWriter(f);
    Object.assign(f.env, {
      composeV2ContainerHostAcceptance() {
        throw new Error("environment is not a code composer");
      },
      TAKOSERVER_V2_CONTAINER_HOST_ACCEPTANCE: "enabled",
    });
    const ordinary = createWorkerEntry({ composeV2Forms: () => ({ [FORM]: f.form }) });
    expect(
      (await create(ordinary, f.env, "ordinary-container-omitted", "container-omitted-0001"))
        .status,
    ).toBe(202);

    const endpointClaim = await f.reserve("endpoint-only-container");
    const endpointOnly = createWorkerEntry({
      composeV2Forms: () => ({ [FORM]: f.form }),
      composeV2WorkerEndpointOrigin: () => f.selection,
    });
    expect(
      (await create(endpointOnly, f.env, endpointClaim.name, "container-endpoint-only-0001"))
        .status,
    ).toBe(202);

    let formClock: unknown;
    let capturedSql: unknown;
    let compositions = 0;
    const combinedClaim = await f.reserve("endpoint-with-container");
    const combined = createWorkerEntry({
      composeV2Forms({ clock }) {
        formClock = clock;
        return { [FORM]: f.form };
      },
      composeV2WorkerEndpointOrigin: () => f.selection,
      composeV2ContainerHostAcceptance(context) {
        compositions++;
        expect(Object.keys(context).sort()).toEqual(["clock", "env", "sql"]);
        expect(Object.isFrozen(context)).toBe(true);
        expect(context.env).toBe(f.env);
        expect(formClock).toBe(context.clock);
        expect(context.sql).not.toBe(f.sql);
        capturedSql = context.sql;
        return createV2ContainerHostAcceptance({
          sql: context.sql,
          installationId: "fixture-container-installation",
          backendId: "fixture-container-backend",
          targetKey: "fixture-container-target",
        });
      },
    });
    expect(
      (await request(combined, f.env, `/support?form=${encodeURIComponent(FORM)}`)).status,
    ).toBe(200);
    expect(
      (await create(combined, f.env, combinedClaim.name, "container-endpoint-combined-0001"))
        .status,
    ).toBe(202);
    expect(compositions).toBe(2);
    expect(f.primaries).toHaveLength(2);
    expect(capturedSql).toBeDefined();
    expect(await f.sql.query(`SELECT count(*) AS n FROM ${BINDINGS}`)).toEqual([{ n: 2 }]);
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_operations")).toEqual([{ n: 3 }]);
    expect(f.providerCalls()).toBe(0);
    expect(f.effects()).toBe(0);
  } finally {
    await f.runtime.dispose();
  }
}, 60_000);

test("Container composer omission result, malformed issuer, foreign Sql and private throw redact startup", async () => {
  const f = await fixture("entry-container-composer-refusal", false);
  try {
    await selectRequestWriter(f);
    const secret = "PRIVATE-CONTAINER-COMPOSER-DIAGNOSTIC";
    let deleteGetterCalls = 0;
    type ContainerComposer = NonNullable<WorkerEntryOptions["composeV2ContainerHostAcceptance"]>;
    const cases: ContainerComposer[] = [
      null as unknown as ContainerComposer,
      () => undefined as never,
      async () => undefined as never,
      () => ({}) as never,
      ({ sql }) => {
        const actual = createV2ContainerHostAcceptance({
          sql,
          installationId: "missing-delete-installation",
          backendId: "missing-delete-backend",
          targetKey: "missing-delete-target",
        });
        return { ...actual, prepareDelete: undefined } as never;
      },
      ({ sql }) => {
        const actual = createV2ContainerHostAcceptance({
          sql,
          installationId: "accessor-delete-installation",
          backendId: "accessor-delete-backend",
          targetKey: "accessor-delete-target",
        });
        return Object.defineProperty({ ...actual }, "prepareDelete", {
          get() {
            deleteGetterCalls++;
            throw new Error(secret);
          },
        }) as never;
      },
      () => {
        throw new Error(secret);
      },
      () =>
        ({
          get assertSql() {
            throw new Error(secret);
          },
        }) as never,
      () =>
        createV2ContainerHostAcceptance({
          sql: f.sql,
          installationId: "foreign-container-installation",
          backendId: "foreign-container-backend",
          targetKey: "foreign-container-target",
        }),
    ];
    for (const composeV2ContainerHostAcceptance of cases) {
      const entry = createWorkerEntry({
        composeV2Forms: () => ({ [FORM]: f.form }),
        composeV2ContainerHostAcceptance,
      });
      const response = await request(entry, f.env, "/resources");
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.text();
      expect(body).not.toContain(secret);
      expect(JSON.stringify([...response.headers])).not.toContain(secret);
      expect(JSON.parse(body)).toMatchObject({
        error: { code: "backend_unavailable", details: { reason: "runtime-configuration" } },
      });
    }
    expect(deleteGetterCalls).toBe(0);
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_operations")).toEqual([{ n: 0 }]);
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_resources")).toEqual([{ n: 0 }]);
    expect(f.providerCalls()).toBe(0);
    expect(f.effects()).toBe(0);
  } finally {
    await f.runtime.dispose();
  }
}, 60_000);

test("Container HTTP requests and a scheduled invocation each own an actual native primary, final Sql and clock", async () => {
  const f = await fixture("entry-container-request-origins");
  try {
    await selectRequestWriter(f);
    expect(f.env.PUBLIC_ORIGIN).not.toBe(SHARED_AUTH_STAGING_PROFILE.publicOrigin);
    let formContext: { readonly sql: Sql; readonly clock: Clock } | undefined;
    const captured: {
      readonly sql: Sql;
      readonly clock: Clock;
      readonly marker: string;
      readonly acceptance: ReturnType<typeof createV2ContainerHostAcceptance>;
    }[] = [];
    const entry = createWorkerEntry({
      composeV2Forms({ sql, clock }) {
        formContext = { sql, clock };
        return { [FORM]: f.form };
      },
      async composeV2ContainerHostAcceptance(context) {
        expect(context.env).toBe(f.env);
        expect(Object.isFrozen(context)).toBe(true);
        expect(formContext?.sql).toBe(context.sql);
        expect(formContext?.clock).toBe(context.clock);
        expect(context.clock()).toBeInstanceOf(Date);
        expect(context.sql).not.toBe(f.sql);
        assertMoneyCutoverSqlOrigin(context.sql, { writerEpoch: REQUEST_WRITER });
        const ordinal = captured.length + 1;
        const marker = `SELECT ${ordinal} AS entry_request_origin`;
        expect(await context.sql.query(marker)).toEqual([{ entry_request_origin: ordinal }]);
        const acceptance = createV2ContainerHostAcceptance({
          sql: context.sql,
          installationId: "request-container-installation",
          backendId: "request-container-backend",
          targetKey: "request-container-target",
        });
        acceptance.assertSql(context.sql);
        captured.push({ sql: context.sql, clock: context.clock, marker, acceptance });
        return acceptance;
      },
    });
    for (let index = 0; index < 2; index++) {
      expect(
        (await request(entry, f.env, `/support?form=${encodeURIComponent(FORM)}`)).status,
      ).toBe(200);
    }
    expect(captured).toHaveLength(2);
    expect(f.primaries).toHaveLength(2);
    await entry.scheduled({}, f.env);
    expect(captured).toHaveLength(3);
    expect(f.primaries).toHaveLength(3);
    for (let index = 0; index < captured.length; index++) {
      const current = captured[index];
      const primary = f.primaries[index];
      if (!current || !primary) throw new Error("missing actual invocation origin");
      expect(primary.constraint).toBe("first-primary");
      expect(primary.queries).toContain(current.marker);
      for (let otherIndex = 0; otherIndex < captured.length; otherIndex++) {
        if (otherIndex === index) continue;
        const other = captured[otherIndex];
        const otherPrimary = f.primaries[otherIndex];
        if (!other || !otherPrimary) throw new Error("missing competing invocation origin");
        expect(primary.native).not.toBe(otherPrimary.native);
        expect(primary.queries).not.toContain(other.marker);
        expect(current.sql).not.toBe(other.sql);
        expect(current.clock).not.toBe(other.clock);
        expect(() => current.acceptance.assertSql(other.sql)).toThrow();
      }
    }
    expect(f.rootQueries).toEqual([]);
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_operations")).toEqual([{ n: 0 }]);
    expect(f.providerCalls()).toBe(0);
    expect(f.effects()).toBe(0);
  } finally {
    await f.runtime.dispose();
  }
}, 60_000);

test("Container freeze is re-read on a fresh native primary before any later HTTP or scheduled composer", async () => {
  const f = await fixture("entry-container-request-freeze");
  try {
    await selectRequestWriter(f);
    let compositions = 0;
    const entry = createWorkerEntry({
      composeV2Forms: () => ({ [FORM]: f.form }),
      composeV2ContainerHostAcceptance({ sql }) {
        compositions++;
        return createV2ContainerHostAcceptance({
          sql,
          installationId: "freeze-container-installation",
          backendId: "freeze-container-backend",
          targetKey: "freeze-container-target",
        });
      },
    });
    expect((await request(entry, f.env, `/support?form=${encodeURIComponent(FORM)}`)).status).toBe(
      200,
    );
    expect(compositions).toBe(1);
    // Test-only row on this actual Miniflare database, using the existing owning DDL.
    await f.sql.run(
      `INSERT INTO ${MONEY_CUTOVER_FREEZE_TABLE}
        (singleton, binding_digest, origin_digest, backup_digest, writer_digest, source_digest)
        VALUES (?, ?, ?, ?, ?, ?)`,
      [1, ...["1", "2", "3", "4", "5"].map((hex) => `sha256:${hex.repeat(64)}`)],
    );
    const refused = await request(entry, f.env, `/support?form=${encodeURIComponent(FORM)}`);
    expect(refused.status).toBe(503);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(await refused.json()).toMatchObject({
      error: { code: "backend_unavailable", details: { reason: "money-cutover-freeze" } },
    });
    await entry.scheduled({}, f.env);
    expect(compositions).toBe(1);
    expect(f.primaries).toHaveLength(3);
    expect(f.primaries.every((primary) => primary.constraint === "first-primary")).toBe(true);
    expect(f.rootQueries).toEqual([]);
    expect(await f.sql.query("SELECT count(*) AS n FROM tf_v2_operations")).toEqual([{ n: 0 }]);
    expect(f.providerCalls()).toBe(0);
    expect(f.effects()).toBe(0);
  } finally {
    await f.runtime.dispose();
  }
}, 60_000);

test("selected Container refuses a missing Money epoch or native primary without fallback or composer", async () => {
  const f = await fixture("entry-container-native-requirements");
  try {
    let compositions = 0;
    const entry = createWorkerEntry({
      composeV2Forms: () => ({ [FORM]: f.form }),
      composeV2ContainerHostAcceptance({ sql }) {
        compositions++;
        return createV2ContainerHostAcceptance({
          sql,
          installationId: "required-container-installation",
          backendId: "required-container-backend",
          targetKey: "required-container-target",
        });
      },
    });
    expect((await request(entry, f.env, "/resources")).status).toBe(503);
    await expect(entry.scheduled({}, f.env)).rejects.toThrow("requires the selected Money writer");
    expect(f.primaries).toHaveLength(0);
    await selectRequestWriter(f);
    const { withSession: _withSession, ...withoutPrimary } = f.env.STATE_DB;
    const env = { ...f.env, STATE_DB: withoutPrimary };
    expect((await request(entry, env, "/resources")).status).toBe(503);
    await expect(entry.scheduled({}, env)).rejects.toThrow("native primary D1 session");
    expect(compositions).toBe(0);
    expect(f.primaries).toHaveLength(0);
    expect(f.rootQueries).toEqual([]);
    expect(f.providerCalls()).toBe(0);
    expect(f.effects()).toBe(0);
  } finally {
    await f.runtime.dispose();
  }
}, 60_000);

test("generic native provenance cannot select sharedAuth consumers or bypass its existing origin guard", async () => {
  const f = await fixture("entry-container-generic-not-shared-auth");
  try {
    await selectRequestWriter(f);
    const connection = await createWorkerPrimaryRequestSql({
      database: f.env.STATE_DB,
      writerEpoch: REQUEST_WRITER,
    });
    expect(connection.moneyGuard).toBe("ready");
    assertMoneyCutoverSqlOrigin(connection.sql, { writerEpoch: REQUEST_WRITER });
    const sharedAuthStaging: NonNullable<WorkerEntryOptions["sharedAuthStaging"]> = {
      kind: "shared-auth-staging-v1",
      clientSecret: "fixture-shared-auth-not-a-credential",
      encryptionKey: new Uint8Array(32),
      principals: {
        async resolve(): Promise<never> {
          throw new Error("this fixture grants no Principal producer");
        },
      },
    };
    expect(() =>
      createWorkerRequestConsumers({
        connection,
        sql: connection.sql,
        sharedAuth: sharedAuthStaging,
        // No realm/credential is supplied: refusal must precede either assertion.
        client: null as never,
        realm: null as never,
        identity: {
          async verify(): Promise<never> {
            throw new Error("this fixture grants no identity");
          },
        },
        clock: () => new Date(),
        randomId: () => crypto.randomUUID(),
        publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
        consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
      }),
    ).toThrow("shared-login Worker request composition differs");
    await expect(
      createWorkerRequestSql({
        database: f.env.STATE_DB,
        writerEpoch: REQUEST_WRITER,
        publicOrigin: ORIGIN,
        consoleOrigin: undefined,
      }),
    ).rejects.toThrow("exact selected staging origins");
    let containerCompositions = 0;
    const entry = createWorkerEntry({
      sharedAuthStaging,
      composeV2Forms: () => ({ [FORM]: f.form }),
      composeV2ContainerHostAcceptance({ sql }) {
        containerCompositions++;
        return createV2ContainerHostAcceptance({
          sql,
          installationId: "shared-auth-refusal-installation",
          backendId: "shared-auth-refusal-backend",
          targetKey: "shared-auth-refusal-target",
        });
      },
    });
    expect((await request(entry, f.env, "/resources")).status).toBe(503);
    expect(f.primaries).toHaveLength(1);
    expect(containerCompositions).toBe(0);
    expect(f.rootQueries).toEqual([]);
    expect(f.providerCalls()).toBe(0);
    expect(f.effects()).toBe(0);
  } finally {
    await f.runtime.dispose();
  }
}, 60_000);

test("sharedAuth still requires its genuine canonical Hosted realm before Container composition", async () => {
  const f = await fixture("entry-container-shared-auth-realm-refusal");
  try {
    await selectRequestWriter(f);
    Object.assign(f.env, {
      PUBLIC_ORIGIN: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
      TAKOSERVER_CONSOLE_ORIGIN: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
    });
    let containerCompositions = 0;
    const entry = createWorkerEntry({
      sharedAuthStaging: {
        kind: "shared-auth-staging-v1",
        clientSecret: "fixture-shared-auth-unavailable-realm",
        encryptionKey: new Uint8Array(32),
        principals: {
          async resolve(): Promise<never> {
            throw new Error("this fixture grants no Principal producer");
          },
        },
      },
      composeV2ContainerHostAcceptance({ sql }) {
        containerCompositions++;
        return createV2ContainerHostAcceptance({
          sql,
          installationId: "shared-auth-realm-installation",
          backendId: "shared-auth-realm-backend",
          targetKey: "shared-auth-realm-target",
        });
      },
    });
    for (let index = 0; index < 2; index++) {
      const response = await entry.fetch(
        new Request(`${SHARED_AUTH_STAGING_PROFILE.publicOrigin}/healthz`),
        f.env,
      );
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("requires its genuine canonical Hosted TEST realm");
    }
    expect(f.primaries).toHaveLength(2);
    expect(containerCompositions).toBe(0);
    expect(f.rootQueries).toEqual([]);
    expect(f.providerCalls()).toBe(0);
    expect(f.effects()).toBe(0);
  } finally {
    await f.runtime.dispose();
  }
}, 60_000);
