import { createHash, randomInt } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ActorResourceGraph, ActorResourceGraphReader } from "./actor-resource-graph.ts";
import type { ResourceDeploymentStore } from "./resource-deployments.ts";
import {
  openWorkerdActorNamespace,
  type WorkerdActorNamespace,
} from "./selfhost-actor-native-process.ts";
import { readWorkerdSelectedActiveVersion } from "./workerd-runtime.ts";

interface Session {
  readonly selection: string;
  readonly process: WorkerdActorNamespace;
  active: number;
  readonly idle: Set<() => void>;
  dead: boolean;
  reap?: Promise<void>;
}
interface Owner {
  tail: Promise<void>;
  session?: Session;
  locked: boolean;
}

/**
 * Internal self-host composition: persisted Resource incarnation -> active
 * Worker realization -> immutable published Version -> native Actor namespace.
 * This is deliberately not an admission capability or a public binding API.
 * Existing unsupported Actor gates remain in force while alarm/socket/quota
 * and broader crash-recovery qualifications are outstanding.
 */
export function createSelfhostActorExecutionHost(options: {
  readonly runtimeRoot: string;
  readonly storageRoot: string;
  /** Same operator-selected executable used by the serving workerd owner. */
  readonly binary: string;
  readonly graph: ActorResourceGraphReader;
  readonly deployments: Pick<ResourceDeploymentStore, "active">;
  readonly providerPackRef: string;
  readonly providerInstallationRef: string;
  readonly basisPoint?: () => number;
}) {
  if (!isAbsolute(options.runtimeRoot) || !isAbsolute(options.storageRoot))
    throw new Error("Actor owner roots must be absolute");
  const owners = new Map<string, Owner>();
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const keyOf = (tenantId: string, uid: string): string =>
    createHash("sha256")
      .update(JSON.stringify([tenantId, uid]))
      .digest("hex");
  const exclusive = <T>(owner: Owner, callback: () => Promise<T>): Promise<T> => {
    const result = owner.tail.then(callback);
    owner.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const retire = async (owner: Owner): Promise<void> => {
    const session = owner.session;
    if (!session) return;
    if (session.active > 0 && !session.dead)
      await new Promise<void>((resolve) => session.idle.add(resolve));
    await (session.reap ?? session.process.close());
    if (owner.session === session) delete owner.session;
  };
  const sameGraph = (a: ActorResourceGraph, b: ActorResourceGraph | null): boolean =>
    b !== null && JSON.stringify(a) === JSON.stringify(b);

  return {
    async fetch(
      scope: {
        readonly tenantId: string;
        readonly namespaceResourceUid: string;
        readonly id: string;
      },
      request: Request,
    ): Promise<Response> {
      if (
        stopped ||
        !scope.tenantId ||
        !scope.namespaceResourceUid ||
        !scope.id ||
        scope.id.includes("\u0000")
      )
        throw new Error("Actor namespace unavailable");
      // Capture caller-owned identity before any asynchronous resolution.
      const identity = { ...scope };
      const key = keyOf(identity.tenantId, identity.namespaceResourceUid);
      let owner = owners.get(key);
      if (!owner) {
        owner = { tail: Promise.resolve(), locked: false };
        owners.set(key, owner);
      }
      const current = owner;
      // Only lifecycle selection is queued here. Individual IDs run under
      // native input gates, not a second generic application scheduler.
      const acquired = await exclusive(current, async () => {
        if (stopped) throw new Error("Actor owner stopped");
        const graph = await options.graph(identity, request.signal);
        if (
          !graph ||
          graph.tenantId !== identity.tenantId ||
          graph.namespace.uid !== identity.namespaceResourceUid
        ) {
          await retire(current);
          throw new Error("Actor Resource unavailable");
        }
        const deployment = await options.deployments.active(identity.tenantId, graph.worker.uid);
        const script = deployment?.outputs.scriptName;
        if (
          deployment?.state !== "active" ||
          deployment.tenantId !== identity.tenantId ||
          deployment.resourceUid !== graph.worker.uid ||
          deployment.providerPackRef !== options.providerPackRef ||
          deployment.providerInstallationRef !== options.providerInstallationRef ||
          typeof script !== "string" ||
          !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(script) ||
          !deployment.nativeId.startsWith(`selfhost-worker:${script}:`) ||
          deployment.nativeId === `selfhost-worker:${script}:`
        ) {
          await retire(current);
          throw new Error("Actor Worker realization unavailable");
        }
        const basisPoint = (options.basisPoint ?? (() => randomInt(10_000)))();
        const selected = await readWorkerdSelectedActiveVersion(options.runtimeRoot, script, {
          expectedWorkerResourceUid: graph.worker.uid,
          basisPoint,
        });
        if (!selected) {
          await retire(current);
          throw new Error("Actor Worker Version unavailable");
        }
        // A publication read cannot confer authority after Resource deletion
        // or deployment replacement during that read.
        const again = await options.deployments.active(identity.tenantId, graph.worker.uid);
        if (
          !sameGraph(graph, await options.graph(identity, request.signal)) ||
          JSON.stringify(again) !== JSON.stringify(deployment)
        ) {
          await retire(current);
          throw new Error("Actor Resource changed during selection");
        }
        request.signal.throwIfAborted();
        const selection = JSON.stringify([
          graph.namespace.className,
          graph.worker.uid,
          selected.versionId,
          selected.workerVersionUid,
          selected.generationKey,
        ]);
        if (current.session?.selection !== selection || current.session.dead) {
          await retire(current);
          if (!current.locked) {
            await mkdir(join(options.storageRoot, "leases"), { recursive: true, mode: 0o700 });
            // Exclusive across Host instances. A crash leaves this lease in
            // place and fails closed; automatic stale-lock recovery is not
            // qualified or guessed from a PID. Admission stays disabled.
            await mkdir(join(options.storageRoot, "leases", key), { mode: 0o700 });
            current.locked = true;
          }
          const process = await openWorkerdActorNamespace(options.binary, {
            namespaceKey: key,
            storagePath: join(options.storageRoot, "namespaces", key),
            className: graph.namespace.className,
            site: selected.site,
            modules: selected.modules,
            hostModules: selected.hostModules,
            signal: request.signal,
          });
          const session: Session = {
            selection,
            process,
            active: 0,
            idle: new Set(),
            dead: false,
          };
          current.session = session;
          void process.exited.then(() => {
            session.dead = true;
            // A dead child cannot complete a held response. Wake retirement
            // without replaying an in-flight request or waiting for its body.
            for (const notify of session.idle) notify();
            session.idle.clear();
            session.reap = process.close();
            // The normal close path also awaits this promise. Attach a handler
            // now so a cleanup error cannot become an unhandled rejection.
            void session.reap.catch(() => {});
            void exclusive(current, async () => {
              if (current.session === session) await retire(current);
            }).catch(() => {});
          });
        }
        // Retirement can wait on an old response stream, and native startup
        // can also yield. A Resource or publication selected before either
        // wait must not be dispatched afterward without another readback.
        const finalVersion = await readWorkerdSelectedActiveVersion(options.runtimeRoot, script, {
          expectedWorkerResourceUid: graph.worker.uid,
          basisPoint,
        });
        const finalDeployment = await options.deployments.active(
          identity.tenantId,
          graph.worker.uid,
        );
        const finalGraph = await options.graph(identity, request.signal);
        if (
          stopped ||
          !sameGraph(graph, finalGraph) ||
          JSON.stringify(finalDeployment) !== JSON.stringify(deployment) ||
          !finalVersion ||
          JSON.stringify([
            graph.namespace.className,
            graph.worker.uid,
            finalVersion.versionId,
            finalVersion.workerVersionUid,
            finalVersion.generationKey,
          ]) !== selection
        ) {
          await retire(current);
          throw new Error("Actor Resource changed during selection");
        }
        request.signal.throwIfAborted();
        const session = current.session;
        if (!session || session.dead) throw new Error("Actor namespace unavailable");
        session.active += 1;
        return session;
      });
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        acquired.active -= 1;
        if (acquired.active === 0) {
          for (const notify of acquired.idle) notify();
          acquired.idle.clear();
        }
      };
      try {
        const response = await acquired.process.fetch(identity.id, request);
        if (!response.body) {
          release();
          return response;
        }
        const reader = response.body.getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const result = await reader.read();
              if (result.done) {
                release();
                controller.close();
              } else controller.enqueue(result.value);
            } catch (error) {
              release();
              controller.error(error);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              release();
            }
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        release();
        throw error;
      }
    },
    close(): Promise<void> {
      stopped = true;
      stopping ??= (async () => {
        // Retained SQL is never removed by execution-owner shutdown.
        await Promise.all(
          [...owners].map(([key, owner]) =>
            exclusive(owner, async () => {
              await retire(owner);
              if (owner.locked) {
                await rm(join(options.storageRoot, "leases", key), { recursive: true });
                owner.locked = false;
              }
            }),
          ),
        );
      })();
      return stopping;
    },
  };
}
