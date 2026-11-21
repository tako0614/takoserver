import { spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import { request as importedRequest } from "node:http";
import { PassThrough } from "node:stream";

function observed<T>(promise: Promise<T>) {
  let state = "pending";
  const value = promise.then(
    (result) => {
      state = "resolved";
      return { result };
    },
    (error: unknown) => {
      state = "rejected";
      return { error };
    },
  );
  return { value, state: () => state };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// No raw Node request/socket is created. Only the actual transport bodies run;
// the Node overload boundary is typed, not a provider/native authority oracle.
function raw() {
  const outgoing = new EventEmitter();
  const incoming = new PassThrough({ autoDestroy: false });
  let calls = 0,
    ends = 0,
    requestDestroy = 0,
    responseDestroy = 0,
    writable = true;
  const writes: Uint8Array[] = [];
  const targets: unknown[] = [];
  const request = Object.assign(outgoing, {
    destroyed: false,
    write(bytes: Uint8Array) {
      writes.push(bytes.slice());
      return writable;
    },
    end() {
      ends++;
      return request;
    },
    destroy() {
      requestDestroy++;
      request.destroyed = true;
      return request;
    },
  });
  Object.assign(incoming, { statusCode: 200, statusMessage: "OK", rawHeaders: [] });
  const destroy = spyOn(incoming, "destroy").mockImplementation(() => {
    responseDestroy++;
    return incoming;
  });
  const intercept = spyOn(http, "request").mockImplementation(((..._args: unknown[]) => {
    calls++;
    targets.push(_args[0]);
    return request;
  }) as unknown as typeof http.request);
  if (!Object.is(importedRequest, intercept)) throw Error("raw request interception absent");
  return {
    request,
    incoming,
    writes,
    targets,
    writable(value: boolean) {
      writable = value;
    },
    head() {
      request.emit("response", incoming);
    },
    closeRequest() {
      request.emit("close");
    },
    closeResponse() {
      incoming.emit("close");
    },
    counts: () => ({ calls, ends, requestDestroy, responseDestroy }),
    restore() {
      intercept.mockRestore();
      destroy.mockRestore();
      incoming.destroy();
    },
  };
}

export { observed as observeRawPromise, raw as ownedRawHttp, tick as rawTick };
