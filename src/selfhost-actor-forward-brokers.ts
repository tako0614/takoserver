import type { createSelfhostActorExecutionHost } from "./selfhost-actor-execution-host.ts";
import { openSelfhostActorHttpBroker } from "./selfhost-actor-http-broker.ts";
import {
  openSelfhostActorUpgradeBroker,
  type SelfhostActorDuplexLease,
} from "./selfhost-actor-upgrade-broker.ts";
import type { WorkerdActorForwardSocket } from "./workerd-runtime.ts";

type NativeExecutionHost = ReturnType<typeof createSelfhostActorExecutionHost>;
type ExecutionHost = {
  readonly fetch: NativeExecutionHost["fetch"];
  readonly reserveDuplex: (
    scope: Parameters<NativeExecutionHost["reserveDuplex"]>[0],
    request: Request,
  ) => Promise<SelfhostActorDuplexLease>;
};

/**
 * Bind one exact persisted Actor namespace identity to the two Host-private
 * workerd transports. The execution Host performs live graph, deployment,
 * selected Version and revocation checks for every call and commit.
 */
export async function openSelfhostActorForwardBrokers(options: {
  readonly tenantId: string;
  readonly namespaceResourceUid: string;
  readonly token: string;
  readonly httpSocketPath: string;
  readonly upgradeSocketPath: string;
  readonly executionHost: ExecutionHost;
}): Promise<{
  readonly socketMapping: WorkerdActorForwardSocket;
  retire(): Promise<void>;
  close(): Promise<void>;
}> {
  if (
    !options.tenantId ||
    !options.namespaceResourceUid ||
    options.httpSocketPath === options.upgradeSocketPath
  )
    throw new Error("Actor forward broker scope unavailable");
  // Snapshot caller-owned identity before either broker can receive requests.
  const tenantId = options.tenantId;
  const namespaceResourceUid = options.namespaceResourceUid;
  const host = options.executionHost;
  const http = await openSelfhostActorHttpBroker({
    socketPath: options.httpSocketPath,
    token: options.token,
    fetch: (id, request) => host.fetch({ tenantId, namespaceResourceUid, id }, request),
  });
  let upgrade: Awaited<ReturnType<typeof openSelfhostActorUpgradeBroker>>;
  try {
    upgrade = await openSelfhostActorUpgradeBroker({
      socketPath: options.upgradeSocketPath,
      token: options.token,
      reserve: (id, request) => host.reserveDuplex({ tenantId, namespaceResourceUid, id }, request),
    });
  } catch (error) {
    await http.close();
    throw error;
  }
  return Object.freeze({
    socketMapping: Object.freeze({
      tenantId,
      namespaceResourceUid,
      token: options.token,
      httpSocketPath: http.socketPath,
      upgradeSocketPath: upgrade.socketPath,
    }),
    async retire() {
      await Promise.all([upgrade.retire(), http.retire()]);
    },
    async close() {
      await Promise.all([upgrade.close(), http.close()]);
    },
  });
}
