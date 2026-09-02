import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createEphemeralSql } from "../src/compat.ts";
import type { ControlRoutes } from "../src/control.ts";
import {
  SELFHOST_WORKER_DATA_PLANE_BINDING,
  selfhostDataServiceSource,
} from "../src/providers/selfhost-data-service.ts";
import {
  SELFHOST_DATA_PLANE_KV_PATH,
  SELFHOST_DATA_PLANE_ORIGIN,
  SELFHOST_DATA_PLANE_PROTOCOL,
  SELFHOST_DATA_PLANE_SQL_PATH,
  SELFHOST_WORKER_DATA_TOKEN_BINDING,
} from "../src/providers/selfhost-worker-wrapper.ts";
import { createRouter } from "../src/router.ts";
import { serveSelfhostDataPlanes } from "../src/selfhost-data-planes.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";

/**
 * Where the data planes are, and what a leaked binding to them can reach.
 *
 * Two claims are under test and neither is about the facade's behaviour for a
 * well-behaved caller. The first is that the planes are not on the origin this
 * Host publishes: their bearer token is minted per Worker Version and a route
 * on the public listener would make it an internet-facing credential for
 * arbitrary SQL. The second is that the service binding a tenant's isolate
 * holds — the one thing that survives every projection, because workerd gives
 * a service's bindings to everything that service runs — addresses a facade
 * that rewrites the request completely, so holding it buys two routes rather
 * than a way into the control API.
 */

const TOKEN = "sw1.v1.plane-secret-value-0";

let root: string | undefined;
let served: ReturnType<typeof serveSelfhostDataPlanes> | undefined;

afterEach(() => {
  served?.stop(true);
  served = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

interface Forwarded {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly headers: readonly string[];
  readonly body: string;
}

/** Loads the generated facade as a real module, with a plane it can watch. */
async function facade(answer = { ok: true, value: {} }): Promise<{
  readonly fetch: (request: Request, env: Record<string, unknown>) => Promise<Response>;
  readonly env: Record<string, unknown>;
  readonly forwarded: Forwarded[];
}> {
  root = mkdtempSync(join(tmpdir(), "takoserver-facade-"));
  const path = join(root, "facade.mjs");
  await Bun.write(path, selfhostDataServiceSource());
  const loaded = (await import(`${pathToFileURL(path).href}?test=${crypto.randomUUID()}`)) as {
    readonly default: {
      fetch: (request: Request, env: Record<string, unknown>) => Promise<Response>;
    };
  };
  const forwarded: Forwarded[] = [];
  return {
    fetch: loaded.default.fetch,
    forwarded,
    env: {
      [SELFHOST_WORKER_DATA_TOKEN_BINDING]: TOKEN,
      [SELFHOST_WORKER_DATA_PLANE_BINDING]: {
        async fetch(url: string, init: RequestInit) {
          const headers = init.headers as Record<string, string>;
          forwarded.push({
            url,
            method: String(init.method),
            authorization: headers.authorization ?? null,
            headers: Object.keys(headers).sort(),
            body: new TextDecoder().decode(init.body as ArrayBuffer),
          });
          return new Response(JSON.stringify(answer), {
            status: 200,
            headers: { "content-type": "application/json", "x-plane-detail": "never forwarded" },
          });
        },
      },
    },
  };
}

const call = (path: string, init: RequestInit = {}) =>
  new Request(`${SELFHOST_DATA_PLANE_ORIGIN}${path}`, {
    method: "POST",
    body: JSON.stringify({ protocol: SELFHOST_DATA_PLANE_PROTOCOL, binding: "DB", op: "execute" }),
    ...init,
  });

test("the facade forwards to the two plane routes and presents the token itself", async () => {
  const { fetch: served_, env, forwarded } = await facade();
  expect((await served_(call(SELFHOST_DATA_PLANE_KV_PATH), env)).status).toBe(200);
  expect((await served_(call(SELFHOST_DATA_PLANE_SQL_PATH), env)).status).toBe(200);
  expect(forwarded.map((entry) => entry.url)).toEqual([
    `${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_KV_PATH}`,
    `${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_SQL_PATH}`,
  ]);
  expect(forwarded[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  expect(forwarded[0]?.headers).toEqual(["authorization", "content-type"]);
  expect(forwarded[0]?.method).toBe("POST");
});

test("a leaked service binding reaches nothing but those two routes", async () => {
  const { fetch: served_, env, forwarded } = await facade();
  for (const path of [
    "/v1/organizations",
    "/provision/v1",
    "/",
    `${SELFHOST_DATA_PLANE_SQL_PATH}/`,
    `${SELFHOST_DATA_PLANE_SQL_PATH}?x=1#y`.split("?")[0] + "x",
    "/.well-known/takoserver/selfhost-data/v1/../../../v1/organizations",
  ]) {
    const response = await served_(call(path), env);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "backend_unavailable" },
    });
  }
  // Not one of them became a request to anything.
  expect(forwarded).toEqual([]);
});

test("the facade decides the destination, whatever the caller wrote on the request", async () => {
  const { fetch: served_, env, forwarded } = await facade();
  await served_(
    new Request(`http://control.internal${SELFHOST_DATA_PLANE_SQL_PATH}?target=/v1/organizations`, {
      method: "POST",
      headers: { authorization: "Bearer attacker-chosen", "x-forwarded-host": "elsewhere" },
      body: "{}",
    }),
    env,
  );
  expect(forwarded[0]?.url).toBe(`${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_SQL_PATH}`);
  // The caller's own authorization header is replaced, never merged.
  expect(forwarded[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  expect(forwarded[0]?.headers).toEqual(["authorization", "content-type"]);
});

test("a method other than POST is not a facade request", async () => {
  const { fetch: served_, env, forwarded } = await facade();
  for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
    const request = new Request(`${SELFHOST_DATA_PLANE_ORIGIN}${SELFHOST_DATA_PLANE_SQL_PATH}`, {
      method,
    });
    expect((await served_(request, env)).status).toBe(404);
  }
  expect(forwarded).toEqual([]);
});

test("nothing but the envelope comes back", async () => {
  const { fetch: served_, env } = await facade();
  const response = await served_(call(SELFHOST_DATA_PLANE_KV_PATH), env);
  expect(response.headers.get("x-plane-detail")).toBeNull();
  expect(response.headers.get("content-type")).toBe("application/json");
});

test("the facade refuses rather than calling without a token", async () => {
  const { fetch: served_, env, forwarded } = await facade();
  const response = await served_(call(SELFHOST_DATA_PLANE_SQL_PATH), {
    ...env,
    [SELFHOST_WORKER_DATA_TOKEN_BINDING]: undefined,
  });
  expect(response.status).toBe(503);
  expect(forwarded).toEqual([]);
});

// ---------------------------------------------------------------------------
// Where the planes are
// ---------------------------------------------------------------------------

test("the planes answer on their own loopback listener and never on the public one", async () => {
  root = mkdtempSync(join(tmpdir(), "takoserver-plane-listener-"));
  const databases = root;
  served = serveSelfhostDataPlanes({
    sql: createEphemeralSql(),
    grant: async (script, versionId) =>
      script === "sw1" && versionId === "v1"
        ? {
            secret: "plane-secret-value-0",
            kv: { KV: "tskv-1" },
            sql: { DB: "tsdb-1" },
            queue: {},
            objects: {},
          }
        : null,
    databasePath: (name) => join(databases, `${name}.sqlite`),
    objectRoot: join(databases, "objects"),
  });
  expect(served.address).toStartWith("127.0.0.1:");

  const body = JSON.stringify({
    protocol: SELFHOST_DATA_PLANE_PROTOCOL,
    binding: "DB",
    op: "execute",
    statement: { sql: "SELECT 1 AS one" },
  });
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };
  const onPlane = await fetch(`http://${served.address}${SELFHOST_DATA_PLANE_SQL_PATH}`, {
    method: "POST",
    headers,
    body,
  });
  expect(onPlane.status).toBe(200);
  expect(await onPlane.json()).toEqual({
    ok: true,
    value: { rows: [{ one: 1 }], rowsWritten: 0 },
  });

  // The same token, the same path, the public dispatch: nothing there claims
  // it, so it falls through to the honest 404 every unknown path gets.
  const control: ControlRoutes = async () => null;
  const publicRouter = createRouter({ control, publicOrigin: "https://api.example.test" });
  for (const path of [SELFHOST_DATA_PLANE_SQL_PATH, SELFHOST_DATA_PLANE_KV_PATH]) {
    const answered = await publicRouter(
      new Request(`https://api.example.test${path}`, { method: "POST", headers, body }),
    );
    expect(answered.status).toBe(404);
    expect(await answered.text()).not.toContain("rows");
  }

  // And a path the planes do not own is not theirs to answer either.
  const stray = await fetch(`http://${served.address}/v1/organizations`, { method: "POST" });
  expect(stray.status).toBe(404);
});

// ---------------------------------------------------------------------------
// Which addresses a generated externalServer may name
// ---------------------------------------------------------------------------

test("only a loopback address with a real port may be published", async () => {
  root = mkdtempSync(join(tmpdir(), "takoserver-plane-address-"));
  const runtime = createWorkerdRuntime({ root, isReady: () => true });
  const site = (address: string) => ({
    directory: "sw1",
    mainModule: "index.js",
    hostnames: [],
    dataPlane: { address, module: "__takoserver-selfhost-data.js", vars: [] },
  });
  const modules = new Map([["index.js", new TextEncoder().encode("export default {};")]]);
  for (const address of ["127.0.0.1:8787", "[::1]:1", "127.0.0.1:65535"]) {
    await runtime.write("sw1", site(address), modules);
  }
  for (const address of [
    // A name is a resolver answer, not an address: it may be `::1` where the
    // listener is on `127.0.0.1`, and on a machine whose hosts file somebody
    // edited it may be neither.
    "localhost:8787",
    "0.0.0.0:8787",
    "10.0.0.1:8787",
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "127.0.0.1:99999",
    "127.0.0.1",
    "127.0.0.1:8787 ",
    "example.com:8787",
  ]) {
    await expect(runtime.write("sw1", site(address), modules)).rejects.toThrow(
      "unusable data plane address",
    );
  }
});
