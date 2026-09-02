declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected readonly env: Env;
  }
  /**
   * Enough of the base class for the programs that type-check a Durable Object
   * without `@cloudflare/workers-types`. `ctx` is `never` here so a caller must
   * name the real state type it holds; the Worker programs use Cloudflare's own
   * declaration, which is the authority on the shape.
   */
  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: unknown;
    protected readonly env: Env;
    constructor(ctx: never, env: Env);
    fetch?(request: Request): Response | Promise<Response>;
  }
}
