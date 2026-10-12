import { DeployError, preflightError } from "./errors.ts";

const ATTEMPT_DEADLINE_MS = 14_900;
const CLEANUP_DEADLINE_MS = 100;

type GetFetcher = (request: Request) => Promise<Response>;

/** Safe metadata for callers that must report whether headers were received. */
export class CloudflareGetTransportError extends DeployError {
  readonly indeterminate = false;

  constructor(
    label: string,
    readonly status: number,
    reason: string,
  ) {
    super("preflight", `${label} transport failed`, reason);
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
 * A GET-only transport boundary. HTTP status and decoded content remain the
 * caller's authority; only raw fetch/body transport failures may be retried.
 */
export async function readCloudflareGetText(input: {
  readonly fetcher: GetFetcher;
  readonly request: (signal: AbortSignal) => Request;
  readonly maximumBytes: number;
  readonly label: string;
}): Promise<{ readonly response: Response; readonly text: string }> {
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1) {
    throw preflightError(`${input.label} response bound is invalid`);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
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
        throw new CloudflareGetTransportError(input.label, 0, safeReason(error));
      }
      const text = await readBoundedResponseText(
        response,
        input.maximumBytes,
        input.label,
        deadline,
        controller.signal,
      );
      if (controller.signal.aborted) throw new RetryableTransportFailure("TimeoutError");
      return { response, text };
    } catch (error) {
      const retryable = error instanceof RetryableTransportFailure;
      if (
        retryable &&
        attempt === 0 &&
        (response === undefined || isSuccessfulResponse(response))
      ) {
        continue;
      }
      if (retryable) {
        throw new CloudflareGetTransportError(input.label, response?.status ?? 0, error.reason);
      }
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
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
  if (error instanceof DOMException) return error.name;
  return "TransportError";
}
