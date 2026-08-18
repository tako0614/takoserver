import type { AiGateway, AiModel, AiUsage } from "./ai-port.ts";
import {
  type AiPendingRequest,
  type AiRequestRecord,
  AiRequestStoreError,
  type AiSettledRequest,
  type ClaimedAiRequest,
  createAiRequestStore,
} from "./ai-requests.ts";
import type { Accounts } from "./auth.ts";
import { canonicalDigest, canonicalJson, isJsonObject, type JsonObject } from "./json.ts";
import type { Ledger } from "./ledger.ts";
import type { Clock, Sql } from "./ports.ts";
import { parseStrictJson, StrictJsonError } from "./strict-json.ts";

const PREFIX = "/v1/ai/";
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MESSAGES = 256;
const MAX_DURABLE_RESULT_BYTES = 64 * 1024;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/u;

export interface DataAiOptions {
  readonly accounts: Accounts;
  readonly gateway?: AiGateway;
  readonly ledger: Ledger;
  readonly sql: Sql;
  readonly record: (usage: AiUsage) => Promise<void>;
  readonly clock: Clock;
  readonly randomId: () => string;
}

export type DataAiRoutes = (request: Request, url: URL) => Promise<Response | null>;

/** OpenAI-compatible models and non-streaming Chat Completions. */
export function createDataAiRoutes(options: DataAiOptions): DataAiRoutes {
  const models = validateModels(options.gateway?.models ?? []);
  const commercialModels = new Map(
    models.map((model) => [model.id, modelCommercialTerms(model)] as const),
  );
  const requests = createAiRequestStore(options.sql, options.clock);

  return async (request, url) => {
    if (!url.pathname.startsWith(PREFIX)) return null;
    if (!options.gateway) return openAiFailure("service_unavailable", 503);

    const actor = await options.accounts.authorize(
      request.headers.get("authorization"),
      "ai:invoke",
    );
    if (!actor?.organizationId) return openAiFailure("invalid_api_key", 401);

    if (request.method === "GET" && url.pathname === `${PREFIX}models`) {
      return Response.json({
        object: "list",
        data: await Promise.all(
          models.map(async (model) => ({
            id: model.id,
            object: "model",
            created: model.created,
            owned_by: model.ownedBy,
            takoserver: await commercialModels.get(model.id),
          })),
        ),
      });
    }

    if (request.method === "POST" && url.pathname === `${PREFIX}chat/completions`) {
      let body: JsonObject;
      try {
        const parsed = parseStrictJson(new Uint8Array(await request.arrayBuffer()), MAX_BODY_BYTES);
        if (!isJsonObject(parsed)) throw new StrictJsonError();
        body = parsed;
      } catch (error) {
        if (error instanceof StrictJsonError) return openAiFailure("invalid_request", 400);
        throw error;
      }

      const model = requestedModel(body, models);
      if (!model) return openAiFailure("model_not_found", 404, "model");
      const expectedPricingRevision = request.headers.get("x-takoserver-ai-pricing-revision");
      if (
        expectedPricingRevision !== null &&
        expectedPricingRevision !== (await commercialModels.get(model.id))?.pricing_revision
      ) {
        return openAiFailure("pricing_revision_conflict", 409, "model");
      }
      if (!validMessages(body.messages)) {
        return openAiFailure("invalid_messages", 400, "messages");
      }
      if (body.stream !== undefined && body.stream !== false) {
        return openAiFailure("stream_not_supported", 400, "stream");
      }
      const maxOutputTokens = outputLimit(body.max_tokens, model);
      if (maxOutputTokens === null) {
        return openAiFailure("invalid_max_tokens", 400, "max_tokens");
      }

      const idempotencyKey = request.headers.get("idempotency-key");
      if (idempotencyKey === null) {
        return openAiFailure("idempotency_key_required", 400);
      }
      if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
        return openAiFailure("invalid_idempotency_key", 400);
      }

      const requestId = `ai_${options.randomId()}`;
      const ceiling = tokenCharge(model.limits.maxInputTokens, maxOutputTokens, model);
      let claim: ClaimedAiRequest;
      try {
        claim = await requests.claim({
          organizationId: actor.organizationId,
          idempotencyKey,
          fingerprint: await canonicalDigest(body),
          requestId,
          ceilingMinor: ceiling,
        });
      } catch (error) {
        return requestStoreFailure(error);
      }

      if (!claim.created) {
        return await resumeAiRequest({
          claim,
          record: claim.record,
          body,
          model,
          idempotencyKey,
          organizationId: actor.organizationId,
          gateway: options.gateway,
          ledger: options.ledger,
          recordUsage: options.record,
          requests,
        });
      }

      if (
        ceiling > 0 &&
        !(await options.ledger.hold({
          organizationId: actor.organizationId,
          reference: requestId,
          amountMinor: ceiling,
        }))
      ) {
        const responseBody = openAiFailureBody("insufficient_quota", 402);
        try {
          await requests.reject(claim, 402, responseBody);
        } catch (error) {
          return requestStoreFailure(error);
        }
        return jsonResponse(responseBody, 402);
      }

      try {
        const ready = await requests.ready(claim);
        return await resumeAiRequest({
          claim,
          record: ready,
          body,
          model,
          idempotencyKey,
          organizationId: actor.organizationId,
          gateway: options.gateway,
          ledger: options.ledger,
          recordUsage: options.record,
          requests,
        });
      } catch (error) {
        return requestStoreFailure(error);
      }
    }

    if (url.pathname === `${PREFIX}models` || url.pathname === `${PREFIX}chat/completions`) {
      return openAiFailure("method_not_allowed", 405);
    }
    return openAiFailure("not_found", 404);
  };
}

type AiRequestStore = ReturnType<typeof createAiRequestStore>;

async function resumeAiRequest(input: {
  readonly claim: Awaited<ReturnType<AiRequestStore["claim"]>>;
  readonly record: AiRequestRecord;
  readonly body: JsonObject;
  readonly model: AiModel;
  readonly idempotencyKey: string;
  readonly organizationId: string;
  readonly gateway: AiGateway;
  readonly ledger: Ledger;
  readonly recordUsage: (usage: AiUsage) => Promise<void>;
  readonly requests: AiRequestStore;
}): Promise<Response> {
  const {
    claim,
    body,
    model,
    idempotencyKey,
    organizationId,
    gateway,
    ledger,
    recordUsage,
    requests,
  } = input;
  let record = input.record;

  if (record.kind === "rejected") {
    return jsonResponse(record.responseBody, record.responseStatus);
  }
  if (record.kind === "result" && record.phase === "completed") {
    return resultResponse(record);
  }
  if (record.kind === "result" && record.phase === "staged") {
    return await settleAiRequest({ claim, record, organizationId, ledger, recordUsage, requests });
  }
  if (record.kind !== "pending") return openAiFailure("request_state_unavailable", 503);

  if (record.phase === "claimed") {
    return openAiFailure("idempotency_request_in_progress", 409);
  }
  if (record.phase === "dispatched") {
    return openAiFailure("idempotency_request_indeterminate", 409);
  }

  try {
    record = await requests.dispatched(claim, record);
  } catch (error) {
    return requestStoreFailure(error);
  }
  if (record.kind !== "pending" || record.phase !== "dispatched") {
    return openAiFailure("idempotency_request_in_progress", 409);
  }

  let outcome: Omit<AiSettledRequest, "phase">;
  try {
    const completion = parseCompletion(
      await gateway.chat(body, { requestId: record.requestId, idempotencyKey }),
      model.id,
    );
    if (!completion || durableJsonBytes(completion.body) > MAX_DURABLE_RESULT_BYTES) {
      outcome = failedOutcome(record, "invalid_upstream_response");
    } else {
      const withinLimits =
        completion.usage.inputTokens <= model.limits.maxInputTokens &&
        completion.usage.outputTokens <= model.limits.maxOutputTokens;
      const actual = withinLimits
        ? tokenCharge(completion.usage.inputTokens, completion.usage.outputTokens, model)
        : record.ceilingMinor + 1;
      outcome =
        actual <= record.ceilingMinor
          ? {
              kind: "result",
              requestId: record.requestId,
              ceilingMinor: record.ceilingMinor,
              actualMinor: actual,
              responseStatus: 200,
              responseBody: completion.body,
              usageModel: model.id,
              inputTokens: completion.usage.inputTokens,
              outputTokens: completion.usage.outputTokens,
            }
          : failedOutcome(record, "usage_exceeded_reserved_limit");
    }
  } catch {
    outcome = failedOutcome(record, "upstream_unavailable");
  }

  try {
    const staged = await requests.stage(claim, outcome);
    if (staged.kind !== "result") return openAiFailure("request_state_unavailable", 503);
    return await settleAiRequest({
      claim,
      record: staged,
      organizationId,
      ledger,
      recordUsage,
      requests,
    });
  } catch (error) {
    return requestStoreFailure(error);
  }
}

async function settleAiRequest(input: {
  readonly claim: Awaited<ReturnType<AiRequestStore["claim"]>>;
  readonly record: AiSettledRequest;
  readonly organizationId: string;
  readonly ledger: Ledger;
  readonly recordUsage: (usage: AiUsage) => Promise<void>;
  readonly requests: AiRequestStore;
}): Promise<Response> {
  const { claim, record, organizationId, ledger, recordUsage, requests } = input;
  try {
    if (record.actualMinor > 0) {
      await ledger.capture({
        organizationId,
        reference: record.requestId,
        amountMinor: record.actualMinor,
      });
    }
    await release(
      ledger,
      organizationId,
      record.requestId,
      record.ceilingMinor - record.actualMinor,
    );
    if (record.usageModel !== null) {
      await recordUsage({
        requestId: record.requestId,
        organizationId,
        model: record.usageModel,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
      });
    }
    const completed = await requests.finish(claim, record);
    if (completed.kind !== "result") throw new AiRequestStoreError("state_conflict");
    return resultResponse(completed);
  } catch {
    return openAiFailure("settlement_pending", 503);
  }
}

function failedOutcome(record: AiPendingRequest, code: string): Omit<AiSettledRequest, "phase"> {
  return {
    kind: "result",
    requestId: record.requestId,
    ceilingMinor: record.ceilingMinor,
    actualMinor: 0,
    responseStatus: 502,
    responseBody: openAiFailureBody(code, 502),
    usageModel: null,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function resultResponse(record: AiSettledRequest): Response {
  return jsonResponse(record.responseBody, record.responseStatus, {
    "x-request-id": record.requestId,
    "x-takoserver-billed-minor": String(record.actualMinor),
  });
}

function requestStoreFailure(error: unknown): Response {
  if (error instanceof AiRequestStoreError && error.code === "fingerprint_conflict") {
    return openAiFailure("idempotency_key_conflict", 409);
  }
  return openAiFailure("request_state_unavailable", 503);
}

function validateModels(input: readonly AiModel[]): readonly AiModel[] {
  const ids = new Set<string>();
  for (const model of input) {
    if (
      !MODEL_ID.test(model.id) ||
      ids.has(model.id) ||
      !Number.isSafeInteger(model.created) ||
      model.created < 0 ||
      model.ownedBy.length < 1 ||
      model.ownedBy.length > 128 ||
      !positiveInteger(model.limits.maxInputTokens) ||
      !positiveInteger(model.limits.maxOutputTokens) ||
      !nonNegativeInteger(model.price.inputMinorPerMillionTokens) ||
      !nonNegativeInteger(model.price.outputMinorPerMillionTokens) ||
      !Number.isSafeInteger(
        model.limits.maxInputTokens * model.price.inputMinorPerMillionTokens +
          model.limits.maxOutputTokens * model.price.outputMinorPerMillionTokens,
      )
    ) {
      throw new TypeError("invalid AI model catalog");
    }
    ids.add(model.id);
  }
  return structuredClone(input);
}

function requestedModel(body: JsonObject, models: readonly AiModel[]): AiModel | undefined {
  return typeof body.model === "string"
    ? models.find((model) => model.id === body.model)
    : undefined;
}

function outputLimit(value: unknown, model: AiModel): number | null {
  if (value === undefined) return model.limits.maxOutputTokens;
  return positiveInteger(value) && value <= model.limits.maxOutputTokens ? value : null;
}

function validMessages(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MESSAGES) return false;
  return value.every((entry) => {
    if (!isJsonObject(entry)) return false;
    if (!(["system", "user", "assistant", "tool"] as const).includes(entry.role as never)) {
      return false;
    }
    if (typeof entry.content === "string") return entry.content.length <= 256 * 1024;
    return Array.isArray(entry.content) && entry.content.length <= 64;
  });
}

function parseCompletion(
  value: unknown,
  model: string,
): {
  readonly body: JsonObject;
  readonly usage: { inputTokens: number; outputTokens: number };
} | null {
  if (!isJsonObject(value) || value.object !== "chat.completion" || value.model !== model)
    return null;
  if (typeof value.id !== "string" || !Number.isSafeInteger(value.created)) return null;
  if (!Array.isArray(value.choices) || value.choices.length < 1) return null;
  const usage = value.usage;
  if (!isJsonObject(usage)) return null;
  const inputTokens = usage.prompt_tokens;
  const outputTokens = usage.completion_tokens;
  const totalTokens = usage.total_tokens;
  if (
    !nonNegativeInteger(inputTokens) ||
    !nonNegativeInteger(outputTokens) ||
    !nonNegativeInteger(totalTokens) ||
    totalTokens !== inputTokens + outputTokens
  ) {
    return null;
  }
  return { body: value, usage: { inputTokens, outputTokens } };
}

function tokenCharge(inputTokens: number, outputTokens: number, model: AiModel): number {
  const micros =
    inputTokens * model.price.inputMinorPerMillionTokens +
    outputTokens * model.price.outputMinorPerMillionTokens;
  return Math.ceil(micros / 1_000_000);
}

async function modelCommercialTerms(model: AiModel): Promise<{
  readonly pricing_revision: `sha256:${string}`;
  readonly maximum_charge_minor: number;
}> {
  return {
    pricing_revision: await canonicalDigest({
      id: model.id,
      limits: model.limits,
      price: model.price,
    }),
    maximum_charge_minor: tokenCharge(
      model.limits.maxInputTokens,
      model.limits.maxOutputTokens,
      model,
    ),
  };
}

function durableJsonBytes(value: JsonObject): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

async function release(
  ledger: Ledger,
  organizationId: string,
  reference: string,
  amountMinor: number,
): Promise<void> {
  if (amountMinor <= 0) return;
  await ledger.release({ organizationId, reference, amountMinor });
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function openAiFailure(code: string, status: number, param: string | null = null): Response {
  return jsonResponse(openAiFailureBody(code, status, param), status);
}

function openAiFailureBody(code: string, status: number, param: string | null = null): JsonObject {
  return {
    error: {
      message: code.replaceAll("_", " "),
      type: status >= 500 ? "server_error" : "invalid_request_error",
      param,
      code,
    },
  };
}

function jsonResponse(
  body: JsonObject,
  status: number,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return Response.json(body, { status, headers });
}
