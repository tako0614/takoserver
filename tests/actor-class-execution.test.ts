import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ActorExecutionError,
  ActorRuntimeError,
  createActorClassExecution,
  createActorContext,
  createActorTurn,
  inspectActorClass,
} from "../src/actor-class-execution.ts";

const signal = new AbortController().signal;

function context(sockets: Record<string, unknown> = {}): ReturnType<typeof createActorContext> {
  return createActorContext({ id: "actor-1", storage: {}, alarm: {}, sockets });
}

function turn(): ReturnType<typeof createActorTurn> {
  return createActorTurn(signal);
}

function requiredMethods(base: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fetch() {
      return new Response("ok");
    },
    alarm() {},
    socketMessage() {},
    socketClose() {},
    socketError() {},
    ...base,
  };
}

function completePrototype(Actor: { readonly prototype: object }): void {
  const methods = requiredMethods();
  for (const name of ["fetch", "alarm", "socketMessage", "socketClose", "socketError"]) {
    if (Object.getOwnPropertyDescriptor(Actor.prototype, name) !== undefined) continue;
    Object.defineProperty(Actor.prototype, name, {
      value: methods[name],
      writable: true,
      configurable: true,
    });
  }
}

describe("private Actor ordinary-class execution seam", () => {
  test("accepts inherited prototype methods and uses one receiver for every handler", async () => {
    const receivers: unknown[] = [];
    const seen: Array<{ kind: string; args: unknown[] }> = [];
    const order: string[] = [];
    const base = {
      fetch(this: unknown, request: Request, receivedTurn: object) {
        receivers.push(this);
        seen.push({ kind: "fetch", args: [request, receivedTurn] });
        return new Response("ok");
      },
      alarm(this: unknown, receivedTurn: object) {
        receivers.push(this);
        seen.push({ kind: "alarm", args: [receivedTurn] });
      },
      socketMessage(
        this: unknown,
        socket: object,
        data: string | Uint8Array,
        receivedTurn: object,
      ) {
        receivers.push(this);
        seen.push({ kind: "socketMessage", args: [socket, data, receivedTurn] });
      },
      socketClose(this: unknown, socket: object, event: object, receivedTurn: object) {
        receivers.push(this);
        seen.push({ kind: "socketClose", args: [socket, event, receivedTurn] });
      },
      socketError(this: unknown, socket: object, event: object, receivedTurn: object) {
        receivers.push(this);
        seen.push({ kind: "socketError", args: [socket, event, receivedTurn] });
      },
    };
    class Actor {
      constructor(receivedContext: object, receivedEnv: object) {
        order.push("constructor");
        expect(Object.keys(receivedContext)).toEqual(["id", "storage", "alarm", "sockets"]);
        expect(receivedEnv).toEqual({ SELECTED: "yes" });
      }
      start(receivedTurn: object) {
        order.push("start");
        expect(receivedTurn).toBe(currentTurn);
      }
    }
    Object.setPrototypeOf(Actor.prototype, base);

    const execution = createActorClassExecution({
      namespace: { Actor },
      exportName: "Actor",
      env: { SELECTED: "yes" },
      context: context(),
    });
    const currentTurn = turn();
    const request = new Request("https://actor.invalid/");
    const socket = {};
    const closeEvent = { code: 1000, reason: "bye", wasClean: true };
    const errorEvent = { code: "transport_error" as const };

    expect(await execution.dispatch({ kind: "fetch", request }, currentTurn)).toBeInstanceOf(
      Response,
    );
    await execution.dispatch({ kind: "alarm" }, currentTurn);
    await execution.dispatch({ kind: "socketMessage", socket, data: "message" }, currentTurn);
    await execution.dispatch({ kind: "socketClose", socket, event: closeEvent }, currentTurn);
    await execution.dispatch({ kind: "socketError", socket, event: errorEvent }, currentTurn);

    expect(order).toEqual(["constructor", "start"]);
    expect(receivers).toHaveLength(5);
    expect(new Set(receivers).size).toBe(1);
    expect(seen[0]?.args).toEqual([request, currentTurn]);
    expect(seen[1]?.args).toEqual([currentTurn]);
    expect(seen[2]?.args).toEqual([socket, "message", currentTurn]);
    expect(seen[3]?.args).toEqual([socket, closeEvent, currentTurn]);
    expect(seen[4]?.args).toEqual([socket, errorEvent, currentTurn]);
  });

  test("refuses an accessor handler without invoking its getter", () => {
    let getterCalls = 0;
    class Actor {
      get fetch(): () => Response {
        getterCalls += 1;
        return () => new Response("unexpected");
      }
    }
    completePrototype(Actor);
    expect(() => inspectActorClass({ Actor }, "Actor")).toThrow(ActorRuntimeError);
    expect(getterCalls).toBe(0);
  });

  test("inspection never invokes a constructor", () => {
    let constructions = 0;
    class Actor {
      constructor() {
        constructions += 1;
      }
    }
    completePrototype(Actor);
    const inspection = inspectActorClass({ Actor }, "Actor");
    expect(inspection.exportName).toBe("Actor");
    expect(constructions).toBe(0);
  });

  test("constructability probe remains a static inert source invariant", () => {
    const source = readFileSync(
      new URL("../src/actor-class-execution.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("function inertConstructTarget()");
    expect(source).toContain("SafeReflectConstruct(inertConstructTarget, [], exported)");
    expect(source).not.toMatch(/(?:const|let|var)\s+\w+\s*=\s*Function\b/);
    expect(source).not.toMatch(/Reflect\.construct\(\s*Function\b/);
  });

  test("rejects per-instance handler replacement with a redacted HTTP 500", async () => {
    let replacementCalled = false;
    class Actor {
      constructor() {
        Object.defineProperty(this, "fetch", {
          value: () => {
            replacementCalled = true;
            return new Response("replacement");
          },
        });
      }
    }
    completePrototype(Actor);
    const execution = createActorClassExecution({
      namespace: { Actor },
      exportName: "Actor",
      env: {},
      context: context(),
    });
    const result = await execution.dispatch(
      { kind: "fetch", request: new Request("https://actor.invalid/") },
      turn(),
    );
    expect(result?.status).toBe(500);
    expect(await result?.text()).not.toContain("replacement");
    expect(replacementCalled).toBe(false);
  });

  test("constructs synchronously, awaits start, then delivers fetch", async () => {
    const order: string[] = [];
    let releaseStart!: () => void;
    const startFinished = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    class Actor {
      constructor() {
        order.push("constructor");
      }
      async start() {
        order.push("start-called");
        await startFinished;
        order.push("start-finished");
      }
      fetch() {
        order.push("fetch");
        return new Response("ok");
      }
    }
    completePrototype(Actor);
    const execution = createActorClassExecution({
      namespace: { Actor },
      exportName: "Actor",
      env: {},
      context: context(),
    });
    const pending = execution.dispatch(
      { kind: "fetch", request: new Request("https://actor.invalid/") },
      turn(),
    );
    expect(order).toEqual(["constructor", "start-called"]);
    releaseStart();
    await pending;
    expect(order).toEqual(["constructor", "start-called", "start-finished", "fetch"]);
  });

  test("explicit initialization runs constructor and start without dispatching an event", async () => {
    const order: string[] = [];
    class Actor {
      constructor() {
        order.push("constructor");
      }
      start() {
        order.push("start");
      }
      fetch() {
        order.push("fetch");
        return new Response("ok");
      }
    }
    completePrototype(Actor);
    const execution = createActorClassExecution({
      namespace: { Actor },
      exportName: "Actor",
      env: {},
      context: context(),
    });

    await execution.initialize(turn());

    expect(order).toEqual(["constructor", "start"]);
  });

  test("overlapping initialization and dispatch share one constructor/start promise", async () => {
    const order: string[] = [];
    let releaseStart!: () => void;
    const startFinished = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    class Actor {
      constructor() {
        order.push("constructor");
      }
      async start() {
        order.push("start-called");
        await startFinished;
        order.push("start-finished");
      }
      fetch() {
        order.push("fetch");
        return new Response("ok");
      }
    }
    completePrototype(Actor);
    const execution = createActorClassExecution({
      namespace: { Actor },
      exportName: "Actor",
      env: {},
      context: context(),
    });
    const currentTurn = turn();
    const initialization = execution.initialize(currentTurn);
    const dispatch = execution.dispatch(
      { kind: "fetch", request: new Request("https://actor.invalid/") },
      currentTurn,
    );

    expect(order).toEqual(["constructor", "start-called"]);
    releaseStart();
    await initialization;
    expect((await dispatch)?.status).toBe(200);
    expect(order).toEqual(["constructor", "start-called", "start-finished", "fetch"]);
  });

  test("initialization failure is sticky, and dispatch still redacts HTTP failures", async () => {
    const failure = new Error("start secret");
    let starts = 0;
    class Actor {
      start() {
        starts += 1;
        throw failure;
      }
    }
    completePrototype(Actor);
    const execution = createActorClassExecution({
      namespace: { Actor },
      exportName: "Actor",
      env: {},
      context: context(),
    });
    const currentTurn = turn();

    await expect(execution.initialize(currentTurn)).rejects.toBe(failure);
    await expect(execution.initialize(currentTurn)).rejects.toBe(failure);
    const result = await execution.dispatch(
      { kind: "fetch", request: new Request("https://actor.invalid/") },
      currentTurn,
    );

    expect(result?.status).toBe(500);
    expect(await result?.text()).not.toContain("secret");
    expect(starts).toBe(1);
  });

  test("explicit initialization does not require or invoke an optional start hook", async () => {
    let fetches = 0;
    class Actor {
      fetch() {
        fetches += 1;
        return new Response("ok");
      }
    }
    completePrototype(Actor);
    const execution = createActorClassExecution({
      namespace: { Actor },
      exportName: "Actor",
      env: {},
      context: context(),
    });

    await execution.initialize(turn());
    await execution.initialize(turn());
    expect(fetches).toBe(0);
    expect(
      (
        await execution.dispatch(
          { kind: "fetch", request: new Request("https://actor.invalid/") },
          turn(),
        )
      )?.status,
    ).toBe(200);
    expect(fetches).toBe(1);
  });

  test("optional start is not required or called when absent", async () => {
    let calls = 0;
    class Actor {}
    Object.defineProperty(Actor.prototype, "fetch", {
      value() {
        calls += 1;
        return new Response("ok");
      },
      writable: true,
      configurable: true,
    });
    completePrototype(Actor);
    const execution = createActorClassExecution({
      namespace: { Actor },
      exportName: "Actor",
      env: {},
      context: context(),
    });
    expect(
      (
        await execution.dispatch(
          { kind: "fetch", request: new Request("https://actor.invalid/") },
          turn(),
        )
      )?.status,
    ).toBe(200);
    expect(calls).toBe(1);
  });

  test("a new execution context starts again after eviction", async () => {
    let starts = 0;
    class Actor {
      start() {
        starts += 1;
      }
    }
    completePrototype(Actor);
    const options = {
      namespace: { Actor },
      exportName: "Actor",
      env: {},
      context: context(),
    } as const;
    const first = createActorClassExecution(options);
    const second = createActorClassExecution(options);
    const request = new Request("https://actor.invalid/");
    await first.dispatch({ kind: "fetch", request }, turn());
    await second.dispatch({ kind: "fetch", request }, turn());
    expect(starts).toBe(2);
  });

  test("constructor, start, fetch and facades redact application failures for HTTP", async () => {
    let facadeCalls = 0;
    for (const Actor of [
      class {
        constructor() {
          throw new Error("constructor secret");
        }
      },
      class {
        start() {
          throw new Error("start secret");
        }
      },
      class {
        fetch() {
          throw new Error("fetch secret");
        }
      },
      class {
        constructor(receivedContext: object) {
          const supplied = (receivedContext as { sockets: { accept(): Response } }).sockets;
          Object.defineProperty(this, "sockets", { value: supplied });
        }
        fetch() {
          return (this as unknown as { sockets: { accept(): Response } }).sockets.accept();
        }
      },
    ]) {
      completePrototype(Actor);
      const sockets = {
        accept() {
          facadeCalls += 1;
          throw new Error("facade secret");
        },
      };
      const execution = createActorClassExecution({
        namespace: { Actor },
        exportName: "Actor",
        env: {},
        context: context(sockets),
      });
      const result = await execution.dispatch(
        { kind: "fetch", request: new Request("https://actor.invalid/") },
        turn(),
      );
      expect(result?.status).toBe(500);
      expect(await result?.text()).not.toContain("secret");
    }
    expect(facadeCalls).toBe(1);
  });

  test("missing or invalid class fails before execution as backend_unavailable", () => {
    expect(() => inspectActorClass({}, "Actor")).toThrowError(
      expect.objectContaining({ name: "backend_unavailable", code: "backend_unavailable" }),
    );
    class Actor {}
    completePrototype(Actor);
    expect(() => inspectActorClass({ Other: Actor }, "Actor")).toThrowError(
      expect.objectContaining({ name: "backend_unavailable", code: "backend_unavailable" }),
    );
  });

  test("non-HTTP handler failures remain typed failures for the caller", async () => {
    const failure = new Error("alarm secret");
    class Actor {
      alarm() {
        throw failure;
      }
    }
    completePrototype(Actor);
    const execution = createActorClassExecution({
      namespace: { Actor },
      exportName: "Actor",
      env: {},
      context: context(),
    });
    await expect(execution.dispatch({ kind: "alarm" }, turn())).rejects.toBe(failure);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(Response);
  });

  test("passes through an injected socket facade Response unchanged", async () => {
    const opaqueResponse = new Response("opaque", { status: 299 });
    const socket = {};
    const sockets = {
      accept() {
        return { response: opaqueResponse, socket };
      },
    };
    class Actor {
      private readonly sockets = sockets;
      fetch() {
        const accepted = (this as unknown as { sockets: typeof sockets }).sockets.accept();
        return accepted.response;
      }
    }
    completePrototype(Actor);
    const execution = createActorClassExecution({
      namespace: { Actor },
      exportName: "Actor",
      env: {},
      context: context(sockets),
    });
    const result = await execution.dispatch(
      { kind: "fetch", request: new Request("https://actor.invalid/") },
      turn(),
    );
    expect(result).toBe(opaqueResponse);
    expect(await result?.text()).toBe("opaque");
  });

  test("context and turn are closed Host-created values", () => {
    const actorContext = context();
    const actorTurn = turn();
    expect(Object.keys(actorContext)).toEqual(["id", "storage", "alarm", "sockets"]);
    expect(Object.isFrozen(actorContext)).toBe(true);
    expect(Object.keys(actorTurn)).toEqual(["signal"]);
    expect(Object.isFrozen(actorTurn)).toBe(true);
    expect(() => Object.defineProperty(actorContext, "binding", { value: {} })).toThrow();
    expect(() => Object.defineProperty(actorTurn, "native", { value: {} })).toThrow();
  });

  test("rejects a malformed turn before constructing the actor", async () => {
    let constructions = 0;
    class Actor {
      constructor() {
        constructions += 1;
      }
    }
    completePrototype(Actor);
    const execution = createActorClassExecution({
      namespace: { Actor },
      exportName: "Actor",
      env: {},
      context: context(),
    });
    await expect(
      execution.dispatch({ kind: "fetch", request: new Request("https://actor.invalid/") }, {
        signal: {},
      } as never),
    ).rejects.toMatchObject({ name: "backend_unavailable", code: "backend_unavailable" });
    expect(constructions).toBe(0);
  });

  test("primitive non-HTTP failures are wrapped as ActorExecutionError", async () => {
    class Actor {
      alarm() {
        throw "not-an-error";
      }
    }
    completePrototype(Actor);
    const execution = createActorClassExecution({
      namespace: { Actor },
      exportName: "Actor",
      env: {},
      context: context(),
    });
    await expect(execution.dispatch({ kind: "alarm" }, turn())).rejects.toBeInstanceOf(
      ActorExecutionError,
    );
  });
});
