import { canonicalJson, isJsonObject, type JsonObject } from "./json.ts";
import type { Clock, Sql } from "./ports.ts";

const RETENTION_MS = 24 * 60 * 60 * 1_000;

export interface AiPendingRequest {
  readonly kind: "pending";
  readonly phase: "claimed" | "ready" | "dispatched";
  readonly requestId: string;
  readonly ceilingMinor: number;
}

export interface AiSettledRequest {
  readonly kind: "result";
  readonly phase: "staged" | "completed";
  readonly requestId: string;
  readonly ceilingMinor: number;
  readonly actualMinor: number;
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

export type AiRequestRecord = AiPendingRequest | AiSettledRequest | AiRejectedRequest;

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
    async claim(input: {
      readonly organizationId: string;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
      readonly requestId: string;
      readonly ceilingMinor: number;
    }): Promise<ClaimedAiRequest> {
      const scope = `ai:${input.organizationId}:${input.idempotencyKey}`;
      const record: AiPendingRequest = {
        kind: "pending",
        phase: "claimed",
        requestId: input.requestId,
        ceilingMinor: input.ceilingMinor,
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
    nonNegativeInteger(value.ceilingMinor)
  ) {
    return value as unknown as AiPendingRequest;
  }
  if (
    value.kind === "result" &&
    ((status === 202 && value.phase === "staged") ||
      (status === value.responseStatus && value.phase === "completed")) &&
    typeof value.requestId === "string" &&
    nonNegativeInteger(value.ceilingMinor) &&
    nonNegativeInteger(value.actualMinor) &&
    positiveStatus(value.responseStatus) &&
    isJsonObject(value.responseBody) &&
    (value.usageModel === null || typeof value.usageModel === "string") &&
    nonNegativeInteger(value.inputTokens) &&
    nonNegativeInteger(value.outputTokens)
  ) {
    return value as unknown as AiSettledRequest;
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
