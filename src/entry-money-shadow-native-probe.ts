import {
  createMoneyCutoverSql,
  inspectMoneyCutoverGuard,
  MONEY_CUTOVER_EPOCH,
  MONEY_CUTOVER_WRITER_EPOCH_PATTERN,
} from "./money-cutover-sql.ts";
import type { Row, Sql } from "./ports.ts";
import { createD1Sql, type D1DatabaseLike } from "./sql-d1.ts";

/** This Worker is a one-use synthetic D1 diagnostic, never a product data plane. */
interface ProbeEnv {
  readonly STATE_DB: D1DatabaseLike;
  readonly MONEY_SHADOW_PROBE_AUTH: string;
  readonly MONEY_SHADOW_WRITER_EPOCH: string;
  readonly MONEY_SHADOW_REVOKED_EPOCH: string;
  readonly MONEY_SHADOW_BINDING_DIGEST: string;
  readonly MONEY_SHADOW_SOURCE_COMMIT: string;
}

const JOURNAL = "money_shadow_native_batch_probe_journal";
const EVENT = "evt_rehearsal";
const SHA = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const AUTH = /^[0-9a-f]{64}$/u;
const JOURNAL_DDL = `CREATE TABLE ${JOURNAL} (singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1), binding_digest TEXT NOT NULL, source_commit TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('started','complete','failed')), result_digest TEXT, started_at TEXT NOT NULL, finished_at TEXT)`;

function equalFixed(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return difference === 0;
}

function json(value: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function one(
  sql: Sql,
  statement: string,
  params?: readonly (string | number | null)[],
): Promise<Row> {
  const rows = await sql.query(statement, params);
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("shadow probe row shape differs");
  return rows[0];
}

async function snapshot(sql: Sql, expectedOutcome: "deferred" | "ignored"): Promise<string> {
  const [event, ledger, permit, epoch, freeze] = await Promise.all([
    one(
      sql,
      "SELECT event_id, type, livemode, object_id, event_created_at, received_at, outcome, outcome_detail, settled_at FROM stripe_events WHERE event_id = ?",
      [EVENT],
    ),
    one(
      sql,
      "SELECT id, org_id, type, ref, CAST(settled_delta_micros AS TEXT) AS settled_delta_micros, CAST(held_delta_micros AS TEXT) AS held_delta_micros, created_at FROM ledger WHERE id = 'fund-rehearsal'",
    ),
    one(sql, "SELECT COUNT(*) AS n FROM money_cutover_writer_permit"),
    one(sql, "SELECT writer_epoch FROM money_cutover_authorized_epoch WHERE singleton = 1"),
    one(sql, "SELECT COUNT(*) AS n FROM money_cutover_freeze"),
  ]);
  if (
    event.event_id !== EVENT ||
    event.outcome !== expectedOutcome ||
    permit.n !== 0 ||
    freeze.n !== 0 ||
    typeof epoch.writer_epoch !== "string"
  )
    throw new Error("shadow probe baseline differs");
  return digest({ event, ledger, permit, epoch, freeze });
}

async function journal(sql: Sql): Promise<Row | null> {
  const exists = await sql.query(
    "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
    [JOURNAL],
  );
  if (exists.length === 0) return null;
  if (exists.length !== 1 || exists[0]?.sql !== JOURNAL_DDL)
    throw new Error("shadow probe journal schema differs");
  const rows = await sql.query(
    `SELECT singleton, binding_digest, source_commit, state, result_digest, started_at, finished_at FROM ${JOURNAL}`,
  );
  if (rows.length !== 1 || rows[0]?.singleton !== 1)
    throw new Error("shadow probe journal differs");
  return rows[0];
}

async function rejected(action: () => Promise<unknown>, expected: RegExp): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error && expected.test(error.message)) return;
    throw new Error("shadow probe rejected operation with an unexpected error");
  }
  throw new Error("shadow probe unexpectedly admitted a forbidden write");
}

async function runProbe(raw: Sql, env: ProbeEnv): Promise<string> {
  const baseline = await snapshot(raw, "deferred");
  const guarded = createMoneyCutoverSql(raw, env.MONEY_SHADOW_WRITER_EPOCH);
  const success = await guarded.batch([
    {
      sql: "UPDATE stripe_events SET outcome = 'ignored' WHERE event_id = ? AND outcome = 'deferred'",
      params: [EVENT],
    },
  ]);
  const afterSuccess = await snapshot(raw, "ignored");
  if (success.length !== 1 || success[0]?.changes !== 1 || afterSuccess === baseline)
    throw new Error(
      "shadow probe current epoch batch did not observably change the seeded Stripe row",
    );

  // The second native D1.batch statement fails CHECK after a permit INSERT.
  await rejected(
    () =>
      raw.batch([
        {
          sql: `INSERT INTO money_cutover_writer_permit (singleton, epoch, writer_epoch) VALUES (1, '${MONEY_CUTOVER_EPOCH}', ?)`,
          params: [env.MONEY_SHADOW_WRITER_EPOCH],
        },
        {
          sql: "UPDATE money_cutover_writer_permit SET epoch = 'invalid-probe-epoch' WHERE singleton = 1",
        },
      ]),
    /CHECK constraint failed/iu,
  );
  if ((await snapshot(raw, "ignored")) !== afterSuccess)
    throw new Error("shadow probe false CHECK batch retained a permit or changed money rows");

  await rejected(
    () =>
      guarded.batch([
        {
          sql: "UPDATE stripe_events SET outcome = 'deferred' WHERE event_id = ?",
          params: [EVENT],
        },
        { sql: "UPDATE stripe_events SET livemode = 2 WHERE event_id = ?", params: [EVENT] },
      ]),
    /CHECK constraint failed/iu,
  );
  if ((await snapshot(raw, "ignored")) !== afterSuccess)
    throw new Error("shadow probe failed guarded batch changed Stripe or retained a permit");

  for (const statement of [
    "INSERT INTO stripe_events (event_id,type,livemode,event_created_at,received_at,outcome,settled_at) VALUES ('evt_native_raw','synthetic',0,'2026-10-14T00:00:00Z','2026-10-14T00:00:00Z','ignored','2026-10-14T00:00:00Z')",
    `UPDATE stripe_events SET outcome = 'deferred' WHERE event_id = '${EVENT}'`,
    `DELETE FROM stripe_events WHERE event_id = '${EVENT}'`,
  ]) {
    await rejected(() => raw.run(statement), /money cutover writer permit required/iu);
    if ((await snapshot(raw, "ignored")) !== afterSuccess)
      throw new Error("shadow probe raw legacy Stripe write changed the baseline");
  }
  const revoked = createMoneyCutoverSql(raw, env.MONEY_SHADOW_REVOKED_EPOCH);
  await rejected(
    () => revoked.run("UPDATE stripe_events SET outcome = 'deferred' WHERE event_id = ?", [EVENT]),
    /money cutover Writer epoch revoked/iu,
  );
  if ((await snapshot(raw, "ignored")) !== afterSuccess)
    throw new Error("shadow probe revoked epoch changed the baseline");
  return afterSuccess;
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    try {
      if (
        !AUTH.test(env.MONEY_SHADOW_PROBE_AUTH) ||
        !MONEY_CUTOVER_WRITER_EPOCH_PATTERN.test(env.MONEY_SHADOW_WRITER_EPOCH) ||
        !MONEY_CUTOVER_WRITER_EPOCH_PATTERN.test(env.MONEY_SHADOW_REVOKED_EPOCH) ||
        env.MONEY_SHADOW_WRITER_EPOCH === env.MONEY_SHADOW_REVOKED_EPOCH ||
        !SHA.test(env.MONEY_SHADOW_BINDING_DIGEST) ||
        !COMMIT.test(env.MONEY_SHADOW_SOURCE_COMMIT)
      )
        return json({ state: "unavailable" }, 503);
      const authorization = request.headers.get("authorization") ?? "";
      if (!equalFixed(`Bearer ${env.MONEY_SHADOW_PROBE_AUTH}`, authorization))
        return json({ state: "unauthorized" }, 401);
      const url = new URL(request.url);
      if (
        url.search !== "" ||
        url.hash !== "" ||
        (url.pathname !== "/status" && url.pathname !== "/run")
      )
        return json({ state: "not-found" }, 404);
      const raw = createD1Sql(env.STATE_DB);
      const recorded = await journal(raw);
      if (
        recorded !== null &&
        (recorded.binding_digest !== env.MONEY_SHADOW_BINDING_DIGEST ||
          recorded.source_commit !== env.MONEY_SHADOW_SOURCE_COMMIT)
      )
        return json({ state: "quarantined" }, 503);
      if (request.method === "GET" && url.pathname === "/status") {
        const completeReadbackMatches =
          recorded?.state === "complete"
            ? (await snapshot(raw, "ignored")) === recorded.result_digest
            : null;
        return json({
          state: recorded?.state ?? "absent",
          bindingDigest: env.MONEY_SHADOW_BINDING_DIGEST,
          sourceCommit: env.MONEY_SHADOW_SOURCE_COMMIT,
          resultDigest: recorded?.result_digest ?? null,
          completeReadbackMatches,
          permitEmpty:
            (await one(raw, "SELECT COUNT(*) AS n FROM money_cutover_writer_permit")).n === 0,
          writerEpochMatches:
            (
              await one(
                raw,
                "SELECT writer_epoch FROM money_cutover_authorized_epoch WHERE singleton = 1",
              )
            ).writer_epoch === env.MONEY_SHADOW_WRITER_EPOCH,
        });
      }
      if (request.method !== "POST" || url.pathname !== "/run" || request.body !== null)
        return json({ state: "method-or-body-rejected" }, 405);
      if (recorded !== null) return json({ state: "already-dispatched" }, 409);
      if ((await inspectMoneyCutoverGuard(raw, env.MONEY_SHADOW_WRITER_EPOCH)) !== "ready")
        return json({ state: "not-ready" }, 503);
      await snapshot(raw, "deferred");
      await raw.batch([
        { sql: JOURNAL_DDL },
        {
          sql: `INSERT INTO ${JOURNAL} (singleton,binding_digest,source_commit,state,started_at) VALUES (1,?,?,'started',?)`,
          params: [
            env.MONEY_SHADOW_BINDING_DIGEST,
            env.MONEY_SHADOW_SOURCE_COMMIT,
            new Date().toISOString(),
          ],
        },
      ]);
      try {
        const resultDigest = await runProbe(raw, env);
        const terminal = await raw.run(
          `UPDATE ${JOURNAL} SET state = 'complete', result_digest = ?, finished_at = ? WHERE singleton = 1 AND state = 'started' AND binding_digest = ?`,
          [resultDigest, new Date().toISOString(), env.MONEY_SHADOW_BINDING_DIGEST],
        );
        if (terminal.changes !== 1)
          throw new Error("shadow probe terminal journal update differed");
        return json({
          state: "complete",
          bindingDigest: env.MONEY_SHADOW_BINDING_DIGEST,
          resultDigest,
        });
      } catch {
        await raw
          .run(
            `UPDATE ${JOURNAL} SET state = 'failed', finished_at = ? WHERE singleton = 1 AND state = 'started'`,
            [new Date().toISOString()],
          )
          .catch(() => undefined);
        return json({ state: "failed" }, 503);
      }
    } catch {
      return json({ state: "quarantined" }, 503);
    }
  },
};
