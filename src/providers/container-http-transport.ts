import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { CONTAINER_CONTRACT as C } from "../container-contract.ts";
import { ContainerError } from "../container-http.ts";

/** Dedicated HTTP connection, no redirect handling, decompression or retry. */
export function containerHttpTransport(request: Request): Promise<Response> {
  return new Promise((resolve, reject) => {
    const url = new URL(request.url);
    const abort = () => outgoing.destroy(new ContainerError(C.errors.requestAborted));
    const outgoing = httpRequest(
      url,
      {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        agent: false,
        maxHeaderSize: C.limits.headerBytes,
      },
      (incoming) => {
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2)
          headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        if (request.method === "HEAD" || [204, 205, 304].includes(incoming.statusCode ?? 0)) {
          incoming.resume();
          resolve(
            new Response(null, {
              status: incoming.statusCode ?? 502,
              statusText: incoming.statusMessage ?? "",
              headers,
            }),
          );
        } else
          resolve(
            new Response(Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>, {
              status: incoming.statusCode ?? 502,
              statusText: incoming.statusMessage ?? "",
              headers,
            }),
          );
      },
    );
    outgoing.once("error", (error: Error & { code?: string }) =>
      reject(
        error.code === "HPE_HEADER_OVERFLOW"
          ? new ContainerError(C.errors.responseTooLarge)
          : error,
      ),
    );
    outgoing.once("close", () => request.signal.removeEventListener("abort", abort));
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) {
      abort();
      return;
    }
    void (async () => {
      const body = request.body?.getReader();
      if (body) {
        const stopUpload = () => {
          void body.cancel().catch(() => {});
        };
        outgoing.once("close", stopUpload);
        try {
          while (!outgoing.destroyed) {
            const next = await body.read();
            if (next.done) break;
            if (!outgoing.write(next.value))
              await new Promise<void>((resolve) => {
                const finish = () => {
                  outgoing.removeListener("drain", finish);
                  outgoing.removeListener("close", finish);
                  resolve();
                };
                outgoing.once("drain", finish);
                outgoing.once("close", finish);
              });
          }
        } finally {
          outgoing.removeListener("close", stopUpload);
          await body.cancel().catch(() => {});
        }
      }
      outgoing.end();
    })().catch((error: unknown) =>
      outgoing.destroy(
        error instanceof Error ? error : new ContainerError(C.errors.requestAborted),
      ),
    );
  });
}
