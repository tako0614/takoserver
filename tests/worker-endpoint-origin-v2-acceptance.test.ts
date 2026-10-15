/**
 * Engine/Store acceptance proof using the actual unmounted shared-name ledger.
 * The small Form is a fixture, not real Endpoint publication or writer cutover.
 * DDL below is UNALLOCATED and test-owned; no migration or live schema is adopted.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { type Sql, SqlError, type SqlStatement } from "../src/ports.ts";
import { createSharedAppLedger, type SharedAppAssignment } from "../src/shared-app-ledger.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2PrivateInputCustody } from "../src/takoform-v2/private-inputs.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2EngineOptions, V2Form } from "../src/takoform-v2/types.ts";
import {
  createWorkerEndpointOriginV2Acceptance,
  createWorkerEndpointOriginV2FormRouteAcceptance,
} from "../src/worker-endpoint-origin-v2-acceptance.ts";

const FORM = "https://forms.example.test/BindingAcceptance/1.0.0/";
const BACKEND = "origin-binding-fixture";
const TARGET = "origin-binding-sqlite";
const ORGANIZATION = "org-fixture";
const PRINCIPAL = `org:${ORGANIZATION}`;
const OWNER = { organizationId: ORGANIZATION, product: "takoserver" as const };
const AT = "2026-10-15T00:00:00.000Z";
const BINDINGS = "shared_app_staging_endpoint_bindings";
const SELECTED_OUTPUT = {
  hostname: "selected-name.app-staging.takos.jp",
  url: "https://selected-name.app-staging.takos.jp/",
};
const ADMISSION_DETAIL = "The fixture Form refused this acceptance.";

type OmittedWrite = "resource" | "private" | "configured" | "reference-seal";

function sharedSchema(db: Database, includeBindings: boolean, typed = false): void {
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

async function privateCustody(): Promise<V2PrivateInputCustody> {
  // Fixed, non-production test material, imported non-extractably like the real port.
  const transfer = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(7),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  const comparison = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(11),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return {
    transfer: { current: { id: "fixture-transfer", key: transfer } },
    comparison: { current: { id: "fixture-comparison", key: comparison } },
    transferTtlSeconds: 60,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function isAcceptance(statements: readonly SqlStatement[]): boolean {
  return statements.some((statement) => /^\s*INSERT INTO tf_v2_operations\b/u.test(statement.sql));
}

function omitted(statement: SqlStatement, write: OmittedWrite): boolean {
  switch (write) {
    case "resource":
      return /^\s*INSERT INTO tf_v2_resources\b/u.test(statement.sql);
    case "private":
      return /^\s*INSERT INTO tf_v2_private_inputs\b/u.test(statement.sql);
    case "configured":
      return /^\s*INSERT INTO tf_v2_configured_private_inputs\b/u.test(statement.sql);
    case "reference-seal":
      return /^\s*UPDATE tf_v2_operation_reference_sets SET sealed = 1\b/u.test(statement.sql);
  }
}

async function fixture(
  options: {
    bindings?: boolean;
    custody?: boolean;
    references?: "empty" | "missing";
    admission?: boolean;
    typed?: boolean;
  } = {},
) {
  const db = new Database(":memory:");
  migrateSqlite(db);
  const raw = createSqliteSql(db);
  sharedSchema(db, options.bindings !== false, options.typed);
  let blocked = false;
  let loseAck = false;
  let hideAfterCommit = false;
  let outcomeUnknown = false;
  let admissionAllowed = options.admission !== false;
  let admissionCode: "dependency_conflict" | "resource_busy" = "dependency_conflict";
  let acceptanceBatches = 0;
  let committedBatches = 0;
  let backendCalls = 0;
  let assignments = 0;
  let reserves = 0;
  let ownerReads = 0;
  let dropped = 0;
  let omit: OmittedWrite | null = null;
  let lastBatchError: unknown;
  let batchGate: {
    remaining: number;
    entered: ReturnType<typeof deferred>;
    release: ReturnType<typeof deferred>;
  } | null = null;
  let ownerGate: {
    entered: ReturnType<typeof deferred>;
    release: ReturnType<typeof deferred>;
  } | null = null;
  const sql: Sql = {
    async query(query, params) {
      if (blocked) throw new SqlError("unavailable", "fixture readback unavailable");
      return raw.query(query, params);
    },
    run: raw.run,
    async batch(statements) {
      const accepting = isAcceptance(statements);
      if (accepting) {
        acceptanceBatches++;
        if (batchGate && batchGate.remaining > 0) {
          const gate = batchGate;
          gate.remaining--;
          if (gate.remaining === 0) gate.entered.resolve();
          await gate.release.promise;
        }
      }
      const forwarded =
        accepting && omit
          ? statements.filter((statement) => {
              if (!omit || !omitted(statement, omit)) return true;
              dropped++;
              return false;
            })
          : statements;
      let result: Awaited<ReturnType<Sql["batch"]>>;
      try {
        result = await raw.batch(forwarded);
      } catch (error) {
        lastBatchError = error;
        throw error;
      }
      if (accepting) {
        committedBatches++;
        if (loseAck) {
          loseAck = false;
          blocked = hideAfterCommit;
          throw new SqlError("unavailable", "fixture committed ACK lost");
        }
      }
      return result;
    },
  };
  const ledger = createSharedAppLedger({
    environment: "staging",
    primary: () => sql,
    clock: () => new Date(AT),
  });
  // Instrument the actual issuer, delegating every result and mutation to it.
  const actualForOwner = ledger.forTrustedOwner.bind(ledger);
  ledger.forTrustedOwner = (owner) => {
    const actual = actualForOwner(owner);
    return {
      ...actual,
      async reserve(input) {
        reserves++;
        return actual.reserve(input);
      },
      async readOriginal(id) {
        ownerReads++;
        if (ownerGate) {
          const gate = ownerGate;
          gate.entered.resolve();
          await gate.release.promise;
        }
        return actual.readOriginal(id);
      },
    };
  };
  const form: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    initialOutput() {
      assignments++;
      return { hostname: "ordinary.example.invalid" };
    },
    ...(options.admission !== undefined
      ? {
          prepareAdmission: async () => ({
            sql: admissionAllowed ? "1" : "0",
            params: [],
            conflictCode: admissionCode,
            ...(admissionCode === "dependency_conflict" ? { detail: ADMISSION_DETAIL } : {}),
          }),
        }
      : {}),
    ...(options.references
      ? {
          references: () =>
            options.references === "missing"
              ? [{ resourceUid: "missing-target", formUrl: FORM, readiness: "ready" as const }]
              : [],
        }
      : {}),
    ...(options.custody
      ? {
          privateInputs: {
            validateCreate() {},
            validateUpdate() {},
            async prepareCreate() {
              return {
                keyId: "configured-fixture",
                nonce: "configured-nonce",
                ciphertext: "configured-ciphertext",
              };
            },
          },
        }
      : {}),
    backend: {
      id: BACKEND,
      targetKey: TARGET,
      async execute(input) {
        backendCalls++;
        return outcomeUnknown
          ? { kind: "unknown" }
          : { kind: "complete", observed: { ready: true }, output: input.previousOutput };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    },
  };
  const engineOptions: V2EngineOptions = {
    sql,
    now: () => new Date(AT),
    replayWindowSeconds: 3600,
    authorize: async (principal, space) => principal === `org:${space}`,
    forms: { [FORM]: form },
    ...(options.custody ? { privateInputCustody: await privateCustody() } : {}),
  };
  const capability = (
    options.typed
      ? createWorkerEndpointOriginV2FormRouteAcceptance
      : createWorkerEndpointOriginV2Acceptance
  )({
    sql,
    ledger,
    formUrl: FORM,
    backendId: BACKEND,
    targetKey: TARGET,
  });
  const engine = createTakoformV2Engine(engineOptions, capability);
  return {
    db,
    raw,
    sql,
    ledger,
    engine,
    engineOptions,
    capability,
    async reserve(name = "selected-name") {
      return ledger.forTrustedOwner(OWNER).reserve({ reservationId: `reserve-${name}`, name });
    },
    counts: () => ({
      acceptanceBatches,
      committedBatches,
      backendCalls,
      assignments,
      reserves,
      ownerReads,
      dropped,
    }),
    lastBatchError: () => lastBatchError,
    omit(write: OmittedWrite) {
      omit = write;
    },
    loseAck(hideReadback = false) {
      loseAck = true;
      hideAfterCommit = hideReadback;
    },
    restoreReadback() {
      blocked = false;
    },
    unknown() {
      outcomeUnknown = true;
    },
    refuseAdmission(code: "dependency_conflict" | "resource_busy") {
      admissionAllowed = false;
      admissionCode = code;
    },
    holdAcceptances(count = 1) {
      const entered = deferred();
      const release = deferred();
      batchGate = { remaining: count, entered, release };
      return { entered: entered.promise, release: release.resolve };
    },
    holdOriginalRead() {
      const entered = deferred();
      const release = deferred();
      ownerGate = { entered, release };
      return {
        entered: entered.promise,
        release() {
          ownerGate = null;
          release.resolve();
        },
      };
    },
    close() {
      batchGate?.release.resolve();
      ownerGate?.release.resolve();
      db.close();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function createRequest(name = "selected-name", key = "selected-create-key-0001") {
  return {
    principal: PRINCIPAL,
    key,
    input: { form: FORM, space: ORGANIZATION, name, spec: { value: "original" } },
  };
}

function bindings(f: Fixture) {
  return f.db.query(`SELECT * FROM ${BINDINGS}`).all();
}

function assertEmptyAcceptance(f: Fixture): void {
  for (const table of [
    "tf_v2_resources",
    "tf_v2_operations",
    "tf_v2_private_inputs",
    "tf_v2_configured_private_inputs",
    "tf_v2_operation_reference_sets",
    "tf_v2_operation_references",
    "tf_v2_resource_references",
    BINDINGS,
  ]) {
    expect(f.db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  }
}

function bindingAt(f: Fixture, assignment: SharedAppAssignment) {
  return f.db.query(`SELECT * FROM ${BINDINGS} WHERE incarnation=?`).get(assignment.incarnation);
}

async function failedDelete(
  f: Fixture,
  uid: string,
  generation: number,
  effect: "none" | "partial" | "unknown" = "none",
) {
  const accepted = await f.engine.acceptDelete({
    principal: PRINCIPAL,
    key: `delete-gap-${generation}-${effect}-fixture`,
    uid,
    expectedGeneration: generation,
  });
  const store = createV2Store(f.sql);
  const token = crypto.randomUUID();
  expect(await store.claim(accepted.id, token, Date.parse(AT), Date.parse(AT) + 120_000)).toBe(
    true,
  );
  expect(await store.markDispatch(accepted.id, token, AT)).toBe(true);
  expect(
    await store.settle({
      id: accepted.id,
      token,
      status: effect === "unknown" ? "reconciling" : "failed",
      effect,
      at: AT,
      retainUntil: "2026-10-15T01:00:00.000Z",
      ...(effect === "unknown"
        ? {}
        : { error: { code: "fixture_delete_failure", message: "controlled failure" } }),
    }),
  ).toBe(true);
  return accepted;
}

const acceptanceTables = [
  "tf_v2_resources",
  "tf_v2_operations",
  "tf_v2_private_inputs",
  "tf_v2_configured_private_inputs",
  "tf_v2_operation_reference_sets",
  "tf_v2_operation_references",
  "tf_v2_resource_references",
  BINDINGS,
] as const;

test("selected UPDATE after one or two real no-effect DELETEs advances its actual older binding and preserves the original", async () => {
  for (const deletes of [1, 2]) {
    const f = await fixture({ custody: true, references: "empty" });
    try {
      const assignment = await f.reserve();
      const created = await f.engine.acceptCreate({
        ...createRequest(),
        input: { ...createRequest().input, privateInputs: { password: "fixture-create" } },
      });
      expect(await f.engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
      for (let generation = 1; generation <= deletes; generation++)
        await failedDelete(f, created.resourceUid, generation);
      expect(bindingAt(f, assignment)).toMatchObject({
        endpoint_generation: 1,
        current_operation_id: created.id,
      });
      const request = {
        principal: PRINCIPAL,
        key: `update-after-${deletes}-deletes-fixture`,
        uid: created.resourceUid,
        expectedGeneration: deletes + 1,
        spec: { value: "reapplied" },
        privateInputs: { password: "fixture-update" },
      };
      const updated = await f.engine.acceptUpdate(request);
      expect(updated.generation).toBe(deletes + 2);
      expect(bindingAt(f, assignment)).toMatchObject({
        incarnation: assignment.incarnation,
        endpoint_generation: deletes + 2,
        create_operation_id: created.id,
        current_operation_id: updated.id,
      });
      expect(await createV2Store(f.sql).resource(created.resourceUid)).toMatchObject({
        generation: deletes + 2,
        last_operation: updated.id,
        busy_operation: updated.id,
        spec_json: '{"value":"reapplied"}',
      });
      expect(await f.ledger.forTrustedOwner(OWNER).readOriginal(assignment.reservationId)).toEqual(
        assignment,
      );
      expect(
        f.db
          .query("SELECT count(*) AS n FROM tf_v2_private_inputs WHERE operation_id=?")
          .get(updated.id),
      ).toEqual({ n: 1 });
      expect(
        f.db
          .query(
            "SELECT count(*) AS n FROM tf_v2_operation_reference_sets WHERE operation_id=? AND sealed=1",
          )
          .get(updated.id),
      ).toEqual({ n: 1 });
      const writes = f.counts().acceptanceBatches;
      expect((await f.engine.acceptUpdate(request)).id).toBe(updated.id);
      expect(f.counts().acceptanceBatches).toBe(writes);
      expect(await f.engine.runNext()).toMatchObject({ id: updated.id, status: "succeeded" });
    } finally {
      f.close();
    }
  }
});

test("selected UPDATE cannot cross a partial DELETE and unknown DELETE remains busy", async () => {
  for (const effect of ["partial", "unknown"] as const) {
    const f = await fixture();
    try {
      await f.reserve();
      const created = await f.engine.acceptCreate(createRequest());
      await f.engine.runNext();
      await failedDelete(f, created.resourceUid, 1, effect);
      const before = acceptanceTables.map((table) => f.db.query(`SELECT * FROM ${table}`).all());
      const pending = f.engine.acceptUpdate({
        principal: PRINCIPAL,
        key: `update-after-${effect}-delete-fixture`,
        uid: created.resourceUid,
        expectedGeneration: 2,
        spec: { value: "must-not-accept" },
      });
      if (effect === "unknown")
        await expect(pending).rejects.toMatchObject({ code: "resource_busy", status: 409 });
      else await expect(pending).rejects.toBeInstanceOf(SqlError);
      for (const [index, table] of acceptanceTables.entries()) {
        const expected = before[index];
        if (expected === undefined) throw new Error("missing paired durable snapshot");
        expect(f.db.query(`SELECT * FROM ${table}`).all()).toEqual(expected);
      }
    } finally {
      f.close();
    }
  }
});

test("selected UPDATE rechecks earlier DELETE effect and exact binding inside the real accepted batch", async () => {
  for (const race of ["earlier-effect", "binding"] as const) {
    const f = await fixture({ custody: true, references: "empty" });
    try {
      await f.reserve();
      const created = await f.engine.acceptCreate({
        ...createRequest(),
        input: { ...createRequest().input, privateInputs: { password: "fixture-create" } },
      });
      await f.engine.runNext();
      const earlier = await failedDelete(f, created.resourceUid, 1);
      const last = await failedDelete(f, created.resourceUid, 2);
      const held = f.holdAcceptances();
      const pending = f.engine.acceptUpdate({
        principal: PRINCIPAL,
        key: `update-delete-gap-${race}-fixture`,
        uid: created.resourceUid,
        expectedGeneration: 3,
        spec: { value: "must-roll-back" },
        privateInputs: { password: "fixture-update" },
      });
      try {
        await held.entered;
        if (race === "earlier-effect")
          f.db.query("UPDATE tf_v2_operations SET effect='partial' WHERE id=?").run(earlier.id);
        else f.db.query(`UPDATE ${BINDINGS} SET current_operation_id=?`).run(last.id);
        const before = acceptanceTables.map((table) => f.db.query(`SELECT * FROM ${table}`).all());
        held.release();
        await expect(pending).rejects.toBeInstanceOf(SqlError);
        expect(f.lastBatchError()).toMatchObject({
          code: "constraint",
          message: expect.stringContaining(`${BINDINGS}.endpoint_uid`),
        });
        for (const [index, table] of acceptanceTables.entries()) {
          const expected = before[index];
          if (expected === undefined) throw new Error("missing paired durable snapshot");
          expect(f.db.query(`SELECT * FROM ${table}`).all()).toEqual(expected);
        }
      } finally {
        held.release();
      }
    } finally {
      f.close();
    }
  }
});

test("preclaimed CREATE binds actual Core UID without activating or allocating a name", async () => {
  const f = await fixture();
  try {
    const assignment = await f.reserve();
    const accepted = await f.engine.acceptCreate(createRequest());
    expect(bindingAt(f, assignment)).toEqual({
      incarnation: assignment.incarnation,
      organization_id: ORGANIZATION,
      product: "takoserver",
      reservation_id: assignment.reservationId,
      name: assignment.name,
      endpoint_uid: accepted.resourceUid,
      endpoint_generation: 1,
      form_url: FORM,
      backend_id: BACKEND,
      target_key: TARGET,
      create_operation_id: accepted.id,
      current_operation_id: accepted.id,
    });
    expect(
      (await f.engine.getResource({ principal: PRINCIPAL, uid: accepted.resourceUid })).output,
    ).toEqual(SELECTED_OUTPUT);
    expect(await f.ledger.forTrustedOwner(OWNER).readOriginal(assignment.reservationId)).toEqual(
      assignment,
    );
    expect(await f.ledger.readCurrent(assignment.name)).toBeNull();
    expect(f.counts().reserves).toBe(1);
    expect(f.counts().assignments).toBe(0);
    expect(f.db.query("SELECT count(*) AS n FROM shared_app_staging_assignments").get()).toEqual({
      n: 1,
    });
    expect(
      f.db
        .query(`SELECT name FROM sqlite_master
      WHERE name IN ('shared_app_staging_route_commands','shared_app_staging_batch_assertions')`)
        .all(),
    ).toEqual([]);
  } finally {
    f.close();
  }
});

test("selected admission rejects missing, rewritten, foreign-owner and foreign-product claims", async () => {
  const f = await fixture();
  try {
    await f.reserve();
    await f.ledger
      .forTrustedOwner({ organizationId: "foreign-org", product: "takoserver" })
      .reserve({ reservationId: "foreign-owner-reservation", name: "foreign-owner" });
    await f.ledger
      .forTrustedOwner({ organizationId: ORGANIZATION, product: "takosumi-hosted" })
      .reserve({ reservationId: "foreign-product-reservation", name: "foreign-product" });
    const originalReserves = f.counts().reserves;
    for (const name of ["missing-name", "SELECTED-NAME", "foreign-owner", "foreign-product"]) {
      await expect(
        f.engine.acceptCreate(createRequest(name, `refused-${name}-0001`)),
      ).rejects.toThrow();
      assertEmptyAcceptance(f);
    }
    expect(f.counts().reserves).toBe(originalReserves);
  } finally {
    f.close();
  }
});

test("caller mutation during issuer read cannot replace captured Core identity or output", async () => {
  const f = await fixture();
  const gate = f.holdOriginalRead();
  try {
    const assignment = await f.reserve();
    const request = createRequest();
    const pending = f.engine.acceptCreate(request);
    await gate.entered;
    request.principal = "org:other-org";
    request.key = "mutated-create-key-0001";
    request.input.space = "other-org";
    request.input.name = "mutated-name";
    request.input.spec.value = "mutated";
    gate.release();
    const accepted = await pending;
    expect(bindingAt(f, assignment)).toMatchObject({
      endpoint_uid: accepted.resourceUid,
      organization_id: ORGANIZATION,
      name: "selected-name",
      current_operation_id: accepted.id,
    });
    expect(
      await f.engine.getResource({ principal: PRINCIPAL, uid: accepted.resourceUid }),
    ).toMatchObject({
      space: ORGANIZATION,
      name: "selected-name",
      spec: { value: "original" },
      output: SELECTED_OUTPUT,
    });
    expect(
      f.db.query("SELECT principal,replay_key FROM tf_v2_operations WHERE id=?").get(accepted.id),
    ).toEqual({ principal: PRINCIPAL, replay_key: "selected-create-key-0001" });
  } finally {
    gate.release();
    f.close();
  }
});

test("release after prepare leaves zero Core or binding writes when its batch finally runs", async () => {
  const f = await fixture();
  const gate = f.holdAcceptances();
  try {
    const assignment = await f.reserve();
    const pending = f.engine.acceptCreate(createRequest());
    await gate.entered;
    const released = await f.ledger.forTrustedOwner(OWNER).release(assignment);
    gate.release();
    await expect(pending).rejects.toThrow();
    assertEmptyAcceptance(f);
    expect(await f.ledger.forTrustedOwner(OWNER).readOriginal(assignment.reservationId)).toEqual(
      released,
    );
    expect(f.counts().committedBatches).toBe(0);
    expect(f.counts().reserves).toBe(1);
  } finally {
    gate.release();
    f.close();
  }
});

test("two pre-observed Endpoint creates have one Core and binding winner", async () => {
  const f = await fixture();
  const gate = f.holdAcceptances(2);
  try {
    const assignment = await f.reserve();
    const pending = [
      f.engine.acceptCreate(createRequest("selected-name", "race-first-key-0001")),
      f.engine.acceptCreate(createRequest("selected-name", "race-second-key-0001")),
    ];
    await gate.entered;
    gate.release();
    const results = await Promise.allSettled(pending);
    const winner = results.find((value) => value.status === "fulfilled");
    expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((value) => value.status === "rejected")).toHaveLength(1);
    if (winner?.status !== "fulfilled") throw new Error("missing acceptance winner");
    expect(bindings(f)).toHaveLength(1);
    expect(bindingAt(f, assignment)).toMatchObject({
      endpoint_uid: winner.value.resourceUid,
      current_operation_id: winner.value.id,
    });
    expect(f.db.query("SELECT count(*) AS n FROM tf_v2_resources").get()).toEqual({ n: 1 });
    expect(f.db.query("SELECT count(*) AS n FROM tf_v2_operations").get()).toEqual({ n: 1 });
    expect(f.counts().reserves).toBe(1);
  } finally {
    gate.release();
    f.close();
  }
});

for (const write of ["resource", "private", "configured", "reference-seal"] as const) {
  test(`terminal binding NOT NULL aborts a missing required ${write} write`, async () => {
    const f = await fixture({ custody: true, references: "empty" });
    try {
      const assignment = await f.reserve();
      f.omit(write);
      await expect(
        f.engine.acceptCreate({
          ...createRequest(),
          input: { ...createRequest().input, privateInputs: { password: "fixture-input" } },
        }),
      ).rejects.toThrow();
      expect(f.counts().dropped).toBe(1);
      expect(f.lastBatchError()).toBeInstanceOf(SqlError);
      expect((f.lastBatchError() as SqlError).code).toBe("constraint");
      expect((f.lastBatchError() as SqlError).message).toContain(`${BINDINGS}.endpoint_uid`);
      assertEmptyAcceptance(f);
      expect(await f.ledger.forTrustedOwner(OWNER).readOriginal(assignment.reservationId)).toEqual(
        assignment,
      );
    } finally {
      f.close();
    }
  });
}

test("actual 0073 reference guard rolls back selected Core custody without a binding", async () => {
  const f = await fixture({ custody: true, references: "missing" });
  try {
    const assignment = await f.reserve();
    await expect(
      f.engine.acceptCreate({
        ...createRequest(),
        input: { ...createRequest().input, privateInputs: { password: "fixture-input" } },
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict" });
    expect((f.lastBatchError() as SqlError).message).toContain(
      "tf_v2_reference_target_unavailable",
    );
    assertEmptyAcceptance(f);
    expect(await f.ledger.forTrustedOwner(OWNER).readOriginal(assignment.reservationId)).toEqual(
      assignment,
    );
  } finally {
    f.close();
  }
});

test("actual replay UNIQUE failure rolls back the selected candidate Resource and binding", async () => {
  const f = await fixture();
  const gate = f.holdAcceptances();
  try {
    const assignment = await f.reserve();
    const request = createRequest();
    const pending = f.engine.acceptCreate(request);
    await gate.entered;
    await createV2Store(f.raw).insertCreate(
      {
        id: "competing-operation",
        resourceUid: "competing-resource",
        principal: PRINCIPAL,
        key: request.key,
        fingerprint: "different-competing-fingerprint",
        action: "create",
        generation: 1,
        at: AT,
        retainUntil: "2026-10-16T00:00:00.000Z",
        backendId: BACKEND,
        targetKey: TARGET,
        specJson: "{}",
      },
      { form: FORM, space: ORGANIZATION, name: "competing-name" },
    );
    gate.release();
    await expect(pending).rejects.toThrow();
    expect(f.db.query("SELECT uid FROM tf_v2_resources").all()).toEqual([
      { uid: "competing-resource" },
    ]);
    expect(f.db.query("SELECT id FROM tf_v2_operations").all()).toEqual([
      { id: "competing-operation" },
    ]);
    expect(bindings(f)).toEqual([]);
    expect(await f.ledger.forTrustedOwner(OWNER).readOriginal(assignment.reservationId)).toEqual(
      assignment,
    );
  } finally {
    gate.release();
    f.close();
  }
});

test("UPDATE advances Endpoint generation while retaining incarnation and route generation", async () => {
  const f = await fixture();
  try {
    const assignment = await f.reserve();
    const created = await f.engine.acceptCreate(createRequest());
    await f.engine.runNext();
    const updated = await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "selected-update-key-0001",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: { value: "updated" },
    });
    expect(bindingAt(f, assignment)).toMatchObject({
      incarnation: assignment.incarnation,
      endpoint_uid: created.resourceUid,
      endpoint_generation: 2,
      create_operation_id: created.id,
      current_operation_id: updated.id,
    });
    expect(
      (await f.engine.getResource({ principal: PRINCIPAL, uid: created.resourceUid })).output,
    ).toEqual(SELECTED_OUTPUT);
    expect(await f.ledger.forTrustedOwner(OWNER).readOriginal(assignment.reservationId)).toEqual(
      assignment,
    );
    expect(assignment.generation).toBe(1);
    expect(await f.ledger.readCurrent(assignment.name)).toBeNull();
    const before = bindings(f);
    await expect(
      f.engine.acceptUpdate({
        principal: PRINCIPAL,
        key: "selected-stale-update-0001",
        uid: created.resourceUid,
        expectedGeneration: 1,
        spec: { value: "stale" },
      }),
    ).rejects.toThrow();
    expect(bindings(f)).toEqual(before);
    expect(f.db.query("SELECT count(*) AS n FROM tf_v2_operations").get()).toEqual({ n: 2 });
    expect(f.counts().reserves).toBe(1);
  } finally {
    f.close();
  }
});

test("a released claim aborts UPDATE while retaining its prior Resource and binding", async () => {
  const f = await fixture();
  let release = () => {};
  try {
    const assignment = await f.reserve();
    const created = await f.engine.acceptCreate(createRequest());
    await f.engine.runNext();
    const previousBinding = bindings(f);
    const previousResource = await f.engine.getResource({
      principal: PRINCIPAL,
      uid: created.resourceUid,
    });
    const gate = f.holdAcceptances();
    release = gate.release;
    const pending = f.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "released-update-key-0001",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: { value: "must-not-commit" },
    });
    await gate.entered;
    // Fault/race injection through the real old writer, not qualification of its cutover.
    const released = await f.ledger.forTrustedOwner(OWNER).release(assignment);
    gate.release();
    await expect(pending).rejects.toThrow();
    expect(bindings(f)).toEqual(previousBinding);
    expect(await f.engine.getResource({ principal: PRINCIPAL, uid: created.resourceUid })).toEqual(
      previousResource,
    );
    expect(f.db.query("SELECT id FROM tf_v2_operations").all()).toEqual([{ id: created.id }]);
    expect(await f.ledger.forTrustedOwner(OWNER).readOriginal(assignment.reservationId)).toEqual(
      released,
    );
  } finally {
    release();
    f.close();
  }
});

test("lost ACK settles original binding and retained replay never prepares another claim", async () => {
  const f = await fixture();
  try {
    const assignment = await f.reserve();
    f.loseAck();
    const accepted = await f.engine.acceptCreate(createRequest());
    const before = f.counts();
    const retained = createTakoformV2Engine(
      {
        ...f.engineOptions,
        forms: {},
        retainedForms: f.engineOptions.forms,
      },
      f.capability,
    );
    expect((await f.engine.acceptCreate(createRequest())).id).toBe(accepted.id);
    expect((await retained.acceptCreate(createRequest())).resourceUid).toBe(accepted.resourceUid);
    await expect(
      retained.acceptCreate(createRequest("other-name", "retained-new-key-0001")),
    ).rejects.toMatchObject({ code: "unsupported_form" });
    expect(f.counts()).toEqual(before);
    expect(before.acceptanceBatches).toBe(1);
    expect(before.committedBatches).toBe(1);
    expect(bindingAt(f, assignment)).toMatchObject({
      endpoint_uid: accepted.resourceUid,
      create_operation_id: accepted.id,
      current_operation_id: accepted.id,
    });
  } finally {
    f.close();
  }
});

test("unreadable committed ACK remains failed closed until the same request can replay", async () => {
  const f = await fixture();
  try {
    await f.reserve();
    f.loseAck(true);
    await expect(f.engine.acceptCreate(createRequest())).rejects.toThrow();
    const committed = f.db
      .query(`SELECT endpoint_uid,current_operation_id FROM ${BINDINGS}`)
      .get() as { endpoint_uid: string; current_operation_id: string };
    expect(committed).not.toBeNull();
    f.restoreReadback();
    const before = f.counts();
    const replayed = await f.engine.acceptCreate(createRequest());
    expect(replayed.resourceUid).toBe(committed.endpoint_uid);
    expect(replayed.id).toBe(committed.current_operation_id);
    expect(f.counts()).toEqual(before);
    expect(before.reserves).toBe(1);
    expect(before.acceptanceBatches).toBe(1);
  } finally {
    f.close();
  }
});

test("backend UNKNOWN preserves the accepted binding and exact replay without a new claim", async () => {
  const f = await fixture();
  try {
    const assignment = await f.reserve();
    const accepted = await f.engine.acceptCreate(createRequest());
    const beforeBinding = bindings(f);
    f.unknown();
    expect(await f.engine.runNext()).toMatchObject({ status: "reconciling", effect: "unknown" });
    const beforeReplay = f.counts();
    expect((await f.engine.acceptCreate(createRequest())).id).toBe(accepted.id);
    expect(f.counts()).toEqual(beforeReplay);
    expect(bindings(f)).toEqual(beforeBinding);
    expect(await f.ledger.forTrustedOwner(OWNER).readOriginal(assignment.reservationId)).toEqual(
      assignment,
    );
    expect(f.counts().backendCalls).toBe(1);
    expect(f.counts().reserves).toBe(1);
  } finally {
    f.close();
  }
});

test("selected capability refuses a different Sql identity even for the same database", async () => {
  const f = await fixture();
  try {
    expect(() =>
      createTakoformV2Engine({ ...f.engineOptions, sql: { ...f.sql } }, f.capability),
    ).toThrow();
    assertEmptyAcceptance(f);
  } finally {
    f.close();
  }
});

test("serialized construction and raw unissued prepared witnesses cannot write Core state", async () => {
  const f = await fixture();
  try {
    expect(() =>
      createTakoformV2Engine(
        f.engineOptions,
        JSON.parse('{"prepare":{"guard":"caller-selected"}}'),
      ),
    ).toThrow();
    // Host methods are trusted construction, but returned frames must have real issuance.
    const replacement = {
      assertSql(sql: Sql) {
        if (sql !== f.sql) throw new TypeError("fixture requires its original Sql");
      },
      initialOutput() {
        return { ...SELECTED_OUTPUT };
      },
      async prepare() {
        return {
          guard: { sql: "1", params: [] },
          terminal: { sql: "SELECT 1", params: [] },
        } as never;
      },
    };
    const engine = createTakoformV2Engine(f.engineOptions, replacement);
    await expect(engine.acceptCreate(createRequest())).rejects.toThrow();
    expect(f.counts().acceptanceBatches).toBe(0);
    assertEmptyAcceptance(f);
  } finally {
    f.close();
  }
});

test("missing binding schema fails selected admission while default acceptance stays available", async () => {
  const f = await fixture({ bindings: false });
  try {
    await f.reserve();
    await expect(f.engine.acceptCreate(createRequest())).rejects.toThrow();
    expect(f.db.query("SELECT uid FROM tf_v2_resources").all()).toEqual([]);
    expect(f.db.query("SELECT id FROM tf_v2_operations").all()).toEqual([]);
    const ordinary = createTakoformV2Engine(f.engineOptions);
    const accepted = await ordinary.acceptCreate(createRequest("ordinary-name"));
    expect(
      (await ordinary.getResource({ principal: PRINCIPAL, uid: accepted.resourceUid })).output,
    ).toEqual({ hostname: "ordinary.example.invalid" });
    expect(f.counts().reserves).toBe(1);
  } finally {
    f.close();
  }
});

test("existing Form refusal cannot be bypassed by a valid preclaimed binding", async () => {
  const f = await fixture({ admission: false });
  try {
    const assignment = await f.reserve();
    await expect(f.engine.acceptCreate(createRequest())).rejects.toMatchObject({
      code: "dependency_conflict",
      status: 409,
      detail: ADMISSION_DETAIL,
    });
    assertEmptyAcceptance(f);
    expect(await f.ledger.forTrustedOwner(OWNER).readOriginal(assignment.reservationId)).toEqual(
      assignment,
    );
  } finally {
    f.close();
  }
});

test("selected UPDATE preserves the original Form refusal classification and binding", async () => {
  const f = await fixture({ admission: true });
  try {
    const assignment = await f.reserve();
    const created = await f.engine.acceptCreate(createRequest());
    await f.engine.runNext();
    const previousBinding = bindings(f);
    const previousResource = await f.engine.getResource({
      principal: PRINCIPAL,
      uid: created.resourceUid,
    });
    for (const code of ["dependency_conflict", "resource_busy"] as const) {
      f.refuseAdmission(code);
      await expect(
        f.engine.acceptUpdate({
          principal: PRINCIPAL,
          key: `refused-update-${code}-0001`,
          uid: created.resourceUid,
          expectedGeneration: 1,
          spec: { value: "must-not-commit" },
        }),
      ).rejects.toMatchObject({
        code,
        status: 409,
        detail: code === "dependency_conflict" ? ADMISSION_DETAIL : undefined,
      });
      expect(bindings(f)).toEqual(previousBinding);
      expect(bindingAt(f, assignment)).toMatchObject({
        endpoint_generation: 1,
        create_operation_id: created.id,
        current_operation_id: created.id,
      });
      expect(
        await f.engine.getResource({ principal: PRINCIPAL, uid: created.resourceUid }),
      ).toEqual(previousResource);
      expect(f.db.query("SELECT id FROM tf_v2_operations").all()).toEqual([{ id: created.id }]);
    }
  } finally {
    f.close();
  }
});

test("selected Store keeps its construction-bound batch while the issuer read is held", async () => {
  const f = await fixture();
  const originalBatch = f.sql.batch;
  const gate = f.holdOriginalRead();
  let replacementCalls = 0;
  try {
    const assignment = await f.reserve();
    const pending = f.engine.acceptCreate(createRequest());
    await gate.entered;
    f.sql.batch = async () => {
      replacementCalls++;
      throw new Error("replacement batch must not own selected acceptance");
    };
    gate.release();
    const accepted = await pending;
    expect(replacementCalls).toBe(0);
    expect(f.counts().acceptanceBatches).toBe(1);
    expect(bindingAt(f, assignment)).toMatchObject({
      endpoint_uid: accepted.resourceUid,
      current_operation_id: accepted.id,
    });
    expect(
      (await f.engine.getResource({ principal: PRINCIPAL, uid: accepted.resourceUid })).output,
    ).toEqual(SELECTED_OUTPUT);
  } finally {
    f.sql.batch = originalBatch;
    gate.release();
    f.close();
  }
});

test("explicit Form-v2 acceptance reads the typed owner method while scalar construction remains scalar", async () => {
  const f = await fixture({ typed: true, references: "empty" });
  try {
    const original = await f.reserve();
    const actual = f.ledger.forTrustedOwner.bind(f.ledger);
    let scalarReads = 0;
    let typedReads = 0;
    f.ledger.forTrustedOwner = (owner) => {
      const selected = actual(owner);
      return {
        ...selected,
        async readOriginal() {
          scalarReads++;
          throw new Error("scalar decoder must not see a typed path");
        },
        async readOriginalRoute(id) {
          typedReads++;
          return selected.readOriginalRoute(id);
        },
      };
    };
    const operation = await f.engine.acceptCreate(createRequest());
    expect(operation.generation).toBe(1);
    expect(scalarReads).toBe(0);
    expect(typedReads).toBeGreaterThan(0);
    expect(bindings(f)).toHaveLength(1);
    expect(bindingAt(f, original)).toMatchObject({
      endpoint_uid: operation.resourceUid,
      endpoint_generation: 1,
      current_operation_id: operation.id,
    });
    expect(
      f.db
        .query(
          "SELECT generation,state,binding_kind,binding_json FROM shared_app_staging_assignments",
        )
        .get(),
    ).toEqual({
      generation: 1,
      state: "reserved",
      binding_kind: null,
      binding_json: null,
    });
    expect(f.counts().backendCalls).toBe(0);
  } finally {
    f.close();
  }
});

test("explicit typed acceptance retains tags and fences the actual claim without changing route generation", async () => {
  const f = await fixture({ typed: true, references: "empty" });
  try {
    const original = await f.reserve();
    // A non-serving tagged fixture exercises the separate decoder. Actual
    // live tagged publication and subsequent UPDATE are tested in the receiver
    // file with real Core/0074/history/native rows, not fabricated here.
    await f.sql.run(
      "UPDATE shared_app_staging_assignments SET binding_kind='form-v2@1' WHERE incarnation=?",
      [original.incarnation],
    );
    const created = await f.engine.acceptCreate(createRequest());
    expect(await f.engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
    const before = f.db.query(`SELECT * FROM ${BINDINGS}`).all();
    const updated = await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "explicit-typed-update",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec: {},
    });
    expect(updated.generation).toBe(2);
    expect(
      f.db.query(`SELECT endpoint_generation,current_operation_id FROM ${BINDINGS}`).get(),
    ).toEqual({
      endpoint_generation: 2,
      current_operation_id: updated.id,
    });
    expect(
      f.db.query("SELECT generation,binding_kind FROM shared_app_staging_assignments").get(),
    ).toEqual({ generation: 1, binding_kind: "form-v2@1" });
    expect(before).toHaveLength(1);
    await expect(
      f.ledger.forTrustedOwner(OWNER).readOriginal(original.reservationId),
    ).rejects.toMatchObject({ code: "unavailable" });
  } finally {
    f.close();
  }
});

test("typed compiler never falls back on malformed tag data or a different Sql identity", async () => {
  const f = await fixture({ typed: true, references: "empty" });
  try {
    await f.reserve();
    expect(() => f.capability.assertSql({ ...f.sql })).toThrow("same atomic Sql");
    f.capability.assertSql(f.sql);
    // Real fixture CHECK is deliberately bypassed solely to emulate corrupt
    // persisted data; the actual typed reader must still fail closed.
    f.db.exec("PRAGMA ignore_check_constraints=ON");
    f.db.exec("UPDATE shared_app_staging_assignments SET binding_kind='future@9'");
    f.db.exec("PRAGMA ignore_check_constraints=OFF");
    await expect(f.engine.acceptCreate(createRequest())).rejects.toBeDefined();
    expect(f.db.query("SELECT count(*) AS n FROM tf_v2_resources").get()).toEqual({ n: 0 });
    expect(bindings(f)).toEqual([]);
  } finally {
    f.close();
  }
});
