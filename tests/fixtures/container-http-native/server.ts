const revision = process.env.FIXTURE_REVISION ?? "A";
let healthy = process.env.FIXTURE_HEALTHY !== "false";
Bun.serve({
  hostname: "0.0.0.0",
  port: 8080,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response(null, { status: healthy ? 204 : 503 });
    if (url.pathname === "/healthy") {
      healthy = true;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/redirect")
      return new Response(null, { status: 302, headers: { location: "https://outside.invalid/" } });
    if (url.pathname === "/error") return new Response("application", { status: 503 });
    if (url.pathname === "/stream")
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(revision));
          },
        }),
        { headers: { "content-type": "text/plain" } },
      );
    if (url.pathname === "/egress") {
      try {
        await fetch("http://1.1.1.1/", { signal: AbortSignal.timeout(500) });
        return new Response("reachable");
      } catch {
        return new Response("blocked");
      }
    }
    return Response.json({
      revision,
      path: url.pathname + url.search,
      method: request.method,
      authorization: request.headers.get("authorization"),
      body: await request.text(),
    });
  },
});
