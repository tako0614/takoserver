import { CONTAINER_CONTRACT as C } from "./container-contract.ts";

export type ContainerErrorCode = (typeof C.errors)[
  | "invalidRequest"
  | "backendUnavailable"
  | "requestAborted"
  | "requestTooLarge"
  | "responseAborted"
  | "responseTooLarge"];
export class ContainerError extends Error {
  constructor(readonly code: ContainerErrorCode) {
    super(code);
    this.name = C.errorName;
  }
}
const E = C.errors;
const fail = (code: ContainerErrorCode): never => {
  throw new ContainerError(code);
};

function headers(input: Headers, response: boolean): Headers {
  let count = 0;
  let size = 0;
  for (const [name, value] of input) {
    count++;
    size += new TextEncoder().encode(`${name}: ${value}\r\n`).byteLength;
  }
  if (count > C.limits.headers || size > C.limits.headerBytes)
    fail(response ? E.responseTooLarge : E.requestTooLarge);
  const result = new Headers(input);
  const nominated = (result.get("connection") ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!response && nominated.some((name) => name.toLowerCase() === "content-length"))
    fail(E.invalidRequest);
  try {
    for (const name of [
      ...nominated,
      "connection",
      "content-length",
      "host",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ])
      result.delete(name);
  } catch {
    fail(response ? E.backendUnavailable : E.invalidRequest);
  }
  return result;
}

function length(input: Headers, response: boolean, payload = true): number | undefined {
  const value = input.get("content-length");
  if (value === null) return undefined;
  if (!/^(0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value)))
    fail(response ? E.backendUnavailable : E.invalidRequest);
  const size = Number(value);
  if (payload && size > C.limits.bodyBytes) fail(response ? E.responseTooLarge : E.requestTooLarge);
  return size;
}

/** One pull per consumer pull, with no pre-read and bounded chunk accounting. */
export function containerBody(
  body: ReadableStream<Uint8Array> | null,
  expected: number | undefined,
  response: boolean,
  signal: AbortSignal,
  abort: () => void,
  finish: () => void = () => {},
  report: (error: ContainerError) => void = () => {},
): ReadableStream<Uint8Array> | null {
  if (!body) {
    if (expected !== undefined && expected !== 0)
      fail(response ? E.responseAborted : E.invalidRequest);
    return null;
  }
  const reader = body.getReader();
  let size = 0;
  let done = false;
  let onAbort: () => void;
  const close = () => {
    if (!done) {
      done = true;
      signal.removeEventListener("abort", onAbort);
      finish();
    }
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        onAbort = () => {
          if (done) return;
          close();
          controller.error(
            new ContainerError(
              response && signal.reason !== E.requestAborted ? E.responseAborted : E.requestAborted,
            ),
          );
          void reader.cancel().catch(() => {});
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      },
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (done) return;
          if (chunk.done) {
            if (expected !== undefined && size !== expected)
              fail(response ? E.responseAborted : E.requestAborted);
            close();
            controller.close();
            return;
          }
          size += chunk.value.byteLength;
          if (size > C.limits.bodyBytes) fail(response ? E.responseTooLarge : E.requestTooLarge);
          if (expected !== undefined && size > expected)
            fail(response ? E.responseAborted : E.requestAborted);
          controller.enqueue(chunk.value);
        } catch (error) {
          if (done) return;
          close();
          const failure =
            error instanceof ContainerError
              ? error
              : new ContainerError(response ? E.responseAborted : E.requestAborted);
          report(failure);
          controller.error(failure);
          void reader.cancel().catch(() => {});
          abort();
        }
      },
      async cancel() {
        close();
        abort();
        await reader.cancel().catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
}

/** Transport is Host-selected. Request authority never selects a backend. */
export async function forwardContainerHttp(
  request: Request,
  endpoint: string,
  transport: (request: Request) => Promise<Response>,
  externalSignal?: AbortSignal,
): Promise<Response> {
  if (
    !(request instanceof Request) ||
    !C.methods.includes(request.method as (typeof C.methods)[number]) ||
    request.headers.has("upgrade")
  )
    fail(E.invalidRequest);
  if (request.signal.aborted || externalSignal?.aborted) fail(E.requestAborted);
  const source = new URL(request.url);
  if (!["http:", "https:"].includes(source.protocol)) fail(E.invalidRequest);
  if ((source.pathname + source.search).length > C.limits.pathQuery) fail(E.requestTooLarge);
  const target = new URL(endpoint);
  if (
    target.protocol !== "http:" ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  )
    fail(E.backendUnavailable);
  target.pathname = source.pathname;
  target.search = source.search;
  const outgoingHeaders = headers(request.headers, false);
  const expected = length(request.headers, false);
  const abort = new AbortController();
  // The lifecycle signal also carries drain; only the original caller marks a request abort.
  const cancel = () => abort.abort(request.signal.aborted ? E.requestAborted : undefined);
  request.signal.addEventListener("abort", cancel, { once: true });
  externalSignal?.addEventListener("abort", cancel, { once: true });
  const finish = () => {
    request.signal.removeEventListener("abort", cancel);
    externalSignal?.removeEventListener("abort", cancel);
  };
  let requestError: unknown;
  let response: Response | undefined;
  try {
    const body = containerBody(
      request.body,
      expected,
      false,
      abort.signal,
      cancel,
      () => {},
      (error) => {
        requestError = error;
      },
    );
    response = await transport(
      new Request(target, {
        method: request.method,
        headers: outgoingHeaders,
        body,
        redirect: "manual",
        signal: abort.signal,
        ...({ duplex: "half" } as { duplex: "half" }),
      }),
    );
    if (abort.signal.aborted) fail(E.requestAborted);
    const incomingHeaders = headers(response.headers, true);
    const bodyless = request.method === "HEAD" || [204, 205, 304].includes(response.status);
    const responseLength = length(response.headers, true, !bodyless);
    if (bodyless) {
      await response.body?.cancel();
      finish();
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: incomingHeaders,
      });
    }
    const incomingBody = containerBody(
      response.body,
      responseLength,
      true,
      abort.signal,
      cancel,
      finish,
    );
    if (!incomingBody) finish();
    return new Response(incomingBody, {
      status: response.status,
      statusText: response.statusText,
      headers: incomingHeaders,
    });
  } catch (error) {
    finish();
    cancel();
    await response?.body?.cancel().catch(() => {});
    if (requestError instanceof ContainerError) throw requestError;
    if (error instanceof ContainerError) throw error;
    return fail(
      request.signal.aborted || externalSignal?.aborted ? E.requestAborted : E.backendUnavailable,
    );
  }
}
