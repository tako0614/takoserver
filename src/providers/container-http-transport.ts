import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStreamDefaultReader as NodeReadableStreamDefaultReader } from "node:stream/web";
import { CONTAINER_CONTRACT as C } from "../container-contract.ts";
import { ContainerError } from "../container-http.ts";

/** One original exchange. Cancellation is an instruction, not a join: the
 * same request/response close events and upload/reader settlement remain held.
 * The caller registers this handle before send, and retains it on UNKNOWN. */
export function createContainerHttpInvocation() {
  let attempted = false,
    constructing = false,
    closing = false,
    terminal = false;
  let outgoingClosed = false,
    incomingClosed = false,
    uploadFinished = false;
  let responseFinished = true,
    outgoingDestroySent = false,
    incomingDestroySent = false;
  let outgoing: ClientRequest | undefined, incoming: IncomingMessage | undefined;
  let upload: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let responseReader: NodeReadableStreamDefaultReader<Uint8Array> | undefined;
  let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let original: Request | undefined, unknown: unknown;
  let uploadCancellation: Promise<void> | undefined,
    responseCancellation: Promise<void> | undefined;
  let resolveJoin!: () => void, rejectJoin!: (error: unknown) => void;
  const settlement = new Promise<void>((resolve, reject) => {
    resolveJoin = resolve;
    rejectJoin = reject;
  });
  void settlement.catch(() => undefined);
  const rememberUnknown = (error: unknown) => {
    unknown ??= error instanceof Error ? error : new ContainerError(C.errors.responseAborted);
    rejectJoin(unknown);
  };
  const check = () => {
    if (
      attempted &&
      !constructing &&
      (!outgoing || outgoingClosed) &&
      (!incoming || incomingClosed) &&
      uploadFinished &&
      responseFinished
    ) {
      terminal = true;
      original?.signal.removeEventListener("abort", abort);
      if (unknown !== undefined) rejectJoin(unknown);
      else resolveJoin();
    }
  };
  const stopUpload = () => {
    if (upload && !uploadCancellation)
      uploadCancellation = Promise.resolve()
        .then(() => upload!.cancel())
        .then(
          () => undefined,
          (error: unknown) => rememberUnknown(error),
        );
    return uploadCancellation ?? Promise.resolve();
  };
  const stopResponse = () => {
    if (responseReader && !responseCancellation) {
      // Readable.toWeb cancellation owns the original incoming.destroy.
      // Consume that attempt here, before invoking the reader, rather than
      // destroying the same message independently through a second path.
      incomingDestroySent = true;
      try {
        responseController?.error(new ContainerError(C.errors.responseAborted));
      } catch {
        /* Already closed/canceled by the original consumer. */
      }
      responseCancellation = Promise.resolve()
        .then(() => responseReader!.cancel())
        .then(
          () => undefined,
          (error: unknown) => rememberUnknown(error),
        )
        .finally(() => {
          responseFinished = true;
          check();
        });
    }
    return responseCancellation ?? Promise.resolve();
  };
  function abort() {
    closing = true;
    try {
      if (outgoing && !outgoingClosed && !outgoingDestroySent) {
        outgoingDestroySent = true;
        outgoing.destroy(new ContainerError(C.errors.requestAborted));
      }
      if (
        incoming &&
        !incomingClosed &&
        !incomingDestroySent &&
        (!responseReader || responseFinished)
      ) {
        incomingDestroySent = true;
        incoming.destroy(new ContainerError(C.errors.responseAborted));
      }
      void stopUpload();
      void stopResponse();
    } catch (error) {
      rememberUnknown(error);
    }
  }
  const assertJoined = () => {
    if (!terminal || unknown !== undefined)
      throw unknown ?? new Error("container_http_io_retained");
  };
  return Object.freeze({
    settlement,
    assertJoined,
    /** No retry or replacement request. The response still resolves at head. */
    send(request: Request): Promise<Response> {
      if (attempted || closing) return Promise.reject(new Error("container_http_io_attempted"));
      attempted = true;
      original = request;
      return new Promise<Response>((resolve, reject) => {
        let head = false;
        const refuse = (error: unknown) => {
          if (!head) reject(error);
          abort();
        };
        try {
          if (!(request instanceof Request) || request.signal.aborted) {
            uploadFinished = true;
            closing = true;
            reject(new ContainerError(C.errors.requestAborted));
            check();
            return;
          }
          const url = new URL(request.url);
          upload = request.body?.getReader();
          constructing = true;
          outgoing = httpRequest(url, {
            method: request.method,
            headers: Object.fromEntries(request.headers),
            agent: false,
            maxHeaderSize: C.limits.headerBytes,
          });
          outgoing.once("response", (message: IncomingMessage) => {
            if (incoming || terminal) {
              rememberUnknown(new Error("container_http_late_response"));
              message.destroy();
              return;
            }
            incoming = message;
            message.once("close", () => {
              incomingClosed = true;
              check();
            });
            message.once("error", refuse);
            if (closing) {
              abort();
              return;
            }
            try {
              const headers = new Headers();
              for (let i = 0; i < message.rawHeaders.length; i += 2)
                headers.append(message.rawHeaders[i]!, message.rawHeaders[i + 1]!);
              const init = {
                status: message.statusCode ?? 502,
                statusText: message.statusMessage ?? "",
                headers,
              };
              const bodyless = request.method === "HEAD" || [204, 205, 304].includes(init.status);
              if (bodyless) message.resume();
              else {
                responseFinished = false;
                responseReader = Readable.toWeb(message).getReader();
              }
              const body = bodyless
                ? null
                : new ReadableStream<Uint8Array>(
                    {
                      start(controller) {
                        responseController = controller;
                      },
                      async pull(controller) {
                        try {
                          const next = await responseReader!.read();
                          if (closing) return;
                          if (next.done) {
                            responseFinished = true;
                            controller.close();
                            await stopUpload();
                            check();
                          } else controller.enqueue(next.value);
                        } catch (error) {
                          if (!closing) controller.error(error);
                          await stopResponse();
                          abort();
                        }
                      },
                      async cancel() {
                        abort();
                        await stopResponse();
                      },
                    },
                    { highWaterMark: 0 },
                  );
              const response = new Response(body, init);
              head = true;
              resolve(response);
            } catch (error) {
              refuse(error);
            }
          });
          outgoing.once("error", (error: Error & { code?: string }) =>
            refuse(
              error.code === "HPE_HEADER_OVERFLOW"
                ? new ContainerError(C.errors.responseTooLarge)
                : error,
            ),
          );
          outgoing.once("close", () => {
            outgoingClosed = true;
            if (!head) reject(new ContainerError(C.errors.backendUnavailable));
            void stopUpload();
            check();
          });
          request.signal.addEventListener("abort", abort, { once: true });
          constructing = false;
          if (request.signal.aborted || closing) abort();
          void (async () => {
            try {
              if (upload)
                while (!closing && !outgoing!.destroyed) {
                  const next = await upload.read();
                  if (next.done || closing) break;
                  if (!outgoing!.write(next.value))
                    await new Promise<void>((ready) => {
                      const finish = () => {
                        outgoing!.removeListener("drain", finish);
                        outgoing!.removeListener("close", finish);
                        ready();
                      };
                      outgoing!.once("drain", finish);
                      outgoing!.once("close", finish);
                    });
                }
              if (!closing && !outgoing!.destroyed) outgoing!.end();
            } catch (error) {
              refuse(error);
            } finally {
              await stopUpload();
              uploadFinished = true;
              check();
            }
          })();
          check();
        } catch (error) {
          constructing = false;
          uploadFinished = upload === undefined;
          refuse(error);
          if (upload)
            void stopUpload().finally(() => {
              uploadFinished = true;
              check();
            });
          check();
        }
      });
    },
    close(): Promise<void> {
      if (!attempted) {
        attempted = true;
        uploadFinished = true;
      }
      abort();
      check();
      return settlement.then(assertJoined);
    },
  });
}

/** Dedicated HTTP connection, no redirect handling, decompression or retry.
 * Existing callers retain the response-at-head API; owners also retain/join
 * the invocation above, independently of logical response completion. */
export function containerHttpTransport(request: Request): Promise<Response> {
  return createContainerHttpInvocation().send(request);
}
