import { WorkerEntrypoint } from "cloudflare:workers";
import {
  createCloudflareManagedWorkerGateway,
  createD1ManagedWorkerGatewayState,
  type ManagedWorkerD1Database,
  type ManagedWorkerDispatchNamespace,
} from "./providers/cloudflare-managed-worker-gateway.ts";
import {
  type ManagedWorkerSqliteAuthority,
  managedWorkerSqliteAdminProof,
  managedWorkerSqliteInstanceName,
} from "./providers/cloudflare-managed-worker-sqlite.ts";
import type { CloudflareManagedWorkerGatewayAuthority } from "./providers/cloudflare-worker-backend.ts";

export { TakoserverManagedWorkerSqlite } from "./providers/cloudflare-managed-worker-sqlite-object.ts";

/**
 * Bindings and non-secret identity selected by the owning deploy target.
 *
 * This internet-routed dispatcher owns only its D1/dispatch/SQLite boundary.
 * Managed ObjectBucket receipt and S3 credentials belong to the separate
 * route-less receipt authority Worker and must never be bound here.
 */
export interface ManagedWorkerGatewayWorkerEnv {
  readonly STATE_DB: ManagedWorkerD1Database;
  readonly DISPATCHER: ManagedWorkerDispatchNamespace;
  readonly MANAGED_PROVIDER_ID: string;
  readonly TAKOSERVER_MANAGED_WORKER_GATEWAY_ID?: string;
  readonly TAKOSERVER_ENVIRONMENT?: string;
  readonly TAKOSERVER_MANAGED_SQLITE_ADMIN_SECRET?: string;
}

/** Provider-only SQLite HMAC operations; no default RPC method is exported. */
export class TakoserverManagedWorkerAuthority
  extends WorkerEntrypoint<ManagedWorkerGatewayWorkerEnv>
  implements CloudflareManagedWorkerGatewayAuthority
{
  async deriveSqliteInstanceName(input: {
    readonly providerId: string;
    readonly resourceUid: string;
    readonly generation: string;
  }): Promise<string> {
    this.assertProvider(input.providerId);
    return await managedWorkerSqliteInstanceName({
      ...input,
      instanceSecret: this.secret(),
    });
  }

  async sealSqliteAdminProof(input: {
    readonly operation: Parameters<typeof managedWorkerSqliteAdminProof>[0]["operation"];
    readonly authority: ManagedWorkerSqliteAuthority;
  }): Promise<string> {
    this.assertProvider(input.authority.providerId);
    return await managedWorkerSqliteAdminProof({ secret: this.secret(), ...input });
  }

  private secret(): string {
    const secret = this.env.TAKOSERVER_MANAGED_SQLITE_ADMIN_SECRET;
    if (typeof secret !== "string" || secret.length === 0) {
      throw new TypeError("managed SQLite authority is unavailable");
    }
    return secret;
  }

  private assertProvider(providerId: string): void {
    if (providerId !== this.env.MANAGED_PROVIDER_ID) {
      throw new TypeError("managed SQLite provider identity conflicts");
    }
  }
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
