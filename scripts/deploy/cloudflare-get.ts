import { DeployError, type DeployReason, preflightError } from "./errors.ts";

const ATTEMPT_DEADLINE_MS = 14_900;
// At most two more GETs after a transport failure, HTTP 429 or a 5xx, with
// waits capped at 8 s (a finite Retry-After included) inside one 60 s budget.
const GET_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000];
const GET_RETRY_MAX_WAIT_MS = 8_000;
const GET_RETRY_TOTAL_MS = 60_000;
const CLEANUP_DEADLINE_MS = 100;

type GetFetcher = (request: Request) => Promise<Response>;

/** Safe metadata for callers that must report whether headers were received. */
export class CloudflareGetTransportError extends DeployError {
  readonly indeterminate = false;

  constructor(
    label: string,
    readonly status: number,
    reason: string,
    attempts = 1,
  ) {
    super("preflight", `${label} transport failed`, reason, {
      code: "http-transport",
      operation: "provider-read",
      attempts,
    });
  }
}

/** Semantic body failure after receiving an HTTP response. Never retry it. */
export class CloudflareGetResponseError extends DeployError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super("preflight", message);
  }
}

class DeadlineError extends Error {
  constructor() {
    super("Cloudflare GET deadline exceeded");
    this.name = "TimeoutError";
  }
}

class RetryableTransportFailure extends Error {
  constructor(readonly reason: string) {
    super("Cloudflare GET transport failed");
  }
}

/**
 * A GET-only transport boundary. Raw fetch/body transport failures and HTTP
 * 429/5xx are read again a bounded number of times; the last answer, and every
 * other status or decoded content, remains the caller's authority.
 */
export async function readCloudflareGetText(input: {
  readonly fetcher: GetFetcher;
  readonly request: (signal: AbortSignal) => Request;
  readonly maximumBytes: number;
  readonly label: string;
  /** Preserve a caller's existing UTF-8 BOM handling; public state defaults to false. */
  readonly ignoreBOM?: boolean;
  /** Test seam for the bounded waits; deploy callers keep the default. */
  readonly retryDelaysMs?: readonly number[];
}): Promise<{ readonly response: Response; readonly text: string; readonly attempts: number }> {
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1) {
    throw preflightError(`${input.label} response bound is invalid`);
  }
  const budget = Date.now() + GET_RETRY_TOTAL_MS;
  const delays = input.retryDelaysMs ?? GET_RETRY_DELAYS_MS;
  const waitFor = (attempt: number, retryAfterMs = 0): number | undefined => {
    const delay = delays[attempt];
    if (delay === undefined) return undefined;
    const wait = Math.min(Math.max(delay, retryAfterMs), GET_RETRY_MAX_WAIT_MS);
    return Date.now() + wait > budget ? undefined : wait;
  };
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const controller = new AbortController();
    let expire: (() => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
      expire = () => {
        controller.abort();
        reject(new DeadlineError());
      };
    });
    let response: Response | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      let request: Request;
      try {
        request = new Request(input.request(controller.signal), { signal: controller.signal });
      } catch {
        throw preflightError(`${input.label} GET request is invalid`);
      }
      if (request.method !== "GET" || request.redirect !== "manual") {
        throw preflightError(`${input.label} requires a manual-redirect GET`);
      }
      timer = setTimeout(() => expire?.(), ATTEMPT_DEADLINE_MS);
      const pendingResponse = Promise.resolve().then(() => input.fetcher(request));
      try {
        response = await Promise.race([pendingResponse, deadline]);
      } catch (error) {
        if (error instanceof DeadlineError) {
          // A non-cooperative injected fetcher may resolve after our deadline.
          // Aborting first and discarding its eventual body prevents a late leak.
          void pendingResponse.then((late) => cancelBody(late.body)).catch(() => undefined);
        }
        if (isRawTransportFailure(error)) {
          throw new RetryableTransportFailure(safeReason(error));
        }
        throw new CloudflareGetTransportError(input.label, 0, safeReason(error), attempt + 1);
      }
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get("retry-after") ?? "");
        const wait = waitFor(
          attempt,
          Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 0,
        );
        if (wait !== undefined) {
          void cancelBody(response.body).catch(() => undefined);
          if (timer !== undefined) clearTimeout(timer);
          controller.abort();
          await Bun.sleep(wait);
          continue;
        }
      }
      const text = await readBoundedResponseText(
        response,
        input.maximumBytes,
        input.label,
        deadline,
        controller.signal,
        input.ignoreBOM ?? false,
      );
      if (controller.signal.aborted) throw new RetryableTransportFailure("TimeoutError");
      return { response, text, attempts: attempt + 1 };
    } catch (error) {
      const retryable = error instanceof RetryableTransportFailure;
      const wait =
        retryable && (response === undefined || isSuccessfulResponse(response))
          ? waitFor(attempt)
          : undefined;
      if (wait !== undefined) {
        if (timer !== undefined) clearTimeout(timer);
        controller.abort();
        await Bun.sleep(wait);
        continue;
      }
      if (retryable) {
        throw new CloudflareGetTransportError(
          input.label,
          response?.status ?? 0,
          error.reason,
          attempt + 1,
        );
      }
      // A transport error raised inside the body reader counts this attempt too.
      if (error instanceof CloudflareGetTransportError && error.reason?.attempts !== attempt + 1)
        throw new CloudflareGetTransportError(
          input.label,
          error.status,
          error.detail ?? "",
          attempt + 1,
        );
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }
  throw preflightError(`${input.label} GET attempts exhausted`);
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
  label: string,
  deadline: Promise<never>,
  signal: AbortSignal,
  ignoreBOM: boolean,
): Promise<string> {
  let declared: string | null;
  try {
    declared = response.headers.get("content-length");
  } catch {
    throw new CloudflareGetResponseError(`${label} response metadata is invalid`, response.status);
  }
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximumBytes)
  ) {
    await cancelBody(response.body);
    throw new CloudflareGetResponseError(`${label} response is too large`, response.status);
  }
  if (response.body === null) return "";
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw new CloudflareGetResponseError(`${label} response body is invalid`, response.status);
  }
  let complete = false;
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await Promise.race([reader.read(), deadline]);
      } catch (error) {
        if (isRawTransportFailure(error)) {
          throw new RetryableTransportFailure(safeReason(error));
        }
        throw new CloudflareGetTransportError(label, response.status, safeReason(error));
      }
      const { done, value } = chunk;
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        throw new CloudflareGetResponseError(`${label} response is too large`, response.status);
      }
      chunks.push(value);
    }
    if (signal.aborted) throw new RetryableTransportFailure("TimeoutError");
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM }).decode(bytes);
    } catch {
      throw new CloudflareGetResponseError(`${label} response is not valid UTF-8`, response.status);
    }
    complete = true;
    return text;
  } finally {
    if (!complete) {
      try {
        await boundedCleanup(reader.cancel());
      } catch {
        // Cleanup cannot replace the primary failure or authorize a retry.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // A non-cooperative stream can keep a read pending past the deadline.
    }
  }
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body !== null) {
    try {
      await boundedCleanup(body.cancel());
    } catch {
      // The original response failure remains authoritative.
    }
  }
}

async function boundedCleanup(pending: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLEANUP_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isSuccessfulResponse(response: Response): boolean {
  return response.ok && !response.redirected;
}

function isRawTransportFailure(error: unknown): boolean {
  return (
    error instanceof DeadlineError ||
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

function safeReason(error: unknown): string {
  if (error instanceof DeadlineError) return "TimeoutError";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof DOMException) {
    return error.name === "AbortError" || error.name === "TimeoutError"
      ? error.name
      : "TransportError";
  }
  return "TransportError";
}
