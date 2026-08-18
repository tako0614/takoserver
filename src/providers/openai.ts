import { type AiGateway, AiGatewayError, type AiModel } from "../ai-port.ts";
import { isJsonObject, type JsonObject } from "../json.ts";
import { parseStrictJson } from "../strict-json.ts";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const UPSTREAM_REFERENCE = /^@?[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/u;

export interface OpenAiModelConfig extends AiModel {
  readonly upstreamId: string;
}

export interface OpenAiGatewayOptions {
  readonly baseUrl: string;
  readonly models: readonly OpenAiModelConfig[];
  readonly authorize: () => string | Promise<string>;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly timeoutMs?: number;
}

/** Strict operator configuration; unknown fields are refused, never guessed. */
export function parseOpenAiModelConfig(value: string): readonly OpenAiModelConfig[] {
  const parsed = parseStrictJson(new TextEncoder().encode(value), 64 * 1024);
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 64) {
    throw new TypeError("invalid OpenAI model configuration");
  }
  return parsed.map((entry) => {
    if (!isJsonObject(entry)) throw new TypeError("invalid OpenAI model configuration");
    const keys = Object.keys(entry).sort();
    const expected = [
      "created",
      "id",
      "inputMinorPerMillionTokens",
      "maxInputTokens",
      "maxOutputTokens",
      "outputMinorPerMillionTokens",
      "ownedBy",
      "upstreamId",
    ].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expected)) {
      throw new TypeError("invalid OpenAI model configuration");
    }
    if (
      typeof entry.id !== "string" ||
      typeof entry.upstreamId !== "string" ||
      typeof entry.ownedBy !== "string" ||
      typeof entry.created !== "number" ||
      !Number.isSafeInteger(entry.created) ||
      typeof entry.maxInputTokens !== "number" ||
      !Number.isSafeInteger(entry.maxInputTokens) ||
      typeof entry.maxOutputTokens !== "number" ||
      !Number.isSafeInteger(entry.maxOutputTokens) ||
      typeof entry.inputMinorPerMillionTokens !== "number" ||
      !Number.isSafeInteger(entry.inputMinorPerMillionTokens) ||
      typeof entry.outputMinorPerMillionTokens !== "number" ||
      !Number.isSafeInteger(entry.outputMinorPerMillionTokens)
    ) {
      throw new TypeError("invalid OpenAI model configuration");
    }
    return {
      id: entry.id,
      upstreamId: entry.upstreamId,
      created: entry.created,
      ownedBy: entry.ownedBy,
      limits: {
        maxInputTokens: entry.maxInputTokens,
        maxOutputTokens: entry.maxOutputTokens,
      },
      price: {
        inputMinorPerMillionTokens: entry.inputMinorPerMillionTokens,
        outputMinorPerMillionTokens: entry.outputMinorPerMillionTokens,
      },
    };
  });
}

/**
 * Connect any OpenAI-compatible upstream without leaking its model names,
 * credential, response errors, or billing authority into the public API.
 */
export function createOpenAiGateway(options: OpenAiGatewayOptions): AiGateway {
  const baseUrl = apiBase(options.baseUrl);
  const configured = new Map<string, OpenAiModelConfig>();
  for (const model of options.models) {
    if (!UPSTREAM_REFERENCE.test(model.upstreamId) || configured.has(model.id)) {
      throw new TypeError("invalid OpenAI model mapping");
    }
    configured.set(model.id, structuredClone(model));
  }
  const fetcher = options.fetch ?? ((request: Request) => fetch(request));
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new TypeError("invalid OpenAI upstream timeout");
  }

  return {
    models: [...configured.values()].map(({ upstreamId: _upstreamId, ...model }) => model),
    async chat(request, context) {
      const publicModel = typeof request.model === "string" ? request.model : "";
      const model = configured.get(publicModel);
      if (!model) throw new AiGatewayError("invalid_response");
      const upstreamRequest: JsonObject = { ...request, model: model.upstreamId, stream: false };

      let response: Response;
      try {
        response = await fetcher(
          new Request(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              accept: "application/json",
              authorization: await options.authorize(),
              "content-type": "application/json",
              "idempotency-key": context.idempotencyKey,
              "x-request-id": context.requestId,
            },
            body: JSON.stringify(upstreamRequest),
            signal: AbortSignal.timeout(timeoutMs),
          }),
        );
      } catch {
        throw new AiGatewayError("unavailable");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new AiGatewayError(
          response.status === 408 || response.status === 504 ? "timeout" : "unavailable",
        );
      }

      const declared = Number(response.headers.get("content-length") ?? "NaN");
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new AiGatewayError("invalid_response");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new AiGatewayError("invalid_response");

      let parsed: unknown;
      try {
        parsed = parseStrictJson(bytes, MAX_RESPONSE_BYTES);
      } catch {
        throw new AiGatewayError("invalid_response");
      }
      if (!isJsonObject(parsed) || parsed.model !== model.upstreamId) {
        throw new AiGatewayError("invalid_response");
      }
      return { ...parsed, model: publicModel };
    },
  };
}

function apiBase(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === "/"
  ) {
    throw new TypeError("OpenAI base URL must be an HTTPS API base path");
  }
  return `${url.origin}${url.pathname.replace(/\/$/u, "")}`;
}
