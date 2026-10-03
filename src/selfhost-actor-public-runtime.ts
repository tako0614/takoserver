import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ActorResourceGraphReader } from "./actor-resource-graph.ts";
import { selfhostVersionBindingsRoot } from "./providers/selfhost.ts";
import {
  createSelfhostVersionBindingStore,
  type SelfhostVersionActorBinding,
} from "./providers/selfhost-version-bindings.ts";
import type { ResourceDeploymentStore } from "./resource-deployments.ts";
import { createSelfhostActorExecutionHost } from "./selfhost-actor-execution-host.ts";
import { openSelfhostActorForwardBrokers } from "./selfhost-actor-forward-brokers.ts";
import type {
  WorkerdActorForwardPublication,
  WorkerdActorForwardSocket,
} from "./workerd-runtime.ts";

/** Derives one private facade credential from an immutable Version secret. */
export function deriveSelfhostActorForwardToken(input: {
  readonly eventToken: string;
  readonly workerVersionResourceUid: string;
  readonly binding: SelfhostVersionActorBinding;
}): string {
  const key = Buffer.from(input.eventToken, "base64url");
  if (
    key.length !== 32 ||
    key.toString("base64url") !== input.eventToken ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{2,254}$/u.test(input.workerVersionResourceUid)
  )
    throw new Error("Actor Version credential unavailable");
  const binding = input.binding;
  if (
    !binding ||
    typeof binding.name !== "string" ||
    typeof binding.tenantId !== "string" ||
    typeof binding.namespaceResourceUid !== "string"
  )
    throw new Error("Actor Version relation unavailable");
  // JSON arrays are length-delimited by the encoding and preserve field
  // boundaries even when tenant or binding names contain punctuation.
  const message = JSON.stringify([
    "takoserver.selfhost-actor-forward-token@v1",
    binding.tenantId,
    input.workerVersionResourceUid,
    binding.namespaceResourceUid,
    binding.name,
    binding.workerResourceUid,
    binding.className,
  ]);
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}

const OWNED_ACTOR_RUNTIME = Symbol("owned self-host Actor runtime");
const MAX_SOCKET_PAIRS = 128;

type ExecutionHost = ReturnType<typeof createSelfhostActorExecutionHost>;
type ForwardBrokers = Awaited<ReturnType<typeof openSelfhostActorForwardBrokers>>;

export interface SelfhostActorPublicRuntime {
  readonly [OWNED_ACTOR_RUNTIME]: true;
  readonly actorNamespace: Pick<
    ExecutionHost,
    | "readCurrentGraph"
    | "registerNamespace"
    | "hasNamespace"
    | "namespaceAbsent"
    | "forgetNamespace"
  >;
  readonly actorForwardLifecycle: {
    prepare(publications: readonly WorkerdActorForwardPublication[]): Promise<void>;
    activated(publications: readonly WorkerdActorForwardPublication[]): void;
    uncertain(): void;
  };
  actorForwardSockets(): readonly WorkerdActorForwardSocket[];
  close(): Promise<void>;
}

/** Only the completed native owner can grant this composition capability. */
export function isOwnedSelfhostActorPublicRuntime(
  value: SelfhostActorPublicRuntime | undefined,
): value is SelfhostActorPublicRuntime {
  return value?.[OWNED_ACTOR_RUNTIME] === true;
}

function brokerKey(binding: {
  readonly tenantId: string;
  readonly namespaceResourceUid: string;
  readonly token: string;
}): string {
  return JSON.stringify([binding.tenantId, binding.namespaceResourceUid, binding.token]);
}

/**
 * One native namespace owner and one volatile, bounded socket graph. No second
 * durable Actor ledger or Version secret is written here. Workerd drives this
 * owner with its exact immutable publication snapshot before every render.
 */
export async function openSelfhostActorPublicRuntime(options: {
  readonly dataRoot: string;
  readonly runtimeRoot: string;
  readonly socketParent: string;
  readonly binary: string;
  readonly graph: ActorResourceGraphReader;
  readonly deployments: Pick<ResourceDeploymentStore, "active">;
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
}): Promise<SelfhostActorPublicRuntime> {
  if (
    !isAbsolute(options.dataRoot) ||
    !isAbsolute(options.runtimeRoot) ||
    !isAbsolute(options.socketParent) ||
    !isAbsolute(options.binary)
  )
    throw new Error("Actor owner configuration unavailable");
  await mkdir(options.socketParent, { recursive: true, mode: 0o700 });
  const socketDirectory = await mkdtemp(join(options.socketParent, "actor-"));
  const host = createSelfhostActorExecutionHost({
    runtimeRoot: options.runtimeRoot,
    storageRoot: join(options.dataRoot, "actor-namespaces"),
    binary: options.binary,
    graph: options.graph,
    deployments: options.deployments,
    providerPackRef: options.providerPackRef,
    providerInstallationRef: options.providerInstallationRef,
  });
  try {
    await host.ready;
  } catch (error) {
    await host.close().catch(() => {});
    await rm(socketDirectory, { recursive: true, force: true });
    throw error;
  }
  const versionBindings = createSelfhostVersionBindingStore({
    root: selfhostVersionBindingsRoot(options.dataRoot),
  });
  const brokers = new Map<string, ForwardBrokers>();
  let admitted = new Set<string>();
  let closed = false;

  const prove = async (publication: WorkerdActorForwardPublication): Promise<void> => {
    const stored = await versionBindings.read(publication.script, publication.versionId);
    if (
      !stored ||
      stored.workerResourceUid !== publication.workerResourceUid ||
      stored.workerVersionResourceUid !== publication.workerVersionResourceUid ||
      !stored.eventToken ||
      !stored.actorBindings ||
      stored.actorBindings.length !== publication.bindings.length
    )
      throw new Error("Actor immutable Version authority unavailable");
    for (const binding of publication.bindings) {
      const exact = stored.actorBindings.filter((item) => item.name === binding.publicName);
      const target = exact[0];
      if (
        exact.length !== 1 ||
        !target ||
        target.tenantId !== binding.tenantId ||
        target.namespaceResourceUid !== binding.namespaceResourceUid ||
        deriveSelfhostActorForwardToken({
          eventToken: stored.eventToken,
          workerVersionResourceUid: publication.workerVersionResourceUid,
          binding: target,
        }) !== binding.token
      )
        throw new Error("Actor immutable Version relation changed");
      const scope = {
        tenantId: target.tenantId,
        namespaceResourceUid: target.namespaceResourceUid,
      };
      const graph = await host.readCurrentGraph(scope, AbortSignal.timeout(30_000));
      if (
        !graph ||
        graph.worker.uid !== target.workerResourceUid ||
        graph.namespace.className !== target.className ||
        !(await host.hasNamespace(scope))
      )
        throw new Error("Actor namespace authority unavailable");
    }
  };

  const lifecycle = Object.freeze({
    async prepare(publications: readonly WorkerdActorForwardPublication[]): Promise<void> {
      if (closed) throw new Error("Actor owner closed");
      const requested = new Map<string, (typeof publications)[number]["bindings"][number]>();
      for (const publication of publications) {
        await prove(publication);
        for (const binding of publication.bindings) {
          const key = brokerKey(binding);
          if (requested.has(key)) continue;
          requested.set(key, binding);
        }
      }
      if (
        requested.size + [...brokers.keys()].filter((key) => !requested.has(key)).length >
        MAX_SOCKET_PAIRS
      )
        throw new Error("Actor forward socket capacity exceeded");
      const opened: [string, ForwardBrokers][] = [];
      try {
        for (const [key, binding] of requested) {
          if (brokers.has(key)) continue;
          const hash = createHash("sha256").update(key).digest("hex").slice(0, 20);
          const httpSocketPath = join(socketDirectory, `${hash}.h.sock`);
          const upgradeSocketPath = join(socketDirectory, `${hash}.u.sock`);
          if (Buffer.byteLength(upgradeSocketPath) >= 100)
            throw new Error("Actor forward socket path unavailable");
          const pair = await openSelfhostActorForwardBrokers({
            tenantId: binding.tenantId,
            namespaceResourceUid: binding.namespaceResourceUid,
            token: binding.token,
            httpSocketPath,
            upgradeSocketPath,
            executionHost: {
              fetch(scope, request) {
                if (!admitted.has(key)) throw new Error("Actor Version not active");
                return host.fetch(scope, request);
              },
              reserveDuplex(scope, request) {
                if (!admitted.has(key)) throw new Error("Actor Version not active");
                return host.reserveDuplex(scope, request);
              },
            },
          });
          opened.push([key, pair]);
        }
      } catch (error) {
        await Promise.all(opened.map(([, pair]) => pair.close()));
        throw error;
      }
      // The registered relation is mutable. Before letting the render see new
      // sockets, recheck its exact authority; any failure denies this render.
      try {
        for (const publication of publications) await prove(publication);
      } catch (error) {
        await Promise.all(opened.map(([, pair]) => pair.close()));
        throw error;
      }
      for (const [key, pair] of opened) brokers.set(key, pair);
    },
    activated(publications: readonly WorkerdActorForwardPublication[]): void {
      if (closed) return;
      const next = new Set(publications.flatMap((item) => item.bindings.map(brokerKey)));
      admitted = [...next].every((key) => brokers.has(key)) ? next : new Set();
    },
    uncertain(): void {
      admitted = new Set();
    },
  });

  return Object.freeze({
    [OWNED_ACTOR_RUNTIME]: true as const,
    actorNamespace: host,
    actorForwardLifecycle: lifecycle,
    actorForwardSockets: () => [...brokers.values()].map((pair) => pair.socketMapping),
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      admitted = new Set();
      await Promise.all([...brokers.values()].map((pair) => pair.close()));
      await host.close();
      await rm(socketDirectory, { recursive: true, force: true });
    },
  });
}
