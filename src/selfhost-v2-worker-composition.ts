import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import type { Clock, ObjectStoreAccess, Sql } from "./ports.ts";
import {
  createSelfhostV2SqliteBindingBroker,
  type V2SqliteBindingGrant,
} from "./providers/selfhost-v2-sqlite-binding-broker.ts";
import type { SelfhostV2SQLiteStore } from "./providers/selfhost-v2-sqlite-store.ts";
import type { V2OperatorFormFactory } from "./takoform-v2/application.ts";
import type { V2ApplicationConfig } from "./takoform-v2/config.ts";
import { readV2ConfiguredPrivateInputs } from "./takoform-v2/configured-private-inputs.ts";
import { createV2HeldArtifactSource } from "./takoform-v2/forms/artifact-source.ts";
import { createSQLiteWorkerBindingAuthority } from "./takoform-v2/forms/sqlite-worker-binding-authority.ts";
import { createStaticAssetBundleCustody } from "./takoform-v2/forms/static-asset-bundle-backend.ts";
import { createWorkerBundleCustody } from "./takoform-v2/forms/worker-bundle-backend.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseWorkerDeploymentSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "./takoform-v2/forms/worker-specs.ts";
import { createWorkerCronTriggerAdmissionReader } from "./takoform-v2/worker-cron-trigger-backend.ts";
import { createWorkerDeploymentForm } from "./takoform-v2/worker-deployment-backend.ts";
import { createWorkerEndpointForm } from "./takoform-v2/worker-endpoint-backend.ts";
import {
  createInternalV2ModuleWorkerForm,
  createInternalV2WorkerVersionForm,
  createV2CodeConfiguredInputReader,
} from "./takoform-v2/worker-lifecycle-backend.ts";
import { createV2WorkerPublicationState } from "./takoform-v2/worker-publication-state.ts";
import { createV2WorkerdWorkerRuntimeReaders } from "./takoform-v2/worker-runtime-readers.ts";
import type { createV2WorkerVersionConfiguredInputSealer } from "./takoform-v2/worker-version-configured-inputs.ts";
import { spawnWorkerdWithParentDeath } from "./workerd-linux-process.ts";
import type { WorkerdProcess } from "./workerd-supervisor.ts";
import { createWorkerdWorkerModuleInspector } from "./workerd-worker-module-inspector.ts";
import {
  openWorkerdWorkerRuntimeOwner,
  type WorkerdWorkerRuntimeOwner,
} from "./workerd-worker-runtime-owner.ts";

type EndpointPorts = Pick<
  Parameters<typeof createWorkerEndpointForm>[0],
  "assignHostname" | "observeTls" | "observeRouteAbsent"
>;

export interface SelfhostV2WorkerCompositionOptions {
  readonly sql: Sql;
  readonly objects: ObjectStoreAccess;
  readonly clock: Clock;
  readonly config: V2ApplicationConfig;
  /** Private 0700 root, separate from the legacy shared Workerd graph. */
  readonly rootDirectory: string;
  readonly targetKey: string;
  /** Already selected and pinned by the normal Bun entry. */
  readonly workerdBinary: string | null;
  /** Already-created operator key authority; absent refuses sensitive Worker Versions. */
  readonly configuredInputSealer?: ReturnType<typeof createV2WorkerVersionConfiguredInputSealer>;
  /** Already-created Resource custody and pre-existing private signing authority. */
  readonly sqliteBinding?: {
    readonly store: SelfhostV2SQLiteStore;
    readonly signingKey: Uint8Array;
    /** Stable operator-selected loopback port, retained across Host restarts. */
    readonly privatePort: number;
  };
  /** Exact frontend authority; absent on the ordinary public entry today. */
  readonly endpoint?: EndpointPorts;
  /** Tests may substitute a child, but production uses parent-death-fenced Workerd. */
  readonly spawn?: (command: readonly string[]) => WorkerdProcess;
  readonly listenerPortForOperation?: (operationId: string) => number | Promise<number>;
}

function ownerKey(uid: string): string {
  return createHash("sha256").update(uid, "utf8").digest("hex");
}

async function unusedPrivatePort(excluded: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 503 }),
    });
    const port = Number(reservation.port);
    await reservation.stop(true);
    if (Number.isSafeInteger(port) && port > 0 && !excluded.has(port)) {
      excluded.add(port);
      return port;
    }
  }
  throw new Error("v2 Worker private listener allocation unavailable");
}

/**
 * One Bun process owns one private owner lock per accepted Worker UID. This
 * composition shares the normal application's SQL and held object store; it
 * neither adds a Resource ledger nor registers incomplete Worker Forms itself.
 */
export function createSelfhostV2WorkerComposition(options: SelfhostV2WorkerCompositionOptions): {
  restoreOwners(): Promise<readonly string[]>;
  ownerForWorkerUid(uid: string): Promise<WorkerdWorkerRuntimeOwner>;
  /** Close retired owners, then stop the private broker; active owners refuse. */
  closePrivateBindingServices(): Promise<void>;
  /** Internal acceptance seam only. The normal entry must not register it yet. */
  readonly internalFormFactory: V2OperatorFormFactory;
} {
  if (!options.targetKey || !options.rootDirectory || !options.sql || !options.objects) {
    throw new TypeError("v2 Worker composition requires SQL, objects, target and private root");
  }
  const { sql, objects, clock, config, targetKey } = options;
  if (
    options.sqliteBinding &&
    (options.sqliteBinding.store?.targetKey !== targetKey ||
      typeof options.sqliteBinding.store.withAuthorizedDatabase !== "function" ||
      !(options.sqliteBinding.signingKey instanceof Uint8Array) ||
      options.sqliteBinding.signingKey.byteLength < 32 ||
      !Number.isSafeInteger(options.sqliteBinding.privatePort) ||
      options.sqliteBinding.privatePort < 1 ||
      options.sqliteBinding.privatePort > 65_535)
  ) {
    throw new TypeError("v2 SQLite binding requires exact store, private key and fixed port");
  }
  // A caller cannot retarget the private listener, signing bytes, or custody
  // methods between factory construction and the first owner restoration.
  const sqliteBinding = options.sqliteBinding
    ? Object.freeze({
        store: Object.freeze({ ...options.sqliteBinding.store }),
        signingKey: new Uint8Array(options.sqliteBinding.signingKey),
        privatePort: options.sqliteBinding.privatePort,
      })
    : undefined;
  const suppliedSealer = options.configuredInputSealer;
  if (
    suppliedSealer &&
    (typeof suppliedSealer.seal !== "function" ||
      typeof suppliedSealer.open !== "function" ||
      typeof suppliedSealer.compare !== "function")
  ) {
    throw new TypeError("v2 Worker configured input sealer is incomplete");
  }
  // Keep admission and runtime on the same methods selected at boot. The
  // sealer's compare() calls this.open(), so bind it to this frozen snapshot.
  const configuredInputSealer = suppliedSealer
    ? Object.freeze({
        seal: suppliedSealer.seal.bind(suppliedSealer),
        open: suppliedSealer.open.bind(suppliedSealer),
        compare: suppliedSealer.compare,
      })
    : undefined;
  const configuredInputCustody = configuredInputSealer
    ? {
        read: (identity: Parameters<typeof readV2ConfiguredPrivateInputs>[1]) =>
          readV2ConfiguredPrivateInputs(sql, identity),
      }
    : undefined;
  const configuredInputs =
    configuredInputSealer && configuredInputCustody
      ? createV2CodeConfiguredInputReader({
          sql,
          sealer: configuredInputSealer,
          custody: configuredInputCustody,
        })
      : undefined;
  const bundleCustody = config.workerBundle
    ? createWorkerBundleCustody({
        sql,
        source: createV2HeldArtifactSource({
          objects,
          entries: config.workerBundle.heldArtifacts,
        }),
      })
    : undefined;
  const assetCustody = config.staticAssetBundle
    ? createStaticAssetBundleCustody({
        sql,
        source: createV2HeldArtifactSource({
          objects,
          entries: config.staticAssetBundle.heldArtifacts,
        }),
      })
    : undefined;
  const publicationState = createV2WorkerPublicationState({
    sql,
    now: clock,
    ...(bundleCustody ? { bundleCustody } : {}),
    ...(assetCustody ? { assetCustody } : {}),
  });
  const inspectModule = createWorkerdWorkerModuleInspector({
    binary: options.workerdBinary,
  }).inspect;
  const owners = new Map<string, Promise<WorkerdWorkerRuntimeOwner>>();
  const sqliteAuthority = sqliteBinding
    ? createSQLiteWorkerBindingAuthority({ sql, targetKey })
    : undefined;
  const sqliteBroker =
    sqliteBinding && sqliteAuthority
      ? createSelfhostV2SqliteBindingBroker({
          store: sqliteBinding.store,
          signingKey: sqliteBinding.signingKey,
          resolveCurrentBinding: sqliteAuthority.resolveCurrentBinding,
          async observeVersionTarget(input) {
            try {
              if (!restorationComplete) return { kind: "unknown" };
              const owner = await openOwner(input.workerUid);
              return await owner.observeVersionTarget(input);
            } catch {
              return { kind: "unknown" };
            }
          },
          async graphStillCurrent(grant) {
            return await sqliteGrantGraphStillCurrent(grant);
          },
        })
      : undefined;
  const sqliteBoot =
    sqliteBinding && sqliteBroker && sqliteAuthority
      ? Object.freeze({
          address: `127.0.0.1:${sqliteBinding.privatePort}`,
          issueGrant: sqliteBroker.issueGrant,
          resolveCurrentBinding: sqliteAuthority.resolveCurrentBinding,
        })
      : undefined;
  let sqliteServer: ReturnType<typeof Bun.serve> | undefined;
  const reservedPorts = new Set<number>();
  const listenerPortForOperation =
    options.listenerPortForOperation ?? (() => unusedPrivatePort(reservedPorts));
  const spawn =
    options.spawn ??
    ((command: readonly string[]) =>
      spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "ignore" }));
  let restoration: Promise<readonly string[]> | undefined;
  let restorationComplete = false;

  async function sqliteGrantGraphStillCurrent(grant: V2SqliteBindingGrant): Promise<boolean> {
    try {
      if (!restorationComplete || grant.targetKey !== targetKey) return false;
      const owner = await openOwner(grant.workerUid);
      const nativeTarget = {
        workerUid: grant.workerUid,
        versionId: grant.nativeVersionId,
        incarnationId: grant.incarnationId,
        servingSourceOperationId: grant.servingSourceOperationId,
      };
      const observedTarget = await owner.observeVersionTarget(nativeTarget);
      if (
        observedTarget.kind !== "confirmed" ||
        observedTarget.workerUid !== grant.workerUid ||
        observedTarget.versionId !== grant.nativeVersionId ||
        observedTarget.incarnationId !== grant.incarnationId ||
        observedTarget.servingSourceOperationId !== grant.servingSourceOperationId
      )
        return false;
      let beforeServing =
        observedTarget.status === "active"
          ? await owner.observeServing({ workerResourceUid: grant.workerUid, targetKey })
          : null;
      if (
        beforeServing &&
        (beforeServing.kind !== "serving" ||
          beforeServing.sourceOperationId !== grant.servingSourceOperationId ||
          !beforeServing.versions.some(
            (version) => version.workerVersionUid === grant.workerVersionUid,
          ))
      ) {
        const transitioned = await owner.observeVersionTarget(nativeTarget);
        if (
          transitioned.kind !== "confirmed" ||
          transitioned.status !== "draining" ||
          transitioned.workerUid !== grant.workerUid ||
          transitioned.versionId !== grant.nativeVersionId ||
          transitioned.incarnationId !== grant.incarnationId ||
          transitioned.servingSourceOperationId !== grant.servingSourceOperationId
        )
          return false;
        beforeServing = null;
      }

      // The grant is minted only from a preflighted accepted publication and
      // bound to one native owner incarnation. A pending replacement may make
      // current-serving SQL unavailable *before* that old owner drains. Existing
      // contexts still retain their selected Version through both states; this
      // gate cannot admit a new invocation or select a stale Version for one.
      if (!sqliteAuthority || grant.bindings.length === 0) return false;
      const worker = await sql.query(
        `SELECT uid FROM tf_v2_resources
         WHERE uid = ? AND form_url = ? AND principal = ? AND space = ?
           AND target_key = ? AND deleted_at IS NULL`,
        [grant.workerUid, MODULE_WORKER_FORM_URL, grant.principal, grant.space, targetKey],
      );
      if (worker.length !== 1 || worker[0]?.uid !== grant.workerUid) return false;
      for (const binding of grant.bindings) {
        const current = await sqliteAuthority.resolveCurrentBinding(grant, binding.name);
        if (current?.resourceUid !== binding.resourceUid) return false;
      }
      const afterTarget = await owner.observeVersionTarget(nativeTarget);
      if (
        afterTarget.kind !== "confirmed" ||
        (observedTarget.status === "draining" && afterTarget.status !== "draining") ||
        (afterTarget.status !== "active" && afterTarget.status !== "draining") ||
        afterTarget.workerUid !== observedTarget.workerUid ||
        afterTarget.versionId !== observedTarget.versionId ||
        afterTarget.incarnationId !== observedTarget.incarnationId ||
        afterTarget.servingSourceOperationId !== observedTarget.servingSourceOperationId
      )
        return false;
      if (afterTarget.status === "draining") return true;
      if (!beforeServing) return false;
      const afterServing = await owner.observeServing({
        workerResourceUid: grant.workerUid,
        targetKey,
      });
      const finalTarget = await owner.observeVersionTarget(nativeTarget);
      if (
        finalTarget.kind === "confirmed" &&
        finalTarget.status === "draining" &&
        finalTarget.workerUid === grant.workerUid &&
        finalTarget.versionId === grant.nativeVersionId &&
        finalTarget.incarnationId === grant.incarnationId &&
        finalTarget.servingSourceOperationId === grant.servingSourceOperationId
      )
        return true;
      return (
        afterServing.kind === "serving" &&
        JSON.stringify(afterServing) === JSON.stringify(beforeServing) &&
        finalTarget.kind === "confirmed" &&
        finalTarget.status === "active" &&
        finalTarget.workerUid === grant.workerUid &&
        finalTarget.versionId === grant.nativeVersionId &&
        finalTarget.incarnationId === grant.incarnationId &&
        finalTarget.servingSourceOperationId === grant.servingSourceOperationId
      );
    } catch {
      return false;
    }
  }

  async function openOwner(
    uid: string,
    allowRetiredSqlResource = false,
  ): Promise<WorkerdWorkerRuntimeOwner> {
    if (!uid || uid.length > 256) throw new TypeError("invalid Worker UID");
    const existing = owners.get(uid);
    if (existing) return await existing;
    const opening = (async () => {
      const rows = await sql.query(
        `SELECT uid, deleted_at FROM tf_v2_resources
         WHERE uid = ? AND form_url = ? AND target_key = ?`,
        [uid, MODULE_WORKER_FORM_URL, targetKey],
      );
      if (
        rows.length !== 1 ||
        rows[0]?.uid !== uid ||
        (!allowRetiredSqlResource && rows[0]?.deleted_at !== null)
      ) {
        throw new Error("v2 Worker UID is not current in this Host target");
      }
      return await openWorkerdWorkerRuntimeOwner({
        rootDirectory: options.rootDirectory,
        workerResourceUid: uid,
        targetKey,
        publicationState,
        ...(configuredInputs ? { configuredInputs } : {}),
        ...(sqliteBoot ? { v2SqliteBinding: sqliteBoot } : {}),
        workerdBinary: options.workerdBinary,
        inspectModule,
        listenerPortForOperation,
        spawn,
      });
    })();
    owners.set(uid, opening);
    try {
      return await opening;
    } catch (error) {
      if (owners.get(uid) === opening) owners.delete(uid);
      throw error;
    }
  }

  async function restore(): Promise<readonly string[]> {
    await mkdir(options.rootDirectory, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(options.rootDirectory);
    const canonicalRoot = await realpath(options.rootDirectory);
    const canonicalInfo = await lstat(canonicalRoot);
    if (
      !rootInfo.isDirectory() ||
      rootInfo.isSymbolicLink() ||
      (rootInfo.mode & 0o077) !== 0 ||
      !canonicalInfo.isDirectory() ||
      (canonicalInfo.mode & 0o077) !== 0
    ) {
      throw new Error("v2 Worker owner root is not private");
    }
    const workers = await sql.query(
      `SELECT uid, observed_json FROM tf_v2_resources
       WHERE form_url = ? AND target_key = ?`,
      [MODULE_WORKER_FORM_URL, targetKey],
    );
    const byOwnerKey = new Map<string, string>();
    const expectedServing = new Set<string>();
    for (const row of workers) {
      if (typeof row.uid !== "string" || typeof row.observed_json !== "string") {
        throw new Error("v2 Worker inventory is malformed");
      }
      const observed: unknown = JSON.parse(row.observed_json);
      if (!observed || typeof observed !== "object" || Array.isArray(observed)) {
        throw new Error("v2 Worker observation is malformed");
      }
      byOwnerKey.set(ownerKey(row.uid), row.uid);
      if (
        (observed as Record<string, unknown>).activeDeploymentUid !== null &&
        (observed as Record<string, unknown>).activeDeploymentUid !== undefined
      ) {
        expectedServing.add(ownerKey(row.uid));
      }
    }
    const deployments = await sql.query(
      `SELECT spec_json FROM tf_v2_resources
       WHERE form_url = ? AND target_key = ? AND deleted_at IS NULL
         AND json_extract(observed_json, '$.active') = 1`,
      [WORKER_DEPLOYMENT_FORM_URL, targetKey],
    );
    for (const row of deployments) {
      if (typeof row.spec_json !== "string") throw new Error("v2 Deployment inventory malformed");
      const workerUid = parseWorkerDeploymentSpec(JSON.parse(row.spec_json)).worker.resourceUid;
      expectedServing.add(ownerKey(workerUid));
    }
    const entries = await readdir(canonicalRoot, { withFileTypes: true });
    const names = new Set(entries.map((entry) => entry.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || !byOwnerKey.has(entry.name)) {
        throw new Error("v2 Worker owner namespace is not explained by current SQL");
      }
    }
    for (const key of expectedServing) {
      if (!names.has(key)) throw new Error("v2 Worker serving owner is missing");
    }
    if (sqliteBroker && sqliteBinding) {
      sqliteServer = Bun.serve({
        hostname: "127.0.0.1",
        port: sqliteBinding.privatePort,
        async fetch(request) {
          return (await sqliteBroker.handle(request)) ?? new Response(null, { status: 404 });
        },
      });
      if (sqliteServer.port !== sqliteBinding.privatePort) {
        await sqliteServer.stop(true);
        sqliteServer = undefined;
        throw new Error("v2 SQLite private listener address changed");
      }
    }
    const restored: string[] = [];
    try {
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const uid = byOwnerKey.get(entry.name);
        if (!uid) throw new Error("v2 Worker owner inventory changed");
        await openOwner(uid, true);
        restored.push(uid);
      }
    } catch (error) {
      await sqliteServer?.stop(true);
      sqliteServer = undefined;
      throw error;
    }
    restorationComplete = true;
    return restored;
  }

  const readers = createV2WorkerdWorkerRuntimeReaders({
    ownerForWorkerUid: async (uid) => {
      if (!restoration) return null;
      await restoration;
      return await openOwner(uid);
    },
  });
  const internalFormFactory: V2OperatorFormFactory = (context) => {
    if (context.sql !== sql || context.objects !== objects || context.clock !== clock) {
      throw new TypeError(
        "v2 Worker Forms must use this application's exact SQL, objects and clock",
      );
    }
    if (!restorationComplete)
      throw new TypeError("v2 Worker owners must restore before Form composition");
    if (
      !options.endpoint?.assignHostname ||
      !options.endpoint.observeTls ||
      !options.endpoint.observeRouteAbsent
    ) {
      throw new TypeError("v2 Worker Endpoint frontend proof is not composed");
    }
    return {
      [MODULE_WORKER_FORM_URL]: createInternalV2ModuleWorkerForm({
        sql,
        targetKey,
        ...readers,
      }),
      [WORKER_VERSION_FORM_URL]: createInternalV2WorkerVersionForm({
        sql,
        targetKey,
        publicationState,
        retirement: readers.retirement,
        inspectModule,
        ...(sqliteBoot ? { v2SqliteBinding: sqliteBoot } : {}),
        ...(configuredInputSealer && configuredInputCustody
          ? { configuredInputSealer, configuredInputCustody }
          : {}),
      }),
      [WORKER_DEPLOYMENT_FORM_URL]: createWorkerDeploymentForm({
        targetKey,
        publicationState,
        scheduledAttachments: createWorkerCronTriggerAdmissionReader({ sql }),
        ownerForWorker: async (uid) => {
          await restoration;
          return await openOwner(uid);
        },
      }),
      [WORKER_ENDPOINT_FORM_URL]: createWorkerEndpointForm({
        targetKey,
        publicationState,
        ownerForWorker: async (uid) => {
          await restoration;
          return await openOwner(uid);
        },
        ...options.endpoint,
      }),
    };
  };

  return {
    restoreOwners() {
      restoration ??= restore();
      return restoration;
    },
    async ownerForWorkerUid(uid) {
      if (!restoration) throw new Error("v2 Worker owners have not restored");
      await restoration;
      return await openOwner(uid);
    },
    async closePrivateBindingServices() {
      if (!sqliteServer) return;
      // A private companion address is pinned in every live native graph.
      // Refuse to remove it while any owner still has an active/draining copy.
      for (const opening of owners.values()) await (await opening).close();
      await sqliteServer?.stop(true);
      sqliteServer = undefined;
    },
    internalFormFactory,
  };
}
