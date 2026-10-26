import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { Miniflare } from "miniflare";
import { fetch } from "undici";

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
