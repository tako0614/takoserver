import { expect, test } from "bun:test";
import { CONTAINER_CONTRACT as C } from "../src/container-contract.ts";
import { ContainerError, forwardContainerHttp } from "../src/container-http.ts";
import { createSelfhostContainerBindingBroker } from "../src/providers/selfhost-container-binding-broker.ts";
import {
  makeContainerBinding,
  selfhostContainerBindingClientSource,
} from "../src/providers/selfhost-container-binding-client.ts";
import {
  parseContainerWorkerVersionSpec,
  referencesForContainerWorkerVersion,
} from "../src/takoform-v2/forms/worker-container-specs.ts";
import { parseWorkerVersionSpec } from "../src/takoform-v2/forms/worker-specs.ts";

const F = C.fields;
const claim = {
  principal: "alice",
  space: "default",
  workerVersionUid: "version-one",
  operationId: "operation-one",
  bindingName: "APP",
  targetUid: "container-one",
};

test("successor binding parser pins UIDs, rejects collisions, and leaves frozen parser closed", () => {
  const spec = {
    worker: { resourceUid: "worker-one" },
    bundle: { resourceUid: "bundle-one" },
    handlers: ["fetch"],
    [F.containerBindings]: [
      { [F.name]: "APP", [F.resource]: { [F.resourceUid]: "container-one" } },
    ],
  };
  const parsed = parseContainerWorkerVersionSpec(spec);
  expect(referencesForContainerWorkerVersion(parsed)).toContainEqual({
    resourceUid: "container-one",
    formUrl: C.formUrl,
    readiness: "observed",
  });
  expect(() => parseWorkerVersionSpec(spec)).toThrow();
  expect(() => parseContainerWorkerVersionSpec({ ...spec, vars: { APP: true } })).toThrow();
  expect(() => parseContainerWorkerVersionSpec({ ...spec, [F.containerBindings]: null })).toThrow();
  expect(() =>
    parseContainerWorkerVersionSpec({
      ...spec,
      [F.containerBindings]: [...spec[F.containerBindings], ...spec[F.containerBindings]],
    }),
  ).toThrow();
  expect(C.supported).toBe(false);
});

test("private broker/client passes application status, headers, stream and pinned authority", async () => {
  const broker = createSelfhostContainerBindingBroker({
    claim,
    resolve: async (input) => {
      expect(input).toEqual(claim);
      return { resourceUid: input.targetUid, incarnationId: "host-one" };
    },
    runtime: {
      async fetch(identity, request) {
        expect(identity.resourceUid).toBe(claim.targetUid);
        return forwardContainerHttp(request, "http://127.0.0.1:8080", async (forwarded) => {
          expect(forwarded.url).toBe("http://127.0.0.1:8080/echo?q=1");
          expect(forwarded.headers.get("authorization")).toBe("application");
          expect(await forwarded.text()).toBe("input");
          return new Response("output", {
            status: 401,
            headers: [
              ["set-cookie", "a=1"],
              ["set-cookie", "b=2"],
            ],
          });
        });
      },
    },
  });
  const client = makeContainerBinding({ fetch: broker });
  expect(Object.keys(client)).toEqual(["fetch"]);
  const response = await client.fetch(
    new Request("https://ignored.example/echo?q=1", {
      method: "POST",
      headers: { authorization: "application" },
      body: "input",
    }),
  );
  expect(response.status).toBe(401);
  expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  expect(await response.text()).toBe("output");
});

test("broker refuses revoked claims without delivery and carries payload-free failure", async () => {
  let calls = 0;
  const broker = createSelfhostContainerBindingBroker({
    claim,
    resolve: async () => null,
    runtime: {
      async fetch() {
        calls++;
        return new Response();
      },
    },
  });
  await expect(
    makeContainerBinding({ fetch: broker }).fetch(new Request("http://a/")),
  ).rejects.toMatchObject({ name: C.errorName, code: C.errors.backendUnavailable });
  expect(calls).toBe(0);
});

test("post-head errors cross private framing with original error code", async () => {
  const broker = createSelfhostContainerBindingBroker({
    claim,
    resolve: async () => ({ resourceUid: claim.targetUid, incarnationId: "host-one" }),
    runtime: {
      async fetch() {
        return new Response(
          new ReadableStream(
            {
              pull(controller) {
                controller.error(new ContainerError(C.errors.responseTooLarge));
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 202 },
        );
      },
    },
  });
  const response = await makeContainerBinding({ fetch: broker }).fetch(new Request("http://a/"));
  expect(response.status).toBe(202);
  await expect(response.text()).rejects.toMatchObject({ code: C.errors.responseTooLarge });
});

test("emitted Host-private source executes without imports or leaked helpers", async () => {
  const source = selfhostContainerBindingClientSource();
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
  expect(typeof module.makeContainerBinding).toBe("function");
  expect(Object.keys(module)).toEqual(["makeContainerBinding"]);
});

test("cancel before the response head remains a request abort through native failures", async () => {
  const abort = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const broker = createSelfhostContainerBindingBroker({
    claim,
    resolve: async () => ({ resourceUid: claim.targetUid, incarnationId: "host-one" }),
    runtime: {
      async fetch(_identity, request) {
        entered();
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("private native failure");
      },
    },
  });
  const response = makeContainerBinding({ fetch: broker }).fetch(
    new Request("http://a/", { signal: abort.signal }),
  );
  await started;
  abort.abort();
  await expect(response).rejects.toMatchObject({ code: C.errors.requestAborted });
});

test("real binding keeps caller cancellation after the response head as request_aborted", async () => {
  const caller = new AbortController();
  let dispatches = 0;
  let reads = 0;
  let sourceCancels = 0;
  let transportAborts = 0;
  const binding = makeContainerBinding({
    async fetch(request) {
      dispatches++;
      request.signal.addEventListener("abort", () => transportAborts++);
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull() {
              reads++;
            },
            cancel() {
              sourceCancels++;
            },
          },
          { highWaterMark: 0 },
        ),
        {
          headers: {
            "x-takoserver-container-result": JSON.stringify({ status: 202, headers: [] }),
          },
        },
      );
    },
  });
  const response = await binding.fetch(new Request("http://a/", { signal: caller.signal }));
  expect(response.status).toBe(202);
  expect(reads).toBe(0);
  const pending = response.text();
  caller.abort();
  await expect(pending).rejects.toMatchObject({
    name: C.errorName,
    code: C.errors.requestAborted,
  });
  expect(response.status).toBe(202);
  expect(dispatches).toBe(1);
  expect(sourceCancels).toBe(1);
  expect(transportAborts).toBe(1);
});
