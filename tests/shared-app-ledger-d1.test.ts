import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import {
  planSharedAppLegacyAdoption,
  type SharedAppAssignment,
  type SharedAppLegacyProjection,
  type SharedAppPin,
} from "../src/shared-app-ledger.ts";
import { createSharedAppLedgerD1, type SharedAppPrimaryD1 } from "../src/shared-app-ledger-d1.ts";
import { createD1Sql, type D1DatabaseLike } from "../src/sql-d1.ts";

const START = Date.parse("2026-10-15T00:00:00Z");
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1_000; // A refusal boundary, not a reuse policy.
const SERVER = { organizationId: "org-server", product: "takoserver" as const };
const HOSTED = { organizationId: "org-hosted", product: "takosumi-hosted" as const };

async function harness(options: { unpublishedRelease?: boolean } = {}) {
  const id = `shared-app-${crypto.randomUUID()}`;
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
          env: { STATE_DB: { type: "d1", id } },
          triggers: [],
        },
      },
    ],
  });
  const database = await runtime.getD1Database("STATE_DB");
  const sql = createD1Sql(database);
  // UNALLOCATED TEST-ONLY DDL: this is not a migration number, writer or live schema.
  for (const realm of ["staging", "production"]) {
    const prefix = `shared_app_${realm}`;
    await sql.run(`CREATE TABLE ${prefix}_assignments (
      incarnation TEXT PRIMARY KEY CHECK (length(incarnation) = 32 AND incarnation NOT GLOB '*[^0-9a-f]*'),
      name TEXT NOT NULL CHECK (length(name) BETWEEN 3 AND 32 AND name NOT GLOB '*[^a-z0-9-]*'),
      organization_id TEXT NOT NULL, product TEXT NOT NULL CHECK (product IN ('takoserver', 'takosumi-hosted')),
      reservation_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740990),
      state TEXT NOT NULL CHECK (state IN ('reserved', 'active', 'released')), script TEXT,
      released_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (organization_id, reservation_id), CHECK (updated_at >= created_at),
      CHECK ((state = 'released') = (released_at IS NOT NULL)),
      CHECK (released_at IS NULL OR released_at >= created_at),
      CHECK (state <> 'reserved' OR script IS NULL), CHECK (state <> 'active' OR script IS NOT NULL)
    )`);
    await sql.run(`CREATE TABLE ${prefix}_names (
      normalized_name TEXT PRIMARY KEY CHECK (length(normalized_name) BETWEEN 3 AND 32
        AND normalized_name NOT GLOB '*[^a-z0-9-]*'),
      incarnation TEXT NOT NULL REFERENCES ${prefix}_assignments(incarnation),
      generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740990),
      state TEXT NOT NULL CHECK (state IN ('reserved', 'active', 'released')),
      released_at INTEGER, updated_at INTEGER NOT NULL,
      CHECK ((state = 'released') = (released_at IS NOT NULL))
    )`);
  }
  if (options.unpublishedRelease) {
    // Opt-in UNALLOCATED typed fixture; keep every old-schema test unchanged.
    for (const realm of ["staging", "production"]) {
      const prefix = `shared_app_${realm}`;
      await sql.run(`ALTER TABLE ${prefix}_assignments ADD COLUMN binding_kind TEXT`);
      await sql.run(`ALTER TABLE ${prefix}_assignments ADD COLUMN binding_json TEXT`);
      await sql.run(`CREATE TABLE ${prefix}_route_commands (
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
      await sql.run(`CREATE TABLE ${prefix}_batch_assertions (witness TEXT PRIMARY KEY,
        ok INTEGER NOT NULL CHECK(ok=1),apply_effects INTEGER NOT NULL CHECK(apply_effects IN (0,1)))`);
    }
    // This is deliberately an owner-like metadata constraint, not the HTTP carrier schema.
    // Actual carrier/Engine qualification belongs to the authenticated composition suite.
    await sql.run(`CREATE TABLE cancellation_metadata_fixture (
      incarnation TEXT PRIMARY KEY REFERENCES shared_app_staging_assignments(incarnation),
      state TEXT NOT NULL CHECK(state IN ('prepared','released')),released_at INTEGER,
      CHECK((state='released')=(released_at IS NOT NULL)))`);
  }
  let now = START;
  const sessions: string[] = [];
  let loseNextAck = false;
  let hideNextCommittedRead = false;
  let blockReads = false;
  const binding: SharedAppPrimaryD1 = {
    withSession(constraint) {
      sessions.push(constraint);
      const session = database.withSession(constraint);
      const statementMap = new WeakMap<object, ReturnType<typeof session.prepare>>();
      const wrap = (
        native: ReturnType<typeof session.prepare>,
      ): ReturnType<D1DatabaseLike["prepare"]> => {
        const statement = {
          bind(...values: Parameters<typeof native.bind>) {
            return wrap(native.bind(...values));
          },
          async all() {
            if (blockReads) throw new Error("injected lost read transport");
            return await native.all();
          },
        };
        statementMap.set(statement, native);
        return statement;
      };
      return {
        prepare: (query) => wrap(session.prepare(query)),
        async batch(statements) {
          const native = statements.map((statement) => {
            const value = statementMap.get(statement);
            if (!value) throw new Error("foreign test statement");
            return value;
          });
          const result = await session.batch<Record<string, unknown>>(native);
          if (hideNextCommittedRead) {
            hideNextCommittedRead = false;
            blockReads = true;
          }
          if (loseNextAck) {
            loseNextAck = false;
            blockReads = true;
            throw new Error("injected lost batch ACK after native commit");
          }
          return result;
        },
      };
    },
  };
  const ledger = createSharedAppLedgerD1({
    database: binding,
    environment: "staging",
    clock: () => new Date(now),
  });
  return {
    sql,
    database,
    binding,
    ledger,
    sessions,
    close: () => runtime.dispose(),
    setNow(value: number) {
      now = value;
    },
    loseAck() {
      loseNextAck = true;
    },
    hideReadAfterCommit() {
      hideNextCommittedRead = true;
    },
    restoreReads() {
      blockReads = false;
    },
    blockReads() {
      blockReads = true;
    },
  };
}

function cancellationBatch(
  h: Awaited<ReturnType<typeof harness>>,
  pin: SharedAppPin,
  updateMatches = true,
) {
  const release = h.ledger.forTrustedOwner(SERVER).prepareReleaseUnpublished(pin);
  const witness = `fixture-carrier:${crypto.randomUUID()}`;
  return [
    ...release.before,
    {
      sql: `UPDATE cancellation_metadata_fixture SET state='released',released_at=?
        WHERE incarnation=? AND state='prepared' AND ?=1 AND (${release.publicationGuard.sql})`,
      params: [
        release.releasedAt,
        pin.incarnation,
        updateMatches ? 1 : 0,
        ...(release.publicationGuard.params ?? []),
      ],
    },
    {
      sql: `INSERT INTO shared_app_staging_batch_assertions (witness,ok,apply_effects)
        SELECT ?,CASE WHEN EXISTS (SELECT 1 FROM cancellation_metadata_fixture
          WHERE incarnation=? AND state='released' AND released_at=?)
          AND (${release.publicationGuard.sql}) THEN 1 ELSE 0 END,0`,
      params: [
        witness,
        pin.incarnation,
        release.releasedAt,
        ...(release.publicationGuard.params ?? []),
      ],
    },
    ...release.after,
    { sql: "DELETE FROM shared_app_staging_batch_assertions WHERE witness=?", params: [witness] },
  ];
}

test("native D1 unpublished effects share one metadata atom and retain a permanent original", async () => {
  const h = await harness({ unpublishedRelease: true });
  try {
    const owner = h.ledger.forTrustedOwner(SERVER);
    const original = await owner.reserve({
      reservationId: "cancel-original",
      name: "cancel-original",
    });
    await h.sql.run("INSERT INTO cancellation_metadata_fixture VALUES (?,'prepared',NULL)", [
      original.incarnation,
    ]);
    const batch = cancellationBatch(h, original);
    expect(await owner.readOriginalRoute(original.reservationId)).toEqual({
      kind: "scalar",
      value: original,
    });
    expect(batch.every((s) => (s.params?.length ?? 0) <= 90)).toBe(true);
    await createD1Sql(h.binding.withSession("first-primary")).batch(batch);
    const released = {
      ...original,
      generation: 2,
      state: "released",
      releasedAt: START,
    } satisfies SharedAppAssignment;
    expect(await owner.readOriginal(original.reservationId)).toEqual(released);
    expect(await h.sql.query("SELECT * FROM cancellation_metadata_fixture")).toEqual([
      { incarnation: original.incarnation, state: "released", released_at: START },
    ]);
    expect(await h.sql.query("SELECT * FROM shared_app_staging_batch_assertions")).toEqual([]);
    for (const at of [START + THIRTY_DAYS + 1, START + 100 * 365 * 24 * 60 * 60 * 1000]) {
      h.setNow(at);
      for (const identity of [SERVER, HOSTED])
        await expect(
          h.ledger
            .forTrustedOwner(identity)
            .reserve({ reservationId: `new-${at}`, name: "ＣＡＮＣＥＬ-original" }),
        ).rejects.toMatchObject({ code: "conflict" });
      expect(await owner.readOriginal(original.reservationId)).toEqual(released);
    }
    expect(await h.ledger.readCurrentRoute(original.name)).toBeNull();
    expect(h.sessions.every((s) => s === "first-primary")).toBe(true);
  } finally {
    await h.close();
  }
});

test("native D1 zero metadata effect and final constraint roll back the entire cancellation", async () => {
  const h = await harness({ unpublishedRelease: true });
  try {
    const owner = h.ledger.forTrustedOwner(SERVER);
    const original = await owner.reserve({
      reservationId: "rollback-original",
      name: "rollback-original",
    });
    await h.sql.run("INSERT INTO cancellation_metadata_fixture VALUES (?,'prepared',NULL)", [
      original.incarnation,
    ]);
    const snapshot = async () => ({
      original: await owner.readOriginalRoute(original.reservationId),
      names: await h.sql.query("SELECT * FROM shared_app_staging_names"),
      metadata: await h.sql.query("SELECT * FROM cancellation_metadata_fixture"),
      witnesses: await h.sql.query("SELECT * FROM shared_app_staging_batch_assertions"),
    });
    const before = await snapshot();
    await expect(h.sql.batch(cancellationBatch(h, original, false))).rejects.toMatchObject({
      code: "constraint",
    });
    expect(await snapshot()).toEqual(before);
    const batch = cancellationBatch(h, original);
    await expect(
      h.sql.batch([
        ...batch,
        {
          sql: "INSERT INTO shared_app_staging_batch_assertions VALUES ('final-failure',0,0)",
          params: [],
        },
      ]),
    ).rejects.toMatchObject({ code: "constraint" });
    expect(await snapshot()).toEqual(before);
    await h.sql.run(`CREATE TRIGGER cancellation_metadata_reject BEFORE UPDATE ON cancellation_metadata_fixture
      BEGIN SELECT RAISE(ABORT,'actual metadata constraint'); END`);
    await expect(h.sql.batch(cancellationBatch(h, original))).rejects.toMatchObject({
      code: "constraint",
    });
    expect(await snapshot()).toEqual(before);
  } finally {
    await h.close();
  }
});

test("native D1 cancellation never falls back to the old scalar schema", async () => {
  const h = await harness();
  try {
    const owner = h.ledger.forTrustedOwner(SERVER);
    const original = await owner.reserve({
      reservationId: "old-schema-original",
      name: "old-schema-original",
    });
    const release = owner.prepareReleaseUnpublished(original);
    await expect(h.sql.batch([...release.before, ...release.after])).rejects.toBeDefined();
    expect(await owner.readOriginal(original.reservationId)).toEqual(original);
    expect(
      await h.sql.query("SELECT generation,state,released_at FROM shared_app_staging_names"),
    ).toEqual([{ generation: 1, state: "reserved", released_at: null }]);
  } finally {
    await h.close();
  }
});

test("native D1 unpublished cancellation refuses a foreign full pin and retained route history", async () => {
  const h = await harness({ unpublishedRelease: true });
  try {
    const owner = h.ledger.forTrustedOwner(SERVER);
    const original = await owner.reserve({
      reservationId: "history-original",
      name: "history-original",
    });
    await h.sql.run("INSERT INTO cancellation_metadata_fixture VALUES (?,'prepared',NULL)", [
      original.incarnation,
    ]);
    const foreign = h.ledger.forTrustedOwner(HOSTED).prepareReleaseUnpublished({
      ...original,
      ...HOSTED,
    });
    await expect(h.sql.batch([...foreign.before, ...foreign.after])).rejects.toMatchObject({
      code: "constraint",
    });
    expect(await owner.readOriginal(original.reservationId)).toEqual(original);
    // Constraints-valid retained command with a degraded old head: presence is never an untouched hold.
    await h.sql.run(
      `INSERT INTO shared_app_staging_route_commands
      (organization_id,product,reservation_id,name,incarnation,action,command_ref,prior_generation,
       prior_state,prior_script,next_script,endpoint_uid,endpoint_generation,worker_uid,deployment_uid,
       deployment_generation,source_operation_id,provider_id,target_key,next_generation,next_state,created_at)
      VALUES (?,?,?,?,?,'activate','retained-command',1,'reserved',NULL,'historical-script',
        'endpoint',1,'worker','deployment',1,'operation','provider','target',2,'active',?)`,
      [
        SERVER.organizationId,
        SERVER.product,
        original.reservationId,
        original.name,
        original.incarnation,
        START,
      ],
    );
    const history = await h.sql.query("SELECT * FROM shared_app_staging_route_commands");
    await expect(h.sql.batch(cancellationBatch(h, original))).rejects.toMatchObject({
      code: "constraint",
    });
    expect(await owner.readOriginal(original.reservationId)).toEqual(original);
    expect(await h.sql.query("SELECT * FROM shared_app_staging_route_commands")).toEqual(history);
    expect(await h.sql.query("SELECT * FROM cancellation_metadata_fixture")).toEqual([
      { incarnation: original.incarnation, state: "prepared", released_at: null },
    ]);
    expect(await h.sql.query("SELECT * FROM shared_app_staging_batch_assertions")).toEqual([]);
  } finally {
    await h.close();
  }
});

test("native D1 cancellation lost ACK keeps the original and first timestamp for primary readback", async () => {
  const h = await harness({ unpublishedRelease: true });
  try {
    const owner = h.ledger.forTrustedOwner(SERVER);
    const original = await owner.reserve({
      reservationId: "lost-cancel-original",
      name: "lost-cancel-original",
    });
    await h.sql.run("INSERT INTO cancellation_metadata_fixture VALUES (?,'prepared',NULL)", [
      original.incarnation,
    ]);
    const effects = owner.prepareReleaseUnpublished(original);
    const batch = cancellationBatch(h, original);
    h.loseAck();
    await expect(
      createD1Sql(h.binding.withSession("first-primary")).batch(batch),
    ).rejects.toBeDefined();
    await expect(owner.readOriginal(original.reservationId)).rejects.toBeDefined();
    expect(effects.original).toEqual({
      environment: original.environment,
      organizationId: original.organizationId,
      product: original.product,
      reservationId: original.reservationId,
      name: original.name,
      incarnation: original.incarnation,
      generation: original.generation,
    });
    expect(effects.releasedAt).toBe(START);
    h.setNow(START + 10_000);
    h.restoreReads();
    expect(await owner.readOriginal(original.reservationId)).toEqual({
      ...original,
      generation: 2,
      state: "released",
      releasedAt: START,
    });
    expect(await h.sql.query("SELECT * FROM cancellation_metadata_fixture")).toEqual([
      { incarnation: original.incarnation, state: "released", released_at: START },
    ]);
    expect(await h.sql.query("SELECT * FROM shared_app_staging_batch_assertions")).toEqual([]);
  } finally {
    await h.close();
  }
});

test("native D1 globally serializes NFKC races across both products and Organizations", async () => {
  const h = await harness();
  try {
    const owners = [
      SERVER,
      HOSTED,
      { organizationId: "org-third", product: "takoserver" as const },
    ];
    const names = ["Ａｌｐｈａ", "alpha", "Alpha"];
    const results = await Promise.allSettled(
      owners.map((owner, i) =>
        h.ledger
          .forTrustedOwner(owner)
          .reserve({ reservationId: `race-${i}`, name: names[i] ?? "alpha" }),
      ),
    );
    expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    for (const value of results)
      if (value.status === "rejected") expect(value.reason).toMatchObject({ code: "conflict" });
    expect(await h.sql.query("SELECT normalized_name FROM shared_app_staging_names")).toEqual([
      { normalized_name: "alpha" },
    ]);
    expect(await h.sql.query("SELECT COUNT(*) AS n FROM shared_app_staging_assignments")).toEqual([
      { n: 1 },
    ]);
    expect(await h.ledger.readCurrent("alpha")).toBeNull();
  } finally {
    await h.close();
  }
});

test("one original command cannot claim two names, or be borrowed by another product", async () => {
  const h = await harness();
  try {
    const owner = h.ledger.forTrustedOwner(SERVER);
    const results = await Promise.allSettled([
      owner.reserve({ reservationId: "same", name: "first-name" }),
      owner.reserve({ reservationId: "same", name: "other-name" }),
    ]);
    expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((value) => value.status === "rejected")).toHaveLength(1);
    expect(await h.sql.query("SELECT COUNT(*) AS n FROM shared_app_staging_names")).toEqual([
      { n: 1 },
    ]);
    expect(await h.sql.query("SELECT COUNT(*) AS n FROM shared_app_staging_assignments")).toEqual([
      { n: 1 },
    ]);
    const original = await owner.readOriginal("same");
    if (!original) throw new Error("original missing");
    expect(await owner.reserve({ reservationId: "same", name: original.name })).toEqual(original);
    await expect(
      h.ledger
        .forTrustedOwner({ ...SERVER, product: "takosumi-hosted" })
        .reserve({ reservationId: "same", name: original.name }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await h.ledger.forTrustedOwner(HOSTED).readOriginal("same")).toBeNull();
  } finally {
    await h.close();
  }
});

test("release retains its permanent tombstone and never permits another incarnation", async () => {
  const h = await harness();
  try {
    const owner = h.ledger.forTrustedOwner(SERVER);
    const other = h.ledger.forTrustedOwner(HOSTED);
    const reserved = await owner.reserve({ reservationId: "old", name: "reused-name" });
    const active = await owner.activate(reserved, "old-script");
    const selected = await h.ledger.readCurrent(active.name);
    if (!selected) throw new Error("selection missing");
    expect(await h.ledger.isCurrentBeforeDispatch(selected)).toBe(true);
    const released = await owner.release(active);
    for (const at of [
      START,
      START + THIRTY_DAYS - 1,
      START + THIRTY_DAYS,
      START + 31 * 24 * 60 * 60 * 1_000,
      Date.parse("9999-01-01T00:00:00Z"),
    ]) {
      h.setNow(at);
      expect(await owner.release(active)).toEqual(released);
      for (const writer of [owner, other])
        await expect(
          writer.reserve({ reservationId: `never-${at}`, name: active.name }),
        ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        owner.reserve({ reservationId: "old", name: active.name }),
      ).rejects.toMatchObject({ code: "conflict" });
    }
    expect(await h.ledger.readCurrent(active.name)).toBeNull();
    expect(await h.ledger.isCurrentAfterDispatch(selected)).toBe(false);
    expect(await h.ledger.isCurrentBeforeDispatch(selected)).toBe(false);
    expect(await h.ledger.isCurrentAfterDispatch(selected)).toBe(false);
    await expect(owner.activate(reserved, "old-script")).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(other.release(released)).rejects.toMatchObject({ code: "conflict" });
    expect(await owner.readOriginal("old")).toEqual(released);
    expect(
      await h.sql.query(
        "SELECT incarnation, generation, state, released_at FROM shared_app_staging_names WHERE normalized_name = ?",
        [active.name],
      ),
    ).toEqual([
      {
        incarnation: released.incarnation,
        generation: released.generation,
        state: "released",
        released_at: released.releasedAt,
      },
    ]);
    expect(await h.sql.query("SELECT COUNT(*) AS n FROM shared_app_staging_assignments")).toEqual([
      { n: 1 },
    ]);
  } finally {
    await h.close();
  }
});

test("fresh primary pre/post fences reject a late old response and do not preserve a stale negative", async () => {
  const h = await harness();
  try {
    const owner = h.ledger.forTrustedOwner(SERVER);
    const staleNegative = await h.ledger.readCurrent("response-race");
    expect(staleNegative).toBeNull();
    const active = await owner.activate(
      await owner.reserve({ reservationId: "race", name: "response-race" }),
      "old-script",
    );
    const selected = await h.ledger.readCurrent(active.name);
    if (!selected) throw new Error("fresh primary hid a new assignment");
    const beforeCount = h.sessions.length;
    expect(await h.ledger.isCurrentBeforeDispatch(selected)).toBe(true);
    expect(h.sessions.length).toBe(beforeCount + 1);
    let deliver: (() => void) | undefined;
    const response = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    const oldResponse = response.then(() => h.ledger.isCurrentAfterDispatch(selected));
    await owner.release(active);
    h.setNow(START + THIRTY_DAYS);
    const next = h.ledger.forTrustedOwner(HOSTED);
    await expect(
      next.reserve({ reservationId: "blocked", name: active.name }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await h.ledger.readCurrent("fresh-response")).toBeNull();
    await next.activate(
      await next.reserve({ reservationId: "next", name: "fresh-response" }),
      "new-script",
    );
    deliver?.();
    expect(await oldResponse).toBe(false);
    expect(await h.ledger.readCurrent(active.name)).toBeNull();
    const fresh = await h.ledger.readCurrent("fresh-response");
    if (!fresh) throw new Error("current assignment missing");
    expect(await h.ledger.isCurrentAfterDispatch(fresh)).toBe(true);
    expect(h.sessions.every((constraint) => constraint === "first-primary")).toBe(true);
    h.blockReads();
    await expect(h.ledger.readCurrent(active.name)).rejects.toMatchObject({ code: "unavailable" });
    await expect(h.ledger.isCurrentAfterDispatch(fresh)).rejects.toMatchObject({
      code: "unavailable",
    });
  } finally {
    await h.close();
  }
});

test("native committed lost ACK retains original command and replays after reconstruction", async () => {
  const h = await harness();
  try {
    const owner = h.ledger.forTrustedOwner(SERVER);
    const input = { reservationId: "original", name: "lost-ack" };
    h.loseAck();
    const pending = owner.reserve(input);
    input.reservationId = "mutated";
    input.name = "wrong-name";
    await expect(pending).rejects.toMatchObject({
      code: "indeterminate",
      original: { ...SERVER, reservationId: "original", name: "lost-ack" },
    });
    h.restoreReads();
    const restarted = createSharedAppLedgerD1({
      database: h.binding,
      environment: "staging",
      clock: () => new Date(START),
    }).forTrustedOwner(SERVER);
    const retained = await restarted.readOriginal("original");
    if (!retained) throw new Error("retained original missing");
    expect(retained).toMatchObject({
      reservationId: "original",
      name: "lost-ack",
      state: "reserved",
    });
    expect(await restarted.reserve({ reservationId: "original", name: "Ｌｏｓｔ-Ａｃｋ" })).toEqual(
      retained,
    );
    await expect(
      restarted.reserve({ reservationId: "original", name: "wrong-name" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await h.sql.query("SELECT COUNT(*) AS n FROM shared_app_staging_assignments")).toEqual([
      { n: 1 },
    ]);
    h.loseAck();
    await expect(restarted.activate(retained, "pinned-script")).rejects.toMatchObject({
      code: "indeterminate",
      original: {
        reservationId: "original",
        action: "activate",
        incarnation: retained.incarnation,
        expectedGeneration: retained.generation,
        acceptedScript: "pinned-script",
      },
    });
    h.restoreReads();
    expect(await restarted.activate(retained, "pinned-script")).toMatchObject({
      state: "active",
      script: "pinned-script",
      generation: retained.generation + 1,
    });
    await expect(restarted.activate(retained, "foreign-script")).rejects.toMatchObject({
      code: "conflict",
    });
    const active = await restarted.readOriginal("original");
    if (!active) throw new Error("active original missing");
    h.loseAck();
    await expect(restarted.release(active)).rejects.toMatchObject({
      code: "indeterminate",
      original: { reservationId: "original", name: "lost-ack" },
    });
    h.restoreReads();
    const later = createSharedAppLedgerD1({
      database: h.binding,
      environment: "staging",
      clock: () => new Date(START + 20 * 24 * 60 * 60 * 1_000),
    }).forTrustedOwner(SERVER);
    const released = await later.release(active);
    expect(released).toMatchObject({ state: "released", releasedAt: START });
    expect(await later.readOriginal("original")).toEqual(released);
    await expect(
      later.reserve({ reservationId: "replacement", name: "lost-ack" }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
  } finally {
    await h.close();
  }
});

test("D1 batch rollback retains no partial history or name and tables isolate environments", async () => {
  const h = await harness();
  try {
    await h.sql.run(
      "CREATE TRIGGER test_name_failure BEFORE INSERT ON shared_app_staging_names WHEN NEW.normalized_name = 'rollback-name' BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END",
    );
    const owner = h.ledger.forTrustedOwner(SERVER);
    await expect(
      owner.reserve({ reservationId: "rollback", name: "rollback-name" }),
    ).rejects.toMatchObject({ code: "indeterminate" });
    expect(await owner.readOriginal("rollback")).toBeNull();
    expect(await h.sql.query("SELECT COUNT(*) AS n FROM shared_app_staging_assignments")).toEqual([
      { n: 0 },
    ]);
    expect(await h.sql.query("SELECT COUNT(*) AS n FROM shared_app_staging_names")).toEqual([
      { n: 0 },
    ]);
    const productionFixture = createSharedAppLedgerD1({
      database: h.binding,
      environment: "production",
      clock: () => new Date(START),
    });
    const staging = await owner.reserve({ reservationId: "one", name: "same-name" });
    await h.sql.run(
      "CREATE TRIGGER test_activation_failure BEFORE UPDATE ON shared_app_staging_names WHEN NEW.state = 'active' BEGIN SELECT RAISE(ABORT, 'fixture activation rollback'); END",
    );
    await expect(owner.activate(staging, "script")).rejects.toMatchObject({
      code: "indeterminate",
    });
    expect(await owner.readOriginal("one")).toEqual(staging);
    expect(await h.ledger.readCurrent(staging.name)).toBeNull();
    const production = await productionFixture
      .forTrustedOwner(HOSTED)
      .reserve({ reservationId: "two", name: "same-name" });
    expect(staging.incarnation).not.toBe(production.incarnation);
    await expect(owner.activate(production, "foreign-realm")).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(await h.sql.query("SELECT COUNT(*) AS n FROM shared_app_production_names")).toEqual([
      { n: 1 },
    ]);
    expect(await h.sql.query("SELECT COUNT(*) AS n FROM shared_app_staging_names")).toEqual([
      { n: 1 },
    ]);
  } finally {
    await h.close();
  }
});

test("a successful native write ACK followed by read loss retains the full original command", async () => {
  const h = await harness();
  try {
    const owner = h.ledger.forTrustedOwner(SERVER);
    h.hideReadAfterCommit();
    await expect(
      owner.reserve({ reservationId: "ack-read-loss", name: "ack-read-loss" }),
    ).rejects.toMatchObject({
      code: "indeterminate",
      original: {
        ...SERVER,
        reservationId: "ack-read-loss",
        name: "ack-read-loss",
        action: "reserve",
        expectedGeneration: null,
        acceptedScript: null,
      },
    });
    h.restoreReads();
    const reserved = await owner.readOriginal("ack-read-loss");
    if (!reserved) throw new Error("native committed row missing");
    h.hideReadAfterCommit();
    await expect(owner.activate(reserved, "accepted-script")).rejects.toMatchObject({
      code: "indeterminate",
      original: {
        incarnation: reserved.incarnation,
        expectedGeneration: reserved.generation,
        acceptedScript: "accepted-script",
        action: "activate",
      },
    });
    h.restoreReads();
    expect(await owner.activate(reserved, "accepted-script")).toMatchObject({ state: "active" });
    expect(await h.sql.query("SELECT COUNT(*) AS n FROM shared_app_staging_assignments")).toEqual([
      { n: 1 },
    ]);
  } finally {
    await h.close();
  }
});

test("native activation/release CAS race settles one transition without a split head/history", async () => {
  const h = await harness();
  try {
    const owner = h.ledger.forTrustedOwner(SERVER);
    const reserved = await owner.reserve({ reservationId: "transition", name: "cas-race" });
    const outcomes = await Promise.allSettled([
      owner.activate(reserved, "accepted-script"),
      owner.release(reserved),
    ]);
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    for (const value of outcomes)
      if (value.status === "rejected") {
        expect(value.reason).toMatchObject({ code: "conflict" });
      }
    const original = await owner.readOriginal("transition");
    if (!original) throw new Error("transition original missing");
    expect(original.generation).toBe(reserved.generation + 1);
    const head = await h.sql.query(
      "SELECT incarnation, generation, state, released_at FROM shared_app_staging_names WHERE normalized_name = 'cas-race'",
    );
    expect(head).toEqual([
      {
        incarnation: original.incarnation,
        generation: original.generation,
        state: original.state,
        released_at: original.releasedAt,
      },
    ]);
    expect((await h.ledger.readCurrent(original.name))?.script ?? null).toBe(
      original.state === "active" ? "accepted-script" : null,
    );
  } finally {
    await h.close();
  }
});

test("read-only legacy adoption inventory preserves every D1 source row and refuses alias winners", async () => {
  const h = await harness();
  try {
    await h.sql.run(
      "CREATE TABLE legacy_fixture (source_ref TEXT PRIMARY KEY, name TEXT, state TEXT, released_at INTEGER, opaque_history TEXT)",
    );
    for (const row of [
      ["old-a", "Alpha", "activated", null],
      ["old-b", "ａｌｐｈａ", "activated", null],
      ["old-release", "released-name", "released", START - 100],
      ["old-drain", "ab", "bound", null],
    ]) {
      await h.sql.run(
        "INSERT INTO legacy_fixture VALUES (?, ?, ?, ?, 'retain-original-bytes')",
        row,
      );
    }
    const before = await h.sql.query("SELECT * FROM legacy_fixture ORDER BY source_ref");
    const projections = before.map((row) => ({
      sourceReference: String(row.source_ref),
      requestedName: String(row.name),
      state: row.state as SharedAppLegacyProjection["state"],
      releasedAt: row.released_at as number | null,
    }));
    const plan = planSharedAppLegacyAdoption(projections);
    expect(plan.candidates).toEqual([
      {
        name: "released-name",
        original: {
          sourceReference: "old-release",
          requestedName: "released-name",
          state: "released",
          releasedAt: START - 100,
        },
      },
    ]);
    expect(plan.blocked).toContainEqual({ sourceReference: "old-a", reason: "collision" });
    expect(plan.blocked).toContainEqual({ sourceReference: "old-b", reason: "collision" });
    expect(plan.blocked).toContainEqual({ sourceReference: "old-drain", reason: "drain_only" });
    expect(await h.sql.query("SELECT * FROM legacy_fixture ORDER BY source_ref")).toEqual(before);
    expect(await h.sql.query("SELECT COUNT(*) AS n FROM shared_app_staging_names")).toEqual([
      { n: 0 },
    ]);
  } finally {
    await h.close();
  }
});

test("invalid names refuse before D1 and trusted owner pins cannot drift across awaits", async () => {
  const h = await harness();
  try {
    const ownerInput = { ...SERVER };
    const owner = h.ledger.forTrustedOwner(ownerInput);
    ownerInput.organizationId = "foreign-org";
    const before = h.sessions.length;
    for (const name of [
      "Admin",
      "admin.",
      "xn--hello",
      "bad--name",
      "xx",
      "x".repeat(33),
      "name-staging",
    ]) {
      await expect(owner.reserve({ reservationId: "invalid", name })).rejects.toMatchObject({
        code: "invalid_argument",
      });
    }
    expect(h.sessions.length).toBe(before);
    const value = await owner.reserve({ reservationId: "pinned", name: "valid-name" });
    expect(value.organizationId).toBe(SERVER.organizationId);
    const expected = { ...value };
    const pending = owner.activate(expected, "exact-script");
    expected.reservationId = "mutated";
    expected.incarnation = "f".repeat(32);
    expect(await pending).toMatchObject({
      reservationId: "pinned",
      incarnation: value.incarnation,
      script: "exact-script",
    });
  } finally {
    await h.close();
  }
});

test("native D1 active head inconsistencies fail both fresh primary fences", async () => {
  const corruptions = [
    "UPDATE shared_app_staging_names SET generation = generation + 1 WHERE normalized_name = ?",
    "UPDATE shared_app_staging_assignments SET state = 'reserved', script = NULL WHERE name = ?",
    "UPDATE shared_app_staging_assignments SET name = 'renamed-head' WHERE name = ?",
    `UPDATE shared_app_staging_names SET incarnation = (
      SELECT incarnation FROM shared_app_staging_assignments WHERE name = 'other-head'
    ) WHERE normalized_name = ?`,
  ];
  for (const corruption of corruptions) {
    const h = await harness();
    try {
      const owner = h.ledger.forTrustedOwner(SERVER);
      const active = await owner.activate(
        await owner.reserve({ reservationId: "corrupt", name: "corrupt-head" }),
        "original-script",
      );
      await owner.reserve({ reservationId: "other", name: "other-head" });
      const selected = await h.ledger.readCurrent(active.name);
      if (!selected) throw new Error("healthy active selection missing");
      expect(await h.ledger.isCurrentBeforeDispatch(selected)).toBe(true);
      let deliver: (() => void) | undefined;
      const response = new Promise<void>((resolve) => {
        deliver = resolve;
      });
      const lateResponse = response.then(() => h.ledger.isCurrentAfterDispatch(selected));

      // Each mutation preserves every native CHECK and FK while breaking the head/assignment tuple.
      await h.sql.run(corruption, [active.name]);
      const rows = () =>
        Promise.all([
          h.sql.query("SELECT * FROM shared_app_staging_names ORDER BY normalized_name"),
          h.sql.query("SELECT * FROM shared_app_staging_assignments ORDER BY incarnation"),
        ]);
      const before = await rows();
      for (const read of [
        () => h.ledger.readCurrent(active.name),
        () => h.ledger.isCurrentBeforeDispatch(selected),
        () => h.ledger.isCurrentAfterDispatch(selected),
      ]) {
        const sessions = h.sessions.length;
        await expect(read()).rejects.toMatchObject({ code: "unavailable" });
        expect(h.sessions.length).toBe(sessions + 1);
      }
      const sessions = h.sessions.length;
      deliver?.();
      await expect(lateResponse).rejects.toMatchObject({ code: "unavailable" });
      expect(h.sessions.length).toBe(sessions + 1);
      expect(await rows()).toEqual(before);
      expect(h.sessions.every((constraint) => constraint === "first-primary")).toBe(true);
    } finally {
      await h.close();
    }
  }
});

test("native D1 consistent absent inactive and newer selections keep normal read results", async () => {
  const h = await harness();
  try {
    const owner = h.ledger.forTrustedOwner(SERVER);
    expect(await h.ledger.readCurrent("absent-head")).toBeNull();
    const reserved = await owner.reserve({ reservationId: "healthy", name: "healthy-head" });
    expect(await h.ledger.readCurrent(reserved.name)).toBeNull();
    expect(await h.ledger.isCurrentBeforeDispatch({ ...reserved, script: "not-active" })).toBe(
      false,
    );
    expect(await h.ledger.isCurrentAfterDispatch({ ...reserved, script: "not-active" })).toBe(
      false,
    );
    const active = await owner.activate(reserved, "original-script");
    const selected = await h.ledger.readCurrent(active.name);
    if (!selected) throw new Error("healthy active selection missing");
    expect(await h.ledger.isCurrentBeforeDispatch(selected)).toBe(true);
    expect(await h.ledger.isCurrentAfterDispatch(selected)).toBe(true);

    // Fixture setup for a consistent newer tuple, not an owner publication mount.
    await h.sql.batch([
      {
        sql: `UPDATE shared_app_staging_assignments SET generation = generation + 1,
          script = 'successor-script' WHERE name = ?`,
        params: [active.name],
      },
      {
        sql: `UPDATE shared_app_staging_names SET generation = generation + 1
          WHERE normalized_name = ?`,
        params: [active.name],
      },
    ]);
    const current = await h.ledger.readCurrent(active.name);
    expect(current).toMatchObject({
      generation: active.generation + 1,
      script: "successor-script",
    });
    expect(await h.ledger.isCurrentBeforeDispatch(selected)).toBe(false);
    expect(await h.ledger.isCurrentAfterDispatch(selected)).toBe(false);
    if (!current) throw new Error("healthy newer selection missing");
    expect(await h.ledger.isCurrentBeforeDispatch(current)).toBe(true);
    expect(await h.ledger.isCurrentAfterDispatch(current)).toBe(true);
    await owner.release(current);
    expect(await h.ledger.readCurrent(current.name)).toBeNull();
    expect(await h.ledger.isCurrentBeforeDispatch(current)).toBe(false);
    expect(await h.ledger.isCurrentAfterDispatch(current)).toBe(false);
  } finally {
    await h.close();
  }
});
