import { createHash, randomInt } from "node:crypto";
import { link, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  retiring: boolean;
  reap?: Promise<void>;
}
interface Owner {
  tail: Promise<void>;
  session?: Session;
  locked: boolean;
}

interface ActorScope {
  readonly tenantId: string;
  readonly namespaceResourceUid: string;
}

class ActorAuthorityUnavailable extends Error {}

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
  const registrations = join(options.storageRoot, "registrations");
  const keyOf = (tenantId: string, uid: string): string =>
    createHash("sha256")
      .update(JSON.stringify([tenantId, uid]))
      .digest("hex");
  const registrationPath = (key: string): string => join(registrations, `${key}.json`);
  const persistScope = async (key: string, scope: ActorScope): Promise<void> => {
    await mkdir(registrations, { recursive: true, mode: 0o700 });
    const path = registrationPath(key);
    const bytes = JSON.stringify({
      tenantId: scope.tenantId,
      namespaceResourceUid: scope.namespaceResourceUid,
    });
    // Publish a complete record with no overwrite. A process loss while
    // writing must not expose a truncated registration to the next owner.
    const temporary = await mkdtemp(join(options.storageRoot, "registration-"));
    try {
      const source = join(temporary, "entry.json");
      await writeFile(source, bytes, { flag: "wx", mode: 0o600 });
      try {
        await link(source, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await readFile(path, "utf8")) !== bytes)
          throw new Error("Actor namespace registration changed");
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };
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
    session.retiring = true;
    await (session.reap ?? session.process.close());
    if (owner.session === session) delete owner.session;
  };
  const sameGraph = (a: ActorResourceGraph, b: ActorResourceGraph | null): boolean =>
    b !== null && JSON.stringify(a) === JSON.stringify(b);

  const activate = async (
    identity: ActorScope,
    signal: AbortSignal,
    register: boolean,
  ): Promise<Session> => {
    if (stopped || !identity.tenantId || !identity.namespaceResourceUid)
      throw new Error("Actor namespace unavailable");
    const key = keyOf(identity.tenantId, identity.namespaceResourceUid);
    let owner = owners.get(key);
    if (!owner) {
      owner = { tail: Promise.resolve(), locked: false };
      owners.set(key, owner);
    }
    const current = owner;
    // Only lifecycle selection is queued here. Individual IDs run under
    // native input gates, not a second generic application scheduler.
    return exclusive(current, async () => {
      if (stopped) throw new Error("Actor owner stopped");
      const graph = await options.graph(identity, signal);
      if (
        !graph ||
        graph.tenantId !== identity.tenantId ||
        graph.namespace.uid !== identity.namespaceResourceUid
      ) {
        await retire(current);
        throw new ActorAuthorityUnavailable("Actor Resource unavailable");
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
        throw new ActorAuthorityUnavailable("Actor Worker realization unavailable");
      }
      const basisPoint = (options.basisPoint ?? (() => randomInt(10_000)))();
      const selected = await readWorkerdSelectedActiveVersion(options.runtimeRoot, script, {
        expectedWorkerResourceUid: graph.worker.uid,
        basisPoint,
      });
      if (!selected) {
        await retire(current);
        throw new ActorAuthorityUnavailable("Actor Worker Version unavailable");
      }
      // A publication read cannot confer authority after Resource deletion
      // or deployment replacement during that read.
      const again = await options.deployments.active(identity.tenantId, graph.worker.uid);
      if (
        !sameGraph(graph, await options.graph(identity, signal)) ||
        JSON.stringify(again) !== JSON.stringify(deployment)
      ) {
        await retire(current);
        throw new ActorAuthorityUnavailable("Actor Resource changed during selection");
      }
      signal.throwIfAborted();
      const selection = JSON.stringify([
        graph.namespace.className,
        graph.worker.uid,
        selected.versionId,
        selected.workerVersionUid,
        selected.generationKey,
      ]);
      if (current.session?.selection !== selection || current.session.dead) {
        await retire(current);
        if (register) await persistScope(key, identity);
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
          signal,
        });
        const session: Session = {
          selection,
          process,
          active: 0,
          idle: new Set(),
          dead: false,
          retiring: false,
        };
        current.session = session;
        void process.exited.then(() => {
          const unexpected = !session.retiring;
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
          })
            .then(async () => {
              if (stopped || !unexpected) return;
              // A native child can die while an alarm is pending, with no
              // subsequent HTTP request. Reopen the retained namespace so
              // workerd can reconstruct its native alarm wake.
              for (let attempt = 0; attempt < 3 && !stopped; attempt += 1) {
                try {
                  const warmed = await activate(identity, AbortSignal.timeout(30_000), false);
                  release(warmed);
                  return;
                } catch (error) {
                  // A broken candidate must not fork forever. The durable
                  // alarm stays retained; a later explicit owner restart
                  // can re-attempt after operator repair.
                  if (error instanceof ActorAuthorityUnavailable) return;
                  if (!stopped && attempt < 2) await Bun.sleep(1_000 * 2 ** attempt);
                }
              }
            })
            .catch(() => {});
        });
      }
      // Retirement can wait on an old response stream, and native startup
      // can also yield. A Resource or publication selected before either
      // wait must not be dispatched afterward without another readback.
      const finalVersion = await readWorkerdSelectedActiveVersion(options.runtimeRoot, script, {
        expectedWorkerResourceUid: graph.worker.uid,
        basisPoint,
      });
      const finalDeployment = await options.deployments.active(identity.tenantId, graph.worker.uid);
      const finalGraph = await options.graph(identity, signal);
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
        throw new ActorAuthorityUnavailable("Actor Resource changed during selection");
      }
      signal.throwIfAborted();
      const session = current.session;
      if (!session || session.dead) throw new Error("Actor namespace unavailable");
      session.active += 1;
      return session;
    });
  };
  const release = (session: Session): void => {
    session.active -= 1;
    if (session.active === 0) {
      for (const notify of session.idle) notify();
      session.idle.clear();
    }
  };
  const restore = async (): Promise<void> => {
    // Without a separate durable index of pending alarms, boot every
    // previously served namespace. Work is serial and scales with the
    // registration count, not merely the due-alarm count.
    const entries = await readdir(registrations, { withFileTypes: true }).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      },
    );
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name))
        throw new Error("Actor namespace registration invalid");
      const raw: unknown = JSON.parse(await readFile(join(registrations, entry.name), "utf8"));
      if (
        typeof raw !== "object" ||
        raw === null ||
        Object.keys(raw).sort().join(",") !== "namespaceResourceUid,tenantId" ||
        typeof (raw as ActorScope).tenantId !== "string" ||
        !(raw as ActorScope).tenantId ||
        typeof (raw as ActorScope).namespaceResourceUid !== "string" ||
        !(raw as ActorScope).namespaceResourceUid ||
        `${keyOf((raw as ActorScope).tenantId, (raw as ActorScope).namespaceResourceUid)}.json` !==
          entry.name
      )
        throw new Error("Actor namespace registration invalid");
      // A registration identifies work to inspect, not execution authority:
      // activate rechecks the live Resource, deployment and selected Version.
      try {
        const session = await activate(raw as ActorScope, AbortSignal.timeout(30_000), false);
        release(session);
      } catch (error) {
        // A deleted/replaced Resource is not authority to resurrect its
        // namespace. Keep its retained record for explicit lifecycle cleanup
        // without blocking other registered namespaces from waking.
        if (!(error instanceof ActorAuthorityUnavailable)) throw error;
      }
    }
  };
  const ready = restore();
  void ready.catch(() => {});

  return {
    ready,
    async fetch(scope: ActorScope & { readonly id: string }, request: Request): Promise<Response> {
      if (!scope.id || scope.id.includes("\u0000")) throw new Error("Actor namespace unavailable");
      await ready;
      // Capture caller-owned identity before any asynchronous resolution.
      const identity = { ...scope };
      const acquired = await activate(identity, request.signal, true);
      let released = false;
      const releaseOnce = (): void => {
        if (released) return;
        released = true;
        release(acquired);
      };
      try {
        const response = await acquired.process.fetch(identity.id, request);
        if (!response.body) {
          releaseOnce();
          return response;
        }
        const reader = response.body.getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const result = await reader.read();
              if (result.done) {
                releaseOnce();
                controller.close();
              } else controller.enqueue(result.value);
            } catch (error) {
              releaseOnce();
              controller.error(error);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              releaseOnce();
            }
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        releaseOnce();
        throw error;
      }
    },
    close(): Promise<void> {
      stopped = true;
      stopping ??= (async () => {
        await ready.catch(() => {});
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
