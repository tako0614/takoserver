import { canonicalJson, isJsonObject, type JsonObject } from "./json.ts";
import { prepareLedgerMicrosHoldRelease } from "./ledger.ts";
import { minorToMicros } from "./money.ts";
import type { Clock, Sql } from "./ports.ts";

const RETENTION_MS = 24 * 60 * 60 * 1_000;

/** Expired pending calls cannot be retried or billed; return their exact hold. */
export async function expirePendingAiRequests(
  sql: Sql,
  clock: Clock,
  limit: number,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError("invalid AI expiry limit");
  const now = clock().getTime();
  const rows = await sql.query(
    `SELECT scope_key, fingerprint, status, body_json, expires_at FROM idempotency
     WHERE scope_key LIKE 'ai:%' AND status IN (100, 101, 102) AND expires_at <= ?
     ORDER BY expires_at, scope_key LIMIT ?`,
    [now, limit],
  );
  let expired = 0;
  for (const row of rows) {
    if (
      typeof row.scope_key !== "string" ||
      typeof row.fingerprint !== "string" ||
      typeof row.body_json !== "string"
    ) {
      throw new AiRequestStoreError("state_unavailable");
    }
    const record = parseRecord(Number(row.status), row.body_json);
    if (record.kind !== "pending") throw new AiRequestStoreError("state_conflict");
    try {
      const holds = await sql.query(
        `SELECT org_id, held_delta_micros FROM ledger WHERE type = 'hold' AND ref = ?
       AND substr(?, 1, length(org_id) + 4) = 'ai:' || org_id || ':'`,
        [record.requestId, row.scope_key],
      );
      if (
        holds.length > 1 ||
        (holds.length === 0 && record.phase !== "claimed" && record.ceilingMicros > 0)
      ) {
        throw new AiRequestStoreError("state_unavailable");
      }
      const hold = holds[0];
      if (
        hold &&
        (typeof hold.org_id !== "string" || hold.held_delta_micros !== record.ceilingMicros)
      ) {
        throw new AiRequestStoreError("state_conflict");
      }
      const release = hold
        ? await prepareLedgerMicrosHoldRelease(sql, clock, {
            organizationId: String(hold.org_id),
            reference: record.requestId,
            amountMicros: record.ceilingMicros,
          })
        : [];
      const guardId = `ai_expiry_${crypto.randomUUID()}`;
      const terminal: AiRejectedRequest = {
        kind: "rejected",
        phase: "completed",
        responseStatus: 410,
        responseBody: {
          error: { code: "request_expired", message: "Request expired", type: "request_error" },
          request_id: record.requestId,
        },
      };
      await sql.batch([
        {
          sql: `INSERT INTO wallet_allocation_guards (id, valid) VALUES (?, CASE WHEN EXISTS (
            SELECT 1 FROM idempotency WHERE scope_key = ? AND fingerprint = ? AND status = ?
            AND body_json = ? AND expires_at = ? AND expires_at <= ?) THEN 1 ELSE 0 END)`,
          params: [
            guardId,
            row.scope_key,
            row.fingerprint,
            Number(row.status),
            row.body_json,
            Number(row.expires_at),
            now,
          ],
        },
        ...release,
        {
          sql: "UPDATE idempotency SET status = 410, body_json = ? WHERE scope_key = ?",
          params: [canonicalJson(terminal), row.scope_key],
        },
        { sql: "DELETE FROM wallet_allocation_guards WHERE id = ?", params: [guardId] },
      ]);
      expired += 1;
    } catch (error) {
      const current = await sql.query(
        "SELECT status, body_json FROM idempotency WHERE scope_key = ?",
        [row.scope_key],
      );
      // A completion or another expiry won the transaction. Never release a
      // staged result's hold: it has exact billable usage awaiting settlement.
      if (current[0]?.status === row.status && current[0]?.body_json === row.body_json) throw error;
    }
  }
  return expired;
}

export interface AiPendingRequest {
  readonly kind: "pending";
  readonly phase: "claimed" | "ready" | "dispatched";
  readonly requestId: string;
  readonly moneyPolicy: "usd-micros-v2";
  readonly ceilingMicros: number;
}

export interface AiSettledRequest {
  readonly kind: "result";
  readonly phase: "staged" | "completed";
  readonly requestId: string;
  readonly moneyPolicy: "usd-micros-v2";
  readonly ceilingMicros: number;
  readonly actualMicros: number;
  readonly responseStatus: number;
  readonly responseBody: JsonObject;
  readonly usageModel: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A completed v1 receipt is read-only evidence in its original cents unit. */
export interface AiLegacySettledRequest {
  readonly kind: "result";
  readonly phase: "completed";
  readonly moneyPolicy: "usd-cents-v1";
  readonly requestId: string;
  readonly ceilingMinor: number;
  readonly actualMinor: number;
  readonly ceilingMicros: number;
  readonly actualMicros: number;
  readonly responseStatus: number;
  readonly responseBody: JsonObject;
  readonly usageModel: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AiRejectedRequest {
  readonly kind: "rejected";
  readonly phase: "completed";
  readonly responseStatus: number;
  readonly responseBody: JsonObject;
}

export type AiRequestRecord =
  | AiPendingRequest
  | AiSettledRequest
  | AiLegacySettledRequest
  | AiRejectedRequest;

export interface ClaimedAiRequest {
  readonly scope: string;
  readonly fingerprint: string;
  readonly created: boolean;
  readonly record: AiRequestRecord;
}

/**
 * Durable state machine around one paid inference.
 *
 * `dispatched` is deliberately not auto-retried: an upstream may have accepted
 * the request before this process disappeared. `staged` is safe to resume,
 * because the exact response and billable usage are already durable and every
 * ledger/usage write below it is independently idempotent.
 */
export function createAiRequestStore(sql: Sql, clock: Clock) {
  const read = async (scope: string, fingerprint: string): Promise<AiRequestRecord> => {
    const rows = await sql.query(
      "SELECT fingerprint, status, body_json FROM idempotency WHERE scope_key = ? AND expires_at > ?",
      [scope, clock().getTime()],
    );
    const row = rows[0];
    if (rows.length !== 1 || row === undefined || typeof row.body_json !== "string") {
      throw new AiRequestStoreError("state_unavailable");
    }
    if (row.fingerprint !== fingerprint) throw new AiRequestStoreError("fingerprint_conflict");
    return parseRecord(Number(row.status), row.body_json);
  };

  const transition = async (
    scope: string,
    fingerprint: string,
    fromStatus: number,
    toStatus: number,
    record: AiRequestRecord,
  ): Promise<AiRequestRecord> => {
    const body = canonicalJson(record);
    const changed = await sql.run(
      `UPDATE idempotency SET status = ?, body_json = ?
       WHERE scope_key = ? AND fingerprint = ? AND status = ? AND expires_at > ?`,
      [toStatus, body, scope, fingerprint, fromStatus, clock().getTime()],
    );
    if (changed.changes === 1) return record;
    const existing = await read(scope, fingerprint);
    if (canonicalJson(existing) === body) return existing;
    throw new AiRequestStoreError("state_conflict");
  };

  return {
    async lookupCompletedLegacy(input: {
      readonly organizationId: string;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    }): Promise<AiLegacySettledRequest | null> {
      const scope = `ai:${input.organizationId}:${input.idempotencyKey}`;
      const rows = await sql.query(
        "SELECT fingerprint, status, body_json, expires_at FROM idempotency WHERE scope_key = ?",
        [scope],
      );
      if (rows.length === 0) return null;
      const row = rows[0];
      if (
        rows.length !== 1 ||
        row === undefined ||
        typeof row.body_json !== "string" ||
        typeof row.expires_at !== "number" ||
        row.expires_at <= clock().getTime()
      ) {
        throw new AiRequestStoreError("state_unavailable");
      }
      if (row.fingerprint !== input.fingerprint) {
        throw new AiRequestStoreError("fingerprint_conflict");
      }
      const record = parseRecord(Number(row.status), row.body_json);
      return record.kind === "result" && record.moneyPolicy === "usd-cents-v1" ? record : null;
    },

    async claim(input: {
      readonly organizationId: string;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
      readonly requestId: string;
      readonly ceilingMicros: number;
    }): Promise<ClaimedAiRequest> {
      const scope = `ai:${input.organizationId}:${input.idempotencyKey}`;
      const record: AiPendingRequest = {
        kind: "pending",
        phase: "claimed",
        requestId: input.requestId,
        moneyPolicy: "usd-micros-v2",
        ceilingMicros: input.ceilingMicros,
      };
      const inserted = await sql.run(
        `INSERT OR IGNORE INTO idempotency
           (scope_key, fingerprint, status, body_json, expires_at)
         VALUES (?, ?, 100, ?, ?)`,
        [scope, input.fingerprint, canonicalJson(record), clock().getTime() + RETENTION_MS],
      );
      return {
        scope,
        fingerprint: input.fingerprint,
        created: inserted.changes === 1,
        record: inserted.changes === 1 ? record : await read(scope, input.fingerprint),
      };
    },

    ready(claim: ClaimedAiRequest): Promise<AiRequestRecord> {
      if (claim.record.kind !== "pending") throw new AiRequestStoreError("state_conflict");
      return transition(claim.scope, claim.fingerprint, 100, 101, {
        ...claim.record,
        phase: "ready",
      });
    },

    dispatched(claim: ClaimedAiRequest, record: AiPendingRequest): Promise<AiRequestRecord> {
      return transition(claim.scope, claim.fingerprint, 101, 102, {
        ...record,
        phase: "dispatched",
      });
    },

    stage(
      claim: ClaimedAiRequest,
      record: Omit<AiSettledRequest, "phase">,
    ): Promise<AiRequestRecord> {
      return transition(claim.scope, claim.fingerprint, 102, 202, {
        ...record,
        phase: "staged",
      });
    },

    finish(claim: ClaimedAiRequest, record: AiSettledRequest): Promise<AiRequestRecord> {
      return transition(claim.scope, claim.fingerprint, 202, record.responseStatus, {
        ...record,
        phase: "completed",
      });
    },

    reject(
      claim: ClaimedAiRequest,
      responseStatus: number,
      responseBody: JsonObject,
    ): Promise<AiRequestRecord> {
      return transition(claim.scope, claim.fingerprint, 100, responseStatus, {
        kind: "rejected",
        phase: "completed",
        responseStatus,
        responseBody,
      });
    },
  };
}

export class AiRequestStoreError extends Error {
  constructor(readonly code: "fingerprint_conflict" | "state_conflict" | "state_unavailable") {
    super(code);
    this.name = "AiRequestStoreError";
  }
}

function parseRecord(status: number, body: string): AiRequestRecord {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new AiRequestStoreError("state_unavailable");
  }
  if (!isJsonObject(value)) throw new AiRequestStoreError("state_unavailable");

  if (
    value.kind === "pending" &&
    ((status === 100 && value.phase === "claimed") ||
      (status === 101 && value.phase === "ready") ||
      (status === 102 && value.phase === "dispatched")) &&
    typeof value.requestId === "string" &&
    value.moneyPolicy === "usd-micros-v2" &&
    nonNegativeInteger(value.ceilingMicros)
  ) {
    return value as unknown as AiPendingRequest;
  }
  if (
    value.kind === "result" &&
    ((status === 202 && value.phase === "staged") ||
      (status === value.responseStatus && value.phase === "completed")) &&
    typeof value.requestId === "string" &&
    value.moneyPolicy === "usd-micros-v2" &&
    nonNegativeInteger(value.ceilingMicros) &&
    nonNegativeInteger(value.actualMicros) &&
    positiveStatus(value.responseStatus) &&
    isJsonObject(value.responseBody) &&
    (value.usageModel === null || typeof value.usageModel === "string") &&
    nonNegativeInteger(value.inputTokens) &&
    nonNegativeInteger(value.outputTokens)
  ) {
    return value as unknown as AiSettledRequest;
  }
  if (
    value.kind === "result" &&
    value.phase === "completed" &&
    status === value.responseStatus &&
    value.moneyPolicy === undefined &&
    typeof value.requestId === "string" &&
    nonNegativeInteger(value.ceilingMinor) &&
    nonNegativeInteger(value.actualMinor) &&
    positiveStatus(value.responseStatus) &&
    isJsonObject(value.responseBody) &&
    (value.usageModel === null || typeof value.usageModel === "string") &&
    nonNegativeInteger(value.inputTokens) &&
    nonNegativeInteger(value.outputTokens)
  ) {
    try {
      return {
        ...(value as unknown as Omit<
          AiLegacySettledRequest,
          "moneyPolicy" | "ceilingMicros" | "actualMicros"
        >),
        moneyPolicy: "usd-cents-v1",
        ceilingMicros: minorToMicros(value.ceilingMinor),
        actualMicros: minorToMicros(value.actualMinor),
      };
    } catch {
      throw new AiRequestStoreError("state_unavailable");
    }
  }
  if (
    value.kind === "rejected" &&
    value.phase === "completed" &&
    status === value.responseStatus &&
    positiveStatus(value.responseStatus) &&
    isJsonObject(value.responseBody)
  ) {
    return value as unknown as AiRejectedRequest;
  }
  throw new AiRequestStoreError("state_unavailable");
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveStatus(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 200 && Number(value) <= 599;
}
