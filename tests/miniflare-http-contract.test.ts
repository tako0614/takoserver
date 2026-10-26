import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { Miniflare } from "miniflare";
import { fetch } from "undici";
import { miniflareHttpThreadStarts } from "./preload-miniflare-http.ts";

test("Miniflare HTTP preserves the original URL, CF override and redirects", async () => {
  const mf = new Miniflare({
    cf: false,
    workers: [
      {
        config: {
          name: "http-contract",
          type: "worker",
          compatibilityDate: "2026-08-17",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: `export default {
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/throw") throw new Error("http contract sentinel");
        if (url.pathname === "/redirect") return Response.redirect(new URL("/final?q=kept", url), 302);
        return Response.json({ url: request.url, country: request.cf?.country });
      }
    };`,
              },
            },
          },
        },
      },
    ],
  });
  try {
    const response = await mf.dispatchFetch("https://original.example/redirect", {
      cf: { country: "JP" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: "https://original.example/final?q=kept",
      country: "JP",
    });
    const failure = await mf.dispatchFetch("https://original.example/throw");
    expect(failure.status).toBe(500);
    expect(failure.headers.get("content-type")).toStartWith("text/plain");
    expect(await failure.text()).toContain("http contract sentinel");
  } finally {
    await mf.dispose();
  }
}, 60_000);

test("Miniflare HTTP preload closes connections without replacing the Undici dispatcher", async () => {
  const requests: { connection: string | undefined; port: number | undefined }[] = [];
  const server = createServer((request, response) => {
    requests.push({ connection: request.headers.connection, port: request.socket.remotePort });
    response.end("actual HTTP response");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing loopback listener");
    const url = `http://127.0.0.1:${address.port}/`;
    for (let i = 0; i < 2; i++)
      expect(await (await fetch(url)).text()).toBe("actual HTTP response");
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.connection)).toEqual(["close", "close"]);
    expect(requests[0]?.port).toBeNumber();
    expect(requests[1]?.port).toBeNumber();
    expect(requests[0]?.port).not.toBe(requests[1]?.port);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("Miniflare synchronous HTTP threads load the installed Undici dispatcher", async () => {
  const requests: { connection: string | undefined; port: number | undefined; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      requests.push({
        connection: request.headers.connection,
        port: request.socket.remotePort,
        body,
      });
      response.end("actual threaded HTTP response");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing loopback listener");
  // Match the actual SDK's eval Worker and owning filename resolution. The
  // main test realm's module mock alone cannot reach this separate registry.
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     const actualRequire = require("node:module").createRequire(workerData.filename);
     const { Pool, fetch } = actualRequire("undici");
     (async () => {
       const pool = new Pool(new URL(workerData.url).origin, { headersTimeout: 0, bodyTimeout: 0 });
       const dispatch = pool.dispatch?.bind(pool);
       let dispatches = 0;
       if (dispatch) pool.dispatch = (options, handler) => { dispatches++; return dispatch(options, handler); };
       try {
         const bodies = [];
         for (let i = 0; i < 2; i++) bodies.push(await (await fetch(workerData.url, { method: "POST", body: "retained threaded request", dispatcher: pool })).text());
         parentPort.postMessage({ dispatch: typeof Pool.prototype.dispatch, dispatches, bodies });
       } catch (error) { parentPort.postMessage({ error: String(error) }); }
       finally { await pool.close?.(); }
     })();`,
    {
      eval: true,
      workerData: {
        filename: createRequire(import.meta.url).resolve("miniflare"),
        url: `http://127.0.0.1:${address.port}/`,
      },
    },
  );
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    expect(result).toEqual({
      dispatch: "function",
      dispatches: 2,
      bodies: ["actual threaded HTTP response", "actual threaded HTTP response"],
    });
    expect(requests.map(({ connection, body }) => ({ connection, body }))).toEqual([
      { connection: "close", body: "retained threaded request" },
      { connection: "close", body: "retained threaded request" },
    ]);
    expect(requests[0]?.port).toBeNumber();
    expect(requests[1]?.port).toBeNumber();
    expect(requests[0]?.port).not.toBe(requests[1]?.port);
  } finally {
    await worker.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("the actual Miniflare D1 binding selects its synchronous HTTP thread preload", async () => {
  const before = miniflareHttpThreadStarts.length;
  const mf = new Miniflare({
    cf: false,
    workers: [
      {
        config: {
          name: "http-thread-binding-contract",
          type: "worker",
          compatibilityDate: "2026-08-17",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default {fetch(){return new Response('actual worker')}}",
              },
            },
          },
          env: { DB: { type: "d1", id: "http-thread-binding-contract" } },
        },
      },
    ],
  });
  try {
    const db = await mf.getD1Database("DB");
    await db.prepare("CREATE TABLE proof (value TEXT NOT NULL)").run();
    await db.prepare("INSERT INTO proof VALUES (?)").bind("actual D1 value").run();
    expect(await db.prepare("SELECT value FROM proof").first<{ value: string }>()).toEqual({
      value: "actual D1 value",
    });
    expect(miniflareHttpThreadStarts.slice(before)).toEqual([
      createRequire(import.meta.url).resolve("miniflare"),
    ]);
  } finally {
    await mf.dispose();
  }
}, 60_000);
