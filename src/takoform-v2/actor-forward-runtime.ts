import { createHash, createHmac } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseActorAbiRef } from "../actor-abi-ref.ts";
import { canonicalJson } from "../json.ts";
import type { Sql } from "../ports.ts";
import type { createSelfhostActorExecutionHost } from "../selfhost-actor-execution-host.ts";
import { openSelfhostActorForwardBrokers } from "../selfhost-actor-forward-brokers.ts";
import { SELFHOST_SOCKET_DIRECTORY_PREFIX } from "../selfhost-socket-layout.ts";
import type {
  WorkerdActorForwardBinding,
  WorkerdActorForwardPublication,
  WorkerdActorForwardSocket,
} from "../workerd-runtime.ts";
import type {
  createV2ActorBindingAuthority,
  V2ActorBindingClaim,
} from "./actor-binding-authority.ts";
import { WORKER_VERSION_FORM_URL } from "./forms/worker-specs.ts";

type ActorBindingAuthority = Pick<
  ReturnType<typeof createV2ActorBindingAuthority>,
  "resolveCurrentBinding" | "recoverableBinding"
>;
type PhysicalActorHost = Pick<
  ReturnType<typeof createSelfhostActorExecutionHost>,
  "fetch" | "reserveDuplex"
>;

export interface V2ActorForwardIncarnationIdentity {
  readonly principal: string;
  readonly space: string;
  readonly workerUid: string;
  readonly sourceOperationId: string;
  readonly eventToken: string;
  readonly scriptName: string;
  /** Only a persisted native incarnation may select provisional restore. */
  readonly restoring?: true;
}

/** Host-private workerd binding; never a Resource output or tenant env secret. */
export interface V2IssuedActorForwardBinding {
  readonly publicName: string;
  readonly tenantId: string;
  readonly namespaceResourceUid: string;
  readonly className: string;
  readonly token: string;
  readonly runtimeClassRef: NonNullable<WorkerdActorForwardBinding["runtimeClassRef"]>;
}

/**
 * V2 publication uses the existing persisted incarnation event token and
 * resolves each forwarding grant through accepted v2 SQL before opening the
 * existing Host-owned private Actor transports.
 */
export function createV2ActorForwardBoot(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly authority: ActorBindingAuthority;
  readonly physical: PhysicalActorHost;
  readonly privateSocketDirectory: string;
  /** Shared Host restore barrier; no broker admits while any owner is unproved. */
  readonly canInvoke?: () => boolean;
}) {
  if (
    !options.sql ||
    !options.targetKey ||
    typeof options.authority?.resolveCurrentBinding !== "function" ||
    typeof options.authority?.recoverableBinding !== "function" ||
    typeof options.physical?.fetch !== "function" ||
    typeof options.physical?.reserveDuplex !== "function" ||
    !isAbsolute(options.privateSocketDirectory)
  ) {
    throw new TypeError("Actor forward boot requires exact authority, physical host, and root");
  }
  const authority = options.authority;
  const sql = options.sql;
  const physical = options.physical;
  const canInvoke = options.canInvoke ?? (() => true);
  const privateRoot = options.privateSocketDirectory;
  return Object.freeze({
    openIncarnation(source: V2ActorForwardIncarnationIdentity) {
      const identity = { ...source };
      const key = Buffer.from(identity.eventToken, "hex");
      if (
        !identity.principal ||
        !identity.space ||
        !identity.workerUid ||
        !identity.scriptName ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          identity.sourceOperationId,
        ) ||
        key.byteLength !== 32 ||
        key.toString("hex") !== identity.eventToken
      ) {
        throw new TypeError("Actor forward incarnation identity unavailable");
      }
      let closed = false;
      let restoring = identity.restoring === true;
      let pendingRestoredPublications: readonly WorkerdActorForwardPublication[] | null = null;
      let uncertain = false;
      let socketDirectory: string | null = null;
      let admitted = new Set<string>();
      const brokers = new Map<
        string,
        Awaited<ReturnType<typeof openSelfhostActorForwardBrokers>>
      >();
      const draining = new Set<{
        readonly key: string;
        readonly pair: Awaited<ReturnType<typeof openSelfhostActorForwardBrokers>>;
      }>();
      const everAdmitted = new WeakSet<
        Awaited<ReturnType<typeof openSelfhostActorForwardBrokers>>
      >();
      const reservations = new Map<string, number>();
      let brokerOrdinal = 0;
      let closing: Promise<void> | undefined;
      let serial: Promise<void> = Promise.resolve();
      const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
        const next = serial.then(operation, operation);
        serial = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      };
      const issueBinding = async (
        sourceClaim: V2ActorBindingClaim,
        bindingName: string,
      ): Promise<V2IssuedActorForwardBinding | null> => {
        if (closed || restoring) return null;
        const claim: V2ActorBindingClaim = {
          ...sourceClaim,
          bindings: sourceClaim.bindings.map((binding) => ({ ...binding })),
        };
        const name = bindingName;
        if (
          claim.principal !== identity.principal ||
          claim.space !== identity.space ||
          claim.workerUid !== identity.workerUid ||
          claim.bindings.filter((binding) => binding.name === name).length !== 1
        )
          return null;
        const resolved = await authority.resolveCurrentBinding(claim, name);
        const profile = resolved ? parseActorAbiRef(resolved.runtimeClassRef) : null;
        if (
          closed ||
          !resolved ||
          profile?.kind !== "v2" ||
          resolved.tenantId !== identity.principal
        )
          return null;
        const token = createHmac("sha256", key)
          .update(
            canonicalJson([
              "takoserver.v2-actor-forward-incarnation@1",
              identity.sourceOperationId,
              identity.scriptName,
              identity.workerUid,
              claim.workerVersionUid,
              claim.workerVersionOperationId,
              claim.nativeVersionId,
              name,
              resolved.namespaceResourceUid,
              resolved.vector,
            ]),
          )
          .digest("hex");
        return {
          publicName: name,
          tenantId: resolved.tenantId,
          namespaceResourceUid: resolved.namespaceResourceUid,
          className: resolved.className,
          token,
          runtimeClassRef: profile.ref,
        };
      };
      const bindingKey = (binding: {
        readonly tenantId: string;
        readonly namespaceResourceUid: string;
        readonly token: string;
      }) => canonicalJson([binding.tenantId, binding.namespaceResourceUid, binding.token]);

      const prove = async (publication: WorkerdActorForwardPublication) => {
        if (
          closed ||
          publication.script !== identity.scriptName ||
          publication.workerResourceUid !== identity.workerUid ||
          !publication.versionId ||
          !publication.workerVersionResourceUid ||
          publication.bindings.length > 64
        )
          throw new Error("Actor native publication identity unavailable");
        const rows = await sql.query(
          `SELECT spec_json, backend_id, generation FROM tf_v2_resources
           WHERE uid = ? AND form_url = ? AND principal = ? AND space = ?
             AND target_key = ? AND deleted_at IS NULL LIMIT 2`,
          [
            publication.workerVersionResourceUid,
            WORKER_VERSION_FORM_URL,
            identity.principal,
            identity.space,
            options.targetKey,
          ],
        );
        const version = rows.length === 1 ? rows[0] : null;
        if (
          !version ||
          typeof version.spec_json !== "string" ||
          typeof version.backend_id !== "string" ||
          typeof version.generation !== "number"
        )
          throw new Error("Actor Version operation unavailable");
        // The private publication records the native Version ID, not a second
        // Operation ledger. Resolve its immutable source from Core's accepted
        // operation history; current last_operation may be a same-spec PUT.
        const sources = await sql.query(
          `SELECT id, generation FROM tf_v2_operations
           WHERE resource_uid = ? AND principal = ? AND target_key = ? AND backend_id = ?
             AND action IN ('create','update') AND status = 'succeeded'
             AND effect = 'complete' AND accepted_spec_json = ? AND generation <= ?`,
          [
            publication.workerVersionResourceUid,
            identity.principal,
            options.targetKey,
            version.backend_id,
            version.spec_json,
            version.generation,
          ],
        );
        let operationId: string | null = null;
        for (const source of sources) {
          if (typeof source.id !== "string" || typeof source.generation !== "number") continue;
          const digest = createHash("sha256")
            .update(`${publication.workerVersionResourceUid}\u0000${source.generation}`)
            .digest("hex");
          if (publication.versionId !== `v2-${digest}`) continue;
          if (operationId !== null) throw new Error("Actor Version source ambiguous");
          operationId = source.id;
        }
        if (!operationId) throw new Error("Actor Version operation unavailable");
        const claim: V2ActorBindingClaim = {
          principal: identity.principal,
          space: identity.space,
          targetKey: options.targetKey,
          workerUid: identity.workerUid,
          workerVersionUid: publication.workerVersionResourceUid,
          workerVersionOperationId: operationId,
          nativeVersionId: publication.versionId,
          bindings: publication.bindings.map((binding) => ({
            name: binding.publicName,
            resourceUid: binding.namespaceResourceUid,
          })),
        };
        const proven: {
          readonly key: string;
          readonly binding: WorkerdActorForwardBinding;
          readonly claim: V2ActorBindingClaim;
        }[] = [];
        for (const binding of publication.bindings) {
          if (restoring) {
            if (
              binding.tenantId !== identity.principal ||
              binding.namespaceResourceUid === "" ||
              !/^[a-f0-9]{64}$/u.test(binding.token) ||
              parseActorAbiRef(binding.runtimeClassRef)?.kind !== "v2" ||
              !(await authority.recoverableBinding(claim, binding.publicName, binding))
            )
              throw new Error("retained Actor binding is not recoverable");
            proven.push({ key: bindingKey(binding), binding, claim });
            continue;
          }
          const issued = await issueBinding(claim, binding.publicName);
          if (
            !issued ||
            binding.tenantId !== issued.tenantId ||
            binding.namespaceResourceUid !== issued.namespaceResourceUid ||
            binding.token !== issued.token ||
            canonicalJson(binding.runtimeClassRef) !== canonicalJson(issued.runtimeClassRef)
          )
            throw new Error("Actor immutable Version relation changed");
          proven.push({ key: bindingKey(issued), binding, claim });
        }
        return proven;
      };

      const ensureSocketDirectory = async () => {
        if (socketDirectory) return socketDirectory;
        await mkdir(privateRoot, { recursive: true, mode: 0o700 });
        const info = await lstat(privateRoot);
        if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
          throw new Error("Actor private socket root unavailable");
        const canonical = await realpath(privateRoot);
        if (canonical !== privateRoot)
          throw new Error("Actor private socket root is not canonical");
        socketDirectory = await mkdtemp(
          join(privateRoot, SELFHOST_SOCKET_DIRECTORY_PREFIX.actorBrokers),
        );
        return socketDirectory;
      };

      const prepareGraph = async (publications: readonly WorkerdActorForwardPublication[]) => {
        if (closed) {
          if (publications.length === 0) return new Set<string>();
          throw new Error("Actor forward owner unavailable");
        }
        const requested = new Map<
          string,
          {
            readonly binding: WorkerdActorForwardBinding;
            readonly claim: V2ActorBindingClaim;
          }
        >();
        for (const publication of publications) {
          for (const item of await prove(publication)) {
            if (requested.has(item.key)) throw new Error("Actor binding duplicated");
            requested.set(item.key, item);
          }
        }
        const newKeys = [...requested.keys()].filter((key) => !brokers.has(key));
        if (brokers.size + draining.size + newKeys.length > 128)
          throw new Error("Actor forward capacity exceeded");
        const opened: [string, Awaited<ReturnType<typeof openSelfhostActorForwardBrokers>>][] = [];
        try {
          const root = newKeys.length > 0 ? await ensureSocketDirectory() : null;
          for (const key of newKeys) {
            const item = requested.get(key);
            if (!item || !root) throw new Error("Actor binding unavailable");
            const overlapping = [...draining].some((entry) => entry.key === key);
            const hash = createHash("sha256")
              .update(key)
              .update(overlapping ? `:${++brokerOrdinal}` : "")
              .digest("hex")
              .slice(0, 20);
            const httpSocketPath = join(root, `${hash}.h.sock`);
            const upgradeSocketPath = join(root, `${hash}.u.sock`);
            if (Buffer.byteLength(upgradeSocketPath) >= 100)
              throw new Error("Actor private socket path unavailable");
            const pair = await openSelfhostActorForwardBrokers({
              tenantId: item.binding.tenantId,
              namespaceResourceUid: item.binding.namespaceResourceUid,
              token: item.binding.token,
              httpSocketPath,
              upgradeSocketPath,
              executionHost: {
                async fetch(scope, request) {
                  if (!admitted.has(key) || !canInvoke())
                    throw new Error("Actor Version not active");
                  const current = await issueBinding(item.claim, item.binding.publicName);
                  if (!current || current.token !== item.binding.token)
                    throw new Error("Actor Version relation changed");
                  return physical.fetch(scope, request);
                },
                async reserveDuplex(scope, request) {
                  if (!admitted.has(key) || !canInvoke())
                    throw new Error("Actor Version not active");
                  const current = await issueBinding(item.claim, item.binding.publicName);
                  if (!current || current.token !== item.binding.token)
                    throw new Error("Actor Version relation changed");
                  return physical.reserveDuplex(scope, request);
                },
              },
            });
            opened.push([key, pair]);
          }
          for (const publication of publications) await prove(publication);
        } catch (error) {
          const results = await Promise.allSettled(opened.map(([, pair]) => pair.close()));
          results.forEach((result, index) => {
            if (result.status !== "rejected") return;
            const failed = opened[index];
            if (failed) draining.add({ key: failed[0], pair: failed[1] });
            uncertain = true;
            admitted = new Set();
          });
          throw error;
        }
        for (const [key, pair] of opened) brokers.set(key, pair);
        return new Set(requested.keys());
      };

      const cleanupInactive = async () => {
        if (closed || uncertain) return;
        for (const [key, pair] of brokers) {
          if (closed || uncertain) return;
          if (admitted.has(key) || (reservations.get(key) ?? 0) > 0) continue;
          brokers.delete(key);
          const entry = { key, pair };
          draining.add(entry);
          if (everAdmitted.has(pair)) {
            void pair.retire().then(
              () => draining.delete(entry),
              () => {
                uncertain = true;
                admitted = new Set();
              },
            );
          } else {
            try {
              await pair.close();
              draining.delete(entry);
            } catch (error) {
              uncertain = true;
              admitted = new Set();
              throw error;
            }
          }
        }
      };

      const actorForwardLifecycle = Object.freeze({
        prepare(publications: readonly WorkerdActorForwardPublication[]): Promise<void> {
          return exclusive(async () => {
            await prepareGraph(publications);
          });
        },
        reserve(publications: readonly WorkerdActorForwardPublication[]) {
          return exclusive(async () => {
            const keys = await prepareGraph(publications);
            for (const key of keys) reservations.set(key, (reservations.get(key) ?? 0) + 1);
            let released = false;
            return {
              release(): Promise<void> {
                return exclusive(async () => {
                  if (released) return;
                  released = true;
                  for (const key of keys) {
                    const remaining = (reservations.get(key) ?? 1) - 1;
                    if (remaining > 0) reservations.set(key, remaining);
                    else reservations.delete(key);
                  }
                  await cleanupInactive();
                });
              },
            };
          });
        },
        activated(publications: readonly WorkerdActorForwardPublication[]) {
          if (closed) return;
          if (restoring) {
            pendingRestoredPublications = structuredClone(publications);
            admitted = new Set();
            return;
          }
          const keys = new Set(
            publications.flatMap((publication) => publication.bindings.map(bindingKey)),
          );
          if ([...keys].some((key) => !brokers.has(key))) {
            uncertain = true;
            admitted = new Set();
            return;
          }
          admitted = keys;
          uncertain = false;
          for (const key of keys) {
            const pair = brokers.get(key);
            if (pair) everAdmitted.add(pair);
          }
          void exclusive(cleanupInactive).catch(() => {
            uncertain = true;
            admitted = new Set();
          });
        },
        uncertain() {
          uncertain = true;
          admitted = new Set();
        },
      });
      return Object.freeze({
        issueBinding,
        actorForwardLifecycle,
        completeRestoration(): Promise<void> {
          return exclusive(async () => {
            if (!restoring) return;
            const publications = pendingRestoredPublications;
            if (!publications || closed || uncertain)
              throw new Error("Actor restore graph unavailable");
            // No broker becomes callable until every retained token is reissued
            // by current caller SQL and the target's live native graph.
            restoring = false;
            try {
              const keys = await prepareGraph(publications);
              if ([...keys].some((key) => !brokers.has(key)))
                throw new Error("Actor restore broker unavailable");
              admitted = keys;
              pendingRestoredPublications = null;
            } catch (error) {
              uncertain = true;
              admitted = new Set();
              throw error;
            }
          });
        },
        actorForwardSockets(): readonly WorkerdActorForwardSocket[] {
          return closed ? [] : [...brokers.values()].map((pair) => pair.socketMapping);
        },
        close(): Promise<void> {
          if (!closing) {
            closed = true;
            admitted = new Set();
            closing = (async () => {
              await serial;
              const pairs = new Set([
                ...brokers.values(),
                ...[...draining].map((entry) => entry.pair),
              ]);
              const results = await Promise.allSettled([...pairs].map((pair) => pair.close()));
              if (results.some((result) => result.status === "rejected"))
                throw new Error("Actor forward broker close incomplete");
              if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
            })();
          }
          return closing;
        },
      });
    },
  });
}
