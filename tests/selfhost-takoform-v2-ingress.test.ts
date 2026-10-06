import { expect, test } from "bun:test";
import { createSelfhostTakoformV2Ingress } from "../src/selfhost-takoform-v2-ingress.ts";

const PUBLIC_ORIGIN = "https://api.example.test";

test("Bun self-host v2 ingress canonicalizes a matched TLS-terminated authority only", async () => {
  const seen: Request[] = [];
  const ingress = createSelfhostTakoformV2Ingress({
    publicOrigin: PUBLIC_ORIGIN,
    appFetch: async (request) => {
      seen.push(request);
      return new Response("reached-v2-app");
    },
  });

  const request = new Request("http://api.example.test/apis/forms.takoform.com/v2/resources?x=1", {
    method: "POST",
    headers: {
      host: "api.example.test",
      "content-type": "application/json",
      "x-forwarded-host": "attacker.example",
      forwarded: "host=attacker.example;proto=http",
    },
    body: JSON.stringify({ form: "https://forms.example.test/sqlite-migration-set/0.2.0" }),
  });

  const response = await ingress(request);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("reached-v2-app");
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("https://api.example.test/apis/forms.takoform.com/v2/resources?x=1");
  expect(seen[0]?.method).toBe("POST");
  expect(seen[0]?.headers.get("x-forwarded-host")).toBe("attacker.example");
  expect(await seen[0]?.text()).toBe(
    JSON.stringify({ form: "https://forms.example.test/sqlite-migration-set/0.2.0" }),
  );
});

test("a foreign v2 Host cannot use forwarded headers to reach the app", async () => {
  let appCalls = 0;
  const ingress = createSelfhostTakoformV2Ingress({
    publicOrigin: PUBLIC_ORIGIN,
    appFetch: async () => {
      appCalls += 1;
      return new Response("must-not-reach");
    },
  });

  const response = await ingress(
    new Request("http://attacker.example/apis/forms.takoform.com/v2/resources", {
      headers: {
        host: "attacker.example",
        "x-forwarded-host": "api.example.test",
        "x-forwarded-proto": "https",
        forwarded: "host=api.example.test;proto=https",
      },
    }),
  );

  expect(response.status).toBe(421);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(appCalls).toBe(0);
});

test("a matching Host header cannot override a different request URL authority", async () => {
  let appCalls = 0;
  const ingress = createSelfhostTakoformV2Ingress({
    publicOrigin: PUBLIC_ORIGIN,
    appFetch: async () => {
      appCalls += 1;
      return new Response("must-not-reach");
    },
  });

  const response = await ingress(
    new Request("http://other.example/apis/forms.takoform.com/v2/resources", {
      headers: { host: "api.example.test" },
    }),
  );

  expect(response.status).toBe(421);
  expect(appCalls).toBe(0);
});

test("non-v2 app paths retain their incoming request unchanged", async () => {
  let appRequest: Request | undefined;
  const ingress = createSelfhostTakoformV2Ingress({
    publicOrigin: PUBLIC_ORIGIN,
    appFetch: async (request) => {
      appRequest = request;
      return new Response("legacy-path");
    },
  });
  const request = new Request("http://other.example/health?check=1", {
    headers: { host: "other.example", "x-forwarded-host": "api.example.test" },
  });

  const response = await ingress(request);
  expect(await response.text()).toBe("legacy-path");
  expect(appRequest).toBe(request);
});

test("only exact v2 discovery and API family paths are canonicalized", async () => {
  const seen: string[] = [];
  const ingress = createSelfhostTakoformV2Ingress({
    publicOrigin: PUBLIC_ORIGIN,
    appFetch: async (request) => {
      seen.push(request.url);
      return new Response("ok");
    },
  });

  await ingress(
    new Request("http://api.example.test/.well-known/takoform/v2", {
      headers: { host: "api.example.test" },
    }),
  );
  await ingress(
    new Request("http://api.example.test/apis/forms.takoform.com/v20", {
      headers: { host: "api.example.test" },
    }),
  );
  expect(seen).toEqual([
    "https://api.example.test/.well-known/takoform/v2",
    "http://api.example.test/apis/forms.takoform.com/v20",
  ]);
});

test("canonicalization follows an abort signal from the incoming request", async () => {
  const controller = new AbortController();
  let downstreamSignal: AbortSignal | undefined;
  const ingress = createSelfhostTakoformV2Ingress({
    publicOrigin: PUBLIC_ORIGIN,
    appFetch: async (request) => {
      downstreamSignal = request.signal;
      return new Response("ok");
    },
  });

  await ingress(
    new Request("http://api.example.test/apis/forms.takoform.com/v2/resources", {
      headers: { host: "api.example.test" },
      signal: controller.signal,
    }),
  );
  controller.abort();

  expect(downstreamSignal?.aborted).toBe(true);
});

test("the ingress refuses a non-bare or non-HTTPS configured public origin", () => {
  for (const publicOrigin of ["http://api.example.test", "https://api.example.test/path"]) {
    expect(() =>
      createSelfhostTakoformV2Ingress({
        publicOrigin,
        appFetch: async () => new Response("unused"),
      }),
    ).toThrow();
  }
});
