import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { canonicalJson } from "../src/json.ts";
import type { Sql, SqlStatement } from "../src/ports.ts";
import {
  createSharedAppLedger,
  type SharedAppAssignment,
  type SharedAppFormV2Binding,
  type SharedAppFormV2RouteEffects,
  type SharedAppNativeRouteRowPin,
  type SharedAppNativeRouteSnapshot,
  type SharedAppRouteAssignment,
  type SharedAppRouteEffects,
  type TrustedSharedAppFormV2RouteInput,
  type TrustedSharedAppRouteGuards,
  type TrustedSharedAppRouteInput,
} from "../src/shared-app-ledger.ts";
import { createD1Sql } from "../src/sql-d1.ts";

const OWNER = { organizationId: "org-server", product: "takoserver" as const };
const HOSTNAME = "route-update.app-staging.takos.jp";
const START = Date.parse("2026-10-15T00:00:00Z");

async function harness(routeSchema = true, formV2Schema = false) {
  const id = `route-commands-${crypto.randomUUID()}`;
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: id,
          type: "worker",
          compatibilityDate: "2026-08-17",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { DB: { type: "d1", id } },
          triggers: [],
        },
      },
    ],
  });
  const database = await runtime.getD1Database("DB");
  const sql = createD1Sql(database);
  // UNALLOCATED TEST-ONLY fixture. No migration file, registry or live schema is changed.
  for (const realm of ["staging", "production"]) {
    const prefix = `shared_app_${realm}`;
    const assignmentChecks = formV2Schema
      ? `CHECK((binding_kind IS NULL AND binding_json IS NULL
          AND (state<>'reserved' OR script IS NULL) AND (state<>'active' OR script IS NOT NULL))
        OR (binding_kind IS 'form-v2@1' AND script IS NULL AND
          ((state IN ('reserved','released') AND binding_json IS NULL)
            OR (state='active' AND binding_json IS NOT NULL AND CASE WHEN json_valid(binding_json)=1
              THEN json_type(binding_json) IS 'object'
                AND json_type(binding_json,'$.kind') IS 'text'
                AND json_extract(binding_json,'$.kind') IS 'form-v2@1' ELSE 0 END))))`
      : `CHECK(state<>'reserved' OR script IS NULL), CHECK(state<>'active' OR script IS NOT NULL)`;
    await sql.run(`CREATE TABLE ${prefix}_assignments (
      incarnation TEXT PRIMARY KEY, name TEXT NOT NULL, organization_id TEXT NOT NULL,
      product TEXT NOT NULL, reservation_id TEXT NOT NULL, generation INTEGER NOT NULL,
      state TEXT NOT NULL, script TEXT, released_at INTEGER, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${formV2Schema ? ", binding_kind TEXT, binding_json TEXT" : ""}, UNIQUE(organization_id,reservation_id),
      CHECK(generation BETWEEN 1 AND 9007199254740990), CHECK(updated_at >= created_at),
      CHECK(state IN ('reserved','active','released')), CHECK((state='released')=(released_at IS NOT NULL)),
      ${assignmentChecks})`);
    await sql.run(`CREATE TABLE ${prefix}_names (
      normalized_name TEXT PRIMARY KEY, incarnation TEXT NOT NULL REFERENCES ${prefix}_assignments(incarnation),
      generation INTEGER NOT NULL, state TEXT NOT NULL, released_at INTEGER, updated_at INTEGER NOT NULL,
      CHECK(generation BETWEEN 1 AND 9007199254740990), CHECK((state='released')=(released_at IS NOT NULL)))`);
    if (!routeSchema) continue;
    const historyChecks = formV2Schema
      ? `CHECK((form_v2_original_json IS NULL
          AND ((action='activate' AND prior_state='reserved' AND prior_script IS NULL)
            OR (action<>'activate' AND prior_state='active' AND prior_script IS NOT NULL))
          AND ((action='retire' AND next_state='reserved' AND next_script IS NULL)
            OR (action<>'retire' AND next_state='active' AND next_script IS NOT NULL)))
        OR (form_v2_original_json IS NOT NULL AND CASE WHEN json_valid(form_v2_original_json)=1 THEN
          json_type(form_v2_original_json) IS 'object'
          AND json_extract(form_v2_original_json,'$.action') IS action
          AND ((action='activate' AND prior_state='reserved') OR (action<>'activate' AND prior_state='active'))
          AND ((json_extract(form_v2_original_json,'$.expected.kind') IS 'scalar'
              AND json_extract(form_v2_original_json,'$.expected.value.script') IS prior_script)
            OR (json_extract(form_v2_original_json,'$.expected.kind') IS 'form-v2@1' AND prior_script IS NULL))
          AND next_script IS NULL
          AND ((action='retire' AND next_state='reserved') OR (action<>'retire' AND next_state='active'))
          ELSE 0 END))`
      : `CHECK((action='activate' AND prior_state='reserved' AND prior_script IS NULL)
        OR (action<>'activate' AND prior_state='active' AND prior_script IS NOT NULL)),
      CHECK((action='retire' AND next_state='reserved' AND next_script IS NULL)
        OR (action<>'retire' AND next_state='active' AND next_script IS NOT NULL))`;
    await sql.run(`CREATE TABLE ${prefix}_route_commands (
      organization_id TEXT NOT NULL, product TEXT NOT NULL, reservation_id TEXT NOT NULL,
      name TEXT NOT NULL, incarnation TEXT NOT NULL REFERENCES ${prefix}_assignments(incarnation),
      action TEXT NOT NULL CHECK(action IN ('activate','advance','retire')), command_ref TEXT NOT NULL,
      prior_generation INTEGER NOT NULL, prior_state TEXT NOT NULL, prior_script TEXT, next_script TEXT,
      endpoint_uid TEXT NOT NULL, endpoint_generation INTEGER NOT NULL, worker_uid TEXT NOT NULL,
      deployment_uid TEXT NOT NULL, deployment_generation INTEGER NOT NULL, source_operation_id TEXT NOT NULL,
      provider_id TEXT NOT NULL, target_key TEXT NOT NULL, next_generation INTEGER NOT NULL,
      next_state TEXT NOT NULL, created_at INTEGER NOT NULL${formV2Schema ? ", form_v2_original_json TEXT" : ""},
      PRIMARY KEY(organization_id,command_ref), UNIQUE(incarnation,next_generation),
      CHECK(next_generation=prior_generation+1), CHECK(next_generation BETWEEN 2 AND 9007199254740990),
      ${historyChecks})`);
    await sql.run(`CREATE TABLE ${prefix}_batch_assertions (
      witness TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1),
      apply_effects INTEGER NOT NULL CHECK(apply_effects IN (0,1)))`);
  }
  // Realistic owner-side accepted graph and host projection, intentionally not the actual runtime mount.
  await sql.run(`CREATE TABLE fixture_accepted (
    endpoint_uid TEXT PRIMARY KEY, organization_id TEXT NOT NULL, endpoint_generation INTEGER NOT NULL,
    worker_uid TEXT NOT NULL, deployment_uid TEXT NOT NULL, deployment_generation INTEGER NOT NULL,
    source_operation_id TEXT NOT NULL, provider_id TEXT NOT NULL, target_key TEXT NOT NULL, script TEXT)`);
  await sql.run(`CREATE TABLE fixture_routes (
    hostname TEXT PRIMARY KEY, organization_id TEXT NOT NULL, incarnation TEXT NOT NULL,
    generation INTEGER NOT NULL, script TEXT NOT NULL, command_ref TEXT NOT NULL,
    endpoint_uid TEXT NOT NULL, endpoint_generation INTEGER NOT NULL, worker_uid TEXT NOT NULL,
    deployment_uid TEXT NOT NULL, deployment_generation INTEGER NOT NULL, source_operation_id TEXT NOT NULL,
    provider_id TEXT NOT NULL, target_key TEXT NOT NULL)`);
  if (formV2Schema) {
    // Controlled existing native-owner relation, not another name/history ledger
    // and not a native grant. Actual Engine/Store source proof belongs to the
    // closed receiver suite; these tests exercise its ledger/owner SQL atom.
    await sql.run(`CREATE TABLE cloudflare_managed_worker_routes (
      provider_id TEXT NOT NULL, route_kind TEXT NOT NULL, route_key TEXT NOT NULL,
      owner_native_id TEXT NOT NULL, generation INTEGER NOT NULL,
      operation_id TEXT NOT NULL, state TEXT NOT NULL, value_json TEXT NOT NULL,
      PRIMARY KEY(provider_id,route_kind,route_key), UNIQUE(provider_id,operation_id))`);
  }
  let blocked = false;
  let reads = 0;
  let now = START;
  const primary = (): Sql => ({
    ...sql,
    async query(query, params) {
      reads++;
      if (blocked) throw new Error("injected primary read transport loss");
      return sql.query(query, params);
    },
  });
  const ledger = createSharedAppLedger({
    environment: "staging",
    primary,
    clock: () => new Date(now),
  });
  return {
    sql,
    ledger,
    close: () => runtime.dispose(),
    block: (value: boolean) => {
      blocked = value;
    },
    reads: () => reads,
    setNow: (value: number) => {
      now = value;
    },
  };
}

function input(
  expected: SharedAppAssignment,
  revision: number,
  script: string | null,
  commandRef = `v2-host-route-${revision}`,
): TrustedSharedAppRouteInput {
  return {
    commandRef,
    expected,
    accepted: {
      principal: `org:${OWNER.organizationId}`,
      space: OWNER.organizationId,
      endpointUid: "endpoint-actual",
      endpointGeneration: 1,
      workerUid: "worker-actual",
      deploymentUid: "deployment-actual",
      deploymentGeneration: revision,
      sourceOperationId: `accepted-deployment-operation-${revision}`,
      providerId: "provider-actual",
      targetKey: "target-actual",
      script,
    },
  };
}

async function accept(sql: Sql, command: TrustedSharedAppRouteInput) {
  const a = command.accepted;
  await sql.run(
    `INSERT INTO fixture_accepted VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(endpoint_uid) DO UPDATE SET organization_id=excluded.organization_id,
    endpoint_generation=excluded.endpoint_generation, worker_uid=excluded.worker_uid,
    deployment_uid=excluded.deployment_uid, deployment_generation=excluded.deployment_generation,
    source_operation_id=excluded.source_operation_id, provider_id=excluded.provider_id,
    target_key=excluded.target_key, script=excluded.script`,
    [
      a.endpointUid,
      command.expected.organizationId,
      a.endpointGeneration,
      a.workerUid,
      a.deploymentUid,
      a.deploymentGeneration,
      a.sourceOperationId,
      a.providerId,
      a.targetKey,
      a.script,
    ],
  );
}

function guards(command: TrustedSharedAppRouteInput): TrustedSharedAppRouteGuards {
  const a = command.accepted;
  const previousRoute =
    command.expected.state === "reserved"
      ? { sql: "NOT EXISTS (SELECT 1 FROM fixture_routes WHERE hostname=?)", params: [HOSTNAME] }
      : {
          sql: `EXISTS (SELECT 1 FROM fixture_routes WHERE hostname=? AND organization_id=?
        AND incarnation=? AND generation=? AND script=?)`,
          params: [
            HOSTNAME,
            command.expected.organizationId,
            command.expected.incarnation,
            command.expected.generation,
            command.expected.script,
          ],
        };
  return {
    admission: {
      sql: `EXISTS (SELECT 1 FROM fixture_accepted WHERE endpoint_uid=? AND organization_id=?
      AND endpoint_generation=? AND worker_uid=? AND deployment_uid=? AND deployment_generation=?
      AND source_operation_id=? AND provider_id=? AND target_key=? AND script IS ?)
      AND (${previousRoute.sql})`,
      params: [
        a.endpointUid,
        command.expected.organizationId,
        a.endpointGeneration,
        a.workerUid,
        a.deploymentUid,
        a.deploymentGeneration,
        a.sourceOperationId,
        a.providerId,
        a.targetKey,
        a.script,
        ...previousRoute.params,
      ],
    },
    publication:
      a.script === null
        ? { sql: "NOT EXISTS (SELECT 1 FROM fixture_routes WHERE hostname=?)", params: [HOSTNAME] }
        : {
            sql: `EXISTS (SELECT 1 FROM fixture_routes WHERE hostname=? AND organization_id=?
          AND incarnation=? AND generation=? AND script=? AND command_ref=?
          AND endpoint_uid=? AND endpoint_generation=? AND worker_uid=? AND deployment_uid=?
          AND deployment_generation=? AND source_operation_id=? AND provider_id=? AND target_key=?)`,
            params: [
              HOSTNAME,
              command.expected.organizationId,
              command.expected.incarnation,
              command.expected.generation + 1,
              a.script,
              command.commandRef,
              a.endpointUid,
              a.endpointGeneration,
              a.workerUid,
              a.deploymentUid,
              a.deploymentGeneration,
              a.sourceOperationId,
              a.providerId,
              a.targetKey,
            ],
          },
  };
}

function routeMutation(plan: SharedAppRouteEffects, refuse = false): SqlStatement {
  const c = plan.original;
  const extra = refuse ? "0" : "1";
  if (c.action === "retire")
    return {
      sql: `DELETE FROM fixture_routes WHERE hostname=? AND incarnation=? AND generation=?
      AND (${plan.publicationGuard.sql}) AND ${extra}`,
      params: [
        HOSTNAME,
        c.incarnation,
        c.expectedGeneration,
        ...(plan.publicationGuard.params ?? []),
      ],
    };
  return {
    sql: `INSERT INTO fixture_routes SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE (${plan.publicationGuard.sql}) AND ${extra}
      ON CONFLICT(hostname) DO UPDATE SET organization_id=excluded.organization_id,
      incarnation=excluded.incarnation, generation=excluded.generation, script=excluded.script,
      command_ref=excluded.command_ref, endpoint_uid=excluded.endpoint_uid,
      endpoint_generation=excluded.endpoint_generation, worker_uid=excluded.worker_uid,
      deployment_uid=excluded.deployment_uid, deployment_generation=excluded.deployment_generation,
      source_operation_id=excluded.source_operation_id, provider_id=excluded.provider_id,target_key=excluded.target_key
      WHERE (${plan.publicationGuard.sql}) AND ${extra}`,
    params: [
      HOSTNAME,
      c.organizationId,
      c.incarnation,
      c.expectedGeneration + 1,
      c.acceptedScript,
      c.commandRef,
      c.endpointUid,
      c.endpointGeneration,
      c.workerUid,
      c.deploymentUid,
      c.deploymentGeneration,
      c.sourceOperationId,
      c.providerId,
      c.targetKey,
      ...(plan.publicationGuard.params ?? []),
      ...(plan.publicationGuard.params ?? []),
    ],
  };
}

function batch(plan: SharedAppRouteEffects, refuse = false): readonly SqlStatement[] {
  return [...plan.before, routeMutation(plan, refuse), ...plan.after];
}

async function start(h: Awaited<ReturnType<typeof harness>>) {
  const owner = h.ledger.forTrustedOwner(OWNER);
  const reservation = await owner.reserve({
    reservationId: "reservation-actual",
    name: "route-update",
  });
  const command = input(reservation, 1, "immutable-script-one");
  await accept(h.sql, command);
  const plan = owner.prepareActivate(command, guards(command));
  await h.sql.batch(batch(plan));
  const active = (await owner.settleRoute(plan.original, "acknowledged")).assignment;
  return { owner, reservation, active, plan };
}

test("native OLD schema supports legacy APIs but new prepared commands fail without a silent fallback", async () => {
  const h = await harness(false);
  try {
    const owner = h.ledger.forTrustedOwner(OWNER);
    const held = await owner.reserve({ reservationId: "old-schema", name: "route-update" });
    const command = input(held, 1, "immutable-script-one");
    await accept(h.sql, command);
    const plan = owner.prepareActivate(command, guards(command));
    expect(
      await h.sql.query(
        "SELECT name FROM sqlite_master WHERE name IN ('shared_app_staging_route_commands','shared_app_staging_batch_assertions')",
      ),
    ).toEqual([]);
    await expect(h.sql.batch(batch(plan))).rejects.toMatchObject({ code: "unavailable" });
    expect(await owner.readOriginal(held.reservationId)).toEqual(held);
    await expect(owner.settleRoute(plan.original, "unknown")).rejects.toMatchObject({
      code: "indeterminate",
      original: plan.original,
    });
    const active = await owner.activate(held, "legacy-script");
    expect((await h.ledger.readCurrent("route-update"))?.script).toBe("legacy-script");
    const released = await owner.release(active);
    expect(released.state).toBe("released");
    expect(await h.ledger.readCurrent("route-update")).toBeNull();
  } finally {
    await h.close();
  }
});

test("native D1 activate/advance/retire/republish keep tenant incarnation and monotonic immutable route history", async () => {
  const h = await harness();
  try {
    const { owner, reservation, active, plan } = await start(h);
    const successor = input(active, 2, "immutable-script-two");
    await accept(h.sql, successor);
    const advance = owner.prepareAdvance(successor, guards(successor));
    await h.sql.batch(batch(advance));
    const updated = (await owner.settleRoute(advance.original, "acknowledged")).assignment;
    expect(updated).toMatchObject({
      incarnation: reservation.incarnation,
      generation: 3,
      script: "immutable-script-two",
    });
    expect(
      await h.ledger.isCurrentBeforeDispatch({ ...active, script: "immutable-script-one" }),
    ).toBe(false);
    expect(
      await h.ledger.isCurrentAfterDispatch({ ...updated, script: "immutable-script-two" }),
    ).toBe(true);
    const retiredCommand = input(updated, 3, null);
    await accept(h.sql, retiredCommand);
    const retire = owner.prepareRetire(retiredCommand, guards(retiredCommand));
    await h.sql.batch(batch(retire));
    const held = (await owner.settleRoute(retire.original, "acknowledged")).assignment;
    expect(held).toMatchObject({
      incarnation: reservation.incarnation,
      generation: 4,
      state: "reserved",
      script: null,
      releasedAt: null,
    });
    expect(await h.ledger.readCurrent("route-update")).toBeNull();
    const republishCommand = input(held, 4, "immutable-script-four");
    await accept(h.sql, republishCommand);
    const republish = owner.prepareActivate(republishCommand, guards(republishCommand));
    await h.sql.batch(batch(republish));
    const republished = (await owner.settleRoute(republish.original, "acknowledged")).assignment;
    expect(republished).toMatchObject({
      incarnation: reservation.incarnation,
      generation: 5,
      state: "active",
    });
    expect((await owner.readRouteCommand(plan.original.commandRef))?.assignment).toEqual(active);
    expect(
      await h.sql.query(
        "SELECT prior_generation,next_generation FROM shared_app_staging_route_commands ORDER BY next_generation",
      ),
    ).toEqual([
      { prior_generation: 1, next_generation: 2 },
      { prior_generation: 2, next_generation: 3 },
      { prior_generation: 3, next_generation: 4 },
      { prior_generation: 4, next_generation: 5 },
    ]);
    expect(await h.sql.query("SELECT * FROM shared_app_staging_batch_assertions")).toEqual([]);
    expect(await h.sql.query("SELECT * FROM shared_app_production_route_commands")).toEqual([]);
  } finally {
    await h.close();
  }
});

test("native D1 zero-row owner route guard fails a constraint and rolls back ledger/history/witness writes", async () => {
  const h = await harness();
  try {
    const { owner, active } = await start(h);
    const command = input(active, 2, "immutable-script-two");
    await accept(h.sql, command);
    const plan = owner.prepareAdvance(command, guards(command));
    const before = await h.sql.query("SELECT * FROM shared_app_staging_route_commands");
    await expect(h.sql.batch(batch(plan, true))).rejects.toMatchObject({ code: "constraint" });
    expect(await owner.readOriginal(active.reservationId)).toEqual(active);
    expect(await h.sql.query("SELECT * FROM shared_app_staging_route_commands")).toEqual(before);
    expect(await h.sql.query("SELECT * FROM shared_app_staging_batch_assertions")).toEqual([]);
    expect(await h.sql.query("SELECT generation,script FROM fixture_routes")).toEqual([
      { generation: 2, script: "immutable-script-one" },
    ]);
    await expect(h.sql.batch([...plan.before, ...plan.after])).rejects.toMatchObject({
      code: "constraint",
    });
    expect(await owner.readOriginal(active.reservationId)).toEqual(active);
    await expect(h.sql.batch([routeMutation(plan), ...plan.after])).rejects.toMatchObject({
      code: "constraint",
    });
    expect(await owner.readOriginal(active.reservationId)).toEqual(active);
    await h.sql.batch(batch(plan));
    expect((await owner.settleRoute(plan.original, "acknowledged")).assignment.generation).toBe(3);
  } finally {
    await h.close();
  }
});

test("native D1 historical exact replay never rewinds a newer route, and changed original pins conflict", async () => {
  const h = await harness();
  try {
    const { owner, active, plan: first } = await start(h);
    const command = input(active, 2, "immutable-script-two");
    await accept(h.sql, command);
    const second = owner.prepareAdvance(command, guards(command));
    await h.sql.batch(batch(second));
    const history = await h.sql.query(
      "SELECT * FROM shared_app_staging_route_commands ORDER BY next_generation",
    );
    const routes = await h.sql.query("SELECT * FROM fixture_routes");
    // Both replayed plans have stale admission predicates now; exact history still settles with no route mutation.
    await h.sql.batch(batch(first));
    await h.sql.batch(batch(second));
    expect(await h.sql.query("SELECT * FROM fixture_routes")).toEqual(routes);
    expect(
      await h.sql.query("SELECT * FROM shared_app_staging_route_commands ORDER BY next_generation"),
    ).toEqual(history);
    expect((await owner.settleRoute(first.original, "acknowledged")).assignment).toEqual(active);
    const current = await owner.readOriginal(active.reservationId);
    if (!current) throw new Error("missing current fixture assignment");
    const changed = input(current, 3, "immutable-script-three", second.original.commandRef);
    await accept(h.sql, changed);
    const conflict = owner.prepareAdvance(changed, guards(changed));
    await expect(h.sql.batch(batch(conflict))).rejects.toMatchObject({ code: "constraint" });
    await expect(owner.settleRoute(conflict.original, "unknown")).rejects.toMatchObject({
      code: "conflict",
    });
    expect(
      await h.sql.query("SELECT * FROM shared_app_staging_route_commands ORDER BY next_generation"),
    ).toEqual(history);
    expect(await h.sql.query("SELECT * FROM fixture_routes")).toEqual(routes);
  } finally {
    await h.close();
  }
});

test("native D1 prepared caller strings cannot replace the actual accepted graph", async () => {
  const h = await harness();
  try {
    const { owner, active } = await start(h);
    const accepted = input(active, 2, "immutable-script-two");
    await accept(h.sql, accepted);
    const forged = input(active, 2, "unaccepted-script");
    const plan = owner.prepareAdvance(forged, guards(forged));
    await expect(h.sql.batch(batch(plan))).rejects.toMatchObject({ code: "constraint" });
    expect(await owner.readOriginal(active.reservationId)).toEqual(active);
    expect(await owner.readRouteCommand(plan.original.commandRef)).toBeNull();
    expect(() =>
      owner.prepareAdvance(
        { ...accepted, accepted: { ...accepted.accepted, principal: "org:foreign" } },
        guards(accepted),
      ),
    ).toThrow(expect.objectContaining({ code: "conflict" }));
  } finally {
    await h.close();
  }
});

test("native D1 owner collision guard refuses a foreign host projection without partial ledger history", async () => {
  const h = await harness();
  try {
    const { owner, active } = await start(h);
    const command = input(active, 2, "immutable-script-two");
    await accept(h.sql, command);
    const plan = owner.prepareAdvance(command, guards(command));
    await h.sql.run("UPDATE fixture_routes SET organization_id=?,incarnation=? WHERE hostname=?", [
      "foreign-org",
      "b".repeat(32),
      HOSTNAME,
    ]);
    await expect(h.sql.batch(batch(plan))).rejects.toMatchObject({ code: "constraint" });
    expect(await owner.readOriginal(active.reservationId)).toEqual(active);
    expect(await owner.readRouteCommand(plan.original.commandRef)).toBeNull();
    expect(await h.sql.query("SELECT organization_id FROM fixture_routes")).toEqual([
      { organization_id: "foreign-org" },
    ]);
    expect(await h.sql.query("SELECT * FROM shared_app_staging_batch_assertions")).toEqual([]);
  } finally {
    await h.close();
  }
});

test("native D1 preserves the existing v2 owner's qualified255-character target key exactly", async () => {
  const h = await harness();
  try {
    const { owner, active } = await start(h);
    const command = input(active, 2, "immutable-script-two");
    const targetKey = `target/${"q".repeat(248)}`;
    const qualified = { ...command, accepted: { ...command.accepted, targetKey } };
    await accept(h.sql, qualified);
    const plan = owner.prepareAdvance(qualified, guards(qualified));
    await h.sql.batch(batch(plan));
    expect((await owner.settleRoute(plan.original, "acknowledged")).original.targetKey).toBe(
      targetKey,
    );
    expect(await h.sql.query("SELECT target_key FROM fixture_routes")).toEqual([
      { target_key: targetKey },
    ]);
    expect(() =>
      owner.prepareAdvance(
        { ...qualified, accepted: { ...qualified.accepted, targetKey: `${targetKey}x` } },
        guards(qualified),
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_argument" }));
  } finally {
    await h.close();
  }
});

test("native D1 snapshots trusted input/guards before await and lost ACK retains exact original command", async () => {
  const h = await harness();
  try {
    const { owner, active } = await start(h);
    const command = input(active, 2, "immutable-script-two");
    await accept(h.sql, command);
    const mutable = JSON.parse(JSON.stringify(command)) as TrustedSharedAppRouteInput;
    const mutableGuards = JSON.parse(
      JSON.stringify(guards(command)),
    ) as TrustedSharedAppRouteGuards;
    const reads = h.reads();
    const plan = owner.prepareAdvance(mutable, mutableGuards);
    expect(h.reads()).toBe(reads);
    (mutable.accepted as { script: string }).script = "changed-after-capture";
    (mutable.expected as { generation: number }).generation = 400;
    (mutableGuards.admission.params as (string | number | null)[])[0] = "foreign-endpoint";
    expect(Object.isFrozen(plan.before[0]?.params)).toBe(true);
    const loseAck = async () => {
      await h.sql.batch(batch(plan));
      h.block(true);
      throw new Error("lost ACK after native commit");
    };
    await expect(loseAck()).rejects.toThrow("lost ACK");
    await expect(owner.settleRoute(plan.original, "unknown")).rejects.toMatchObject({
      code: "indeterminate",
      original: plan.original,
    });
    h.block(false);
    const settled = await owner.settleRoute(plan.original, "unknown");
    expect(settled.original).toEqual(plan.original);
    expect(settled.assignment).toMatchObject({
      generation: 3,
      script: "immutable-script-two",
      incarnation: active.incarnation,
    });
    const successor = input(settled.assignment, 3, "immutable-script-three");
    await accept(h.sql, successor);
    const next = owner.prepareAdvance(successor, guards(successor));
    await h.sql.batch(batch(next));
    expect((await owner.settleRoute(plan.original, "unknown")).assignment.generation).toBe(3);
    expect((await h.ledger.readCurrent("route-update"))?.generation).toBe(4);
    expect(await h.sql.query("SELECT COUNT(*) n FROM shared_app_staging_route_commands")).toEqual([
      { n: 3 },
    ]);
  } finally {
    await h.close();
  }
});

test("native D1 unknown missing ACK never mints a new reference or writes a recovery command", async () => {
  const h = await harness();
  try {
    const { owner, active } = await start(h);
    const command = input(active, 2, "immutable-script-two");
    const plan = owner.prepareAdvance(command, guards(command));
    await expect(owner.settleRoute(plan.original, "unknown")).rejects.toMatchObject({
      code: "indeterminate",
      original: plan.original,
    });
    await expect(owner.settleRoute(plan.original, "acknowledged")).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await owner.readOriginal(active.reservationId)).toEqual(active);
    expect(await h.sql.query("SELECT COUNT(*) n FROM shared_app_staging_route_commands")).toEqual([
      { n: 1 },
    ]);
  } finally {
    await h.close();
  }
});

test("native D1 concurrent out-of-order accepted old/new publications only commit the current accepted original", async () => {
  for (const reverse of [false, true]) {
    const h = await harness();
    try {
      const { owner, active } = await start(h);
      const old = input(active, 2, "immutable-script-old");
      await accept(h.sql, old);
      const stale = owner.prepareAdvance(old, guards(old));
      const current = input(active, 3, "immutable-script-current");
      await accept(h.sql, current);
      const fresh = owner.prepareAdvance(current, guards(current));
      const plans = reverse ? [fresh, stale] : [stale, fresh];
      const results = await Promise.allSettled(plans.map((plan) => h.sql.batch(batch(plan))));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results[reverse ? 0 : 1]?.status).toBe("fulfilled");
      expect((await h.ledger.readCurrent("route-update"))?.script).toBe("immutable-script-current");
      expect(await owner.readRouteCommand(stale.original.commandRef)).toBeNull();
      expect((await owner.readRouteCommand(fresh.original.commandRef))?.assignment.generation).toBe(
        3,
      );
      expect(await h.sql.query("SELECT generation,script FROM fixture_routes")).toEqual([
        { generation: 3, script: "immutable-script-current" },
      ]);
    } finally {
      await h.close();
    }
  }
});

test("native D1 concurrent release and normal update CAS fence an old route projection", async () => {
  const h = await harness();
  try {
    const { owner, active } = await start(h);
    const command = input(active, 2, "immutable-script-two");
    await accept(h.sql, command);
    const plan = owner.prepareAdvance(command, guards(command));
    const results = await Promise.allSettled([owner.release(active), h.sql.batch(batch(plan))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const final = await owner.readOriginal(active.reservationId);
    if (!final) throw new Error("missing final fixture assignment");
    expect(final.generation).toBe(3);
    expect(final.incarnation).toBe(active.incarnation);
    if (final.state === "active") {
      expect((await h.ledger.readCurrent("route-update"))?.script).toBe("immutable-script-two");
      expect((await owner.readRouteCommand(plan.original.commandRef))?.assignment).toEqual(final);
    } else {
      expect(final.state).toBe("released");
      expect(await h.ledger.readCurrent("route-update")).toBeNull();
      expect(await owner.readRouteCommand(plan.original.commandRef)).toBeNull();
      // A legacy projection may remain, but neither gateway fence may authorize it.
      expect(
        await h.ledger.isCurrentBeforeDispatch({ ...active, script: "immutable-script-one" }),
      ).toBe(false);
    }
    expect((await owner.readRouteCommand("v2-host-route-1"))?.assignment).toEqual(active);
  } finally {
    await h.close();
  }
});

test("native D1 original history and permanent release refuse reassignment and foreign recovery", async () => {
  const h = await harness();
  try {
    const { owner, active, plan } = await start(h);
    const retireCommand = input(active, 2, null);
    await accept(h.sql, retireCommand);
    const retire = owner.prepareRetire(retireCommand, guards(retireCommand));
    await h.sql.batch(batch(retire));
    const held = (await owner.settleRoute(retire.original, "acknowledged")).assignment;
    const released = await owner.release(held);
    const history = await h.sql.query(
      "SELECT * FROM shared_app_staging_route_commands ORDER BY next_generation",
    );
    h.setNow(START + 31 * 24 * 60 * 60 * 1000);
    const foreign = h.ledger.forTrustedOwner({
      organizationId: "org-hosted",
      product: "takosumi-hosted",
    });
    await expect(
      foreign.reserve({
        reservationId: "foreign-original",
        name: "route-update",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      owner.reserve({ reservationId: "replacement", name: active.name }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await owner.readOriginal(active.reservationId)).toEqual(released);
    expect(await h.sql.query("SELECT COUNT(*) n FROM shared_app_staging_assignments")).toEqual([
      { n: 1 },
    ]);
    expect(
      await h.sql.query("SELECT * FROM shared_app_staging_route_commands ORDER BY next_generation"),
    ).toEqual(history);
    expect((await owner.settleRoute(plan.original, "unknown")).assignment).toEqual(active);
    expect(await foreign.readRouteCommand(plan.original.commandRef)).toBeNull();
    await expect(foreign.settleRoute(plan.original, "unknown")).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      h.ledger
        .forTrustedOwner({ ...OWNER, product: "takosumi-hosted" })
        .readRouteCommand(plan.original.commandRef),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      await h.ledger.isCurrentAfterDispatch({ ...active, script: "immutable-script-one" }),
    ).toBe(false);
  } finally {
    await h.close();
  }
});

const NATIVE_ROUTES = "cloudflare_managed_worker_routes";
const FORM_TARGET = "target-actual";
const FORM_PROVIDER = "provider-actual";
const formOperation = (number: number): string =>
  `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;

function routePin(value: SharedAppRouteAssignment) {
  return value.kind === "scalar" ? value.value : value.pin;
}

function weightedBinding(
  revision: number,
  count: number,
  options: { endpointGeneration?: number; etag?: string; script?: string; target?: string } = {},
): SharedAppFormV2Binding {
  const endpointGeneration = options.endpointGeneration ?? 1;
  const targetKey = options.target ?? FORM_TARGET;
  const releases = Array.from({ length: count }, (_, index) => ({
    versionUid: `version-${String(index).padStart(3, "0")}`,
    versionGeneration: revision,
    scriptName:
      options.script ?? `integration-v2-${(revision * 16 + index).toString(16).padStart(48, "0")}`,
    weight: count === 1 ? 10_000 : count === 2 ? (index === 0 ? 1 : 9999) : 1250,
    descriptorDigest: `sha256:${(revision * 16 + index).toString(16).padStart(64, "0")}` as const,
    providerEtag: options.etag ?? `etag-${revision}-${index}`,
  }));
  const sourceOperationId = formOperation(revision);
  const ownerNativeId = "v2-worker:worker-actual";
  const workerRow: SharedAppNativeRouteRowPin = {
    providerId: FORM_PROVIDER,
    routeKind: "worker",
    routeKey: "worker/v2/worker-actual",
    ownerNativeId,
    generation: revision,
    operationId: `v2-worker:${sourceOperationId}`,
    state: "active",
    valueJson: JSON.stringify({
      schema: "takoserver.v2-wfp-worker-route@v1",
      targetKey,
      workerUid: "worker-actual",
      deploymentUid: "deployment-actual",
      deploymentGeneration: revision,
      sourceOperationId,
      releases,
      generation: revision,
    }),
  };
  const hostRow: SharedAppNativeRouteRowPin = {
    providerId: FORM_PROVIDER,
    routeKind: "host",
    routeKey: `host/v2/${HOSTNAME}`,
    ownerNativeId,
    generation: revision,
    operationId: `v2-host:${sourceOperationId}:${HOSTNAME}`,
    state: "active",
    valueJson: JSON.stringify({
      schema: "takoserver.v2-wfp-host-route@v1",
      targetKey,
      hostname: HOSTNAME,
      workerUid: "worker-actual",
      deploymentUid: "deployment-actual",
      deploymentGeneration: revision,
      endpointUid: "endpoint-actual",
      endpointGeneration,
      sourceOperationId,
      generation: revision,
    }),
  };
  return {
    kind: "form-v2@1",
    endpoint: { uid: "endpoint-actual", generation: endpointGeneration },
    workerUid: "worker-actual",
    deployment: { uid: "deployment-actual", generation: revision },
    providerId: FORM_PROVIDER,
    targetKey,
    nativeSourceOperationId: sourceOperationId,
    hostRow,
    workerRow,
    releases,
  };
}

function weightedInput(
  expected: SharedAppRouteAssignment,
  nextBinding: SharedAppFormV2Binding | null,
  priorBinding: SharedAppFormV2Binding | null = expected.kind === "form-v2@1" &&
  expected.state === "active"
    ? expected.binding
    : null,
  options: {
    kind?: "endpoint" | "deployment";
    generation?: number;
    bindingGeneration?: number;
    operation?: number;
  } = {},
): TrustedSharedAppFormV2RouteInput {
  const selected = routePin(expected);
  const binding = nextBinding ?? priorBinding;
  if (!binding) throw new Error("fixture requires an actual prior or next binding");
  const kind = options.kind ?? (priorBinding && nextBinding ? "deployment" : "endpoint");
  const bindingGeneration = options.bindingGeneration ?? binding.endpoint.generation;
  const generation =
    options.generation ??
    (kind === "deployment"
      ? binding.deployment.generation
      : bindingGeneration + (nextBinding ? 0 : 1));
  const operationId = formOperation(
    options.operation ?? (kind === "deployment" ? generation : generation + 1000),
  );
  const hostAfter: SharedAppNativeRouteRowPin = nextBinding?.hostRow ?? {
    ...binding.hostRow,
    generation: binding.hostRow.generation + 1,
    operationId: `v2-host:${operationId}:${HOSTNAME}`,
    state: "tombstone",
    valueJson: JSON.stringify({
      schema: "takoserver.managed-worker-route-tombstone@v1",
      generation: binding.hostRow.generation + 1,
    }),
  };
  const beforeRows = [priorBinding?.hostRow ?? null, priorBinding?.workerRow ?? binding.workerRow];
  const afterRows = [hostAfter, nextBinding?.workerRow ?? binding.workerRow];
  const snapshots = (
    rows: readonly (SharedAppNativeRouteRowPin | null)[],
  ): SharedAppNativeRouteSnapshot[] =>
    afterRows.map((after, index) => ({
      providerId: after.providerId,
      routeKind: after.routeKind,
      routeKey: after.routeKey,
      row: rows[index] ?? null,
    }));
  return {
    commandRef: `v2-host:${operationId}:${HOSTNAME}`,
    principal: `org:${OWNER.organizationId}`,
    space: OWNER.organizationId,
    expected,
    accepted: {
      kind,
      action: nextBinding ? (priorBinding ? "update" : "create") : "delete",
      resourceUid: kind === "endpoint" ? binding.endpoint.uid : binding.deployment.uid,
      generation,
      operationId,
      formUrl: `https://forms.example.test/${kind === "endpoint" ? "Endpoint" : "Deployment"}/2.0.0/`,
      backendId: `${kind}-actual`,
      targetKey: binding.targetKey,
    },
    endpointBinding: {
      incarnation: selected.incarnation,
      organizationId: OWNER.organizationId,
      product: OWNER.product,
      reservationId: selected.reservationId,
      name: selected.name,
      endpointUid: binding.endpoint.uid,
      endpointGeneration: bindingGeneration,
      formUrl: "https://forms.example.test/Endpoint/2.0.0/",
      backendId: "endpoint-actual",
      targetKey: binding.targetKey,
      createOperationId: formOperation(1001),
      currentOperationId: formOperation(1000 + bindingGeneration),
    },
    priorBinding,
    nextBinding,
    nativeBefore: snapshots(beforeRows),
    nativeAfter: snapshots(afterRows),
  };
}

function nativeVectorPredicate(
  snapshots: readonly SharedAppNativeRouteSnapshot[],
): TrustedSharedAppRouteGuards["admission"] {
  return {
    sql: `NOT EXISTS (SELECT 1 FROM json_each(?) expected LEFT JOIN ${NATIVE_ROUTES} n
      ON n.provider_id = json_extract(expected.value,'$.providerId')
        AND n.route_kind = json_extract(expected.value,'$.routeKind')
        AND n.route_key = json_extract(expected.value,'$.routeKey')
      WHERE (json_type(expected.value,'$.row') IS 'null' AND n.route_key IS NOT NULL)
        OR (json_type(expected.value,'$.row') IS 'object' AND (n.route_key IS NULL
          OR n.owner_native_id IS NOT json_extract(expected.value,'$.row.ownerNativeId')
          OR n.generation IS NOT json_extract(expected.value,'$.row.generation')
          OR n.operation_id IS NOT json_extract(expected.value,'$.row.operationId')
          OR n.state IS NOT json_extract(expected.value,'$.row.state')
          OR n.value_json IS NOT json_extract(expected.value,'$.row.valueJson'))))`,
    params: [canonicalJson(snapshots)],
  };
}

function weightedAcceptedPredicate(
  command: TrustedSharedAppFormV2RouteInput,
): TrustedSharedAppRouteGuards["admission"] {
  const binding = command.nextBinding ?? command.priorBinding;
  if (!binding) throw new Error("missing controlled accepted binding");
  return {
    sql: `EXISTS (SELECT 1 FROM fixture_accepted WHERE endpoint_uid = ? AND organization_id = ?
      AND endpoint_generation = ? AND worker_uid = ? AND deployment_uid = ? AND deployment_generation = ?
      AND source_operation_id = ? AND provider_id = ? AND target_key = ? AND script IS NULL)`,
    params: [
      command.endpointBinding.endpointUid,
      OWNER.organizationId,
      command.accepted.kind === "endpoint"
        ? command.accepted.generation
        : command.endpointBinding.endpointGeneration,
      binding.workerUid,
      binding.deployment.uid,
      binding.deployment.generation,
      command.accepted.operationId,
      binding.providerId,
      binding.targetKey,
    ],
  };
}

function weightedGuards(command: TrustedSharedAppFormV2RouteInput): TrustedSharedAppRouteGuards {
  const accepted = weightedAcceptedPredicate(command);
  const before = nativeVectorPredicate(command.nativeBefore);
  const after = nativeVectorPredicate(command.nativeAfter);
  return {
    admission: {
      sql: `(${accepted.sql}) AND (${before.sql})`,
      params: [...(accepted.params ?? []), ...(before.params ?? [])],
    },
    publication: {
      sql: `(${accepted.sql}) AND (${after.sql})`,
      params: [...(accepted.params ?? []), ...(after.params ?? [])],
    },
  };
}

async function acceptWeighted(sql: Sql, command: TrustedSharedAppFormV2RouteInput): Promise<void> {
  const predicate = weightedAcceptedPredicate(command);
  await sql.run(
    `INSERT INTO fixture_accepted (endpoint_uid,organization_id,endpoint_generation,
    worker_uid,deployment_uid,deployment_generation,source_operation_id,provider_id,target_key,script)
    VALUES (?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(endpoint_uid) DO UPDATE SET
      endpoint_generation=excluded.endpoint_generation,worker_uid=excluded.worker_uid,
      deployment_uid=excluded.deployment_uid,deployment_generation=excluded.deployment_generation,
      source_operation_id=excluded.source_operation_id,provider_id=excluded.provider_id,target_key=excluded.target_key,script=NULL`,
    predicate.params,
  );
}

async function seedWeightedBefore(
  sql: Sql,
  command: TrustedSharedAppFormV2RouteInput,
): Promise<void> {
  for (const { row } of command.nativeBefore) {
    if (!row) continue;
    await sql.run(
      `INSERT INTO ${NATIVE_ROUTES} (provider_id,route_kind,route_key,owner_native_id,
      generation,operation_id,state,value_json) VALUES (?,?,?,?,?,?,?,?)`,
      [
        row.providerId,
        row.routeKind,
        row.routeKey,
        row.ownerNativeId,
        row.generation,
        row.operationId,
        row.state,
        row.valueJson,
      ],
    );
  }
}

function weightedMutations(
  plan: SharedAppFormV2RouteEffects,
  input: TrustedSharedAppFormV2RouteInput = plan.original,
): readonly SqlStatement[] {
  const statements: SqlStatement[] = [];
  const accepted = weightedAcceptedPredicate(input);
  for (const [index, snapshot] of input.nativeAfter.entries()) {
    const next = snapshot.row;
    const before = input.nativeBefore[index]?.row;
    if (!next) throw new Error("fixture write cannot invent native absence");
    if (canonicalJson(before) === canonicalJson(next)) continue;
    const values = [
      next.ownerNativeId,
      next.generation,
      next.operationId,
      next.state,
      next.valueJson,
    ];
    if (before) {
      statements.push({
        sql: `UPDATE ${NATIVE_ROUTES} SET owner_native_id=?,generation=?,operation_id=?,state=?,value_json=?
          WHERE provider_id=? AND route_kind=? AND route_key=? AND owner_native_id=? AND generation=?
            AND operation_id=? AND state=? AND value_json=? AND (${accepted.sql}) AND (${plan.publicationGuard.sql})`,
        params: [
          ...values,
          next.providerId,
          next.routeKind,
          next.routeKey,
          before.ownerNativeId,
          before.generation,
          before.operationId,
          before.state,
          before.valueJson,
          ...(accepted.params ?? []),
          ...(plan.publicationGuard.params ?? []),
        ],
      });
    } else {
      statements.push({
        sql: `INSERT INTO ${NATIVE_ROUTES} (owner_native_id,generation,operation_id,state,value_json,
          provider_id,route_kind,route_key) SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS
          (SELECT 1 FROM ${NATIVE_ROUTES} WHERE provider_id=? AND route_kind=? AND route_key=?)
          AND (${accepted.sql}) AND (${plan.publicationGuard.sql})`,
        params: [
          ...values,
          next.providerId,
          next.routeKind,
          next.routeKey,
          next.providerId,
          next.routeKind,
          next.routeKey,
          ...(accepted.params ?? []),
          ...(plan.publicationGuard.params ?? []),
        ],
      });
    }
  }
  return statements;
}

function weightedBatch(plan: SharedAppFormV2RouteEffects): readonly SqlStatement[] {
  const statements = [...plan.before, ...weightedMutations(plan), ...plan.after];
  for (const statement of statements) {
    expect(statement.params?.length ?? 0).toBeLessThanOrEqual(100);
    expect(new TextEncoder().encode(statement.sql).byteLength).toBeLessThanOrEqual(100_000);
  }
  for (const statement of [...plan.before, plan.publicationGuard, ...plan.after])
    expect(statement.params?.length ?? 0).toBeLessThanOrEqual(90);
  return statements;
}

async function weightedSnapshot(sql: Sql) {
  return {
    head: await sql.query("SELECT * FROM shared_app_staging_names ORDER BY normalized_name"),
    assignment: await sql.query(
      "SELECT * FROM shared_app_staging_assignments ORDER BY incarnation",
    ),
    history: await sql.query(
      "SELECT * FROM shared_app_staging_route_commands ORDER BY next_generation",
    ),
    native: await sql.query(`SELECT * FROM ${NATIVE_ROUTES} ORDER BY route_kind,route_key`),
    witnesses: await sql.query(
      "SELECT * FROM shared_app_staging_batch_assertions ORDER BY witness",
    ),
  };
}

async function startWeighted(h: Awaited<ReturnType<typeof harness>>, count = 2) {
  const owner = h.ledger.forTrustedOwner(OWNER);
  const reserved = await owner.reserve({
    reservationId: "form-route-reservation",
    name: "route-update",
  });
  const command = weightedInput({ kind: "scalar", value: reserved }, weightedBinding(1, count));
  await seedWeightedBefore(h.sql, command);
  await acceptWeighted(h.sql, command);
  const plan = owner.prepareFormV2Route("activate", command, weightedGuards(command));
  await h.sql.batch(weightedBatch(plan));
  const receipt = await owner.settleFormV2Route(plan.original, "acknowledged");
  return { owner, reserved, command, plan, receipt };
}

for (const releaseCount of [1, 2, 8]) {
  test(`native D1 full tagged ${releaseCount}-release original survives current/history reconstruction without scalar fallback`, async () => {
    const h = await harness(true, true);
    try {
      const { owner, plan, receipt } = await startWeighted(h, releaseCount);
      const selected = await h.ledger.readCurrentRoute("route-update");
      expect(selected).toEqual({
        kind: "form-v2@1",
        pin: receipt.assignment.pin,
        binding: plan.original.nextBinding,
      });
      if (!selected) throw new Error("committed full route selection is missing");
      expect(await h.ledger.isRouteCurrentBeforeDispatch(selected)).toBe(true);
      expect(await h.ledger.isRouteCurrentAfterDispatch(selected)).toBe(true);
      expect(await owner.readOriginalRoute(receipt.assignment.pin.reservationId)).toEqual(
        receipt.assignment,
      );
      const reconstructed = createSharedAppLedger({
        environment: "staging",
        primary: () => h.sql,
      }).forTrustedOwner(OWNER);
      expect(await reconstructed.settleFormV2Route(plan.original, "unknown")).toEqual(receipt);
      expect((await owner.readFormV2RouteCommand(plan.original.commandRef))?.original).toEqual(
        plan.original,
      );
      await expect(owner.readOriginal(receipt.assignment.pin.reservationId)).rejects.toMatchObject({
        code: "unavailable",
      });
      await expect(h.ledger.readCurrent("route-update")).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(
        await h.sql.query("SELECT script,binding_kind FROM shared_app_staging_assignments"),
      ).toEqual([{ script: null, binding_kind: "form-v2@1" }]);
    } finally {
      await h.close();
    }
  });
}

test("native D1 tagged advance keeps every six-pin value and exact historical replay cannot rewind newer native rows", async () => {
  const h = await harness(true, true);
  try {
    const first = await startWeighted(h, 2);
    const command = weightedInput(first.receipt.assignment, weightedBinding(2, 8));
    await acceptWeighted(h.sql, command);
    const plan = first.owner.prepareFormV2Route("advance", command, weightedGuards(command));
    await h.sql.batch(weightedBatch(plan));
    const current = await h.ledger.readCurrentRoute("route-update");
    expect(current?.kind).toBe("form-v2@1");
    expect(current?.kind === "form-v2@1" ? current.binding.releases : null).toEqual(
      command.nextBinding?.releases,
    );
    const before = await weightedSnapshot(h.sql);
    await h.sql.batch(
      weightedBatch(
        first.owner.prepareFormV2Route("activate", first.command, weightedGuards(first.command)),
      ),
    );
    expect(await weightedSnapshot(h.sql)).toEqual(before);
    expect(await first.owner.settleFormV2Route(first.plan.original, "unknown")).toEqual(
      first.receipt,
    );
    if (!first.plan.original.nextBinding) throw new Error("activation lost its full next binding");
    expect(
      await h.ledger.isRouteCurrentBeforeDispatch({
        kind: "form-v2@1",
        pin: first.receipt.assignment.pin,
        binding: first.plan.original.nextBinding,
      }),
    ).toBe(false);
    const changed = weightedInput(first.command.expected, weightedBinding(1, 8));
    const conflict = first.owner.prepareFormV2Route("activate", changed, weightedGuards(changed));
    await expect(h.sql.batch(weightedBatch(conflict))).rejects.toThrow();
    expect(await weightedSnapshot(h.sql)).toEqual(before);
  } finally {
    await h.close();
  }
});

test("native D1 missing native transition, stale dependency and postcondition each roll back the entire tagged atom", async () => {
  const h = await harness(true, true);
  try {
    const first = await startWeighted(h, 2);
    const command = weightedInput(first.receipt.assignment, weightedBinding(2, 8));
    await acceptWeighted(h.sql, command);
    for (const omitted of [0, 1]) {
      const plan = first.owner.prepareFormV2Route("advance", command, weightedGuards(command));
      const before = await weightedSnapshot(h.sql);
      const mutations = weightedMutations(plan).filter((_, index) => index !== omitted);
      await expect(h.sql.batch([...plan.before, ...mutations, ...plan.after])).rejects.toThrow();
      expect(await weightedSnapshot(h.sql)).toEqual(before);
    }
    await h.sql.run(
      `UPDATE ${NATIVE_ROUTES} SET value_json=value_json||' ' WHERE route_kind='worker'`,
    );
    const stale = first.owner.prepareFormV2Route("advance", command, weightedGuards(command));
    const before = await weightedSnapshot(h.sql);
    await expect(h.sql.batch(weightedBatch(stale))).rejects.toThrow();
    expect(await weightedSnapshot(h.sql)).toEqual(before);
  } finally {
    await h.close();
  }
});

test("native D1 tagged retirement retains the tag and three independent DELETE/binding/confirmed generations", async () => {
  const h = await harness(true, true);
  try {
    const first = await startWeighted(h, 2);
    const command = weightedInput(
      first.receipt.assignment,
      null,
      first.receipt.assignment.binding,
      { generation: 5, bindingGeneration: 2 },
    );
    await acceptWeighted(h.sql, command);
    const plan = first.owner.prepareFormV2Route("retire", command, weightedGuards(command));
    expect(plan.original.accepted.generation).toBe(5);
    expect(plan.original.endpointBinding.endpointGeneration).toBe(2);
    expect(plan.original.priorBinding?.endpoint.generation).toBe(1);
    await h.sql.batch(weightedBatch(plan));
    const receipt = await first.owner.settleFormV2Route(plan.original, "unknown");
    expect(receipt.assignment).toMatchObject({
      kind: "form-v2@1",
      state: "reserved",
      binding: null,
    });
    expect(await h.ledger.readCurrentRoute("route-update")).toBeNull();
    await expect(
      first.owner.readOriginal(receipt.assignment.pin.reservationId),
    ).rejects.toMatchObject({ code: "unavailable" });
    const before = await weightedSnapshot(h.sql);
    await expect(
      first.owner.activate(receipt.assignment.pin, "legacy-script"),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(first.owner.release(receipt.assignment.pin)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await weightedSnapshot(h.sql)).toEqual(before);
  } finally {
    await h.close();
  }
});

test("native D1 scalar adoption requires actual previous command history and preserves its prior_script", async () => {
  const h = await harness(true, true);
  try {
    const scalar = await start(h);
    const prior = weightedBinding(1, 1, { script: "immutable-script-one" });
    const command = weightedInput(
      { kind: "scalar", value: scalar.active },
      weightedBinding(2, 8),
      prior,
    );
    await seedWeightedBefore(h.sql, command);
    await acceptWeighted(h.sql, command);
    const plan = scalar.owner.prepareFormV2Route("advance", command, weightedGuards(command));
    await h.sql.batch(weightedBatch(plan));
    expect(
      await h.sql.query(
        "SELECT prior_script,next_script FROM shared_app_staging_route_commands WHERE form_v2_original_json IS NOT NULL",
      ),
    ).toEqual([{ prior_script: "immutable-script-one", next_script: null }]);
    const receipt = await scalar.owner.settleFormV2Route(plan.original, "acknowledged");
    expect(receipt.assignment.pin.incarnation).toBe(scalar.active.incarnation);
    expect(receipt.assignment.binding?.releases).toHaveLength(8);
  } finally {
    await h.close();
  }
});

test("native D1 a standalone active scalar cannot be adopted as a complete route history", async () => {
  const h = await harness(true, true);
  try {
    const owner = h.ledger.forTrustedOwner(OWNER);
    const held = await owner.reserve({ reservationId: "standalone", name: "route-update" });
    const active = await owner.activate(held, "standalone-script");
    const prior = weightedBinding(1, 1, { script: "standalone-script" });
    const command = weightedInput({ kind: "scalar", value: active }, weightedBinding(2, 2), prior);
    await seedWeightedBefore(h.sql, command);
    await acceptWeighted(h.sql, command);
    const before = await weightedSnapshot(h.sql);
    const plan = owner.prepareFormV2Route("advance", command, weightedGuards(command));
    await expect(h.sql.batch(weightedBatch(plan))).rejects.toThrow();
    expect(await weightedSnapshot(h.sql)).toEqual(before);
    expect(await owner.readOriginal(active.reservationId)).toEqual(active);
  } finally {
    await h.close();
  }
});

test("native D1 unknown tagged ACK retains the complete original until a fresh primary history read settles it", async () => {
  const h = await harness(true, true);
  try {
    const owner = h.ledger.forTrustedOwner(OWNER);
    const held = await owner.reserve({ reservationId: "lost-weighted-ack", name: "route-update" });
    const command = weightedInput({ kind: "scalar", value: held }, weightedBinding(1, 8));
    await seedWeightedBefore(h.sql, command);
    await acceptWeighted(h.sql, command);
    const plan = owner.prepareFormV2Route("activate", command, weightedGuards(command));
    await expect(owner.settleFormV2Route(plan.original, "unknown")).rejects.toMatchObject({
      code: "indeterminate",
      original: plan.original,
    });
    await h.sql.batch(weightedBatch(plan));
    const committed = await weightedSnapshot(h.sql);
    h.block(true);
    await expect(owner.settleFormV2Route(plan.original, "unknown")).rejects.toMatchObject({
      code: "indeterminate",
      original: plan.original,
    });
    h.block(false);
    const recovered = await owner.settleFormV2Route(plan.original, "unknown");
    expect(recovered.original).toEqual(plan.original);
    expect(recovered.assignment.binding?.releases).toHaveLength(8);
    expect(await weightedSnapshot(h.sql)).toEqual(committed);
    await h.sql.run(
      "UPDATE shared_app_staging_route_commands SET provider_id='corrupt-common-column'",
    );
    await expect(owner.settleFormV2Route(plan.original, "unknown")).rejects.toMatchObject({
      code: "indeterminate",
      original: plan.original,
    });
    await expect(owner.readFormV2RouteCommand(plan.original.commandRef)).rejects.toMatchObject({
      code: "unavailable",
    });
  } finally {
    await h.close();
  }
});

test("native D1 both full-route fences detect an unselected release pin and reject noncanonical stored bindings", async () => {
  const h = await harness(true, true);
  try {
    const first = await startWeighted(h, 8);
    const selected = await h.ledger.readCurrentRoute("route-update");
    if (selected?.kind !== "form-v2@1") throw new Error("full route required");
    const changed = {
      ...selected.binding,
      releases: selected.binding.releases.map((release, index) =>
        index === 7 ? { ...release, providerEtag: "new-unselected-etag" } : release,
      ),
    };
    await h.sql.run("UPDATE shared_app_staging_assignments SET binding_json=?", [
      canonicalJson(changed),
    ]);
    expect(await h.ledger.isRouteCurrentBeforeDispatch(selected)).toBe(false);
    expect(await h.ledger.isRouteCurrentAfterDispatch(selected)).toBe(false);
    expect((await h.ledger.readCurrentRoute("route-update"))?.kind).toBe("form-v2@1");
    await h.sql.run("UPDATE shared_app_staging_assignments SET binding_json=binding_json||' '");
    await expect(h.ledger.readCurrentRoute("route-update")).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(first.owner.readOriginalRoute(first.reserved.reservationId)).rejects.toMatchObject(
      { code: "unavailable" },
    );
  } finally {
    await h.close();
  }
});

test("native D1 tagged preparation captures all data and guards without normalizing raw owner JSON", async () => {
  const h = await harness(true, true);
  try {
    const owner = h.ledger.forTrustedOwner(OWNER);
    const held = await owner.reserve({ reservationId: "captured-weighted", name: "route-update" });
    const originalBinding = weightedBinding(1, 2);
    const nextBinding = {
      ...originalBinding,
      workerRow: {
        ...originalBinding.workerRow,
        valueJson: ` ${originalBinding.workerRow.valueJson}\n`,
      },
    };
    const mutable = structuredClone(weightedInput({ kind: "scalar", value: held }, nextBinding));
    const guards = structuredClone(weightedGuards(mutable));
    const plan = owner.prepareFormV2Route("activate", mutable, guards);
    const expected = canonicalJson(plan.original);
    Object.assign(mutable.accepted, { operationId: formOperation(999) });
    if (!mutable.nextBinding) throw new Error("fixture next binding missing");
    const mutableRelease = mutable.nextBinding.releases[1];
    if (!mutableRelease) throw new Error("fixture second release missing");
    Object.assign(mutableRelease, { providerEtag: "changed-after-prepare" });
    Object.assign(guards.admission, { sql: "0", params: [] });
    expect(canonicalJson(plan.original)).toBe(expected);
    expect(plan.original.nextBinding?.workerRow.valueJson).toBe(nextBinding.workerRow.valueJson);
    expect(Object.isFrozen(plan.original.nextBinding?.releases)).toBe(true);
    expect(Object.isFrozen(plan.original.nextBinding?.releases[1])).toBe(true);
    expect(Object.isFrozen(plan.original.nativeAfter)).toBe(true);
    expect(Object.isFrozen(plan.before[0]?.params)).toBe(true);
    await seedWeightedBefore(h.sql, plan.original);
    await acceptWeighted(h.sql, plan.original);
    await h.sql.batch(weightedBatch(plan));
    expect((await owner.settleFormV2Route(plan.original, "acknowledged")).original).toEqual(
      plan.original,
    );
  } finally {
    await h.close();
  }
});

test("native D1 malformed complete vectors refuse before any owner write or getter evaluation", async () => {
  const h = await harness(true, true);
  try {
    const owner = h.ledger.forTrustedOwner(OWNER);
    const held = await owner.reserve({ reservationId: "invalid-weighted", name: "route-update" });
    const binding = weightedBinding(1, 2);
    const first = binding.releases[0];
    const second = binding.releases[1];
    if (!first || !second) throw new Error("two release pins required");
    const oversizedUnicode = JSON.stringify({ padding: "🐙".repeat(17000) });
    expect(oversizedUnicode.length).toBeLessThan(65536);
    expect(new TextEncoder().encode(oversizedUnicode).byteLength).toBeGreaterThan(65536);
    const extraRelease = { ...first, extraPin: true };
    const variants: readonly SharedAppFormV2Binding[] = [
      { ...binding, releases: [] },
      {
        ...binding,
        releases: Array.from({ length: 9 }, (_, index) => ({
          ...first,
          versionUid: `version-${index}`,
          weight: index === 8 ? 1112 : 1111,
        })),
      },
      { ...binding, releases: [second, first] },
      { ...binding, releases: [first, { ...second, versionUid: first.versionUid }] },
      {
        ...binding,
        releases: [
          { ...first, weight: 0 },
          { ...second, weight: 10000 },
        ],
      },
      {
        ...binding,
        releases: [
          { ...first, weight: 1.5 },
          { ...second, weight: 9998.5 },
        ],
      },
      { ...binding, releases: [{ ...first, versionGeneration: 0 }, second] },
      { ...binding, releases: [{ ...first, descriptorDigest: "sha256:bad" }, second] },
      { ...binding, releases: [{ ...first, providerEtag: "" }, second] },
      { ...binding, releases: [{ ...first, scriptName: "x".repeat(256) }, second] },
      { ...binding, releases: [extraRelease, second] },
      { ...binding, hostRow: { ...binding.hostRow, state: "tombstone" } },
      { ...binding, workerRow: { ...binding.workerRow, ownerNativeId: "different-owner" } },
      { ...binding, workerRow: { ...binding.workerRow, valueJson: oversizedUnicode } },
    ];
    const before = await weightedSnapshot(h.sql);
    for (const variant of variants) {
      const command = weightedInput({ kind: "scalar", value: held }, variant);
      expect(() =>
        owner.prepareFormV2Route("activate", command, weightedGuards(command)),
      ).toThrow();
    }
    const command = weightedInput({ kind: "scalar", value: held }, binding);
    const wrongOrder = {
      ...command,
      nativeBefore: [...command.nativeBefore].reverse(),
      nativeAfter: [...command.nativeAfter].reverse(),
    };
    expect(() =>
      owner.prepareFormV2Route("activate", wrongOrder, weightedGuards(wrongOrder)),
    ).toThrow();
    const missing = {
      ...command,
      nativeBefore: command.nativeBefore.slice(0, 1),
      nativeAfter: command.nativeAfter.slice(0, 1),
    };
    expect(() => owner.prepareFormV2Route("activate", missing, weightedGuards(missing))).toThrow();
    const accessor = structuredClone(command);
    let getterCalls = 0;
    Object.defineProperty(accessor.expected, "kind", {
      enumerable: true,
      get() {
        getterCalls++;
        return "scalar";
      },
    });
    expect(() => owner.prepareFormV2Route("activate", accessor, weightedGuards(command))).toThrow();
    expect(getterCalls).toBe(0);
    const oversizedGuard = {
      ...weightedGuards(command),
      admission: {
        sql: Array.from({ length: 60 }, () => "?=1").join(" AND "),
        params: Array.from({ length: 60 }, () => 1),
      },
    };
    expect(() => owner.prepareFormV2Route("activate", command, oversizedGuard)).toThrow();
    expect(() =>
      owner.prepareFormV2Route("activate", command, {
        ...weightedGuards(command),
        admission: { sql: `1 ${"/**/".repeat(25000)}`, params: [] },
      }),
    ).toThrow();
    expect(await weightedSnapshot(h.sql)).toEqual(before);
  } finally {
    await h.close();
  }
});

test("native D1 per-row raw byte boundary preserves a larger complete original and actual statement budgets", async () => {
  const h = await harness(true, true);
  try {
    const owner = h.ledger.forTrustedOwner(OWNER);
    const held = await owner.reserve({ reservationId: "maximum-weighted", name: "route-update" });
    const encoder = new TextEncoder();
    // Exercise actual compact owner serialization, including all eight complete
    // pins and six-byte JSON escapes. The generic ledger does not impose a
    // private script grammar or grant this data native publication authority.
    const maximumBinding = (revision: number): SharedAppFormV2Binding => {
      const compact = weightedBinding(revision, 8, {
        etag: "\u0001".repeat(255),
        script: "\u0002".repeat(255),
        target: "\u0003".repeat(255),
      });
      const maxReleases = compact.releases.map((release, index) => ({
        ...release,
        versionUid: `v${index}${"x".repeat(126)}`,
      }));
      const maximumValueJson = JSON.stringify({
        schema: "takoserver.v2-wfp-worker-route@v1",
        targetKey: compact.targetKey,
        workerUid: compact.workerUid,
        deploymentUid: compact.deployment.uid,
        deploymentGeneration: compact.deployment.generation,
        sourceOperationId: compact.nativeSourceOperationId,
        releases: maxReleases,
        generation: compact.workerRow.generation,
      });
      expect(encoder.encode(maximumValueJson).byteLength).toBeLessThan(32768);
      expect(maxReleases).toHaveLength(8);
      return {
        ...compact,
        releases: maxReleases,
        workerRow: {
          ...compact.workerRow,
          valueJson: `${maximumValueJson}${" ".repeat(65536 - encoder.encode(maximumValueJson).byteLength)}`,
        },
      };
    };
    const bounded = maximumBinding(1);
    expect(encoder.encode(bounded.workerRow.valueJson).byteLength).toBe(65536);
    const command = weightedInput({ kind: "scalar", value: held }, bounded);
    await seedWeightedBefore(h.sql, command);
    await acceptWeighted(h.sql, command);
    const plan = owner.prepareFormV2Route("activate", command, weightedGuards(command));
    expect(encoder.encode(canonicalJson(plan.original)).byteLength).toBeGreaterThan(65536);
    for (const statement of weightedBatch(plan)) {
      for (const value of statement.params ?? []) {
        if (typeof value === "string")
          expect(encoder.encode(value).byteLength).toBeLessThanOrEqual(2_000_000);
      }
    }
    await h.sql.batch(weightedBatch(plan));
    const active = await owner.settleFormV2Route(plan.original, "unknown");
    expect(active.original.nextBinding?.workerRow.valueJson).toBe(bounded.workerRow.valueJson);
    const nextCommand = weightedInput(active.assignment, maximumBinding(2));
    await acceptWeighted(h.sql, nextCommand);
    const nextPlan = owner.prepareFormV2Route("advance", nextCommand, weightedGuards(nextCommand));
    expect(encoder.encode(canonicalJson(nextPlan.original)).byteLength).toBeGreaterThan(65536);
    expect(nextPlan.original.priorBinding?.releases).toHaveLength(8);
    expect(nextPlan.original.nextBinding?.releases).toHaveLength(8);
    await h.sql.batch(weightedBatch(nextPlan));
    expect((await owner.settleFormV2Route(nextPlan.original, "unknown")).original).toEqual(
      nextPlan.original,
    );
    const overflow = {
      ...bounded,
      workerRow: { ...bounded.workerRow, valueJson: `${bounded.workerRow.valueJson} ` },
    };
    const invalid = weightedInput({ kind: "scalar", value: held }, overflow);
    const before = await weightedSnapshot(h.sql);
    expect(() => owner.prepareFormV2Route("activate", invalid, weightedGuards(invalid))).toThrow();
    expect(await weightedSnapshot(h.sql)).toEqual(before);
  } finally {
    await h.close();
  }
});

test("native D1 typed commands require the three unallocated columns and never fall back to scalar writes", async () => {
  const h = await harness();
  try {
    const owner = h.ledger.forTrustedOwner(OWNER);
    const held = await owner.reserve({
      reservationId: "missing-form-schema",
      name: "route-update",
    });
    const command = weightedInput({ kind: "scalar", value: held }, weightedBinding(1, 2));
    // Schema refusal must occur before any native owner transition. These
    // constant predicates isolate missing-column behavior, not authority.
    const plan = owner.prepareFormV2Route("activate", command, {
      admission: { sql: "1", params: [] },
      publication: { sql: "1", params: [] },
    });
    await expect(h.sql.batch([...plan.before, ...plan.after])).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await owner.readOriginal(held.reservationId)).toEqual(held);
    expect(await owner.readOriginalRoute(held.reservationId)).toEqual({
      kind: "scalar",
      value: held,
    });
    expect(await h.sql.query("SELECT * FROM shared_app_staging_route_commands")).toEqual([]);
    expect(await h.sql.query("SELECT * FROM shared_app_staging_batch_assertions")).toEqual([]);
    await expect(owner.settleFormV2Route(plan.original, "unknown")).rejects.toMatchObject({
      code: "indeterminate",
      original: plan.original,
    });
  } finally {
    await h.close();
  }
});
