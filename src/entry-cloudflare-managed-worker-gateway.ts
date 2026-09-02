import {
  createCloudflareManagedWorkerGateway,
  createD1ManagedWorkerGatewayState,
  type ManagedWorkerD1Database,
  type ManagedWorkerDispatchNamespace,
} from "./providers/cloudflare-managed-worker-gateway.ts";

export { TakoserverManagedWorkerSqlite } from "./providers/cloudflare-managed-worker-sqlite-object.ts";

/**
 * Bindings and non-secret identity selected by the owning deploy target.
 *
 * `TAKOSERVER_MANAGED_SQLITE_ADMIN_SECRET` is declared here because it belongs
 * to this Worker: it is read by the SQLite Durable Object this script exports,
 * which is handed this same environment, and never by the gateway's own
 * request paths. An operator provisions it out of band, with the same value the
 * provider composition seals admin calls with; until they do, the object
 * refuses every admin operation. A tenant's dispatched Worker never holds it.
 */
export interface ManagedWorkerGatewayWorkerEnv {
  readonly STATE_DB: ManagedWorkerD1Database;
  readonly DISPATCHER: ManagedWorkerDispatchNamespace;
  readonly MANAGED_PROVIDER_ID: string;
  readonly TAKOSERVER_MANAGED_WORKER_GATEWAY_ID?: string;
  readonly TAKOSERVER_ENVIRONMENT?: string;
  readonly TAKOSERVER_MANAGED_SQLITE_ADMIN_SECRET?: string;
}

const worker = {
  fetch(request: Request, env: ManagedWorkerGatewayWorkerEnv): Promise<Response> {
    return createGateway(env).fetch(request);
  },
  queue(
    batch: {
      readonly queue: string;
      readonly messages: readonly {
        readonly id: string;
        readonly timestamp: Date;
        readonly attempts: number;
        readonly body: unknown;
        ack(): void;
        retry(options?: { readonly delaySeconds?: number }): void;
      }[];
    },
    env: ManagedWorkerGatewayWorkerEnv,
  ): Promise<void> {
    // Cloudflare's native Queue batch has no portable correlation id.  Mint a
    // bounded opaque id for this delivery; message ids remain the retry
    // stickiness key used by the gateway's weighted selector.
    const batchId = crypto.randomUUID();
    return createGateway(env).queue({ ...batch, batchId });
  },
  scheduled(
    controller: { readonly cron: string; readonly scheduledTime: number },
    env: ManagedWorkerGatewayWorkerEnv,
  ): Promise<void> {
    return createGateway(env).scheduled(controller);
  },
};

export default worker;

function createGateway(env: ManagedWorkerGatewayWorkerEnv) {
  return createCloudflareManagedWorkerGateway({
    state: createD1ManagedWorkerGatewayState({
      database: env.STATE_DB,
      providerId: env.MANAGED_PROVIDER_ID,
    }),
    dispatcher: env.DISPATCHER,
    identity: {
      gatewayId: env.TAKOSERVER_MANAGED_WORKER_GATEWAY_ID ?? "unconfigured",
      environment: env.TAKOSERVER_ENVIRONMENT ?? "unconfigured",
    },
  });
}
