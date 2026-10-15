import type { ContainerBindingClaim } from "../container-contract.ts";
import { CONTAINER_CONTRACT as C } from "../container-contract.ts";
import { ContainerError } from "../container-http.ts";
import { parseStrictJson } from "../strict-json.ts";
import { CONTAINER_BINDING_WIRE as W } from "./selfhost-container-binding-client.ts";
import type { SelfhostContainerRuntimeHandle } from "./selfhost-container-lifecycle.ts";
import type { SelfhostContainerIdentity } from "./selfhost-container-runtime.ts";

const codes = [
  C.errors.invalidRequest,
  C.errors.backendUnavailable,
  C.errors.requestAborted,
  C.errors.requestTooLarge,
  C.errors.responseAborted,
  C.errors.responseTooLarge,
];

/** One listener capability is pinned to one accepted caller and target UID. */
export function createSelfhostContainerBindingBroker(options: {
  readonly claim: ContainerBindingClaim;
  readonly resolve: (claim: ContainerBindingClaim) => Promise<SelfhostContainerIdentity | null>;
  readonly runtime: Pick<SelfhostContainerRuntimeHandle, "fetch">;
}) {
  const claim = structuredClone(options.claim);
  return async (request: Request): Promise<Response> => {
    let response: Response | undefined;
    try {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/")
        throw new ContainerError(C.errors.invalidRequest);
      const document = request.headers.get(W.request);
      if (!document || document.length > 60_000) throw new ContainerError(C.errors.invalidRequest);
      const value = parseStrictJson(new TextEncoder().encode(document), 60_000) as {
        method?: unknown;
        path?: unknown;
        headers?: unknown;
      };
      if (
        !value ||
        Object.keys(value).length !== 3 ||
        typeof value.method !== "string" ||
        typeof value.path !== "string" ||
        !value.path.startsWith("/") ||
        value.path.startsWith("//") ||
        value.path.includes("#") ||
        value.path.includes("\\") ||
        Array.from(value.path).some(
          (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
        ) ||
        !Array.isArray(value.headers) ||
        value.headers.some(
          (entry) =>
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            entry.some((item) => typeof item !== "string"),
        )
      )
        throw new ContainerError(C.errors.invalidRequest);
      const identity = await options.resolve(claim);
      if (!identity || identity.resourceUid !== claim.targetUid)
        throw new ContainerError(C.errors.backendUnavailable);
      const original = new Request(`http://logical.invalid${value.path}`, {
        method: value.method,
        headers: value.headers as [string, string][],
        body: ["GET", "HEAD"].includes(value.method) ? null : request.body,
        redirect: "manual",
        signal: request.signal,
        ...({ duplex: "half" } as { duplex: "half" }),
      });
      response = await options.runtime.fetch(identity, original);
      const head = {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers],
      };
      const input = response.body?.getReader();
      const body = input
        ? new ReadableStream<Uint8Array>(
            {
              async pull(controller) {
                try {
                  const next = await input.read();
                  if (next.done) {
                    controller.enqueue(new Uint8Array(4));
                    controller.close();
                    return;
                  }
                  const prefix = new Uint8Array(4);
                  new DataView(prefix.buffer).setUint32(0, next.value.length);
                  const frame = new Uint8Array(4 + next.value.length);
                  frame.set(prefix);
                  frame.set(next.value, 4);
                  controller.enqueue(frame);
                } catch (error) {
                  const index = codes.indexOf(
                    error instanceof ContainerError ? error.code : C.errors.responseAborted,
                  );
                  controller.enqueue(new Uint8Array([255, 255, 255, 255, index < 0 ? 4 : index]));
                  controller.close();
                }
              },
              async cancel() {
                await input.cancel().catch(() => {});
              },
            },
            { highWaterMark: 0 },
          )
        : null;
      return new Response(body, { headers: { [W.result]: JSON.stringify(head) } });
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      return new Response(null, {
        headers: {
          [W.result]: JSON.stringify({
            error:
              error instanceof ContainerError
                ? error.code
                : request.signal.aborted
                  ? C.errors.requestAborted
                  : C.errors.backendUnavailable,
          }),
        },
      });
    }
  };
}
