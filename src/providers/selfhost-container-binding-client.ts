import { CONTAINER_CONTRACT as C } from "../container-contract.ts";

export const CONTAINER_BINDING_WIRE = Object.freeze({
  request: "x-takoserver-container-request",
  result: "x-takoserver-container-result",
});

/** Self-contained Fetch runtime, emitted only into the Host-private module graph. */
function clientRuntime(contract: typeof C, wire: typeof CONTAINER_BINDING_WIRE) {
  const errors = contract.errors;
  const codes = [
    errors.invalidRequest,
    errors.backendUnavailable,
    errors.requestAborted,
    errors.requestTooLarge,
    errors.responseAborted,
    errors.responseTooLarge,
  ];
  class Failure extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = contract.errorName;
    }
  }
  function fail(code: string): never {
    throw new Failure(code);
  }
  const boundHeaders = (headers: Headers, response = false) => {
    const entries = [...headers];
    const size = entries.reduce(
      (bytes, [name, value]) => bytes + new TextEncoder().encode(`${name}: ${value}\r\n`).length,
      0,
    );
    if (entries.length > contract.limits.headers || size > contract.limits.headerBytes)
      fail(response ? errors.responseTooLarge : errors.requestTooLarge);
    return entries;
  };
  return (plane: { fetch(request: Request): Promise<Response> }) =>
    Object.freeze({
      async fetch(request: Request): Promise<Response> {
        if (
          !(request instanceof Request) ||
          !contract.methods.includes(request.method as (typeof contract.methods)[number]) ||
          request.headers.has("upgrade")
        )
          fail(errors.invalidRequest);
        if (request.signal.aborted) fail(errors.requestAborted);
        const url = new URL(request.url);
        if (!["http:", "https:"].includes(url.protocol)) fail(errors.invalidRequest);
        const path = url.pathname + url.search;
        if (path.length > contract.limits.pathQuery) fail(errors.requestTooLarge);
        const metadata = { method: request.method, path, headers: boundHeaders(request.headers) };
        const declared = request.headers.get("content-length");
        if (
          declared !== null &&
          (!/^(0|[1-9][0-9]*)$/u.test(declared) || !Number.isSafeInteger(Number(declared)))
        )
          fail(errors.invalidRequest);
        if (declared !== null && Number(declared) > contract.limits.bodyBytes)
          fail(errors.requestTooLarge);
        const abort = new AbortController();
        const cancel = () => abort.abort();
        request.signal.addEventListener("abort", cancel, { once: true });
        const finish = () => request.signal.removeEventListener("abort", cancel);
        let uploadFailure: unknown;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let uploadSize = 0;
        const upload = request.body
          ? new ReadableStream<Uint8Array>(
              {
                start() {
                  reader = request.body!.getReader();
                },
                async pull(controller) {
                  try {
                    const next = await reader!.read();
                    if (next.done) {
                      if (declared !== null && Number(declared) !== uploadSize)
                        fail(errors.requestAborted);
                      controller.close();
                      return;
                    }
                    uploadSize += next.value.length;
                    if (uploadSize > contract.limits.bodyBytes) fail(errors.requestTooLarge);
                    if (declared !== null && uploadSize > Number(declared))
                      fail(errors.requestAborted);
                    controller.enqueue(next.value);
                  } catch (error) {
                    uploadFailure = error;
                    controller.error(error);
                    cancel();
                    void reader?.cancel().catch(() => {});
                  }
                },
                async cancel() {
                  cancel();
                  await reader?.cancel().catch(() => {});
                },
              },
              { highWaterMark: 0 },
            )
          : null;
        if (!upload && declared !== null && Number(declared) !== 0) {
          finish();
          fail(errors.invalidRequest);
        }
        let response: Response;
        try {
          response = await plane.fetch(
            new Request("http://container-broker.invalid/", {
              method: "POST",
              headers: { [wire.request]: JSON.stringify(metadata) },
              body: upload,
              redirect: "manual",
              signal: abort.signal,
              ...({ duplex: "half" } as { duplex: "half" }),
            }),
          );
        } catch {
          finish();
          if (uploadFailure instanceof Failure) throw uploadFailure;
          fail(request.signal.aborted ? errors.requestAborted : errors.backendUnavailable);
        }
        let head: {
          status?: number;
          statusText?: string;
          headers?: [string, string][];
          error?: string;
        };
        try {
          head = JSON.parse(response.headers.get(wire.result) ?? "");
        } catch {
          finish();
          await response.body?.cancel();
          fail(errors.backendUnavailable);
        }
        if (head.error !== undefined) {
          finish();
          await response.body?.cancel();
          fail(
            codes.includes(head.error as (typeof codes)[number])
              ? head.error
              : errors.backendUnavailable,
          );
        }
        let headers: Headers;
        try {
          headers = new Headers(head.headers);
          boundHeaders(headers, true);
        } catch (error) {
          finish();
          await response.body?.cancel();
          throw error instanceof Failure ? error : new Failure(errors.responseAborted);
        }
        const status = head.status;
        if (
          typeof status !== "number" ||
          !Number.isInteger(status) ||
          status < 200 ||
          status > 599
        ) {
          finish();
          await response.body?.cancel();
          fail(errors.responseAborted);
        }
        if (!response.body || request.method === "HEAD" || [204, 205, 304].includes(status)) {
          finish();
          await response.body?.cancel();
          return new Response(null, { status, statusText: head.statusText ?? "", headers });
        }
        // Private framing carries post-head error codes without changing status.
        const input = response.body.getReader();
        let pending = new Uint8Array(0);
        let offset = 0;
        let total = 0;
        let done = false;
        const byte = async (): Promise<number | null> => {
          while (offset === pending.length) {
            const next = await input.read();
            if (next.done) return null;
            pending = next.value;
            offset = 0;
          }
          return pending[offset++]!;
        };
        let abortBody: () => void;
        const close = () => {
          done = true;
          finish();
          request.signal.removeEventListener("abort", abortBody);
        };
        const body = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              abortBody = () => {
                if (!done) {
                  close();
                  controller.error(new Failure(errors.requestAborted));
                  void input.cancel().catch(() => {});
                  cancel();
                }
              };
              request.signal.addEventListener("abort", abortBody, { once: true });
              if (request.signal.aborted) abortBody();
            },
            async pull(controller) {
              try {
                const first = await byte();
                if (done) return;
                if (first === null) fail(errors.responseAborted);
                let size = first;
                for (let index = 0; index < 3; index++) {
                  const next = await byte();
                  if (next === null) fail(errors.responseAborted);
                  size = size * 256 + next;
                }
                if (size === 0xffffffff) {
                  const code = await byte();
                  fail(
                    code === null
                      ? errors.responseAborted
                      : (codes[code] ?? errors.responseAborted),
                  );
                }
                if (size === 0) {
                  close();
                  controller.close();
                  return;
                }
                total += size;
                if (size > contract.limits.bodyBytes || total > contract.limits.bodyBytes)
                  fail(errors.responseTooLarge);
                const chunk = new Uint8Array(size);
                let written = 0;
                while (written < size) {
                  if (offset === pending.length) {
                    const next = await input.read();
                    if (next.done) fail(errors.responseAborted);
                    pending = next.value;
                    offset = 0;
                  }
                  const count = Math.min(size - written, pending.length - offset);
                  chunk.set(pending.subarray(offset, offset + count), written);
                  written += count;
                  offset += count;
                }
                if (!done) controller.enqueue(chunk);
              } catch (error) {
                if (done) return;
                close();
                controller.error(
                  error instanceof Failure ? error : new Failure(errors.responseAborted),
                );
                cancel();
                void input.cancel().catch(() => {});
              }
            },
            async cancel() {
              close();
              cancel();
              await input.cancel().catch(() => {});
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(body, { status, statusText: head.statusText ?? "", headers });
      },
    });
}

export const makeContainerBinding = clientRuntime(C, CONTAINER_BINDING_WIRE);

export function selfhostContainerBindingClientSource(): string {
  return `export const makeContainerBinding = (${clientRuntime.toString()})(${JSON.stringify(C)}, ${JSON.stringify(CONTAINER_BINDING_WIRE)});`;
}
