import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/u;
const PRICING_REVISION = /^sha256:[0-9a-f]{64}$/u;
const SAFE_HEADER = /^[\x21-\x7e]{1,256}$/u;
const MAX_CREDENTIAL_BYTES = 512;
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const QUALIFICATION_MAX_TOKENS = 1;

/** A fixed, deliberately tiny probe. Its content is never printed. */
export const AI_LIVE_QUALIFICATION_PROMPT = "Reply with exactly: OK";

export type AiLiveQualificationFailureCode =
  | "invalid_input"
  | "credential_unavailable"
  | "transport_error"
  | "timeout"
  | "discovery_http"
  | "discovery_malformed"
  | "models_http"
  | "models_malformed"
  | "budget_exceeded"
  | "wallet_http"
  | "wallet_malformed"
  | "wallet_insufficient"
  | "post_http"
  | "post_malformed"
  | "replay_http"
  | "replay_malformed"
  | "replay_mismatch";

export type AiLiveQualificationStatus = "skipped" | "passed" | "failed" | "unknown";

export interface AiLiveQualificationOptions {
  /** Canonical bare HTTPS origin (or an HTTP localhost origin for local work). */
  readonly origin: string;
  readonly organizationId: string;
  readonly publicModelId: string;
  readonly exactPricingRevision: string;
  readonly maximumChargeMinor: number;
  /** Caller-chosen key. This client never derives or generates one. */
  readonly idempotencyKey: string;
  /** Absolute path to an existing owned 0600 key under an owned 0700 directory outside Git. */
  readonly apiKeyFile?: string;
  /** Paid network operation is opt-in. */
  readonly executeLive?: boolean;
  /** Test seam; production uses the global fetch. */
  readonly fetcher?: AiLiveQualificationFetcher;
  /** Test seam for an in-memory fake key; production uses safeReadApiKeyFile. */
  readonly readCredential?: (path: string) => string | Promise<string>;
  /** Lower this in tests; production uses a bounded request timeout. */
  readonly timeoutMs?: number;
}

export type AiLiveQualificationFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface AiLiveQualificationWalletProjection {
  readonly availableMinor: number;
  readonly currency: "USD";
  /** This is an observation before inference, never exclusive billing proof. */
  readonly source: "preflight_observation";
}

export interface AiLiveQualificationResponseProjection {
  readonly completionBodyDigest: `sha256:${string}`;
  readonly requestIdDigest: `sha256:${string}`;
  readonly billedMinor: number;
}

export interface AiLiveQualificationResult {
  readonly version: 1;
  readonly status: AiLiveQualificationStatus;
  readonly stage: "none" | "local" | "discovery" | "models" | "wallet" | "post" | "replay";
  readonly executeLive: boolean;
  readonly origin: string;
  readonly organizationId: string;
  readonly publicModelId: string;
  readonly exactPricingRevision: string;
  readonly maximumChargeMinor: number;
  readonly reason?: AiLiveQualificationFailureCode | "execution_not_requested";
  readonly wallet?: AiLiveQualificationWalletProjection;
  readonly response?: AiLiveQualificationResponseProjection;
}

export interface AiLiveQualificationCliIo {
  readonly fetch?: AiLiveQualificationFetcher;
  readonly stdout?: (value: string) => void;
  readonly stderr?: (value: string) => void;
  readonly readCredential?: (path: string) => string | Promise<string>;
}

interface NormalizedInput {
  readonly origin: string;
  readonly organizationId: string;
  readonly publicModelId: string;
  readonly exactPricingRevision: `sha256:${string}`;
  readonly maximumChargeMinor: number;
  readonly idempotencyKey: string;
  readonly apiKeyFile: string | undefined;
  readonly executeLive: boolean;
  readonly fetcher: AiLiveQualificationFetcher;
  readonly readCredential: (path: string) => string | Promise<string>;
  readonly timeoutMs: number;
}

class MalformedResponseError extends Error {
  constructor() {
    super("malformed response");
    this.name = "MalformedResponseError";
  }
}

interface NetworkError {
  readonly kind: "network";
  readonly reason: "transport_error" | "timeout";
}

interface JsonResponse {
  readonly response: Response;
  readonly body: Uint8Array;
  readonly value: unknown;
}

interface MatchingModel {
  readonly id: string;
  readonly maximumChargeMinor: number;
}

interface ValidCompletion {
  readonly body: Uint8Array;
  readonly bodyDigest: `sha256:${string}`;
  readonly requestId: string;
  readonly requestIdDigest: `sha256:${string}`;
  readonly billedMinor: number;
}

/**
 * Qualify one exact public AI route. No environment, target, or credential
 * discovery is performed; all routing and billing values come from options.
 */
export async function runAiLiveQualification(
  options: AiLiveQualificationOptions,
): Promise<AiLiveQualificationResult> {
  const base = resultBase(options);
  let input: NormalizedInput;
  try {
    input = normalizeOptions(options);
  } catch {
    return { ...base, stage: "local", status: "failed", reason: "invalid_input" };
  }

  if (!input.executeLive) {
    return {
      ...baseFromInput(input),
      stage: "none",
      status: "skipped",
      reason: "execution_not_requested",
    };
  }

  let apiKey: string;
  try {
    apiKey = validateApiKey(await input.readCredential(input.apiKeyFile as string));
  } catch {
    return {
      ...baseFromInput(input),
      stage: "local",
      status: "failed",
      reason: "credential_unavailable",
    };
  }

  let discovery: JsonResponse;
  try {
    discovery = await getJson(input, `${input.origin}/.well-known/takoserver`);
  } catch (error) {
    return stageFailure(baseFromInput(input), "discovery", error, "discovery_malformed", false);
  }
  if (discovery.response.status !== 200) {
    return {
      ...baseFromInput(input),
      stage: "discovery",
      status: "failed",
      reason: "discovery_http",
    };
  }
  if (!validDiscovery(discovery.value, input.origin)) {
    return {
      ...baseFromInput(input),
      stage: "discovery",
      status: "failed",
      reason: "discovery_malformed",
    };
  }

  let models: JsonResponse;
  try {
    models = await getJson(input, `${input.origin}/v1/ai/models`, authorizationHeaders(apiKey));
  } catch (error) {
    return stageFailure(baseFromInput(input), "models", error, "models_malformed", false);
  }
  if (models.response.status !== 200) {
    return { ...baseFromInput(input), stage: "models", status: "failed", reason: "models_http" };
  }
  const model = matchingModel(models.value, input);
  if (model === "budget") {
    return {
      ...baseFromInput(input),
      stage: "models",
      status: "failed",
      reason: "budget_exceeded",
    };
  }
  if (!model) {
    return {
      ...baseFromInput(input),
      stage: "models",
      status: "failed",
      reason: "models_malformed",
    };
  }

  let wallet: JsonResponse;
  try {
    wallet = await getJson(
      input,
      `${input.origin}/v1/organizations/${encodeURIComponent(input.organizationId)}/wallet`,
      authorizationHeaders(apiKey),
    );
  } catch (error) {
    return stageFailure(baseFromInput(input), "wallet", error, "wallet_malformed", false);
  }
  if (wallet.response.status !== 200) {
    return { ...baseFromInput(input), stage: "wallet", status: "failed", reason: "wallet_http" };
  }
  const walletProjection = parseWallet(wallet.value, input);
  if (!walletProjection) {
    return {
      ...baseFromInput(input),
      stage: "wallet",
      status: "failed",
      reason: "wallet_malformed",
    };
  }
  if (walletProjection.availableMinor < model.maximumChargeMinor) {
    return {
      ...baseFromInput(input),
      stage: "wallet",
      status: "failed",
      reason: "wallet_insufficient",
      wallet: walletProjection,
    };
  }

  const requestBody = JSON.stringify({
    model: input.publicModelId,
    messages: [{ role: "user", content: AI_LIVE_QUALIFICATION_PROMPT }],
    max_tokens: QUALIFICATION_MAX_TOKENS,
    stream: false,
  });
  const headers = {
    ...authorizationHeaders(apiKey),
    "content-type": "application/json",
    "idempotency-key": input.idempotencyKey,
    "x-takoserver-ai-pricing-revision": input.exactPricingRevision,
  };

  let first: Response;
  try {
    first = await request(input, `${input.origin}/v1/ai/chat/completions`, {
      method: "POST",
      headers: { ...headers },
      body: requestBody,
    });
  } catch (error) {
    return stageFailure(
      { ...baseFromInput(input), stage: "post", wallet: walletProjection },
      "post",
      error,
      "post_malformed",
      true,
    );
  }
  if (first.status !== 200) {
    return {
      ...baseFromInput(input),
      stage: "post",
      status: "failed",
      reason: "post_http",
      wallet: walletProjection,
    };
  }

  let firstCompletion: ValidCompletion;
  try {
    firstCompletion = await parseCompletionResponse(
      first,
      input.publicModelId,
      model.maximumChargeMinor,
      input.timeoutMs,
    );
  } catch (error) {
    if (isNetworkError(error)) {
      return networkResult(
        { ...baseFromInput(input), stage: "post", wallet: walletProjection },
        "post",
        error,
        true,
      );
    }
    return {
      ...baseFromInput(input),
      stage: "post",
      status: "failed",
      reason: "post_malformed",
      wallet: walletProjection,
    };
  }

  let replay: Response;
  try {
    replay = await request(input, `${input.origin}/v1/ai/chat/completions`, {
      method: "POST",
      headers: { ...headers },
      body: requestBody,
    });
  } catch (error) {
    return stageFailure(
      { ...baseFromInput(input), stage: "replay", wallet: walletProjection },
      "replay",
      error,
      "replay_malformed",
      true,
    );
  }
  if (replay.status !== 200) {
    return {
      ...baseFromInput(input),
      stage: "replay",
      status: "failed",
      reason: "replay_http",
      wallet: walletProjection,
    };
  }

  let replayCompletion: ValidCompletion;
  try {
    replayCompletion = await parseCompletionResponse(
      replay,
      input.publicModelId,
      model.maximumChargeMinor,
      input.timeoutMs,
    );
  } catch (error) {
    if (isNetworkError(error)) {
      return networkResult(
        { ...baseFromInput(input), stage: "replay", wallet: walletProjection },
        "replay",
        error,
        true,
      );
    }
    return {
      ...baseFromInput(input),
      stage: "replay",
      status: "failed",
      reason: "replay_malformed",
      wallet: walletProjection,
    };
  }
  if (!sameCompletion(firstCompletion, replayCompletion)) {
    return {
      ...baseFromInput(input),
      stage: "replay",
      status: "failed",
      reason: "replay_mismatch",
      wallet: walletProjection,
      response: responseProjection(firstCompletion),
    };
  }

  return {
    ...baseFromInput(input),
    stage: "replay",
    status: "passed",
    wallet: walletProjection,
    response: responseProjection(firstCompletion),
  };
}

/** Stable, redacted JSON suitable for stdout. It never includes a bearer or raw response. */
export function formatAiLiveQualificationResult(result: AiLiveQualificationResult): string {
  return `${JSON.stringify(result)}\n`;
}

/**
 * Run the command-line client. `--execute-live` is the only switch that may
 * perform network I/O; help and the default dry run are always side-effect free.
 */
export async function runAiLiveQualificationCli(
  argv: readonly string[],
  io: AiLiveQualificationCliIo = {},
): Promise<number> {
  const stdout = io.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = io.stderr ?? ((value: string) => process.stderr.write(value));
  const parsed = parseAiLiveQualificationArgs(argv);
  if (parsed.kind === "help") {
    stdout(AI_LIVE_QUALIFICATION_USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    stdout(
      formatAiLiveQualificationResult({
        version: 1,
        status: "failed",
        stage: "local",
        executeLive: false,
        origin: "",
        organizationId: "",
        publicModelId: "",
        exactPricingRevision: "",
        maximumChargeMinor: 0,
        reason: "invalid_input",
      }),
    );
    stderr("invalid qualification arguments\n");
    return 2;
  }

  const options: AiLiveQualificationOptions = {
    ...parsed.options,
    ...(io.fetch !== undefined ? { fetcher: io.fetch } : {}),
    ...(io.readCredential !== undefined ? { readCredential: io.readCredential } : {}),
  };
  const result = await runAiLiveQualification(options);
  stdout(formatAiLiveQualificationResult(result));
  return result.status === "passed" || result.status === "skipped" ? 0 : 1;
}

export type ParsedAiLiveQualificationArgs =
  | { readonly kind: "help" }
  | { readonly kind: "error" }
  | { readonly kind: "options"; readonly options: AiLiveQualificationOptions };

export const AI_LIVE_QUALIFICATION_USAGE =
  "usage: ai-live-qualification.ts --origin <bare-origin> --organization-id <id> " +
  "--public-model-id <id> --pricing-revision <sha256:...> --maximum-charge-minor <minor> " +
  "--idempotency-key <key> --api-key-file <absolute-path> [--execute-live]\n" +
  "without --execute-live, no network request is made; --execute-live performs one paid probe\n";

export function parseAiLiveQualificationArgs(
  argv: readonly string[],
): ParsedAiLiveQualificationArgs {
  if (argv.length === 1 && argv[0] === "--help") return { kind: "help" };
  const values = new Map<string, string>();
  let executeLive = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute-live") {
      if (executeLive) return { kind: "error" };
      executeLive = true;
      continue;
    }
    if (!arg?.startsWith("--")) return { kind: "error" };
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) return { kind: "error" };
    const key = optionAlias(arg);
    if (!key || values.has(key)) return { kind: "error" };
    values.set(key, next);
    index += 1;
  }
  const origin = values.get("origin");
  const organizationId = values.get("organizationId");
  const publicModelId = values.get("publicModelId");
  const exactPricingRevision = values.get("exactPricingRevision");
  const maximumChargeMinor = values.get("maximumChargeMinor");
  const idempotencyKey = values.get("idempotencyKey");
  const apiKeyFile = values.get("apiKeyFile");
  if (
    !origin ||
    !organizationId ||
    !publicModelId ||
    !exactPricingRevision ||
    !maximumChargeMinor ||
    !idempotencyKey ||
    !apiKeyFile
  ) {
    return { kind: "error" };
  }
  const parsedCharge = Number(maximumChargeMinor);
  if (!Number.isSafeInteger(parsedCharge) || parsedCharge < 0) return { kind: "error" };
  return {
    kind: "options",
    options: {
      origin,
      organizationId,
      publicModelId,
      exactPricingRevision,
      maximumChargeMinor: parsedCharge,
      idempotencyKey,
      apiKeyFile,
      executeLive,
    },
  };
}

/** Read one exact API key only from an owned, canonical 0600 link-free file. */
export function safeReadApiKeyFile(path: string): string {
  let descriptor: number | null = null;
  try {
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error("unsafe");
    assertPrivateCredentialParent(dirname(path));
    const parts = path.split(sep).filter(Boolean);
    let current: string = sep;
    for (const part of parts) {
      current = join(current, part);
      const status = lstatSync(current);
      if (status.isSymbolicLink() || (current !== path && !status.isDirectory())) {
        throw new Error("unsafe");
      }
    }

    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.nlink !== 1 ||
      (typeof process.getuid === "function" && status.uid !== process.getuid()) ||
      (status.mode & 0o7777) !== 0o600 ||
      status.size < 1 ||
      status.size > MAX_CREDENTIAL_BYTES
    ) {
      throw new Error("unsafe");
    }
    const raw = readFileSync(descriptor, "utf8");
    if (
      Buffer.byteLength(raw, "utf8") !== status.size ||
      raw.trim() !== raw ||
      [...raw].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint === undefined || codePoint < 0x21 || codePoint > 0x7e;
      })
    ) {
      throw new Error("unsafe");
    }
    if (!raw) throw new Error("unsafe");
    return raw;
  } catch {
    throw new Error(
      "API key file must be an owned link-free 0600 regular file under an owned 0700 directory outside Git repositories",
    );
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function assertPrivateCredentialParent(path: string): void {
  const normalized = resolve(path);
  let current = normalized;
  while (true) {
    if (lstatSync(join(current, ".git"), { throwIfNoEntry: false })) throw new Error("unsafe");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const status = lstatSync(normalized);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (status.mode & 0o7777) !== 0o700 ||
    (typeof process.getuid === "function" && status.uid !== process.getuid())
  ) {
    throw new Error("unsafe");
  }
}

function optionAlias(arg: string): string | null {
  switch (arg) {
    case "--origin":
      return "origin";
    case "--organization-id":
    case "--org-id":
      return "organizationId";
    case "--public-model-id":
    case "--model-id":
      return "publicModelId";
    case "--pricing-revision":
    case "--exact-pricing-revision":
      return "exactPricingRevision";
    case "--maximum-charge-minor":
    case "--max-charge-minor":
      return "maximumChargeMinor";
    case "--idempotency-key":
      return "idempotencyKey";
    case "--api-key-file":
      return "apiKeyFile";
    default:
      return null;
  }
}

function normalizeOptions(options: AiLiveQualificationOptions): NormalizedInput {
  const origin = normalizeOrigin(options.origin);
  if (!ORGANIZATION_ID.test(options.organizationId)) throw new Error("organization");
  if (!MODEL_ID.test(options.publicModelId)) throw new Error("model");
  if (!PRICING_REVISION.test(options.exactPricingRevision)) throw new Error("pricing");
  if (!Number.isSafeInteger(options.maximumChargeMinor) || options.maximumChargeMinor < 0) {
    throw new Error("charge");
  }
  if (!IDEMPOTENCY_KEY.test(options.idempotencyKey)) throw new Error("idempotency");
  if (options.executeLive === true && !options.apiKeyFile) throw new Error("credential");
  if (
    options.apiKeyFile !== undefined &&
    (!isAbsolute(options.apiKeyFile) || resolve(options.apiKeyFile) !== options.apiKeyFile)
  ) {
    throw new Error("credential path");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new Error("timeout");
  return {
    origin,
    organizationId: options.organizationId,
    publicModelId: options.publicModelId,
    exactPricingRevision: options.exactPricingRevision as `sha256:${string}`,
    maximumChargeMinor: options.maximumChargeMinor,
    idempotencyKey: options.idempotencyKey,
    apiKeyFile: options.apiKeyFile,
    executeLive: options.executeLive === true,
    fetcher: options.fetcher ?? fetch,
    readCredential: options.readCredential ?? safeReadApiKeyFile,
    timeoutMs,
  };
}

function normalizeOrigin(value: string): string {
  const parsed = new URL(value);
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("origin");
  }
  return parsed.origin;
}

function resultBase(options: AiLiveQualificationOptions): AiLiveQualificationResult {
  return {
    version: 1,
    status: "failed",
    stage: "local",
    executeLive: options.executeLive === true,
    origin: typeof options.origin === "string" ? safeOriginProjection(options.origin) : "",
    // These values are caller-controlled and remain blank until normalization
    // proves their exact bounded grammar. Never reflect malformed input.
    organizationId: "",
    publicModelId: "",
    exactPricingRevision: "",
    maximumChargeMinor:
      typeof options.maximumChargeMinor === "number" &&
      Number.isSafeInteger(options.maximumChargeMinor)
        ? options.maximumChargeMinor
        : 0,
  };
}

function safeOriginProjection(value: string): string {
  try {
    return normalizeOrigin(value);
  } catch {
    return "";
  }
}

function baseFromInput(input: NormalizedInput): AiLiveQualificationResult {
  return {
    version: 1,
    status: "failed",
    stage: "local",
    executeLive: input.executeLive,
    origin: input.origin,
    organizationId: input.organizationId,
    publicModelId: input.publicModelId,
    exactPricingRevision: input.exactPricingRevision,
    maximumChargeMinor: input.maximumChargeMinor,
  };
}

function authorizationHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, accept: "application/json" };
}

function validateApiKey(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_BYTES ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined || codePoint < 0x21 || codePoint > 0x7e;
    })
  ) {
    throw new Error("unsafe credential");
  }
  return value;
}

async function getJson(
  input: NormalizedInput,
  url: string,
  headers?: Record<string, string>,
): Promise<JsonResponse> {
  const response = await request(
    input,
    url,
    headers === undefined ? { method: "GET" } : { method: "GET", headers },
  );
  // An HTTP error is already a bounded failure. Do not parse or reflect its
  // body: it may be a provider page rather than the Takoserver contract.
  if (response.status !== 200) return { response, body: new Uint8Array(), value: undefined };
  const body = await readResponseBody(response, input.timeoutMs);
  let value: unknown;
  try {
    value = JSON.parse(decodeJsonBody(body));
  } catch {
    throw new MalformedResponseError();
  }
  return { response, body, value };
}

async function request(input: NormalizedInput, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(networkError("timeout"));
    }, input.timeoutMs);
  });
  try {
    const operation = input.fetcher(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
    const response = await Promise.race([operation, timeout]);
    if (!(response instanceof Response)) throw networkError("transport_error");
    return response;
  } catch (error) {
    if (isNetworkError(error)) throw error;
    throw networkError(isAbortError(error) ? "timeout" : "transport_error");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readResponseBody(response: Response, timeoutMs: number): Promise<Uint8Array> {
  if (!response.body) throw new MalformedResponseError();
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = (async (): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (
          !(next.value instanceof Uint8Array) ||
          next.value.byteLength > MAX_RESPONSE_BYTES - size
        ) {
          await reader.cancel().catch(() => undefined);
          throw new MalformedResponseError();
        }
        chunks.push(next.value);
        size += next.value.byteLength;
      }
    } catch (error) {
      if (error instanceof MalformedResponseError || isNetworkError(error)) throw error;
      throw networkError("transport_error");
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reader.cancel().catch(() => undefined);
      reject(networkError("timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    reader.releaseLock();
  }
}

function validDiscovery(value: unknown, origin: string): boolean {
  if (!isRecord(value) || value.product !== "takoserver" || value.apiVersion !== "v1") return false;
  const endpoints = value.endpoints;
  return isRecord(endpoints) && endpoints.api === origin && endpoints.ai === `${origin}/v1/ai`;
}

function matchingModel(value: unknown, input: NormalizedInput): "budget" | MatchingModel | null {
  if (!isRecord(value) || value.object !== "list" || !Array.isArray(value.data)) return null;
  const matches = value.data.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry.id === input.publicModelId,
  );
  if (matches.length !== 1) return null;
  const model = matches[0];
  if (!model) return null;
  if (
    model.object !== "model" ||
    !isRecord(model.takoserver) ||
    model.takoserver.pricing_revision !== input.exactPricingRevision ||
    !nonNegativeInteger(model.takoserver.maximum_charge_minor)
  ) {
    return null;
  }
  return model.takoserver.maximum_charge_minor > input.maximumChargeMinor
    ? "budget"
    : { id: input.publicModelId, maximumChargeMinor: model.takoserver.maximum_charge_minor };
}

function parseWallet(
  value: unknown,
  input: NormalizedInput,
): AiLiveQualificationWalletProjection | null {
  if (!isRecord(value) || !isRecord(value.wallet)) return null;
  const wallet = value.wallet;
  if (
    wallet.organizationId !== input.organizationId ||
    wallet.currency !== "USD" ||
    !nonNegativeInteger(wallet.availableMinor)
  ) {
    return null;
  }
  return {
    availableMinor: wallet.availableMinor,
    currency: "USD",
    source: "preflight_observation",
  };
}

async function parseCompletionResponse(
  response: Response,
  modelId: string,
  maximumChargeMinor: number,
  timeoutMs: number,
): Promise<ValidCompletion> {
  const body = await readResponseBody(response, timeoutMs);
  let value: unknown;
  try {
    value = JSON.parse(decodeJsonBody(body));
  } catch {
    throw new MalformedResponseError();
  }
  if (!validCompletion(value, modelId)) throw new MalformedResponseError();
  const requestId = response.headers.get("x-request-id");
  const billedRaw = response.headers.get("x-takoserver-billed-minor");
  if (requestId === null || !SAFE_HEADER.test(requestId)) throw new MalformedResponseError();
  if (billedRaw === null || !/^(?:0|[1-9][0-9]*)$/u.test(billedRaw)) {
    throw new MalformedResponseError();
  }
  const billedMinor = Number(billedRaw);
  if (!Number.isSafeInteger(billedMinor) || billedMinor > maximumChargeMinor) {
    throw new MalformedResponseError();
  }
  return {
    body,
    bodyDigest: digest(body),
    requestId,
    requestIdDigest: digest(new TextEncoder().encode(requestId)),
    billedMinor,
  };
}

function validCompletion(value: unknown, modelId: string): boolean {
  if (!isRecord(value) || value.object !== "chat.completion" || value.model !== modelId)
    return false;
  if (
    typeof value.id !== "string" ||
    !SAFE_HEADER.test(value.id) ||
    !nonNegativeInteger(value.created)
  )
    return false;
  if (!Array.isArray(value.choices) || value.choices.length < 1 || !isRecord(value.usage))
    return false;
  const choice = value.choices[0];
  if (
    !isRecord(choice) ||
    !nonNegativeInteger(choice.index) ||
    !isRecord(choice.message) ||
    choice.message.role !== "assistant" ||
    typeof choice.message.content !== "string" ||
    choice.message.content.trim().length === 0 ||
    !Object.hasOwn(choice, "finish_reason") ||
    (choice.finish_reason !== null && typeof choice.finish_reason !== "string")
  ) {
    return false;
  }
  const usage = value.usage;
  return (
    nonNegativeInteger(usage.prompt_tokens) &&
    nonNegativeInteger(usage.completion_tokens) &&
    nonNegativeInteger(usage.total_tokens) &&
    usage.total_tokens === usage.prompt_tokens + usage.completion_tokens
  );
}

function decodeJsonBody(body: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function sameCompletion(left: ValidCompletion, right: ValidCompletion): boolean {
  return (
    equalBytes(left.body, right.body) &&
    left.requestId === right.requestId &&
    left.billedMinor === right.billedMinor
  );
}

function responseProjection(value: ValidCompletion): AiLiveQualificationResponseProjection {
  return {
    completionBodyDigest: value.bodyDigest,
    requestIdDigest: value.requestIdDigest,
    billedMinor: value.billedMinor,
  };
}

function networkResult(
  base: AiLiveQualificationResult,
  stage: AiLiveQualificationResult["stage"],
  error: unknown,
  afterPost: boolean,
): AiLiveQualificationResult {
  const reason = isNetworkError(error) ? error.reason : "transport_error";
  return {
    ...base,
    stage,
    status: afterPost ? "unknown" : "failed",
    reason,
  };
}

function stageFailure(
  base: AiLiveQualificationResult,
  stage: AiLiveQualificationResult["stage"],
  error: unknown,
  malformedReason: AiLiveQualificationFailureCode,
  afterPost: boolean,
): AiLiveQualificationResult {
  if (isNetworkError(error)) return networkResult(base, stage, error, afterPost);
  return { ...base, stage, status: "failed", reason: malformedReason };
}

function networkError(reason: NetworkError["reason"]): NetworkError {
  return { kind: "network", reason };
}

function isNetworkError(error: unknown): error is NetworkError {
  return (
    isRecord(error) &&
    error.kind === "network" &&
    (error.reason === "transport_error" || error.reason === "timeout")
  );
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

function digest(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

if (import.meta.main) {
  process.exitCode = await runAiLiveQualificationCli(process.argv.slice(2));
}
