import { createHash, randomBytes, randomInt } from "node:crypto";
import { link, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ActorResourceGraph, ActorResourceGraphReader } from "./actor-resource-graph.ts";
import type { ResourceDeploymentStore } from "./resource-deployments.ts";
import {
  openWorkerdActorNamespace,
  type WorkerdActorNamespace,
} from "./selfhost-actor-native-process.ts";
import {
  readWorkerdActiveActorGraph,
  readWorkerdSelectedActiveVersion,
  type WorkerdActiveActorGraph,
  type WorkerdSelectedActiveVersion,
} from "./workerd-runtime.ts";

interface Session {
  readonly selection: string;
  readonly graph: WorkerdActiveActorGraph;
  readonly epoch: string;
  readonly process: WorkerdActorNamespace;
  readonly alarmLeases: Set<string>;
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
  refreshing?: Promise<void>;
}

interface ActorScope {
  readonly tenantId: string;
  readonly namespaceResourceUid: string;
}

class ActorAuthorityUnavailable extends Error {}
class ActorNativeStartUnavailable extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Actor native startup unavailable", { cause });
  }
}
class ActorSelectionReadUnavailable extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Actor Version snapshot unavailable", { cause });
  }
}

export interface ActorColdStartFailure extends ActorScope {
  readonly reason:
    | "authority_unavailable"
    | "native_start_unavailable"
    | "version_snapshot_unavailable"
    | "recovery_unavailable";
  readonly attempts: number;
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
  const coldStartFailures = new Map<string, ActorColdStartFailure>();
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
    session.process.disableAlarmAdmission();
    if (session.active > 0 && !session.dead)
      await new Promise<void>((resolve) => session.idle.add(resolve));
    session.retiring = true;
    await (session.reap ?? session.process.close());
    if (owner.session === session) delete owner.session;
  };
  const sameGraph = (a: ActorResourceGraph, b: ActorResourceGraph | null): boolean =>
    b !== null && JSON.stringify(a) === JSON.stringify(b);
  const selectedVersion = async (script: string, workerResourceUid: string, basisPoint: number) => {
    try {
      return await readWorkerdSelectedActiveVersion(options.runtimeRoot, script, {
        expectedWorkerResourceUid: workerResourceUid,
        basisPoint,
      });
    } catch (error) {
      // A bad current snapshot refuses this event. Retain the old native
      // carrier as a wake source: its alarm bridge rechecks authority on
      // every attempt and can resume autonomously after operator repair.
      throw new ActorSelectionReadUnavailable(error);
    }
  };

  const activeGraph = async (
    script: string,
    workerResourceUid: string,
  ): Promise<WorkerdActiveActorGraph | null> => {
    try {
      return await readWorkerdActiveActorGraph(options.runtimeRoot, script, workerResourceUid);
    } catch (error) {
      // Keep the previous carrier for alarm watchdog retries, but do not
      // admit new application work from an unproven graph.
      throw new ActorSelectionReadUnavailable(error);
    }
  };

  const scheduleRefresh = (owner: Owner, identity: ActorScope): void => {
    if (stopped || owner.refreshing) return;
    // The admission bridge must answer the native callback before replacing
    // its process. Coalesce every stale alarm wake into one out-of-band refresh.
    owner.refreshing = Promise.resolve()
      .then(async () => {
        const warmed = await activate(identity, AbortSignal.timeout(30_000), false);
        release(warmed.session);
      })
      .catch(() => {
        // Native alarm obligation remains durable and its watchdog retries.
      })
      .finally(() => {
        delete owner.refreshing;
      });
  };

  const activate = async (
    identity: ActorScope,
    signal: AbortSignal,
    register: boolean,
  ): Promise<{ readonly session: Session; readonly variantKey: string }> => {
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
    const session = await exclusive(current, async () => {
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
      const residentGraph = await activeGraph(script, graph.worker.uid);
      if (!residentGraph) {
        throw new ActorAuthorityUnavailable("Actor Worker graph unavailable");
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
        residentGraph.generationKey,
        residentGraph.versions.map((version) => [
          version.variantKey,
          version.versionId,
          version.workerVersionUid,
          version.weight,
        ]),
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
        let process: WorkerdActorNamespace;
        let admittedSession: Session | undefined;
        const admittedAlarm = async (
          id: string,
          attemptNonce: string,
          gateSignal: AbortSignal,
        ): Promise<{
          readonly variantKey: string;
          readonly generationKey: string;
          readonly epoch: string;
          readonly leaseId: string;
        } | null> => {
          // This runs on the private bridge, never on `exclusive`: a native
          // startup alarm can arrive while activate awaits child readiness.
          const session = admittedSession;
          if (
            stopped ||
            !id ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
              attemptNonce,
            ) ||
            !session ||
            current.session !== session ||
            session.dead ||
            session.retiring
          )
            return null;
          const graphNow = await options.graph(identity, gateSignal);
          if (!sameGraph(graph, graphNow)) return null;
          const deploymentNow = await options.deployments.active(
            identity.tenantId,
            graph.worker.uid,
          );
          if (JSON.stringify(deploymentNow) !== JSON.stringify(deployment)) return null;
          // Entropy is drawn once, at this eligible alarm attempt. A retry
          // draws afresh; neither a stale resident graph nor an exception may
          // silently fall back to another weighted Version.
          const basisPoint = (options.basisPoint ?? (() => randomInt(10_000)))();
          let versionNow: WorkerdSelectedActiveVersion | null;
          try {
            versionNow = await readWorkerdSelectedActiveVersion(options.runtimeRoot, script, {
              expectedWorkerResourceUid: graph.worker.uid,
              basisPoint,
            });
          } catch {
            return null;
          }
          if (!versionNow) return null;
          if (versionNow.generationKey !== session.graph.generationKey) {
            scheduleRefresh(current, identity);
            return null;
          }
          const variant = session.graph.versions.find(
            (entry) =>
              entry.versionId === versionNow.versionId &&
              entry.workerVersionUid === versionNow.workerVersionUid,
          );
          if (!variant) return null;
          // Fence graph/deployment again after the asynchronous Version read.
          // Pending deletion before this final graph read denies the callback.
          const finalDeployment = await options.deployments.active(
            identity.tenantId,
            graph.worker.uid,
          );
          const finalGraph = await options.graph(identity, gateSignal);
          gateSignal.throwIfAborted();
          const stillAuthorized =
            !stopped &&
            current.session === session &&
            !session.dead &&
            !session.retiring &&
            sameGraph(graph, finalGraph) &&
            JSON.stringify(finalDeployment) === JSON.stringify(deployment);
          if (!stillAuthorized) return null;
          const leaseId = randomBytes(16).toString("hex");
          session.alarmLeases.add(leaseId);
          session.active += 1;
          return {
            variantKey: variant.variantKey,
            generationKey: session.graph.generationKey,
            epoch: session.epoch,
            leaseId,
          };
        };
        try {
          process = await openWorkerdActorNamespace(options.binary, {
            namespaceKey: key,
            storagePath: join(options.storageRoot, "namespaces", key),
            className: graph.namespace.className,
            graph: residentGraph,
            signal,
            admitAlarm: admittedAlarm,
            completeAlarm(leaseId) {
              const session = admittedSession;
              if (!session?.alarmLeases.delete(leaseId)) return;
              release(session);
            },
          });
        } catch (error) {
          throw new ActorNativeStartUnavailable(error);
        }
        const session: Session = {
          selection,
          graph: residentGraph,
          epoch: process.epoch,
          process,
          alarmLeases: new Set(),
          active: 0,
          idle: new Set(),
          dead: false,
          retiring: false,
        };
        admittedSession = session;
        current.session = session;
        void process.exited.then(() => {
          process.disableAlarmAdmission();
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
                  release(warmed.session);
                  return;
                } catch (error) {
                  // A broken candidate must not fork forever. The durable
                  // alarm stays retained; a later explicit owner restart
                  // can re-attempt after operator repair.
                  if (error instanceof ActorAuthorityUnavailable) {
                    coldStartFailures.set(key, {
                      tenantId: identity.tenantId,
                      namespaceResourceUid: identity.namespaceResourceUid,
                      reason: "authority_unavailable",
                      attempts: attempt + 1,
                    });
                    return;
                  }
                  const recoverable =
                    error instanceof ActorNativeStartUnavailable ||
                    error instanceof ActorSelectionReadUnavailable;
                  if (!recoverable || attempt === 2) {
                    coldStartFailures.set(key, {
                      tenantId: identity.tenantId,
                      namespaceResourceUid: identity.namespaceResourceUid,
                      reason:
                        error instanceof ActorNativeStartUnavailable
                          ? "native_start_unavailable"
                          : error instanceof ActorSelectionReadUnavailable
                            ? "version_snapshot_unavailable"
                            : "recovery_unavailable",
                      attempts: attempt + 1,
                    });
                    if (!recoverable) return;
                  }
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
      const basisPoint = (options.basisPoint ?? (() => randomInt(10_000)))();
      const finalVersion = await selectedVersion(script, graph.worker.uid, basisPoint);
      const finalDeployment = await options.deployments.active(identity.tenantId, graph.worker.uid);
      const finalGraph = await options.graph(identity, signal);
      if (
        stopped ||
        !sameGraph(graph, finalGraph) ||
        JSON.stringify(finalDeployment) !== JSON.stringify(deployment)
      ) {
        await retire(current);
        throw new ActorAuthorityUnavailable("Actor Resource changed during selection");
      }
      if (!finalVersion || finalVersion.generationKey !== residentGraph.generationKey)
        throw new ActorAuthorityUnavailable("Actor Version changed during selection");
      const variant = residentGraph.versions.find(
        (entry) =>
          entry.versionId === finalVersion.versionId &&
          entry.workerVersionUid === finalVersion.workerVersionUid,
      );
      if (!variant) {
        throw new ActorAuthorityUnavailable("Actor Version is not in resident graph");
      }
      signal.throwIfAborted();
      const session = current.session;
      if (!session || session.dead) throw new Error("Actor namespace unavailable");
      session.process.enableAlarmAdmission();
      session.active += 1;
      return { session, variantKey: variant.variantKey };
    });
    coldStartFailures.delete(key);
    return session;
  };
  const release = (session: Session): void => {
    session.active -= 1;
    if (session.active === 0) {
      for (const notify of session.idle) notify();
      session.idle.clear();
    }
  };
  const restore = async (): Promise<readonly ActorColdStartFailure[]> => {
    // Without a separate durable index of pending alarms, boot every
    // previously served namespace. Work is serial and scales with the
    // registration count, not merely the due-alarm count.
    const entries = await readdir(registrations, { withFileTypes: true }).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      },
    );
    const scopes: ActorScope[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
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
      scopes.push(raw as ActorScope);
    }
    // Validate every registration before launching any process. A corrupt
    // later entry cannot leave an earlier namespace running while ready
    // reports that startup failed closed.
    for (const scope of scopes) {
      // A registration identifies work to inspect, not execution authority:
      // activate rechecks the live Resource, deployment and selected Version.
      const key = keyOf(scope.tenantId, scope.namespaceResourceUid);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const acquired = await activate(scope, AbortSignal.timeout(30_000), false);
          release(acquired.session);
          break;
        } catch (error) {
          // Absence of current authority must never resurrect an old UID.
          // Native startup or one selected Version read failure is isolated
          // to this registration. Corrupt registration metadata, graph store
          // errors and other global failures still reject ready.
          if (error instanceof ActorAuthorityUnavailable) {
            coldStartFailures.set(key, {
              ...scope,
              reason: "authority_unavailable",
              attempts: attempt,
            });
            break;
          }
          if (
            !(error instanceof ActorNativeStartUnavailable) &&
            !(error instanceof ActorSelectionReadUnavailable)
          )
            throw error;
          if (attempt === 3) {
            coldStartFailures.set(key, {
              ...scope,
              reason:
                error instanceof ActorNativeStartUnavailable
                  ? "native_start_unavailable"
                  : "version_snapshot_unavailable",
              attempts: attempt,
            });
          } else {
            await Bun.sleep(1_000 * 2 ** (attempt - 1));
          }
        }
      }
    }
    return [...coldStartFailures.values()].map((failure) => ({ ...failure }));
  };
  const ready = restore();
  void ready.catch(() => {});

  return {
    ready,
    coldStartFailures: (): readonly ActorColdStartFailure[] =>
      [...coldStartFailures.values()].map((failure) => ({ ...failure })),
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
        release(acquired.session);
      };
      try {
        const response = await acquired.session.process.fetch(
          identity.id,
          request,
          acquired.variantKey,
        );
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
