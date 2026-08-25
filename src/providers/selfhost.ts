import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonObject } from "../ports.ts";
import {
  type ApplyInput,
  failed,
  type Provider,
  type ProviderOffering,
  type ProviderRelation,
  type ProviderSqliteMigration,
  type ProviderSqliteMigrationIdentity,
  type ProviderTicket,
  type ProviderValue,
  type ResourceIdentity,
  succeeded,
} from "../provider-port.ts";
import type { WorkerdRuntime } from "../workerd-runtime.ts";

/**
 * Provisioning the released Takoform Edge Family on the machine this runs on.
 *
 * One provider, deliberately. A Worker Version that binds a KV namespace and a
 * bucket inherits the provider installation of every relation it pins, and the
 * driver refuses to bridge two installations — so a machine that sold its
 * buckets from one provider and its workers from another could never accept a
 * worker that uses both. Everything a self-hosted deployment executes locally
 * therefore lives behind this one id.
 *
 * What each Form honestly is here:
 *
 * - **ObjectBucket / EdgeKVNamespace / AtLeastOnceQueue** are namespaces. The
 *   data planes key their contents by resource uid, so creating one is
 *   agreeing that a name exists — the same promise Cloudflare charges per
 *   bucket for, with less machinery.
 * - **SQLiteDatabase** is a file under the data root. It appears when
 *   something writes to it, and the migration ledger below executes real SQL
 *   against it.
 * - **ModuleWorker / WorkerVersion / WorkerDeployment / WorkerEndpoint /
 *   WorkerCustomDomain** are executed for real: a version materializes its
 *   committed bundle to disk, a deployment publishes the winning version into
 *   the workerd runtime, and the endpoint and domain attachments decide which
 *   hostnames route to it. workerd cannot split traffic by percentage, so a
 *   weighted deployment serves its heaviest version and records the split it
 *   was asked for.
 * - **WorkerCronTrigger / QueueConsumer** are recorded declarations. This
 *   machine runs no scheduler and no queue pump yet; the aggregate rules that
 *   gate them on a serving deployment are enforced by the Host, and saying
 *   "recorded, not firing" here beats a scheduler nobody implemented.
 *
 * Version environment (`vars`, non-sensitive bindings) is recorded but not yet
 * projected into the workerd configuration; the runtime serves modules and
 * static assets. Sensitive names are rejected explicitly because this provider
 * has no runtime materialization authority.
 */

const SQLITE_MIGRATION_LEDGER = "_takoform_sqlite_migrations";
const SQLITE_MIGRATION_LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${SQLITE_MIGRATION_LEDGER} (
  sequence INTEGER PRIMARY KEY NOT NULL CHECK (sequence > 0),
  path TEXT NOT NULL UNIQUE CHECK (length(path) BETWEEN 1 AND 255),
  digest TEXT NOT NULL CHECK (
    substr(digest, 1, 7) = 'sha256:' AND length(digest) = 71 AND
    substr(digest, 8) NOT GLOB '*[^0-9a-f]*'
  )
)`;

export interface SelfhostArtifacts {
  /** The committed manifest a tenant holds, or null if it holds none. */
  manifest(
    tenantRef: string,
    digest: string,
  ): Promise<{
    readonly kind: string;
    readonly mainModule?: string;
    readonly modules?: readonly {
      readonly name: string;
      readonly mediaType?: string;
      readonly digest: string;
    }[];
    readonly files?: readonly {
      readonly path: string;
      readonly mediaType?: string;
      readonly digest: string;
    }[];
  } | null>;
  blob(digest: string): Promise<Uint8Array | null>;
}

export interface SelfhostProviderOptions {
  readonly id?: string;
  readonly offerings: readonly ProviderOffering[];
  /** Where databases, materialized versions, and script state live. */
  readonly dataRoot: string;
  /** The runtime deployments publish into. */
  readonly runtime: WorkerdRuntime;
  readonly artifacts: SelfhostArtifacts;
  /**
   * Suffix of the host-assigned Worker endpoint address
   * (`<script>.<suffix>`). `localhost` by default, because that is the one
   * name a self-hosted machine can honestly promise resolves to itself.
   */
  readonly workerEndpointSuffix?: string;
  /** Hostname suffixes custom domains may claim. Empty means any. */
  readonly suffixes?: readonly string[];
}

/** Publication state one script accumulates across the aggregate's Forms. */
interface ScriptState {
  readonly activeVersion?: string;
  readonly endpointHostname?: string;
  readonly domains: readonly string[];
}

interface VersionMeta {
  readonly mainModule: string;
  readonly assets?: { readonly notFoundHandling: string };
}

class SelfhostFailure extends Error {
  readonly ticket: ProviderTicket;
  constructor(ticket: ProviderTicket) {
    super("selfhost provider failure");
    this.ticket = ticket;
  }
}

export function createSelfhostProvider(options: SelfhostProviderOptions): Provider {
  const id = options.id ?? "local";
  const { runtime, artifacts, dataRoot } = options;
  const endpointSuffix = (options.workerEndpointSuffix ?? "localhost").toLowerCase();
  const versionsRoot = join(dataRoot, "selfhost", "versions");
  const scriptsRoot = join(dataRoot, "selfhost", "scripts");
  const databasesRoot = join(dataRoot, "databases");

  const serves = (hostname: string): boolean => {
    const suffixes = options.suffixes ?? [];
    if (suffixes.length === 0) return true;
    return suffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
  };

  // Derived from the address, so the same declaration always names the same
  // thing and a retry cannot make a second one. Legacy readable form for the
  // bucket namespace, hash form for everything DNS- or filename-shaped.
  const legacyName = (identity: ResourceIdentity): string =>
    `${identity.tenantRef}-${identity.space}-${identity.name}`.replace(/[^A-Za-z0-9_-]/gu, "_");

  const scriptOf = (
    tenantRef: string,
    resource: { readonly space: string; readonly name: string },
  ): Promise<string> =>
    derivedName("sw", { tenantRef, space: resource.space, name: resource.name });

  const versionIdOf = (
    tenantRef: string,
    resource: { readonly space: string; readonly name: string },
  ): Promise<string> => derivedName("v", { tenantRef, space: resource.space, name: resource.name });

  const databasePath = (name: string): string => join(databasesRoot, `${name}.sqlite`);

  const scriptStatePath = (script: string): string => join(scriptsRoot, `${script}.json`);

  const readScriptState = async (script: string): Promise<ScriptState> => {
    const raw = await readFile(scriptStatePath(script), "utf8").catch(() => null);
    if (raw === null) return { domains: [] };
    try {
      const parsed = JSON.parse(raw) as Partial<ScriptState>;
      return {
        ...(typeof parsed.activeVersion === "string"
          ? { activeVersion: parsed.activeVersion }
          : {}),
        ...(typeof parsed.endpointHostname === "string"
          ? { endpointHostname: parsed.endpointHostname }
          : {}),
        domains: Array.isArray(parsed.domains)
          ? parsed.domains.filter((entry): entry is string => typeof entry === "string")
          : [],
      };
    } catch {
      return { domains: [] };
    }
  };

  const writeScriptState = async (script: string, state: ScriptState): Promise<void> => {
    await mkdir(scriptsRoot, { recursive: true });
    await writeFile(scriptStatePath(script), JSON.stringify(state), "utf8");
  };

  /** Rewrites what workerd serves for one script from durable state alone. */
  const republish = async (script: string): Promise<void> => {
    const state = await readScriptState(script);
    if (!state.activeVersion) {
      await runtime.remove(script);
      await runtime.reload();
      return;
    }
    const versionDirectory = join(versionsRoot, script, state.activeVersion);
    const rawMeta = await readFile(join(versionDirectory, "meta.json"), "utf8").catch(() => null);
    if (rawMeta === null) {
      throw new SelfhostFailure(
        failed("provider_error", "the active Worker Version is not materialized on this machine"),
      );
    }
    const meta = JSON.parse(rawMeta) as VersionMeta;
    const modules = await readTree(join(versionDirectory, "modules"));
    const assets = meta.assets ? await readTree(join(versionDirectory, "assets")) : undefined;
    const hostnames = [
      ...(state.endpointHostname ? [state.endpointHostname] : []),
      ...state.domains,
    ];
    await runtime.write(
      script,
      {
        directory: script,
        mainModule: meta.mainModule,
        hostnames,
        ...(meta.assets ? { assets: { notFoundHandling: meta.assets.notFoundHandling } } : {}),
      },
      modules,
      assets,
    );
    await runtime.reload();
  };

  const endpointAddress = (script: string): { hostname: string; url: string } => {
    const hostname = `${script}.${endpointSuffix}`.toLowerCase();
    return { hostname, url: `https://${hostname}/` };
  };

  /** The one relation a pointer names, held to the expected target kind. */
  const relationResource = (
    relations: readonly ProviderRelation[] | undefined,
    pointer: string,
    kind: string,
  ): ProviderRelation["resource"] | null => {
    const relation = relations?.find((candidate) => candidate.pointer === pointer);
    return relation?.resource.kind === kind ? relation.resource : null;
  };

  /** A create mints a fresh native identity; an update keeps the recorded one. */
  const nativeId = (input: ApplyInput, base: string): string =>
    input.previous?.nativeId ?? `${base}:${input.operationId}`;

  const applyModuleWorker = async (input: ApplyInput): Promise<ProviderTicket> => {
    const script = await scriptOf(input.identity.tenantRef, {
      space: input.identity.space,
      name: input.identity.name,
    });
    return succeeded({
      nativeId: nativeId(input, `selfhost-worker:${script}`),
      observed: { scriptName: script, allocated: true },
      outputs: { scriptName: script },
    });
  };

  const applyWorkerVersion = async (input: ApplyInput): Promise<ProviderTicket> => {
    if (input.previous) return failed("invalid_spec", "Worker Versions are immutable");
    const requiredSensitive = input.spec.requiredSensitiveVars ?? [];
    if (
      !Array.isArray(requiredSensitive) ||
      requiredSensitive.some((name) => typeof name !== "string")
    ) {
      return failed("invalid_spec", "the sensitive Worker binding declaration is invalid");
    }
    if (requiredSensitive.length > 0) {
      return failed(
        "denied",
        "the sensitive Worker bindings have no runtime materialization authority",
      );
    }
    if (input.runtimeMaterialization) {
      return failed(
        "invalid_spec",
        "runtime materialization authority requires sensitive Worker bindings",
      );
    }
    const worker = relationResource(input.relations, "/worker", "ModuleWorker");
    const bundle = relationResource(input.relations, "/bundle", "WorkerBundle");
    const manifestDigest =
      typeof bundle?.spec.manifestDigest === "string" ? bundle.spec.manifestDigest : null;
    if (!worker || !manifestDigest) {
      return failed("invalid_spec", "the Worker Version is incomplete");
    }
    const script = await scriptOf(input.identity.tenantRef, worker.metadata);
    const versionId = await versionIdOf(input.identity.tenantRef, {
      space: input.identity.space,
      name: input.identity.name,
    });
    const manifest = await artifacts.manifest(input.identity.tenantRef, manifestDigest);
    if (!manifest || manifest.kind !== "WorkerBundle" || !manifest.mainModule) {
      return failed("invalid_spec", "the Worker Bundle is not available");
    }
    const modules = manifest.modules ?? [];
    if (modules.length === 0) return failed("invalid_spec", "the Worker Bundle has no modules");

    const directory = join(versionsRoot, script, versionId);
    // Replaced rather than merged, exactly like the runtime's own script
    // directories: a module the new materialization does not contain must not
    // survive from an earlier incarnation of the same name.
    await rm(directory, { recursive: true, force: true });
    for (const module of modules) {
      const bytes = await artifacts.blob(module.digest);
      if (!bytes) return failed("invalid_spec", `a declared module is missing: ${module.name}`);
      await writeTreeFile(join(directory, "modules"), module.name, bytes);
    }

    const assetsSpec =
      typeof input.spec.assets === "object" && input.spec.assets !== null
        ? (input.spec.assets as JsonObject)
        : null;
    let assetsMeta: VersionMeta["assets"];
    if (assetsSpec) {
      const assetBundle = relationResource(input.relations, "/assets/bundle", "StaticAssetBundle");
      const assetsDigest =
        typeof assetBundle?.spec.manifestDigest === "string"
          ? assetBundle.spec.manifestDigest
          : null;
      if (!assetsDigest) return failed("invalid_spec", "the Static Asset Bundle is unavailable");
      const assetManifest = await artifacts.manifest(input.identity.tenantRef, assetsDigest);
      const files = assetManifest?.files ?? [];
      if (!assetManifest || assetManifest.kind !== "StaticAssetBundle" || files.length === 0) {
        return failed("invalid_spec", "the Static Asset Bundle is unavailable");
      }
      for (const file of files) {
        const bytes = await artifacts.blob(file.digest);
        if (!bytes) return failed("invalid_spec", `a declared asset is missing: ${file.path}`);
        await writeTreeFile(join(directory, "assets"), file.path, bytes);
      }
      assetsMeta = {
        notFoundHandling:
          assetsSpec.notFoundHandling === "single_page_application"
            ? "single-page-application"
            : "none",
      };
    }

    // Written last: a version directory without a meta is not a version.
    const meta: VersionMeta = {
      mainModule: manifest.mainModule,
      ...(assetsMeta ? { assets: assetsMeta } : {}),
    };
    await writeFile(join(directory, "meta.json"), JSON.stringify(meta), "utf8");

    return succeeded({
      nativeId: nativeId(input, `selfhost-version:${script}:${versionId}`),
      observed: { scriptName: script, versionId },
      outputs: { scriptName: script, versionId },
    });
  };

  const applyWorkerDeployment = async (input: ApplyInput): Promise<ProviderTicket> => {
    const worker = relationResource(input.relations, "/worker", "ModuleWorker");
    const declared = Array.isArray(input.spec.versions) ? input.spec.versions : [];
    if (!worker || declared.length === 0) {
      return failed("invalid_spec", "the Worker Deployment is incomplete");
    }
    const script = await scriptOf(input.identity.tenantRef, worker.metadata);
    const weighted: { versionId: string; weight: number }[] = [];
    for (let index = 0; index < declared.length; index += 1) {
      const version = relationResource(
        input.relations,
        `/versions/${index}/workerVersion`,
        "WorkerVersion",
      );
      const entry =
        typeof declared[index] === "object" && declared[index] !== null
          ? (declared[index] as JsonObject)
          : null;
      const weight = Number.isSafeInteger(entry?.weight) ? Number(entry?.weight) : undefined;
      if (!version || weight === undefined) {
        return failed("invalid_spec", "a deployed version does not belong to this Worker");
      }
      weighted.push({
        versionId: await versionIdOf(input.identity.tenantRef, version.metadata),
        weight,
      });
    }
    // workerd routes whole requests, not basis points. The heaviest version
    // serves; the requested split is recorded so what was asked for and what
    // this machine can do are both visible.
    const active = weighted.reduce((best, entry) => (entry.weight > best.weight ? entry : best));
    const state = await readScriptState(script);
    await writeScriptState(script, { ...state, activeVersion: active.versionId });
    try {
      await republish(script);
    } catch (error) {
      if (error instanceof SelfhostFailure) return error.ticket;
      throw error;
    }
    return succeeded({
      nativeId: nativeId(input, `selfhost-deployment:${script}`),
      observed: { scriptName: script, activeVersionId: active.versionId, versions: weighted },
      outputs: {},
    });
  };

  const applyWorkerEndpoint = async (input: ApplyInput): Promise<ProviderTicket> => {
    const worker = relationResource(input.relations, "/worker", "ModuleWorker");
    if (!worker) return failed("invalid_spec", "the Worker Endpoint is incomplete");
    const script = await scriptOf(input.identity.tenantRef, worker.metadata);
    const address = endpointAddress(script);
    const state = await readScriptState(script);
    if (state.endpointHostname !== address.hostname) {
      await writeScriptState(script, { ...state, endpointHostname: address.hostname });
      if (state.activeVersion) {
        try {
          await republish(script);
        } catch (error) {
          if (error instanceof SelfhostFailure) return error.ticket;
          throw error;
        }
      }
    }
    return succeeded({
      nativeId: nativeId(input, `selfhost-endpoint:${script}`),
      observed: { enabled: true, scriptName: script },
      outputs: { hostname: address.hostname, url: address.url },
    });
  };

  const applyWorkerCustomDomain = async (input: ApplyInput): Promise<ProviderTicket> => {
    const worker = relationResource(input.relations, "/worker", "ModuleWorker");
    const hostname =
      typeof input.spec.hostname === "string"
        ? input.spec.hostname.toLowerCase().replace(/\.$/u, "")
        : null;
    if (!worker || !hostname) return failed("invalid_spec", "the custom domain is incomplete");
    if (!serves(hostname)) {
      return failed(
        "invalid_spec",
        `this deployment does not serve ${hostname}; it answers only for the suffixes it was configured with`,
      );
    }
    const script = await scriptOf(input.identity.tenantRef, worker.metadata);
    const state = await readScriptState(script);
    if (!state.domains.includes(hostname)) {
      await writeScriptState(script, { ...state, domains: [...state.domains, hostname] });
      if (state.activeVersion) {
        try {
          await republish(script);
        } catch (error) {
          if (error instanceof SelfhostFailure) return error.ticket;
          throw error;
        }
      }
    }
    return succeeded({
      nativeId: nativeId(input, `selfhost-domain:${hostname}`),
      observed: { hostname, scriptName: script },
      outputs: {},
    });
  };

  const applyWorkerCronTrigger = async (input: ApplyInput): Promise<ProviderTicket> => {
    const worker = relationResource(input.relations, "/worker", "ModuleWorker");
    const cron = typeof input.spec.cron === "string" ? input.spec.cron : null;
    if (!worker || !cron) return failed("invalid_spec", "the cron trigger is incomplete");
    const script = await scriptOf(input.identity.tenantRef, worker.metadata);
    return succeeded({
      nativeId: nativeId(input, `selfhost-cron:${script}`),
      // Recorded, not firing: this machine runs no scheduler yet.
      observed: { cron, scriptName: script, scheduled: false },
      outputs: {},
    });
  };

  const applyQueueConsumer = async (input: ApplyInput): Promise<ProviderTicket> => {
    const worker = relationResource(input.relations, "/worker", "ModuleWorker");
    const queue = relationResource(input.relations, "/queue", "AtLeastOnceQueue");
    if (!worker || !queue) return failed("invalid_spec", "the Queue Consumer is incomplete");
    const script = await scriptOf(input.identity.tenantRef, worker.metadata);
    const queueName = await derivedName("tsq", {
      tenantRef: input.identity.tenantRef,
      space: queue.metadata.space,
      name: queue.metadata.name,
    });
    return succeeded({
      nativeId: nativeId(input, `selfhost-consumer:${queueName}:${script}`),
      // Recorded, not pumping: this machine moves no queue messages yet.
      observed: { queueName, scriptName: script, delivering: false },
      outputs: {},
    });
  };

  const namespaceResult = async (
    kind: string,
    input: { identity: ResourceIdentity },
  ): Promise<{ base: string; observed: JsonObject; outputs: JsonObject }> => {
    switch (kind) {
      case "ObjectBucket":
      case "object_bucket": {
        const name = legacyName(input.identity);
        return {
          base: `local-bucket:${name}`,
          observed: { name },
          outputs: { protocol: "s3", bucketName: name },
        };
      }
      case "EdgeKVNamespace": {
        const name = await derivedName("tskv", input.identity);
        return {
          base: `selfhost-kv:${name}`,
          observed: { name },
          outputs: { namespaceId: name },
        };
      }
      case "AtLeastOnceQueue": {
        const name = await derivedName("tsq", input.identity);
        return {
          base: `selfhost-queue:${name}`,
          observed: { queueName: name },
          outputs: { queueId: name, queueName: name },
        };
      }
      case "SQLiteDatabase":
      case "sql_database": {
        const name = await derivedName("tsdb", input.identity);
        return {
          base: `selfhost-sqlite:${name}`,
          // Nothing is created eagerly: the file appears when something
          // writes to it, and reporting a path that does not exist yet would
          // be reporting a thing that is not there.
          observed: { name },
          outputs: { engine: "sqlite", path: databasePath(name) },
        };
      }
      default:
        throw new SelfhostFailure(
          failed("invalid_spec", `${kind} needs a runtime this deployment does not have`),
        );
    }
  };

  const dispatchKind = (offering: ProviderOffering): string => {
    if (
      offering.kind.startsWith("takoform.") &&
      (offering.form.apiVersion === "edge.forms.takoform.com/v1beta1" ||
        offering.form.apiVersion === "edge.forms.takoform.com")
    ) {
      return offering.form.kind;
    }
    return offering.kind;
  };

  return {
    id,
    offerings: structuredClone(options.offerings) as ProviderOffering[],

    async apply(input): Promise<ProviderTicket> {
      try {
        switch (dispatchKind(input.offering)) {
          case "ModuleWorker":
            return await applyModuleWorker(input);
          case "WorkerVersion":
            return await applyWorkerVersion(input);
          case "WorkerDeployment":
            return await applyWorkerDeployment(input);
          case "WorkerEndpoint":
            return await applyWorkerEndpoint(input);
          case "WorkerCustomDomain":
            return await applyWorkerCustomDomain(input);
          case "WorkerCronTrigger":
            return await applyWorkerCronTrigger(input);
          case "QueueConsumer":
            return await applyQueueConsumer(input);
          default: {
            // Namespaces have nothing mutable in their backend, so an update
            // confirms rather than changes. Saying so beats pretending work
            // happened.
            const made = await namespaceResult(dispatchKind(input.offering), input);
            return succeeded({
              nativeId: nativeId(input, made.base),
              observed: made.observed,
              outputs: made.outputs,
            });
          }
        }
      } catch (error) {
        if (error instanceof SelfhostFailure) return error.ticket;
        throw error;
      }
    },

    async observe(input): Promise<ProviderTicket> {
      try {
        switch (dispatchKind(input.offering)) {
          case "ModuleWorker": {
            const script = await scriptOf(input.identity.tenantRef, {
              space: input.identity.space,
              name: input.identity.name,
            });
            return succeeded({
              nativeId: input.nativeId,
              observed: { scriptName: script, allocated: true },
              outputs: { scriptName: script },
            });
          }
          case "WorkerVersion": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (!worker) return failed("not_found", "the Worker Version has no worker relation");
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const versionId = await versionIdOf(input.identity.tenantRef, {
              space: input.identity.space,
              name: input.identity.name,
            });
            const materialized = existsSync(join(versionsRoot, script, versionId, "meta.json"));
            return succeeded({
              nativeId: input.nativeId,
              observed: { scriptName: script, versionId, materialized },
              outputs: { scriptName: script, versionId },
            });
          }
          case "WorkerDeployment": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (!worker) return failed("not_found", "the Worker Deployment has no worker relation");
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const state = await readScriptState(script);
            return succeeded({
              nativeId: input.nativeId,
              observed: {
                scriptName: script,
                ...(state.activeVersion ? { activeVersionId: state.activeVersion } : {}),
                serving: await runtime.has(script),
              },
              outputs: {},
            });
          }
          case "WorkerEndpoint": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (!worker) return failed("not_found", "the Worker Endpoint has no worker relation");
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const address = endpointAddress(script);
            return succeeded({
              nativeId: input.nativeId,
              observed: { enabled: true, scriptName: script },
              outputs: { hostname: address.hostname, url: address.url },
            });
          }
          case "WorkerCustomDomain": {
            const hostname =
              typeof input.spec.hostname === "string"
                ? input.spec.hostname.toLowerCase().replace(/\.$/u, "")
                : null;
            if (!hostname) return failed("not_found", "the custom domain records no hostname");
            return succeeded({
              nativeId: input.nativeId,
              observed: { hostname },
              outputs: {},
            });
          }
          case "WorkerCronTrigger": {
            const cron = typeof input.spec.cron === "string" ? input.spec.cron : null;
            if (!cron) return failed("not_found", "the cron trigger records no expression");
            return succeeded({
              nativeId: input.nativeId,
              observed: { cron, scheduled: false },
              outputs: {},
            });
          }
          case "QueueConsumer":
            return succeeded({
              nativeId: input.nativeId,
              observed: { delivering: false },
              outputs: {},
            });
          default: {
            const made = await namespaceResult(dispatchKind(input.offering), input);
            return succeeded({
              nativeId: input.nativeId,
              observed: made.observed,
              outputs: made.outputs,
            });
          }
        }
      } catch (error) {
        if (error instanceof SelfhostFailure) return error.ticket;
        throw error;
      }
    },

    async delete(input): Promise<ProviderTicket> {
      const done = (): ProviderTicket =>
        succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} });
      try {
        switch (dispatchKind(input.offering)) {
          case "ModuleWorker": {
            const script = await scriptOf(input.identity.tenantRef, {
              space: input.identity.space,
              name: input.identity.name,
            });
            await runtime.remove(script);
            await rm(join(versionsRoot, script), { recursive: true, force: true });
            await rm(scriptStatePath(script), { force: true });
            await runtime.reload();
            return done();
          }
          case "WorkerVersion": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (worker) {
              const script = await scriptOf(input.identity.tenantRef, worker.metadata);
              const versionId = await versionIdOf(input.identity.tenantRef, {
                space: input.identity.space,
                name: input.identity.name,
              });
              const state = await readScriptState(script);
              await rm(join(versionsRoot, script, versionId), { recursive: true, force: true });
              if (state.activeVersion === versionId) {
                await writeScriptState(script, {
                  domains: state.domains,
                  ...(state.endpointHostname ? { endpointHostname: state.endpointHostname } : {}),
                });
                await republish(script);
              }
            }
            return done();
          }
          case "WorkerDeployment": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (worker) {
              const script = await scriptOf(input.identity.tenantRef, worker.metadata);
              const state = await readScriptState(script);
              await writeScriptState(script, {
                domains: state.domains,
                ...(state.endpointHostname ? { endpointHostname: state.endpointHostname } : {}),
              });
              await republish(script);
            }
            return done();
          }
          case "WorkerEndpoint": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (worker) {
              const script = await scriptOf(input.identity.tenantRef, worker.metadata);
              const state = await readScriptState(script);
              await writeScriptState(script, {
                domains: state.domains,
                ...(state.activeVersion ? { activeVersion: state.activeVersion } : {}),
              });
              if (state.activeVersion) await republish(script);
            }
            return done();
          }
          case "WorkerCustomDomain": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            const hostname =
              typeof input.spec?.hostname === "string"
                ? input.spec.hostname.toLowerCase().replace(/\.$/u, "")
                : null;
            if (worker && hostname) {
              const script = await scriptOf(input.identity.tenantRef, worker.metadata);
              const state = await readScriptState(script);
              await writeScriptState(script, {
                ...state,
                domains: state.domains.filter((entry) => entry !== hostname),
              });
              if (state.activeVersion) await republish(script);
            }
            return done();
          }
          default:
            // Namespaces, cron declarations, consumers, databases: the
            // lifecycle delete removes the declaration. Removing stored bytes
            // too is a reconciliation step, done deliberately and not inside
            // an apply.
            return done();
        }
      } catch (error) {
        if (error instanceof SelfhostFailure) return error.ticket;
        throw error;
      }
    },

    async adopt(input): Promise<ProviderTicket> {
      // Adoption records a claim on a native identity the caller names. Local
      // resources are namespace agreements keyed by declared identity, so the
      // adopted state is recomputed the same way apply computes it, while the
      // caller's native identity is held verbatim.
      const observed = await this.observe(input);
      if (observed.phase !== "succeeded") return observed;
      return succeeded({ ...observed.result, nativeId: input.nativeId });
    },

    sqliteMigrations: {
      readLedger: async (input: {
        readonly nativeId: string;
      }): Promise<ProviderValue<readonly ProviderSqliteMigrationIdentity[]>> => {
        const path = sqlitePathOf(input.nativeId, databasePath);
        if (!path) {
          return {
            ok: false,
            failure: {
              code: "invalid_spec",
              message: "the database identity is invalid",
              retryable: false,
            },
          };
        }
        if (!existsSync(path)) return { ok: true, value: [] };
        const database = new Database(path);
        try {
          const present = database
            .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .all(SQLITE_MIGRATION_LEDGER);
          if (present.length === 0) return { ok: true, value: [] };
          const rows = database
            .query(
              `SELECT sequence, path, digest FROM ${SQLITE_MIGRATION_LEDGER} ORDER BY sequence`,
            )
            .all() as { sequence: number; path: string; digest: string }[];
          const ledger: ProviderSqliteMigrationIdentity[] = [];
          for (const [index, row] of rows.entries()) {
            if (row.sequence !== index + 1 || !migrationPath(row.path) || !sha256(row.digest)) {
              return {
                ok: false,
                failure: {
                  code: "provider_error",
                  message: "the migration ledger is malformed",
                  retryable: false,
                },
              };
            }
            ledger.push({ path: row.path, digest: row.digest as `sha256:${string}` });
          }
          return { ok: true, value: ledger };
        } finally {
          database.close();
        }
      },
      applySuffix: async (input: {
        readonly nativeId: string;
        readonly expectedPrefix: readonly ProviderSqliteMigrationIdentity[];
        readonly migrations: readonly ProviderSqliteMigration[];
      }): Promise<ProviderValue<undefined>> => {
        const path = sqlitePathOf(input.nativeId, databasePath);
        if (!path) {
          return {
            ok: false,
            failure: {
              code: "invalid_spec",
              message: "the database identity is invalid",
              retryable: false,
            },
          };
        }
        if (input.migrations.length < 1 || input.migrations.length > 100) {
          return {
            ok: false,
            failure: {
              code: "invalid_spec",
              message: "the migration suffix is invalid",
              retryable: false,
            },
          };
        }
        const decoded: { path: string; digest: string; sql: string }[] = [];
        for (const migration of input.migrations) {
          if (!migrationPath(migration.path) || !sha256(migration.digest)) {
            return {
              ok: false,
              failure: {
                code: "invalid_spec",
                message: "a migration identity is invalid",
                retryable: false,
              },
            };
          }
          let sql: string;
          try {
            sql = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(migration.sql);
          } catch {
            return {
              ok: false,
              failure: {
                code: "invalid_spec",
                message: "a migration is not UTF-8 SQL",
                retryable: false,
              },
            };
          }
          if (sql.length === 0 || sql.length > 100_000) {
            return {
              ok: false,
              failure: {
                code: "invalid_spec",
                message: "a migration SQL statement is invalid",
                retryable: false,
              },
            };
          }
          decoded.push({ path: migration.path, digest: migration.digest, sql });
        }
        await mkdir(dirname(path), { recursive: true });
        const database = new Database(path, { create: true });
        try {
          database.exec("BEGIN IMMEDIATE");
          try {
            database.exec(SQLITE_MIGRATION_LEDGER_DDL);
            const rows = database
              .query(
                `SELECT sequence, path, digest FROM ${SQLITE_MIGRATION_LEDGER} ORDER BY sequence`,
              )
              .all() as { sequence: number; path: string; digest: string }[];
            const matches =
              rows.length === input.expectedPrefix.length &&
              rows.every(
                (row, index) =>
                  row.sequence === index + 1 &&
                  row.path === input.expectedPrefix[index]?.path &&
                  row.digest === input.expectedPrefix[index]?.digest,
              );
            if (!matches) {
              database.exec("ROLLBACK");
              return {
                ok: false,
                failure: {
                  code: "conflict",
                  message: "the database migration history moved",
                  retryable: false,
                },
              };
            }
            const insert = database.prepare(
              `INSERT INTO ${SQLITE_MIGRATION_LEDGER} (sequence, path, digest) VALUES (?, ?, ?)`,
            );
            for (const [offset, migration] of decoded.entries()) {
              database.exec(migration.sql);
              insert.run(
                input.expectedPrefix.length + offset + 1,
                migration.path,
                migration.digest,
              );
            }
            database.exec("COMMIT");
          } catch (error) {
            try {
              database.exec("ROLLBACK");
            } catch {
              // The transaction may have already been rolled back by SQLite.
            }
            return {
              ok: false,
              failure: {
                code: "provider_error",
                message: `a migration failed to apply: ${error instanceof Error ? error.message : "unknown"}`,
                retryable: false,
              },
            };
          }
          return { ok: true, value: undefined };
        } finally {
          database.close();
        }
      },
    },
  };
}

/** Reads every file under a directory into module-name → bytes. */
async function readTree(root: string): Promise<Map<string, Uint8Array>> {
  const result = new Map<string, Uint8Array>();
  const entries = await readdir(root, { withFileTypes: true, recursive: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parent = join(entry.parentPath ?? root);
    const path = join(parent, entry.name);
    const name = path
      .slice(root.length + 1)
      .split("\\")
      .join("/");
    result.set(name, new Uint8Array(await readFile(path)));
  }
  return result;
}

async function writeTreeFile(root: string, name: string, bytes: Uint8Array): Promise<void> {
  // Names come from a customer's bundle, so they are checked against escaping
  // the directory they are written into.
  if (name.includes("..") || name.startsWith("/")) {
    throw new SelfhostFailure(failed("invalid_spec", `unusable file name: ${name}`));
  }
  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

function sqlitePathOf(nativeId: string, databasePath: (name: string) => string): string | null {
  const parts = nativeId.split(":");
  if (parts[0] !== "selfhost-sqlite" || !parts[1] || !/^[A-Za-z0-9_-]+$/u.test(parts[1])) {
    return null;
  }
  return databasePath(parts[1]);
}

function migrationPath(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 255;
}

function sha256(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

async function derivedName(
  prefix: string,
  identity: { readonly tenantRef: string; readonly space: string; readonly name: string },
): Promise<string> {
  const bytes = new TextEncoder().encode(
    `${identity.tenantRef}\0${identity.space}\0${identity.name}`,
  );
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource),
  );
  const hex = [...digest.slice(0, 20)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex}`;
}
