declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected readonly env: Env;
  }
}
