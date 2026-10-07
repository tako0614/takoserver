import { createHash, randomBytes, randomInt } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  readFile,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ActorResourceGraph, ActorResourceGraphReader } from "./actor-resource-graph.ts";
import { canonicalJson } from "./json.ts";
import type { ResourceDeploymentStore } from "./resource-deployments.ts";
import {
  type ActorExecutionGraph,
  type ActorExecutionRealization,
  type ActorGraphAuthority,
  type ActorRealizationRead,
  createLegacyActorGraphAuthority,
} from "./selfhost-actor-graph-authority.ts";
import {
  openWorkerdActorNamespace,
  type WorkerdActorNamespace,
  type WorkerdActorRuntimeObservation,
} from "./selfhost-actor-native-process.ts";
import type { WorkerdActiveActorGraph, WorkerdSelectedActiveVersion } from "./workerd-runtime.ts";

interface Session {
  readonly selection: string;
  readonly authorityGraph: ActorExecutionGraph;
  readonly realization: ActorExecutionRealization;
  readonly graph: WorkerdActiveActorGraph;
  readonly epoch: string;
  readonly process: WorkerdActorNamespace;
  readonly alarmLeases: Set<string>;
  readonly socketLeases: Set<string>;
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
  revoked?: boolean;
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

export type ActorNamespaceRuntimeObservation =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "confirmed";
      readonly epoch: string;
      readonly observedAt: number;
      readonly activeActorCount: number;
      readonly pendingAlarmCount: number;
      readonly openSocketCount: number;
    };

/** Backend-held exact native selection; this does not itself confer SQL authority. */
export interface ActorAcceptedOperationRuntimeTarget {
  readonly workerUid: string;
  readonly className: string;
  readonly sourceOperationId: string;
  readonly incarnationId: string;
  readonly generationKey: string;
  readonly versions: readonly {
    readonly versionId: string;
    readonly workerVersionUid: string;
    readonly weight: number;
  }[];
}

/** A backend-held, leased candidate for inspection only, never event admission. */
export interface ActorAcceptedOperationWarmCandidate {
  readonly graph: ActorExecutionGraph;
  readonly realization: ActorExecutionRealization;
  readonly expected: ActorAcceptedOperationRuntimeTarget;
  readonly stillAuthorized: (signal: AbortSignal) => Promise<boolean>;
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
  readonly authority?: ActorGraphAuthority;
  /** Retired v1 compatibility input, isolated in createLegacyActorGraphAuthority. */
  readonly graph?: ActorResourceGraphReader;
  readonly deployments?: Pick<ResourceDeploymentStore, "active">;
  readonly providerPackRef?: string;
  readonly providerInstallationRef?: string;
  readonly basisPoint?: () => number;
  /** Fault injection only: an unknown registration ACK must be retryable from exact bytes. */
  readonly afterRegistrationLinkBeforeSync?: () => Promise<void>;
  /** Fault injection only: deletion retains the lease until native data is gone. */
  readonly beforeNamespaceStorageDelete?: () => Promise<void>;
  /** Fault injection only: emulate an unknown lease-unlink durability ACK. */
  readonly afterLeaseUnlinkBeforeSync?: () => Promise<void>;
}) {
  if (!isAbsolute(options.runtimeRoot) || !isAbsolute(options.storageRoot))
    throw new Error("Actor owner roots must be absolute");
  if (options.authority && (options.graph || options.deployments))
    throw new TypeError("Actor owner cannot combine graph authorities");
  const authority =
    options.authority ??
    (options.graph &&
    options.deployments &&
    options.providerPackRef &&
    options.providerInstallationRef
      ? createLegacyActorGraphAuthority({
          runtimeRoot: options.runtimeRoot,
          graph: options.graph,
          deployments: options.deployments,
          providerPackRef: options.providerPackRef,
          providerInstallationRef: options.providerInstallationRef,
        })
      : null);
  if (!authority) throw new TypeError("Actor graph authority is required");
  const owners = new Map<string, Owner>();
  const revoked = new Set<string>();
  const coldStartFailures = new Map<string, ActorColdStartFailure>();
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const registrations = join(options.storageRoot, "registrations");
  const actorIdsRoot = join(options.storageRoot, "actor-id-index-v1");
  const actorIdsDirectory = (key: string): string => join(actorIdsRoot, key);
  const MAX_OBSERVED_ACTOR_IDS = 10_000;
  const MAX_ACTOR_ID_RECORD_BYTES = 2_048;
  const keyOf = (tenantId: string, uid: string): string =>
    createHash("sha256")
      .update(JSON.stringify([tenantId, uid]))
      .digest("hex");
  const validScope = (scope: ActorScope): boolean =>
    typeof scope.tenantId === "string" &&
    scope.tenantId.length > 0 &&
    scope.tenantId.length <= 256 &&
    !scope.tenantId.includes("\u0000") &&
    typeof scope.namespaceResourceUid === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{2,254}$/u.test(scope.namespaceResourceUid);
  const registrationPath = (key: string): string => join(registrations, `${key}.json`);
  const syncDirectory = async (path: string): Promise<void> => {
    const handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  const pathExists = async (path: string): Promise<boolean> => {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  const readActorIdRecord = async (path: string): Promise<string | null> => {
    const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (
        !before.isFile() ||
        before.uid !== process.getuid?.() ||
        before.size < 8 ||
        before.size > MAX_ACTOR_ID_RECORD_BYTES ||
        (before.mode & 0o077) !== 0
      )
        return null;
      const bytes = Buffer.alloc(MAX_ACTOR_ID_RECORD_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const next = await file.read(bytes, length, bytes.length - length, length);
        if (next.bytesRead === 0) break;
        length += next.bytesRead;
      }
      const after = await file.stat();
      if (
        length !== before.size ||
        after.size !== before.size ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        return null;
      const value: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      return value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).join(",") === "id" &&
        typeof (value as { id?: unknown }).id === "string"
        ? (value as { id: string }).id
        : null;
    } finally {
      await file.close();
    }
  };
  const persistScope = async (key: string, scope: ActorScope): Promise<void> => {
    await mkdir(options.storageRoot, { recursive: true, mode: 0o700 });
    await syncDirectory(dirname(options.storageRoot));
    await mkdir(registrations, { recursive: true, mode: 0o700 });
    await syncDirectory(options.storageRoot);
    const path = registrationPath(key);
    // A new registration is the only point where a complete ID index can be
    // established. Historical namespaces with native data but no index remain
    // unknown; a page-cache absence is never treated as a zero count.
    if (
      !(await pathExists(path)) &&
      !(await pathExists(join(options.storageRoot, "namespaces", key))) &&
      !(await pathExists(join(options.storageRoot, "leases", key)))
    ) {
      await mkdir(actorIdsRoot, { recursive: true, mode: 0o700 });
      await syncDirectory(options.storageRoot);
      await mkdir(actorIdsDirectory(key), { recursive: true, mode: 0o700 });
      await syncDirectory(actorIdsRoot);
    }
    const bytes = JSON.stringify({
      tenantId: scope.tenantId,
      namespaceResourceUid: scope.namespaceResourceUid,
    });
    // Publish a complete record with no overwrite. A process loss while
    // writing must not expose a truncated registration to the next owner.
    const temporary = await mkdtemp(join(options.storageRoot, "registration-"));
    try {
      const source = join(temporary, "entry.json");
      const file = await open(
        source,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(source, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // A pre-fsync historical registration may have the right name and
        // bytes without durable file data. Re-ACK only after syncing that
        // existing inode, not the unused temporary inode above.
        const existing = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          if ((await existing.readFile("utf8")) !== bytes)
            throw new Error("Actor namespace registration changed");
          await existing.sync();
        } finally {
          await existing.close();
        }
      }
      await options.afterRegistrationLinkBeforeSync?.();
      await syncDirectory(registrations);
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await syncDirectory(options.storageRoot);
    }
  };
  const registeredScope = async (key: string, scope: ActorScope): Promise<boolean> => {
    let raw: string;
    try {
      raw = await readFile(registrationPath(key), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (
      raw !==
      JSON.stringify({
        tenantId: scope.tenantId,
        namespaceResourceUid: scope.namespaceResourceUid,
      })
    )
      throw new Error("Actor namespace registration changed");
    return true;
  };
  const rememberActorId = async (scope: ActorScope & { readonly id: string }): Promise<void> => {
    const key = keyOf(scope.tenantId, scope.namespaceResourceUid);
    const directory = actorIdsDirectory(key);
    if (!(await pathExists(directory))) return;
    const metadata = await lstat(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o077) !== 0
    )
      throw new Error("Actor identity index unavailable");
    if (!(await registeredScope(key, scope))) return;
    if (!scope.id || Buffer.byteLength(scope.id, "utf8") > 1_024)
      throw new Error("Actor identity unavailable");
    const name = `${createHash("sha256").update(scope.id).digest("hex")}.json`;
    const path = join(directory, name);
    const bytes = JSON.stringify({ id: scope.id });
    const temporary = await mkdtemp(join(options.storageRoot, "actor-id-"));
    try {
      const source = join(temporary, "entry.json");
      const file = await open(
        source,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(source, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await readActorIdRecord(path)) !== scope.id)
          throw new Error("Actor identity index changed");
        const existing = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          await existing.sync();
        } finally {
          await existing.close();
        }
      }
      await syncDirectory(directory);
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await syncDirectory(options.storageRoot);
    }
  };
  const readActorIds = async (key: string): Promise<readonly string[] | null> => {
    const directory = actorIdsDirectory(key);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o077) !== 0
    )
      return null;
    const names: string[] = [];
    for await (const entry of await opendir(directory)) {
      if (!entry.isFile() || names.length >= MAX_OBSERVED_ACTOR_IDS) return null;
      names.push(entry.name);
    }
    names.sort();
    const ids: string[] = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) return null;
      const id = await readActorIdRecord(join(directory, name));
      if (!id || createHash("sha256").update(id).digest("hex") !== name.slice(0, 64)) return null;
      ids.push(id);
    }
    return ids;
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
  const selectedVersion = async (
    graph: ActorExecutionGraph,
    realization: ActorExecutionRealization,
    basisPoint: number,
  ) => {
    try {
      return await authority.selectVersion(graph, realization, basisPoint);
    } catch (error) {
      // A bad current snapshot refuses this event. Retain the old native
      // carrier as a wake source: its alarm bridge rechecks authority on
      // every attempt and can resume autonomously after operator repair.
      throw new ActorSelectionReadUnavailable(error);
    }
  };

  const currentRealization = async (
    graph: ActorExecutionGraph,
    signal: AbortSignal,
  ): Promise<ActorRealizationRead> => {
    try {
      return await authority.readRealization(graph, signal);
    } catch (error) {
      // Keep the previous carrier for alarm watchdog retries, but do not
      // admit new application work from an unproven graph.
      throw new ActorSelectionReadUnavailable(error);
    }
  };

  const hasCurrentRealization = async (
    candidate: ActorExecutionGraph | null,
    identity: ActorScope,
  ): Promise<boolean> => {
    if (
      !candidate ||
      candidate.scope.tenantId !== identity.tenantId ||
      candidate.scope.namespaceResourceUid !== identity.namespaceResourceUid
    )
      return false;
    return authority.hasRealization(candidate);
  };

  const scheduleRefresh = (owner: Owner, identity: ActorScope): void => {
    if (stopped || owner.refreshing) return;
    // The admission bridge must answer the native callback before replacing
    // its process. Coalesce every stale alarm wake into one out-of-band refresh.
    owner.refreshing = Promise.resolve()
      .then(async () => {
        const warmed = await activate(identity, AbortSignal.timeout(30_000));
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
    warm?: ActorAcceptedOperationWarmCandidate,
  ): Promise<{
    readonly session: Session;
    readonly variantKey: string;
    readonly observation?: ActorNamespaceRuntimeObservation;
  }> => {
    if (stopped || !identity.tenantId || !identity.namespaceResourceUid)
      throw new Error("Actor namespace unavailable");
    const key = keyOf(identity.tenantId, identity.namespaceResourceUid);
    if (revoked.has(key)) throw new Error("Actor namespace revoked");
    let owner = owners.get(key);
    if (!owner) {
      owner = { tail: Promise.resolve(), locked: false };
      owners.set(key, owner);
    }
    const current = owner;
    // Only lifecycle selection is queued here. Individual IDs run under
    // native input gates, not a second generic application scheduler.
    const session = await exclusive(current, async () => {
      if (stopped || current.revoked || revoked.has(key)) throw new Error("Actor owner stopped");
      if (!(await registeredScope(key, identity)))
        throw new ActorAuthorityUnavailable("Actor namespace is not registered");
      if (warm && (current.session || !(await warm.stillAuthorized(signal))))
        throw new ActorAuthorityUnavailable("Actor warm candidate unavailable");
      const graph = warm?.graph ?? (await authority.readGraph(identity, signal));
      if (
        !graph ||
        graph.scope.tenantId !== identity.tenantId ||
        graph.scope.namespaceResourceUid !== identity.namespaceResourceUid
      ) {
        if (!warm) await retire(current);
        throw new ActorAuthorityUnavailable("Actor Resource unavailable");
      }
      if (!warm && !(await authority.hasRealization(graph))) {
        await retire(current);
        throw new ActorAuthorityUnavailable("Actor Worker realization unavailable");
      }
      const realized: ActorRealizationRead = warm
        ? { kind: "ready", realization: warm.realization }
        : await currentRealization(graph, signal);
      if (realized.kind === "authority_changed") {
        if (!warm) await retire(current);
        throw new ActorAuthorityUnavailable("Actor Resource changed during selection");
      }
      if (realized.kind !== "ready") {
        throw new ActorAuthorityUnavailable("Actor Worker graph unavailable");
      }
      const realization = realized.realization;
      const residentGraph = realization.graph;
      // A publication read cannot confer authority after Resource deletion
      // or deployment replacement during that read.
      if (
        !(await (warm
          ? warm.stillAuthorized(signal)
          : authority.stillCurrent(graph, realization, signal)))
      ) {
        if (!warm) await retire(current);
        throw new ActorAuthorityUnavailable("Actor Resource changed during selection");
      }
      signal.throwIfAborted();
      if (revoked.has(key)) throw new ActorAuthorityUnavailable("Actor namespace revoked");
      const selection = JSON.stringify([
        graph,
        realization.authorityKey,
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
        if (revoked.has(key)) throw new ActorAuthorityUnavailable("Actor namespace revoked");
        if (!current.locked) {
          await mkdir(join(options.storageRoot, "leases"), { recursive: true, mode: 0o700 });
          // Exclusive across Host instances. A crash leaves this lease in
          // place and fails closed; automatic stale-lock recovery is not
          // qualified or guessed from a PID. Admission stays disabled.
          await mkdir(join(options.storageRoot, "leases", key), { mode: 0o700 });
          current.locked = true;
        }
        // Registration can be revoked while authority reads or lease
        // acquisition yield; a current graph alone cannot open retained SQL.
        if (!(await registeredScope(key, identity)))
          throw new ActorAuthorityUnavailable("Actor namespace is not registered");
        let process: WorkerdActorNamespace;
        let admittedSession: Session | undefined;
        const admitEvent = async (
          kind: "alarm" | "socket",
          id: string,
          attemptNonce: string,
          gateSignal: AbortSignal,
        ): Promise<{
          readonly variantKey: string;
          readonly generationKey: string;
          readonly epoch: string;
          readonly leaseId: string;
        } | null> => {
          // This runs on a private bridge, never on `exclusive`: a native
          // startup event can arrive while activate awaits child readiness.
          const session = admittedSession;
          if (
            stopped ||
            !id ||
            id.includes("\u0000") ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
              attemptNonce,
            ) ||
            !session ||
            current.session !== session ||
            session.dead ||
            session.retiring
          )
            return null;
          const graphNow = await authority.readGraph(identity, gateSignal);
          if (!graphNow || graphNow.authorityKey !== graph.authorityKey) {
            if (await hasCurrentRealization(graphNow, identity)) scheduleRefresh(current, identity);
            return null;
          }
          if (!(await authority.stillCurrent(graph, realization, gateSignal))) {
            if (await hasCurrentRealization(graphNow, identity)) scheduleRefresh(current, identity);
            return null;
          }
          // Entropy is drawn once, at this eligible event attempt. A retry
          // draws afresh; neither a stale resident graph nor an exception may
          // silently fall back to another weighted Version.
          const basisPoint = (options.basisPoint ?? (() => randomInt(10_000)))();
          let versionNow: WorkerdSelectedActiveVersion | null;
          try {
            versionNow = await selectedVersion(graph, realization, basisPoint);
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
          // Fence accepted graph and realization again after Version selection.
          // Pending deletion before this final graph read denies the callback.
          const stillCurrent = await authority.stillCurrent(graph, realization, gateSignal);
          gateSignal.throwIfAborted();
          const stillAuthorized =
            !stopped &&
            current.session === session &&
            !session.dead &&
            !session.retiring &&
            stillCurrent;
          if (!stillAuthorized) {
            if (
              await hasCurrentRealization(await authority.readGraph(identity, gateSignal), identity)
            )
              scheduleRefresh(current, identity);
            return null;
          }
          const leaseId = randomBytes(16).toString("hex");
          (kind === "alarm" ? session.alarmLeases : session.socketLeases).add(leaseId);
          session.active += 1;
          return {
            variantKey: variant.variantKey,
            generationKey: session.graph.generationKey,
            epoch: session.epoch,
            leaseId,
          };
        };
        try {
          if (revoked.has(key)) throw new ActorAuthorityUnavailable("Actor namespace revoked");
          process = await openWorkerdActorNamespace(options.binary, {
            namespaceKey: key,
            storagePath: join(options.storageRoot, "namespaces", key),
            className: graph.className,
            ...(graph.runtimeClassRef === undefined
              ? {}
              : { runtimeClassRef: graph.runtimeClassRef }),
            graph: residentGraph,
            signal,
            admitAlarm: (id, nonce, gateSignal) => admitEvent("alarm", id, nonce, gateSignal),
            completeAlarm(leaseId) {
              const session = admittedSession;
              if (!session?.alarmLeases.delete(leaseId)) return;
              release(session);
            },
            admitSocket: (id, nonce, gateSignal) => admitEvent("socket", id, nonce, gateSignal),
            completeSocket(leaseId) {
              const session = admittedSession;
              if (!session?.socketLeases.delete(leaseId)) return;
              release(session);
            },
          });
        } catch (error) {
          throw new ActorNativeStartUnavailable(error);
        }
        const session: Session = {
          selection,
          authorityGraph: graph,
          realization,
          graph: residentGraph,
          epoch: process.epoch,
          process,
          alarmLeases: new Set(),
          socketLeases: new Set(),
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
                  const warmed = await activate(identity, AbortSignal.timeout(30_000));
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
      if (warm) {
        try {
          signal.throwIfAborted();
          const candidate = current.session;
          if (
            stopped ||
            !candidate ||
            candidate.dead ||
            candidate.retiring ||
            !(await warm.stillAuthorized(signal))
          )
            throw new ActorAuthorityUnavailable("Actor warm candidate changed");
          // Native startup only; normal readGraph/stillCurrent remains the
          // sole gate for every application, alarm, and socket invocation.
          candidate.process.disableAlarmAdmission();
          const observation = await observeSession(
            identity,
            signal,
            async (session, checkSignal) =>
              acceptedOperationMatches(
                session.authorityGraph,
                session.realization,
                warm.expected,
              ) && (await warm.stillAuthorized(checkSignal)),
          );
          if (
            observation.kind !== "confirmed" ||
            !(await warm.stillAuthorized(signal)) ||
            current.session !== candidate
          )
            throw new ActorAuthorityUnavailable("Actor warm inspection unavailable");
          return { session: candidate, variantKey: "", observation };
        } catch (error) {
          // A failed candidate is not a Resource DELETE. Stop only the child
          // opened by this warm attempt; registration, ID index and Actor SQL
          // remain held for a later exact retry.
          await retire(current);
          throw error;
        }
      }
      // Retirement can wait on an old response stream, and native startup
      // can also yield. A Resource or publication selected before either
      // wait must not be dispatched afterward without another readback.
      const basisPoint = (options.basisPoint ?? (() => randomInt(10_000)))();
      const finalVersion = await selectedVersion(graph, realization, basisPoint);
      if (stopped || !(await authority.stillCurrent(graph, realization, signal))) {
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
          const acquired = await activate(scope, AbortSignal.timeout(30_000));
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

  const acceptedOperationMatches = (
    graph: ActorExecutionGraph,
    realization: ActorExecutionRealization,
    expected: ActorAcceptedOperationRuntimeTarget,
  ): boolean => {
    if (
      graph.workerUid !== expected.workerUid ||
      graph.className !== expected.className ||
      realization.graph.workerResourceUid !== expected.workerUid ||
      realization.graph.generationKey !== expected.generationKey ||
      !realization.script ||
      !expected.sourceOperationId ||
      !expected.incarnationId ||
      !Array.isArray(expected.versions)
    )
      return false;
    const parsed: unknown = JSON.parse(realization.authorityKey);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !==
        "generationKey,incarnationId,sourceOperationId,versions" ||
      record.sourceOperationId !== expected.sourceOperationId ||
      record.incarnationId !== expected.incarnationId ||
      record.generationKey !== expected.generationKey
    )
      return false;
    const residentVersions = realization.graph.versions.map(
      ({ versionId, workerVersionUid, weight }) => ({ versionId, workerVersionUid, weight }),
    );
    return (
      canonicalJson(record.versions) === canonicalJson(residentVersions) &&
      canonicalJson(expected.versions) === canonicalJson(residentVersions)
    );
  };

  const observeSession = async (
    scope: ActorScope,
    signal: AbortSignal,
    eligible: (session: Session, signal: AbortSignal) => Promise<boolean>,
  ): Promise<ActorNamespaceRuntimeObservation> => {
    const unknown = { kind: "unknown" } as const;
    try {
      await ready;
      signal.throwIfAborted();
      if (stopped || !validScope(scope)) return unknown;
      const key = keyOf(scope.tenantId, scope.namespaceResourceUid);
      const owner = owners.get(key);
      const session = owner?.session;
      if (
        revoked.has(key) ||
        owner?.revoked ||
        !session ||
        session.dead ||
        session.retiring ||
        !(await registeredScope(key, scope))
      )
        return unknown;
      const observationSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
      const current = async (): Promise<boolean> => {
        observationSignal.throwIfAborted();
        if (
          stopped ||
          revoked.has(key) ||
          owner.revoked ||
          owner.session !== session ||
          session.dead ||
          session.retiring ||
          !(await registeredScope(key, scope)) ||
          !(await eligible(session, observationSignal))
        )
          return false;
        observationSignal.throwIfAborted();
        return (
          !stopped &&
          !revoked.has(key) &&
          !owner.revoked &&
          owner.session === session &&
          !session.dead &&
          !session.retiring &&
          (await registeredScope(key, scope))
        );
      };
      if (!(await current())) return unknown;
      const ids = await readActorIds(key);
      const observeActor = session.process.observeActor;
      const probeRuntime = session.process.probeRuntime;
      if (!ids || !observeActor || !probeRuntime || !(await current())) return unknown;
      const readPass = async (): Promise<readonly WorkerdActorRuntimeObservation[]> => {
        await probeRuntime.call(session.process, observationSignal);
        const values: WorkerdActorRuntimeObservation[] = [];
        for (const id of ids) {
          observationSignal.throwIfAborted();
          const value = await observeActor.call(session.process, id, observationSignal);
          if (
            value.actorId !== id ||
            value.epoch !== session.epoch ||
            value.generationKey !== session.graph.generationKey
          )
            throw new Error("Actor native observation identity changed");
          values.push(value);
        }
        return values;
      };
      const before = await readPass();
      const observedAt = Date.now();
      const after = await readPass();
      if (
        !(await current()) ||
        JSON.stringify(ids) !== JSON.stringify(await readActorIds(key)) ||
        before.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(after[index]))
      )
        return unknown;
      return {
        kind: "confirmed",
        epoch: session.epoch,
        observedAt,
        activeActorCount: before.filter((entry) => entry.activeActor).length,
        pendingAlarmCount: before.reduce((count, entry) => count + entry.pendingAlarmCount, 0),
        openSocketCount: before.reduce((count, entry) => count + entry.openSocketCount, 0),
      };
    } catch {
      return unknown;
    }
  };

  return {
    ready,
    coldStartFailures: (): readonly ActorColdStartFailure[] =>
      [...coldStartFailures.values()].map((failure) => ({ ...failure })),
    /** Physical native observation only; no Form readiness or SQL acceptance claim. */
    async observeNamespaceRuntime(
      scope: ActorScope,
      signal: AbortSignal,
    ): Promise<ActorNamespaceRuntimeObservation> {
      return observeSession(scope, signal, async (session, observationSignal) => {
        if (
          !(await authority.stillCurrent(
            session.authorityGraph,
            session.realization,
            observationSignal,
          ))
        )
          return false;
        const realization = await currentRealization(session.authorityGraph, observationSignal);
        return (
          realization.kind === "ready" &&
          realization.realization.authorityKey === session.realization.authorityKey &&
          realization.realization.graph.generationKey === session.graph.generationKey
        );
      });
    },
    /** Physical read for a backend-held accepted Operation, not SQL authority or warm admission. */
    async observeNamespaceRuntimeForAcceptedOperation(
      scope: ActorScope,
      expected: ActorAcceptedOperationRuntimeTarget,
      signal: AbortSignal,
    ): Promise<ActorNamespaceRuntimeObservation> {
      try {
        const captured = structuredClone(expected);
        return observeSession(scope, signal, async (session) =>
          acceptedOperationMatches(session.authorityGraph, session.realization, captured),
        );
      } catch {
        return { kind: "unknown" };
      }
    },
    /** Initial native readback under a held accepted Operation; never admits an application event. */
    async warmNamespaceForAcceptedOperation(
      scope: ActorScope,
      candidate: ActorAcceptedOperationWarmCandidate,
      signal: AbortSignal,
    ): Promise<ActorNamespaceRuntimeObservation> {
      try {
        await ready;
        signal.throwIfAborted();
        if (stopped || !validScope(scope) || typeof candidate.stillAuthorized !== "function")
          return { kind: "unknown" };
        const captured: ActorAcceptedOperationWarmCandidate = {
          graph: structuredClone(candidate.graph),
          realization: structuredClone(candidate.realization),
          expected: structuredClone(candidate.expected),
          stillAuthorized: candidate.stillAuthorized,
        };
        if (
          captured.graph.scope.tenantId !== scope.tenantId ||
          captured.graph.scope.namespaceResourceUid !== scope.namespaceResourceUid ||
          !acceptedOperationMatches(captured.graph, captured.realization, captured.expected)
        )
          return { kind: "unknown" };
        const warmed = await activate({ ...scope }, signal, captured);
        return warmed.observation ?? { kind: "unknown" };
      } catch {
        return { kind: "unknown" };
      }
    },
    async readCurrentGraph(
      scope: ActorScope,
      signal: AbortSignal,
    ): Promise<ActorResourceGraph | null> {
      await ready;
      if (stopped || !validScope(scope)) return null;
      const identity = { ...scope };
      const graph = await authority.readGraph(identity, signal);
      if (!graph || !(await hasCurrentRealization(graph, identity))) return null;
      const again = await authority.readGraph(identity, signal);
      signal.throwIfAborted();
      if (!again || again.authorityKey !== graph.authorityKey) return null;
      const legacy = await authority.readLegacyGraph?.(identity, signal);
      return legacy && JSON.stringify(legacy) === graph.authorityKey ? legacy : null;
    },
    async registerNamespace(scope: ActorScope): Promise<void> {
      await ready;
      if (
        stopped ||
        !validScope(scope) ||
        revoked.has(keyOf(scope.tenantId, scope.namespaceResourceUid))
      ) {
        throw new Error("Actor namespace unavailable");
      }
      const key = keyOf(scope.tenantId, scope.namespaceResourceUid);
      let owner = owners.get(key);
      if (!owner) {
        owner = { tail: Promise.resolve(), locked: false };
        owners.set(key, owner);
      }
      await exclusive(owner, async () => {
        if (stopped || owner.revoked || revoked.has(key)) throw new Error("Actor owner stopped");
        await persistScope(key, { ...scope });
      });
    },
    async hasNamespace(scope: ActorScope): Promise<boolean> {
      await ready;
      if (!validScope(scope)) return false;
      const key = keyOf(scope.tenantId, scope.namespaceResourceUid);
      return registeredScope(key, scope);
    },
    /** Proves a registered namespace has never allocated native Actor data. */
    async namespaceEmpty(scope: ActorScope): Promise<boolean> {
      await ready;
      if (stopped || !validScope(scope)) return false;
      const key = keyOf(scope.tenantId, scope.namespaceResourceUid);
      const owner = owners.get(key);
      if (owner?.session || owner?.locked || !(await registeredScope(key, scope))) return false;
      const namespaces = join(options.storageRoot, "namespaces");
      const leases = join(options.storageRoot, "leases");
      if ((await pathExists(join(namespaces, key))) || (await pathExists(join(leases, key))))
        return false;
      // A page-cache miss is not an absence receipt across Host processes.
      for (const directory of [registrations, namespaces, leases]) {
        try {
          await syncDirectory(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return (
        !(owner?.session || owner?.locked) &&
        (await registeredScope(key, scope)) &&
        !(await pathExists(join(namespaces, key))) &&
        !(await pathExists(join(leases, key)))
      );
    },
    async namespaceAbsent(scope: ActorScope): Promise<boolean> {
      await ready;
      if (!validScope(scope)) return false;
      const key = keyOf(scope.tenantId, scope.namespaceResourceUid);
      const owner = owners.get(key);
      if (owner?.session || owner?.locked) return false;
      const absent = !(
        (await pathExists(registrationPath(key))) ||
        (await pathExists(join(options.storageRoot, "namespaces", key))) ||
        (await pathExists(join(options.storageRoot, "leases", key)))
      );
      if (!absent) return false;
      // A failed delete may have unlinked a lease without durably publishing
      // that directory change. Recovery must not ACK page-cache absence.
      for (const directory of [
        registrations,
        join(options.storageRoot, "namespaces"),
        join(options.storageRoot, "leases"),
      ]) {
        try {
          await syncDirectory(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return !(
        (await pathExists(registrationPath(key))) ||
        (await pathExists(join(options.storageRoot, "namespaces", key))) ||
        (await pathExists(join(options.storageRoot, "leases", key)))
      );
    },
    async forgetNamespace(scope: ActorScope): Promise<void> {
      await ready;
      if (stopped || !validScope(scope)) {
        throw new Error("Actor namespace unavailable");
      }
      const key = keyOf(scope.tenantId, scope.namespaceResourceUid);
      revoked.add(key);
      const owner = owners.get(key);
      const forget = async (): Promise<void> => {
        if (stopped) throw new Error("Actor owner stopped");
        if (owner?.session && owner.session.active > 0 && !owner.session.dead) {
          revoked.delete(key);
          throw new Error("Actor namespace has active executions");
        }
        // The canonical Resource deletion attestation must already have
        // withdrawn graph authority. A standalone owner call is not a
        // tombstone and may not destroy a still-live namespace.
        if (await authority.hasNamespaceAuthority(scope, AbortSignal.timeout(30_000))) {
          revoked.delete(key);
          throw new Error("Actor namespace still has Resource authority");
        }
        if (owner) owner.revoked = true;
        if (owner) await retire(owner);
        // Hold the cross-Host lease through registration and SQL removal.
        // Releasing it earlier would let a peer open the same native files.
        if (!owner?.locked) {
          await mkdir(join(options.storageRoot, "leases"), { recursive: true, mode: 0o700 });
          await syncDirectory(options.storageRoot);
          // An existing peer/stale lease fails closed; it is never stolen.
          await mkdir(join(options.storageRoot, "leases", key), { mode: 0o700 });
          await syncDirectory(join(options.storageRoot, "leases"));
          if (owner) owner.locked = true;
        }
        if (await registeredScope(key, scope)) {
          await unlink(registrationPath(key));
          await syncDirectory(registrations);
        }
        await options.beforeNamespaceStorageDelete?.();
        await rm(join(options.storageRoot, "namespaces", key), { recursive: true, force: true });
        try {
          await syncDirectory(join(options.storageRoot, "namespaces"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await rm(actorIdsDirectory(key), { recursive: true, force: true });
        try {
          await syncDirectory(actorIdsRoot);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await rm(join(options.storageRoot, "leases", key), { recursive: true });
        await options.afterLeaseUnlinkBeforeSync?.();
        await syncDirectory(join(options.storageRoot, "leases"));
        if (owner) owner.locked = false;
        coldStartFailures.delete(key);
        owners.delete(key);
      };
      if (owner) await exclusive(owner, forget);
      else await forget();
    },
    async fetch(scope: ActorScope & { readonly id: string }, request: Request): Promise<Response> {
      if (!scope.id || scope.id.includes("\u0000")) throw new Error("Actor namespace unavailable");
      await ready;
      // Capture caller-owned identity before any asynchronous resolution.
      const identity = { ...scope };
      await rememberActorId(identity);
      const acquired = await activate(
        { tenantId: identity.tenantId, namespaceResourceUid: identity.namespaceResourceUid },
        request.signal,
      );
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
    /**
     * Host-private duplex lease. The caller must have attested that `request`
     * came from the actual client upgrade ingress, not merely copied headers.
     * No token, target or lease is projected to application code.
     */
    async reserveDuplex(
      scope: ActorScope & { readonly id: string },
      request: Request,
    ): Promise<{
      readonly target: ReturnType<WorkerdActorNamespace["duplexTarget"]>;
      commit(): Promise<void>;
      commitTransport(bearer: string): Promise<void>;
      abandonTransport(bearer: string): Promise<void>;
      abandon(): void;
    }> {
      if (
        request.method !== "GET" ||
        request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
        !request.headers
          .get("connection")
          ?.toLowerCase()
          .split(",")
          .some((part) => part.trim() === "upgrade") ||
        !request.headers.get("sec-websocket-key") ||
        request.headers.get("sec-websocket-version") !== "13"
      )
        throw new Error("invalid_upgrade");
      if (!scope.id || scope.id.includes("\u0000")) throw new Error("Actor namespace unavailable");
      await ready;
      const identity = { ...scope };
      await rememberActorId(identity);
      const acquired = await activate(
        { tenantId: identity.tenantId, namespaceResourceUid: identity.namespaceResourceUid },
        request.signal,
      );
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal.removeEventListener("abort", finish);
        release(acquired.session);
      };
      // This lease spans the Actor's bounded fetch plus the separate 30s
      // outer handoff window; it must not expire before that handoff starts.
      const timer = setTimeout(finish, 65_000);
      request.signal.addEventListener("abort", finish, { once: true });
      if (request.signal.aborted) {
        finish();
        throw new Error("request_aborted");
      }
      try {
        const target = acquired.session.process.duplexTarget(identity.id, acquired.variantKey);
        const verifyAuthority = async (): Promise<void> => {
          if (settled) throw new Error("Actor socket reservation expired");
          const session = acquired.session;
          const residentNow = await currentRealization(session.authorityGraph, request.signal);
          request.signal.throwIfAborted();
          if (
            stopped ||
            session.dead ||
            session.retiring ||
            !(await authority.stillCurrent(
              session.authorityGraph,
              session.realization,
              request.signal,
            )) ||
            residentNow.kind !== "ready" ||
            residentNow.realization.graph.generationKey !== session.graph.generationKey ||
            settled
          )
            throw new ActorAuthorityUnavailable("Actor authority changed before upgrade");
        };
        return Object.freeze({
          target,
          async commit(): Promise<void> {
            try {
              await verifyAuthority();
            } finally {
              finish();
            }
          },
          async commitTransport(bearer: string): Promise<void> {
            try {
              await verifyAuthority();
              await acquired.session.process.settleDuplex(identity.id, bearer, "commit");
            } finally {
              finish();
            }
          },
          async abandonTransport(bearer: string): Promise<void> {
            try {
              await acquired.session.process.settleDuplex(identity.id, bearer, "abandon");
            } finally {
              finish();
            }
          },
          abandon: finish,
        });
      } catch (error) {
        finish();
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
              // Failed revocation retains its fence even during shutdown.
              if (owner.locked && !owner.revoked) {
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
