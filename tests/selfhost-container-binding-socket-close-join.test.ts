import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import { createServer as importedCreateServer } from "node:http";
import { openSelfhostContainerBindingSocket } from "../src/providers/selfhost-container-binding-socket.ts";

function gate() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
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
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

// Only Node HTTP/fs overloads are modeled. The original factory runs without
// binding a socket, touching the filesystem, or dispatching a Container call.
async function socketBoundary(replacement?: "dev" | "ino" | "uid") {
  const directory = "/NONSECRET-broker-close";
  const socketName = `${"a".repeat(64)}.sock`;
  const path = `${directory}/${socketName}`;
  const events: string[] = [];
  const unlink = gate();
  let socketReads = 0;
  const closeCallbacks: (() => void)[] = [];
  let closeReentry: (() => void) | undefined;
  const server = Object.assign(new EventEmitter(), {
    listen(actual: string, callback: () => void) {
      expect(actual).toBe(path);
      events.push("listen");
      callback();
      return server;
    },
    closeAllConnections() {
      events.push("closeAllConnections");
      const reenter = closeReentry;
      closeReentry = undefined;
      reenter?.();
    },
    close(callback: () => void) {
      events.push("server.close");
      closeCallbacks.push(callback);
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
    socketReads++;
    const pin = { dev: 1, ino: 2, uid: 42 };
    if (socketReads > 1) {
      events.push("lstat.cleanup");
      if (replacement) pin[replacement]++;
    }
    return pin as Stats;
  }) as typeof fs.lstat);
  const chmod = spyOn(fs, "chmod").mockImplementation(async (actual, mode) => {
    expect(actual).toBe(path);
    expect(mode).toBe(0o600);
  });
  const remove = spyOn(fs, "unlink").mockImplementation(async (actual) => {
    expect(actual).toBe(path);
    events.push("unlink");
    await unlink.promise;
  });
  const create = spyOn(http, "createServer").mockImplementation((() => {
    events.push("createServer");
    return server;
  }) as unknown as typeof http.createServer);
  const restore = () => {
    create.mockRestore();
    remove.mockRestore();
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
      dispatch: async () => {
        throw Error("unexpected Container dispatch");
      },
    });
    return {
      socket,
      events,
      unlink,
      reenterOnClose(callback: () => void) {
        closeReentry = callback;
      },
      finishServerClose() {
        for (const callback of closeCallbacks.splice(0)) callback();
      },
      restore,
    };
  } catch (error) {
    restore();
    throw error;
  }
}

test("concurrent broker closes join the original server close and guarded unlink", async () => {
  const io = await socketBoundary();
  const first = observed(io.socket.close());
  const second = observed(io.socket.close());
  try {
    await microtasks();
    expect([first.state(), second.state()]).toEqual(["pending", "pending"]);
    expect(io.events).toEqual(["createServer", "listen", "closeAllConnections", "server.close"]);
    io.finishServerClose();
    await microtasks();
    expect([first.state(), second.state()]).toEqual(["pending", "pending"]);
    expect(io.events.slice(-2)).toEqual(["lstat.cleanup", "unlink"]);
    io.unlink.resolve();
    expect(await Promise.all([first.result, second.result])).toEqual([
      { status: "fulfilled" },
      { status: "fulfilled" },
    ]);
    await io.socket.close();
    expect(io.events).toEqual([
      "createServer",
      "listen",
      "closeAllConnections",
      "server.close",
      "lstat.cleanup",
      "unlink",
    ]);
  } finally {
    io.finishServerClose();
    io.unlink.resolve();
    await Promise.all([first.result, second.result]);
    io.restore();
  }
});

test("synchronous broker close reentry sees the cached operation before side effects", async () => {
  const io = await socketBoundary();
  const nested: ReturnType<typeof observed>[] = [];
  const promises: Promise<void>[] = [];
  io.reenterOnClose(() => {
    const promise = io.socket.close();
    promises.push(promise);
    nested.push(observed(promise));
  });
  const original = io.socket.close();
  const first = observed(original);
  try {
    expect(promises).toHaveLength(1);
    expect(promises[0]).toBe(original);
    expect(io.events.filter((event) => event === "closeAllConnections")).toHaveLength(1);
    expect(io.events.filter((event) => event === "server.close")).toHaveLength(1);
    await microtasks();
    expect([first, ...nested].map((call) => call.state())).toEqual(["pending", "pending"]);
    io.finishServerClose();
    await microtasks();
    expect([first, ...nested].map((call) => call.state())).toEqual(["pending", "pending"]);
    io.unlink.resolve();
    expect(await Promise.all([first, ...nested].map((call) => call.result))).toEqual([
      { status: "fulfilled" },
      { status: "fulfilled" },
    ]);
  } finally {
    io.finishServerClose();
    io.unlink.resolve();
    await Promise.all([first, ...nested].map((call) => call.result));
    io.restore();
  }
});

test("broker close cleanup failure stays shared and is never retried", async () => {
  const io = await socketBoundary();
  const first = observed(io.socket.close());
  const second = observed(io.socket.close());
  try {
    io.finishServerClose();
    await microtasks();
    expect([first.state(), second.state()]).toEqual(["pending", "pending"]);
    const error = Error("NONSECRET unlink failure");
    io.unlink.reject(error);
    for (const call of [first, second]) {
      const result = await call.result;
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toBe(error);
    }
    const before = [...io.events];
    const repeated = await observed(io.socket.close()).result;
    expect(repeated.status).toBe("rejected");
    if (repeated.status === "rejected") expect(repeated.reason).toBe(error);
    expect(io.events).toEqual(before);
    expect(io.events.filter((event) => event === "unlink")).toHaveLength(1);
  } finally {
    io.finishServerClose();
    io.unlink.resolve();
    await Promise.all([first.result, second.result]);
    io.restore();
  }
});

test("broker close keeps the original dev ino uid unlink guard", async () => {
  for (const changed of ["dev", "ino", "uid"] as const) {
    const io = await socketBoundary(changed);
    const first = observed(io.socket.close());
    const second = observed(io.socket.close());
    try {
      io.finishServerClose();
      expect(await Promise.all([first.result, second.result])).toEqual([
        { status: "fulfilled" },
        { status: "fulfilled" },
      ]);
      expect(io.events.filter((event) => event === "lstat.cleanup")).toHaveLength(1);
      expect(io.events).not.toContain("unlink");
    } finally {
      io.finishServerClose();
      io.unlink.resolve();
      await Promise.all([first.result, second.result]);
      io.restore();
    }
  }
});
