import { DurableObject } from "cloudflare:workers";

export class Supervisor extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.child = undefined;
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS host_metadata (secret TEXT)");
  }
  async fetch(request) {
    // This is a bounded qualification fixture, NOT a production Actor
    // scheduler. Consuming Counter's small body below is fixture-specific.
    // Do not reuse it for general streaming applications or distributed leases.
    return this.ctx.blockConcurrencyWhile(async () => {
      const url = new URL(request.url);
      if (url.pathname === "/reconstruct") {
        this.ctx.facets.abort("actor", "fixture-reconstruction");
        this.child = undefined;
        return Response.json({ reconstructed: true });
      }
      this.child ??= this.ctx.facets.get("actor", () => ({
        class: this.env.CLASS,
        id: this.ctx.id.toString(),
      }));
      const response = await this.child.fetch(request);
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: response.headers,
      });
    });
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ready");
    // Real native namespace binding; application classes never receive it.
    return env.COUNTERS.get(env.COUNTERS.idFromName(url.searchParams.get("id") ?? "counter")).fetch(
      request,
    );
  },
};
