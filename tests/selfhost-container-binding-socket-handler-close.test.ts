import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import { createServer as importedCreateServer } from "node:http";
import { Readable } from "node:stream";
import { ReadableStream as NodeReadableStream } from "node:stream/web";
import { CONTAINER_BINDING_WIRE as W } from "../src/providers/selfhost-container-binding-client.ts";
import { openSelfhostContainerBindingSocket } from "../src/providers/selfhost-container-binding-socket.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function observed(promise: Promise<void>) {
  let state: "pending" | "fulfilled" | "rejected" = "pending";
  const result = promise.then(
    () => {
      state = "fulfilled";
      return { status: "fulfilled" as const };
    },
    (reason: unknown) => {
      state = "rejected";
      return { status: "rejected" as const, reason };
    },
  );
  return { result, state: () => state };
}

async function microtasks() {
  for (let index = 0; index < 32; index++) await Promise.resolve();
}

// Actual factory, wire framing and Web Streams; only Node HTTP/fs/toWeb and
// the optional negative outer-reader cancel boundary are replaced. No OS I/O.
async function boundary(
  options: { frame?: boolean; cancelError?: Error; innerCancelError?: Error } = {},
) {
  const directory = "/NONSECRET-broker-handler";
  const socketName = `${"b".repeat(64)}.sock`;
  const path = `${directory}/${socketName}`;
  const events: string[] = [];
  const responseReady = gate();
  const read = gate();
  const cancel = gate();
  let dispatchCalls = 0;
  let cancelCalls = 0;
  let readerCancels = 0;
  let toWebCalls = 0;
  let socketReads = 0;
  let outerCancelSeen = false;
  let listener: http.RequestListener | undefined;
  let onClose: (() => void) | undefined;
  const closeCallbacks: (() => void)[] = [];
  const tasks: ReturnType<typeof observed>[] = [];
  const outgoingMessages: EventEmitter[] = [];
  let sent = false;
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (options.frame && !sent) {
            sent = true;
            controller.enqueue(new Uint8Array([7]));
            return;
          }
          return read.promise;
        },
        cancel() {
          cancelCalls++;
          events.push("reader.cancel");
          if (options.innerCancelError) {
            const error = options.innerCancelError;
            return cancel.promise.then(() => {
              throw error;
            });
          }
          return cancel.promise;
        },
      },
      { highWaterMark: 0 },
    ),
  );
  const server = Object.assign(new EventEmitter(), {
    listen(actual: string, done: () => void) {
      expect(actual).toBe(path);
      done();
      return server;
    },
    closeAllConnections() {
      events.push("closeAllConnections");
      for (const outgoing of outgoingMessages) outgoing.emit("close");
      const callback = onClose;
      onClose = undefined;
      callback?.();
    },
    close(done: () => void) {
      events.push("server.close");
      closeCallbacks.push(done);
      return server;
    },
  });
  const uid = spyOn(process, "getuid").mockReturnValue(42);
  const realpath = spyOn(fs, "realpath").mockImplementation((async (actual) => {
    expect(actual).toBe(directory);
    return directory;
  }) as typeof fs.realpath);
  const lstat = spyOn(fs, "lstat").mockImplementation((async (actual) => {
    if (actual === directory)
      return {
        mode: 0o700,
        uid: 42,
        isSymbolicLink: () => false,
        isDirectory: () => true,
      } as Stats;
    expect(actual).toBe(path);
    if (++socketReads > 1) events.push("lstat.cleanup");
    return { dev: 1, ino: 2, uid: 42 } as Stats;
  }) as typeof fs.lstat);
  const chmod = spyOn(fs, "chmod").mockImplementation(async (actual, mode) => {
    expect(actual).toBe(path);
    expect(mode).toBe(0o600);
  });
  const unlink = spyOn(fs, "unlink").mockImplementation(async (actual) => {
    expect(actual).toBe(path);
    events.push("unlink");
  });
  const toWeb = spyOn(Readable, "toWeb").mockImplementation(() => {
    toWebCalls++;
    return new NodeReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  });
  const originalCancel = ReadableStreamDefaultReader.prototype.cancel;
  const readerCancel = spyOn(ReadableStreamDefaultReader.prototype, "cancel").mockImplementation(
    function (this: ReadableStreamDefaultReader, reason?: unknown) {
      readerCancels++;
      const outer = !outerCancelSeen;
      outerCancelSeen = true;
      const original = originalCancel.call(this, reason);
      // Inner wire cancellation intentionally catches its own source failure.
      // This negative model checks the outer Promise the socket actually owns.
      return outer && options.cancelError
        ? original.then(() => {
            throw options.cancelError;
          })
        : original;
    },
  );
  const create = spyOn(http, "createServer").mockImplementation(((
    _options: http.ServerOptions,
    callback: http.RequestListener,
  ) => {
    listener = callback;
    return server;
  }) as unknown as typeof http.createServer);
  const restore = () => {
    create.mockRestore();
    readerCancel.mockRestore();
    toWeb.mockRestore();
    unlink.mockRestore();
    chmod.mockRestore();
    lstat.mockRestore();
    realpath.mockRestore();
    uid.mockRestore();
  };
  try {
    if (!Object.is(importedCreateServer, create)) throw Error("HTTP interception absent");
    const socket = await openSelfhostContainerBindingSocket({
      directory,
      socketName,
      async dispatch(request) {
        dispatchCalls++;
        expect(request.method).toBe("GET");
        expect(new URL(request.url).pathname).toBe("/original");
        await responseReady.promise;
        return response;
      },
    });
    const accept = (backpressure = false) => {
      const incoming = Object.assign(new EventEmitter(), {
        method: "POST",
        url: "/",
        rawHeaders: [W.request, JSON.stringify({ method: "GET", path: "/original", headers: [] })],
      });
      const outgoing = Object.assign(new EventEmitter(), {
        writableFinished: false,
        writeHead() {},
        flushHeaders() {},
        write() {
          events.push("write");
          return !backpressure;
        },
        end() {
          events.push("end");
          outgoing.writableFinished = true;
        },
        destroy() {
          events.push("destroy");
          outgoing.emit("close");
          return outgoing;
        },
      });
      outgoingMessages.push(outgoing);
      if (!listener) throw Error("original HTTP listener absent");
      // Node ignores the listener return; observing its actual Promise here
      // distinguishes socket callback completion from handler/finally join.
      const invoke = listener as unknown as (
        input: typeof incoming,
        output: typeof outgoing,
      ) => Promise<void> | undefined;
      const returned = invoke(incoming, outgoing);
      const task = returned ? observed(returned) : undefined;
      if (task) tasks.push(task);
      return { incoming, outgoing, task };
    };
    return {
      socket,
      accept,
      events,
      responseReady,
      cancel,
      counts: () => ({ dispatchCalls, cancelCalls, readerCancels, toWebCalls }),
      onClose(callback: () => void) {
        onClose = callback;
      },
      finishServerClose() {
        for (const callback of closeCallbacks.splice(0)) callback();
      },
      async dispose(closing: ReturnType<typeof observed>) {
        responseReady.resolve();
        cancel.resolve();
        read.resolve();
        for (const callback of closeCallbacks.splice(0)) callback();
        await Promise.all([...tasks.map((task) => task.result), closing.result]);
        restore();
      },
    };
  } catch (error) {
    restore();
    throw error;
  }
}

test("broker close waits a previously aborted handler finally after server close", async () => {
  const io = await boundary();
  const active = io.accept();
  await microtasks();
  active.incoming.emit("aborted");
  io.responseReady.resolve();
  await microtasks();
  const closing = observed(io.socket.close());
  try {
    expect(io.counts().dispatchCalls).toBe(1);
    expect(io.counts().cancelCalls).toBe(1);
    expect(active.task?.state()).toBe("pending");
    io.finishServerClose();
    await microtasks();
    expect(closing.state()).toBe("pending");
    expect(io.events).not.toContain("unlink");
    io.cancel.resolve();
    expect(await closing.result).toEqual({ status: "fulfilled" });
    expect(active.task?.state()).toBe("fulfilled");
    expect(io.events.slice(-2)).toEqual(["lstat.cleanup", "unlink"]);
  } finally {
    await io.dispose(closing);
  }
});

test("close abort and finally join the same pending reader cancellation", async () => {
  const io = await boundary();
  const active = io.accept();
  io.responseReady.resolve();
  await microtasks();
  const closing = observed(io.socket.close());
  try {
    io.finishServerClose();
    await microtasks();
    expect(io.counts().cancelCalls).toBe(1);
    expect(io.counts().readerCancels).toBe(2); // outer reader plus original inner reader
    expect(active.task?.state()).toBe("pending");
    expect(closing.state()).toBe("pending");
    io.cancel.resolve();
    expect(await closing.result).toEqual({ status: "fulfilled" });
  } finally {
    await io.dispose(closing);
  }
});

test("a handler cancellation rejection stays in the shared close without retry", async () => {
  const error = Error("NONSECRET outer reader cancellation failure");
  const io = await boundary({ cancelError: error });
  io.accept();
  io.responseReady.resolve();
  await microtasks();
  const original = io.socket.close();
  const closing = observed(original);
  try {
    expect(io.socket.close()).toBe(original);
    io.finishServerClose();
    await microtasks();
    expect(closing.state()).toBe("pending");
    io.cancel.resolve();
    const result = await closing.result;
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe(error);
    expect(io.events).not.toContain("unlink");
    const before = [...io.events];
    expect(io.socket.close()).toBe(original);
    expect(await observed(io.socket.close()).result).toEqual(result);
    expect(io.events).toEqual(before);
  } finally {
    await io.dispose(closing);
  }
});

test("a reentrant handler during close is refused before body conversion or dispatch", async () => {
  const io = await boundary();
  io.accept();
  io.responseReady.resolve();
  await microtasks();
  let reentered: Promise<void> | undefined;
  io.onClose(() => {
    io.accept();
    reentered = io.socket.close();
  });
  const original = io.socket.close();
  const closing = observed(original);
  try {
    expect(reentered).toBe(original);
    io.finishServerClose();
    await microtasks();
    expect(io.counts().dispatchCalls).toBe(1);
    expect(io.counts().toWebCalls).toBe(1);
    expect(io.events).toContain("destroy");
    expect(closing.state()).toBe("pending");
    io.cancel.resolve();
    expect(await closing.result).toEqual({ status: "fulfilled" });
  } finally {
    await io.dispose(closing);
  }
});

test("close waits dispatch settlement and then cancels the late response body", async () => {
  const io = await boundary();
  const active = io.accept();
  await microtasks();
  const closing = observed(io.socket.close());
  try {
    io.finishServerClose();
    await microtasks();
    expect(closing.state()).toBe("pending");
    expect(io.counts().cancelCalls).toBe(0);
    io.responseReady.resolve();
    await microtasks();
    expect(io.counts().cancelCalls).toBe(1);
    expect(active.task?.state()).toBe("pending");
    expect(closing.state()).toBe("pending");
    io.cancel.resolve();
    expect(await closing.result).toEqual({ status: "fulfilled" });
  } finally {
    await io.dispose(closing);
  }
});

test("close releases original outgoing backpressure and joins its reader finally", async () => {
  const io = await boundary({ frame: true });
  const active = io.accept(true);
  io.responseReady.resolve();
  await microtasks();
  const closing = observed(io.socket.close());
  try {
    expect(io.events).toContain("write");
    io.finishServerClose();
    await microtasks();
    expect(active.task?.state()).toBe("pending");
    expect(closing.state()).toBe("pending");
    expect(io.counts().cancelCalls).toBe(1);
    io.cancel.resolve();
    expect(await closing.result).toEqual({ status: "fulfilled" });
    expect(active.task?.state()).toBe("fulfilled");
  } finally {
    await io.dispose(closing);
  }
});

test("actual inner reader rejection reaches shared socket close before unlink", async () => {
  const error = Error("NONSECRET actual inner cancellation failure");
  const io = await boundary({ innerCancelError: error });
  io.accept();
  io.responseReady.resolve();
  await microtasks();
  const original = io.socket.close();
  const closing = observed(original);
  try {
    expect(io.socket.close()).toBe(original);
    io.finishServerClose();
    await microtasks();
    expect(io.counts().cancelCalls).toBe(1);
    expect(closing.state()).toBe("pending");
    io.cancel.resolve();
    const result = await closing.result;
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe(error);
    expect(io.events).not.toContain("unlink");
    const before = [...io.events];
    expect(io.socket.close()).toBe(original);
    expect(await observed(io.socket.close()).result).toEqual(result);
    expect(io.counts().cancelCalls).toBe(1);
    expect(io.events).toEqual(before);
  } finally {
    await io.dispose(closing);
  }
});
