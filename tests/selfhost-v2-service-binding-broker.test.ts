import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSelfhostV2ServiceBindingBroker } from "../src/selfhost-v2-service-binding-broker.ts";
import type { V2ServiceBindingClaim } from "../src/takoform-v2/service-binding-authority.ts";

const TOKEN = "ab".repeat(32);
const BROKER_TOKEN_HEADER = "x-takoserver-private-service-binding-token";
const ORIGINAL_URL_HEADER = "x-takoserver-private-service-original-url";
const ORIGINAL_URL = "https://catalog.example/items/one?view=full";
const UNAVAILABLE_HEADER = "x-takoserver-selfhost-service-unavailable";

const claim: V2ServiceBindingClaim = Object.freeze({
  principal: "principal-fixture",
  space: "space-fixture",
  targetKey: "target-fixture",
  workerUid: "worker-caller-fixture",
  workerVersionUid: "worker-version-fixture",
  workerVersionOperationId: "9cd7b935-e504-45b8-9388-618b00f4218a",
  nativeVersionId: "v2-caller-native-fixture",
  incarnationId: "9cd7b935-e504-45b8-9388-618b00f4218a",
  servingSourceOperationId: "9cd7b935-e504-45b8-9388-618b00f4218a",
  bindings: Object.freeze([
    Object.freeze({ name: "CATALOG", resourceUid: "worker-target-fixture" }),
  ]),
});

interface BrokerResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Uint8Array;
}

function requestBroker(
  socketPath: string,
  options: {
    readonly method?: string;
    readonly path?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
  } = {},
): Promise<BrokerResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        socketPath,
        method: options.method ?? "GET",
        path: options.path ?? "/items/one?view=full",
        headers: {
          [BROKER_TOKEN_HEADER]: TOKEN,
          [ORIGINAL_URL_HEADER]: ORIGINAL_URL,
          host: "catalog.example",
          ...options.headers,
        },
      },
      (incoming) => {
        const chunks: Uint8Array[] = [];
        incoming.on("data", (chunk: Uint8Array) => chunks.push(new Uint8Array(chunk)));
        incoming.on("error", reject);
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

async function brokerFixture(
  input: {
    readonly resolve?: boolean;
    readonly stillCurrent?: boolean;
    readonly dispatch?: (
      request: Request,
    ) => { kind: "not_dispatched" } | { kind: "dispatched"; response: Promise<Response> };
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "takoserver-v2-service-binding-"));
  await chmod(root, 0o700);
  const socketPath = join(root, "service.sock");
  let acquired = 0;
  let released = 0;
  let dispatches = 0;
  let targetRequest: Request | undefined;
  let targetBody: Promise<string> | undefined;
  const broker = await openSelfhostV2ServiceBindingBroker({
    socketPath,
    routerToken: TOKEN,
    originalUrlHeader: ORIGINAL_URL_HEADER,
    claim,
    bindingName: "CATALOG",
    authority: {
      async resolveCurrentBinding() {
        if (input.resolve === false) return null;
        return {
          identity: {
            targetKey: claim.targetKey,
            principal: claim.principal,
            space: claim.space,
            resourceUid: "worker-target-fixture",
          },
          vector: "fixture-vector",
          async stillCurrent() {
            return input.stillCurrent !== false;
          },
        };
      },
    },
    async acquireCallerLease(received) {
      expect(received).toEqual(claim);
      acquired += 1;
      return {
        async stillCurrent() {
          return input.stillCurrent !== false;
        },
        async release() {
          released += 1;
        },
      };
    },
    async ownerForResourceUid(resourceUid) {
      if (resourceUid !== "worker-target-fixture") return null;
      return {
        workerResourceUid: resourceUid,
        dispatchServiceBinding(request) {
          dispatches += 1;
          targetRequest = request;
          targetBody = request.text();
          return (
            input.dispatch?.(request) ?? {
              kind: "dispatched",
              response: targetBody.then(() => new Response("target-response", { status: 202 })),
            }
          );
        },
      };
    },
  });
  return {
    root,
    broker,
    socketPath,
    get acquired() {
      return acquired;
    },
    get released() {
      return released;
    },
    get dispatches() {
      return dispatches;
    },
    get targetRequest() {
      return targetRequest;
    },
    get targetBody() {
      return targetBody;
    },
    async cleanup() {
      await broker.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("v2 ServiceBinding bridge authenticates, strips its private token, and streams the response", async () => {
  const fixture = await brokerFixture();
  try {
    const result = await requestBroker(fixture.socketPath, {
      method: "POST",
      headers: { "content-type": "text/plain", authorization: "Bearer tenant-request-value" },
      body: "request-body",
    });
    expect(result.status).toBe(202);
    expect(new TextDecoder().decode(result.body)).toBe("target-response");
    expect(fixture.dispatches).toBe(1);
    expect(fixture.acquired).toBe(1);
    expect(fixture.released).toBe(1);
    expect(fixture.targetRequest?.url).toBe("https://catalog.example/items/one?view=full");
    expect(fixture.targetRequest?.headers.get(BROKER_TOKEN_HEADER)).toBeNull();
    expect(fixture.targetRequest?.headers.get(ORIGINAL_URL_HEADER)).toBeNull();
    expect(fixture.targetRequest?.headers.get("authorization")).toBe("Bearer tenant-request-value");
    expect(await fixture.targetBody).toBe("request-body");
  } finally {
    await fixture.cleanup();
  }
});

test("v2 ServiceBinding broker rejects forged or inconsistent original URL metadata before dispatch", async () => {
  const fixture = await brokerFixture();
  try {
    const forged = await requestBroker(fixture.socketPath, {
      headers: { [ORIGINAL_URL_HEADER]: "https://catalog.example/forged?view=full" },
    });
    expect(forged.status).toBe(400);
    expect(fixture.dispatches).toBe(0);

    const wrongAuthority = await requestBroker(fixture.socketPath, {
      headers: { host: "foreign.example" },
    });
    expect(wrongAuthority.status).toBe(400);
    expect(fixture.dispatches).toBe(0);

    const missing = await requestBroker(fixture.socketPath, {
      headers: { [ORIGINAL_URL_HEADER]: "" },
    });
    expect(missing.status).toBe(404);
    expect(fixture.dispatches).toBe(0);
  } finally {
    await fixture.cleanup();
  }
});

test("v2 ServiceBinding bridge returns only pre-dispatch unavailability as its private signal", async () => {
  const denied = await brokerFixture({ resolve: false });
  try {
    const result = await requestBroker(denied.socketPath);
    expect(result.status).toBe(530);
    expect(result.headers[UNAVAILABLE_HEADER]).toBe(TOKEN);
    expect(denied.dispatches).toBe(0);
    expect(denied.released).toBe(1);
  } finally {
    await denied.cleanup();
  }

  const lostAck = await brokerFixture({
    dispatch: () => ({ kind: "dispatched", response: Promise.reject(new Error("transport lost")) }),
  });
  try {
    const result = await requestBroker(lostAck.socketPath);
    expect(result.status).toBe(500);
    expect(result.headers[UNAVAILABLE_HEADER]).toBeUndefined();
    expect(lostAck.dispatches).toBe(1);
    expect(lostAck.released).toBe(1);
  } finally {
    await lostAck.cleanup();
  }
});

test("v2 ServiceBinding bridge keeps the caller lease until the streamed response is drained", async () => {
  let finish!: () => void;
  let dispatchStarted!: () => void;
  const bodyDone = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const dispatched = new Promise<void>((resolve) => {
    dispatchStarted = resolve;
  });
  const fixture = await brokerFixture({
    dispatch: () => {
      dispatchStarted();
      return {
        kind: "dispatched",
        response: Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("first"));
              },
              async pull(controller) {
                await bodyDone;
                controller.enqueue(new TextEncoder().encode("last"));
                controller.close();
              },
            }),
          ),
        ),
      };
    },
  });
  try {
    const responsePromise = requestBroker(fixture.socketPath);
    await dispatched;
    expect(fixture.released).toBe(0);
    finish();
    const result = await responsePromise;
    expect(new TextDecoder().decode(result.body)).toBe("firstlast");
    expect(fixture.released).toBe(1);
  } finally {
    finish();
    await fixture.cleanup();
  }
});
