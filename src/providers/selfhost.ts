import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonObject } from "../ports.ts";
import {
  type ApplyInput,
  failed,
  PROVIDER_READBACK_API_VERSION,
  type Provider,
  type ProviderNativeAbsence,
  type ProviderNativeAbsenceUnknownReason,
  type ProviderNativeReadbackDescriptor,
  type ProviderNativeReadbackInput,
  type ProviderOffering,
  ProviderReadbackDescriptorError,
  type ProviderRelation,
  type ProviderSqliteMigration,
  type ProviderSqliteMigrationIdentity,
  type ProviderTicket,
  type ProviderValue,
  type ResourceIdentity,
  succeeded,
} from "../provider-port.ts";
import {
  canonicalWorkerEndpointOrigin,
  derivedProviderResourceName,
} from "../provider-worker-endpoint-origin.ts";
import type { WorkerdRuntime } from "../workerd-runtime.ts";
import {
  createSelfhostScriptStateStore,
  type SelfhostScriptState,
  type SelfhostScriptStateSnapshot,
  SelfhostScriptStateStoreError,
} from "./selfhost-script-state.ts";
import {
  createSelfhostVersionBindingStore,
  type SelfhostVersionBinding,
  type SelfhostVersionBindingSet,
  SelfhostVersionBindingStoreError,
  type StoredSelfhostVersionBindings,
} from "./selfhost-version-bindings.ts";
import {
  createSelfhostVersionMaterializer,
  SelfhostVersionMaterializationError,
  type SelfhostVersionMaterializationRequest,
} from "./selfhost-version-materialization.ts";

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
 * A version's `vars` are projected into the workerd configuration as ordinary
 * environment bindings, kept in a `0600` record beside — never inside — the
 * immutable version directory, whose digest means "the bytes the tenant
 * committed" and must not move because a variable did.
 */

const MAX_WORKER_VERSION_VARS = 64;
const WORKER_VERSION_VAR_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;

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
  const versionBindingsRoot = join(dataRoot, "selfhost", "version-bindings");
  const databasesRoot = join(dataRoot, "databases");
  const scriptStates = createSelfhostScriptStateStore({ root: scriptsRoot });
  const versionBindings = createSelfhostVersionBindingStore({ root: versionBindingsRoot });
  const versionMaterializer = createSelfhostVersionMaterializer({
    root: versionsRoot,
    artifacts,
  });
  const inspectVersion = async (script: string, versionId: string) => {
    try {
      return await versionMaterializer.inspect({ script, versionId });
    } catch (error) {
      if (error instanceof SelfhostVersionMaterializationError) {
        throw new SelfhostFailure(
          failed(error.code, materializationMessage(error), error.code === "unavailable"),
        );
      }
      throw error;
    }
  };

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
    derivedProviderResourceName("sw", {
      tenantRef,
      space: resource.space,
      name: resource.name,
    });

  const versionIdOf = (
    tenantRef: string,
    resource: { readonly space: string; readonly name: string },
  ): Promise<string> =>
    derivedProviderResourceName("v", {
      tenantRef,
      space: resource.space,
      name: resource.name,
    });

  const databasePath = (name: string): string => join(databasesRoot, `${name}.sqlite`);

  const scriptStateOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof SelfhostScriptStateStoreError)) throw error;
      if (error.code === "conflict") {
        throw new SelfhostFailure(
          failed("conflict", "the Worker script state changed concurrently", true),
        );
      }
      if (error.code === "corrupt") {
        throw new SelfhostFailure(
          failed("provider_error", "the durable Worker script state is malformed"),
        );
      }
      throw new SelfhostFailure(
        failed("unavailable", "the durable Worker script state is unavailable", true),
      );
    }
  };

  // Runtime publication is an adapter boundary too. A write or reload that
  // throws is not evidence that the durable desired state was rejected, so
  // surface it as a retryable provider outcome and let the next reconcile
  // replay the publication from script state.
  const runtimeOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SelfhostFailure) throw error;
      throw new SelfhostFailure(failed("unavailable", "the Worker runtime is unavailable", true));
    }
  };

  const bindingStoreOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof SelfhostVersionBindingStoreError)) throw error;
      if (error.code === "corrupt") {
        throw new SelfhostFailure(
          failed("provider_error", "the durable Worker Version bindings are malformed"),
        );
      }
      throw new SelfhostFailure(
        failed("unavailable", "the durable Worker Version bindings are unavailable", true),
      );
    }
  };

  const readVersionBindings = (
    script: string,
    versionId: string,
  ): Promise<StoredSelfhostVersionBindings | null> =>
    bindingStoreOperation(() => versionBindings.read(script, versionId));

  // Runtime activation is identified by the complete desired route set and the
  // exact environment, not merely by the active version. An endpoint/domain
  // write can stage a new manifest while reload still serves the previous route
  // table, and a version whose bindings were written after its first publish
  // would otherwise report a stale environment as serving. A version that
  // declares no binding contributes nothing, so its generation is byte-for-byte
  // what it was before bindings existed.
  const runtimeGeneration = async (script: string, state: SelfhostScriptState): Promise<string> => {
    const bindings = state.activeVersion
      ? await readVersionBindings(script, state.activeVersion)
      : null;
    return JSON.stringify({
      activeVersion: state.activeVersion ?? null,
      endpointHostname: state.endpointHostname ?? null,
      domains: state.domains,
      ...(bindings ? { bindingsDigest: bindings.digest } : {}),
    });
  };

  const readScriptState = (script: string): Promise<SelfhostScriptStateSnapshot> =>
    scriptStateOperation(() => scriptStates.read(script));

  const writeScriptState = (
    script: string,
    current: SelfhostScriptStateSnapshot,
    state: SelfhostScriptState,
  ): Promise<SelfhostScriptStateSnapshot> =>
    scriptStateOperation(() => scriptStates.write(script, current.revision, state));

  const removeScriptState = (script: string): Promise<boolean> =>
    scriptStateOperation(() => scriptStates.remove(script));

  /** Rewrites what workerd serves for one script from durable state alone. */
  const republish = async (script: string): Promise<void> => {
    const { state } = await readScriptState(script);
    if (!state.activeVersion) {
      await runtimeOperation(() => runtime.remove(script));
      await runtimeOperation(() => runtime.reload());
      return;
    }
    const versionDirectory = join(versionsRoot, script, state.activeVersion);
    const inspected = await inspectVersion(script, state.activeVersion);
    if (inspected.state === "absent" || inspected.state === "corrupt") {
      throw new SelfhostFailure(
        failed("provider_error", "the active Worker Version is not materialized on this machine"),
      );
    }
    const meta = inspected.meta;
    const modules = await readTree(join(versionDirectory, "modules"));
    const assets = meta.assets ? await readTree(join(versionDirectory, "assets")) : undefined;
    const hostnames = [
      ...(state.endpointHostname ? [state.endpointHostname] : []),
      ...state.domains,
    ];
    // Environment comes from the version's own durable record, not from the
    // materialized tree, so a republish projects exactly what its apply
    // recorded and nothing a later edit of the directory could introduce.
    const bindings = await readVersionBindings(script, state.activeVersion);
    const vars = bindings ? [...bindings.vars, ...bindings.sensitiveVars] : [];
    const generation = await runtimeGeneration(script, state);
    await runtimeOperation(() =>
      runtime.write(
        script,
        {
          directory: script,
          mainModule: meta.mainModule,
          hostnames,
          generation,
          ...(meta.assets ? { assets: { notFoundHandling: meta.assets.notFoundHandling } } : {}),
          ...(vars.length > 0 ? { vars } : {}),
        },
        modules,
        assets,
      ),
    );
    await runtimeOperation(() => runtime.reload());
  };

  const endpointAddress = (
    input: ApplyInput,
  ): { hostname: string; url: string; assignmentDigest: `sha256:${string}` } => {
    const assignment = input.workerEndpointOriginAssignment;
    const origin = assignment?.canonicalPublicOrigin;
    if (!assignment || !origin || origin.length > 2_048) {
      throw new SelfhostFailure(
        failed("invalid_spec", "the Host-assigned Worker endpoint origin is unavailable"),
      );
    }
    try {
      const url = new URL(origin);
      if (
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        url.pathname !== "/" ||
        url.search !== "" ||
        url.hash !== "" ||
        url.origin !== origin ||
        !serves(url.hostname)
      ) {
        throw new TypeError();
      }
      return {
        hostname: url.hostname,
        url: `${origin}/`,
        assignmentDigest: assignment.assignmentDigest,
      };
    } catch {
      throw new SelfhostFailure(
        failed("invalid_spec", "the Host-assigned Worker endpoint origin is invalid"),
      );
    }
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

  /**
   * The Worker Version's own non-secret environment.
   *
   * A string becomes a `text` binding and anything else a `json` one, which is
   * exactly the split the managed backend makes, so the same declaration means
   * the same thing on both. Names are held to the Form's own grammar rather
   * than rewritten: a mangled variable is one the module cannot find.
   */
  const declaredVars = (spec: JsonObject): readonly SelfhostVersionBinding[] => {
    const declared = spec.vars;
    if (declared === undefined) return [];
    if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
      throw new SelfhostFailure(failed("invalid_spec", "the Worker Version vars are invalid"));
    }
    const entries = Object.entries(declared as JsonObject);
    if (entries.length > MAX_WORKER_VERSION_VARS) {
      throw new SelfhostFailure(
        failed("invalid_spec", "the Worker Version declares too many vars"),
      );
    }
    return entries
      .map(([name, value]) => {
        if (!WORKER_VERSION_VAR_NAME.test(name) || value === undefined) {
          throw new SelfhostFailure(failed("invalid_spec", "the Worker Version vars are invalid"));
        }
        return typeof value === "string"
          ? { name, value, kind: "text" as const }
          : { name, value: JSON.stringify(value), kind: "json" as const };
      })
      .sort((left, right) => (left.name < right.name ? -1 : 1));
  };

  /**
   * Records the environment for one immutable version, or removes the record
   * when it declares none — so a version without bindings publishes the exact
   * bytes it published before this Host could project any.
   */
  const writeVersionBindings = async (
    script: string,
    versionId: string,
    set: SelfhostVersionBindingSet,
  ): Promise<void> => {
    if (set.vars.length === 0 && set.sensitiveVars.length === 0) {
      await bindingStoreOperation(() => versionBindings.remove(script, versionId));
      return;
    }
    await bindingStoreOperation(() => versionBindings.write(script, versionId, set));
  };

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
      return failed("denied", "sensitive Worker bindings are unsupported by this Host");
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
    const vars = declaredVars(input.spec);
    const assetsSpec =
      typeof input.spec.assets === "object" && input.spec.assets !== null
        ? (input.spec.assets as JsonObject)
        : null;
    let assetsInput: SelfhostVersionMaterializationRequest["assets"] | undefined;
    if (assetsSpec) {
      const assetBundle = relationResource(input.relations, "/assets/bundle", "StaticAssetBundle");
      const assetsDigest =
        typeof assetBundle?.spec.manifestDigest === "string"
          ? assetBundle.spec.manifestDigest
          : null;
      if (!assetsDigest) return failed("invalid_spec", "the Static Asset Bundle is unavailable");
      assetsInput = {
        manifestDigest: assetsDigest,
        notFoundHandling:
          assetsSpec.notFoundHandling === "single_page_application"
            ? "single-page-application"
            : "none",
      };
    }

    let materialized: Awaited<ReturnType<typeof versionMaterializer.materialize>>;
    try {
      materialized = await versionMaterializer.materialize({
        tenantRef: input.identity.tenantRef,
        script,
        versionId,
        manifestDigest,
        ...(assetsInput ? { assets: assetsInput } : {}),
      });
    } catch (error) {
      if (error instanceof SelfhostVersionMaterializationError) {
        return failed(error.code, materializationMessage(error), error.code === "unavailable");
      }
      throw error;
    }
    await writeVersionBindings(script, versionId, { vars, sensitiveVars: [] });

    return succeeded({
      nativeId: nativeId(input, `selfhost-version:${script}:${versionId}`),
      observed: {
        scriptName: script,
        versionId,
        materializationDigest: materialized.materializationDigest,
        // Names only, and only when there are any: an environment is not
        // identity, and an empty declaration must observe as it always did.
        ...(vars.length > 0 ? { varNames: vars.map((binding) => binding.name) } : {}),
      },
      outputs: {
        scriptName: script,
        versionId,
        materializationDigest: materialized.materializationDigest,
      },
    });
  };

  /**
   * Apply acknowledgement recovery is read-only. Re-resolve the exact
   * artifact closure to derive its expected digest, then inspect the local
   * directory; never route an uncertain recovery back through `apply`.
   */
  const recoverWorkerVersionApply = async (input: ApplyInput): Promise<ProviderTicket> => {
    if (input.previous) return failed("invalid_spec", "Worker Versions are immutable");
    const requiredSensitive = input.spec.requiredSensitiveVars ?? [];
    if (
      !Array.isArray(requiredSensitive) ||
      requiredSensitive.some((name) => typeof name !== "string")
    ) {
      return failed("invalid_spec", "the sensitive Worker binding declaration is invalid");
    }
    if (requiredSensitive.length > 0) {
      return failed("denied", "sensitive Worker bindings are unsupported by this Host");
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
    const vars = declaredVars(input.spec);
    const assetsSpec =
      typeof input.spec.assets === "object" && input.spec.assets !== null
        ? (input.spec.assets as JsonObject)
        : null;
    let assetsInput: SelfhostVersionMaterializationRequest["assets"] | undefined;
    if (assetsSpec) {
      const assetBundle = relationResource(input.relations, "/assets/bundle", "StaticAssetBundle");
      const assetsDigest =
        typeof assetBundle?.spec.manifestDigest === "string"
          ? assetBundle.spec.manifestDigest
          : null;
      if (!assetsDigest) return failed("invalid_spec", "the Static Asset Bundle is unavailable");
      assetsInput = {
        manifestDigest: assetsDigest,
        notFoundHandling:
          assetsSpec.notFoundHandling === "single_page_application"
            ? "single-page-application"
            : "none",
      };
    }
    let expected: Awaited<ReturnType<typeof versionMaterializer.prepare>>;
    try {
      expected = await versionMaterializer.prepare({
        tenantRef: input.identity.tenantRef,
        script,
        versionId,
        manifestDigest,
        ...(assetsInput ? { assets: assetsInput } : {}),
      });
    } catch (error) {
      if (error instanceof SelfhostVersionMaterializationError) {
        return failed(error.code, materializationMessage(error), error.code === "unavailable");
      }
      throw error;
    }
    const materialized = await inspectVersion(script, versionId);
    if (materialized.state === "absent") {
      return failed("not_found", "the Worker Version is not materialized");
    }
    if (materialized.state === "corrupt") {
      return failed("provider_error", "the Worker Version materialization is corrupt");
    }
    if (materialized.digest !== expected.materializationDigest) {
      return failed(
        "conflict",
        "the committed Worker Version materialization conflicts with this recovery",
      );
    }
    // Recovery is readback-only: an environment this Host never recorded is not
    // written here, it is reported as an apply that did not complete, and the
    // ordinary retry of an immutable create is what finishes the job.
    const recorded = await readVersionBindings(script, versionId);
    if (!sameBindingNames(recorded, vars, [])) {
      return failed("not_found", "the Worker Version environment was not recorded");
    }
    return succeeded({
      nativeId: nativeId(input, `selfhost-version:${script}:${versionId}`),
      observed: {
        scriptName: script,
        versionId,
        materialized: true,
        materializationDigest: materialized.digest,
        ...(vars.length > 0 ? { varNames: vars.map((binding) => binding.name) } : {}),
      },
      outputs: {
        scriptName: script,
        versionId,
        materializationDigest: materialized.digest,
      },
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
    const current = await readScriptState(script);
    await writeScriptState(script, current, { ...current.state, activeVersion: active.versionId });
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
    const address = endpointAddress(input);
    const current = await readScriptState(script);
    if (current.state.endpointHostname !== address.hostname) {
      await writeScriptState(script, current, {
        ...current.state,
        endpointHostname: address.hostname,
      });
    }
    // Desired state may already contain this endpoint after a process died
    // during the previous republish. Reconcile runtime truth on every retry;
    // checking only the durable value would turn a failed reload into a false
    // success response.
    if (current.state.activeVersion) {
      try {
        await republish(script);
      } catch (error) {
        if (error instanceof SelfhostFailure) return error.ticket;
        throw error;
      }
    }
    return succeeded({
      nativeId: nativeId(input, `selfhost-endpoint:${script}:${address.hostname}`),
      observed: {
        enabled: true,
        scriptName: script,
        assignmentDigest: address.assignmentDigest,
      },
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
    const current = await readScriptState(script);
    if (!current.state.domains.includes(hostname)) {
      await writeScriptState(script, current, {
        ...current.state,
        domains: [...current.state.domains, hostname],
      });
    }
    // As with endpoint attachment, a committed domain is not proof that the
    // runtime accepted the corresponding route. Always retry publication while
    // a version is active, even when the desired domain list is unchanged.
    if (current.state.activeVersion) {
      try {
        await republish(script);
      } catch (error) {
        if (error instanceof SelfhostFailure) return error.ticket;
        throw error;
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
    const queueName = await derivedProviderResourceName("tsq", {
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
        const name = await derivedProviderResourceName("tskv", input.identity);
        return {
          base: `selfhost-kv:${name}`,
          observed: { name },
          outputs: { namespaceId: name },
        };
      }
      case "AtLeastOnceQueue": {
        const name = await derivedProviderResourceName("tsq", input.identity);
        return {
          base: `selfhost-queue:${name}`,
          observed: { queueName: name },
          outputs: { queueId: name, queueName: name },
        };
      }
      case "SQLiteDatabase":
      case "sql_database": {
        const name = await derivedProviderResourceName("tsdb", input.identity);
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
    workerEndpointOriginReservations: {
      derive: async ({ requestedSubdomain }) => {
        const canonicalPublicOrigin = canonicalWorkerEndpointOrigin(
          requestedSubdomain,
          endpointSuffix,
        );
        return canonicalPublicOrigin ? { canonicalPublicOrigin } : null;
      },
    },

    /** Capture a pure, redacted descriptor for post-delete readback. */
    createNativeReadbackDescriptor(
      input: ProviderNativeReadbackInput,
    ): ProviderNativeReadbackDescriptor {
      const kind = dispatchKind(input.offering);
      const parsed = parseSelfhostNativeId(kind, input.nativeId, input.spec, input.relations);
      if (!parsed) throw new ProviderReadbackDescriptorError();
      const data =
        kind === "WorkerEndpoint" && parsed.script && parsed.hostname
          ? { ...parsed.data, hostname: parsed.hostname }
          : parsed.data;
      return {
        apiVersion: PROVIDER_READBACK_API_VERSION,
        provider: id,
        kind,
        nativeId: input.nativeId,
        data,
      };
    },

    /**
     * Read only local durable/runtime descriptors. This method deliberately
     * avoids `scriptStates.read` and `runtime.has`: both may clean stale
     * activation files, while an absence proof must have no write/reload path.
     */
    async verifyNativeAbsence(input: {
      offering: ProviderOffering;
      descriptor: ProviderNativeReadbackDescriptor;
    }): Promise<ProviderNativeAbsence> {
      const kind = dispatchKind(input.offering);
      const parsed = validateSelfhostReadbackDescriptor(id, kind, input.descriptor);
      if (!parsed) return selfhostUnknown("malformed", false);
      try {
        switch (kind) {
          case "ModuleWorker":
            if (!parsed.script) return selfhostUnknown("malformed", false);
            return await verifySelfhostWorkerAbsence(
              dataRoot,
              scriptsRoot,
              versionsRoot,
              parsed.script,
              input.descriptor,
              kind,
            );
          case "WorkerVersion":
            if (!parsed.script || !parsed.versionId) return selfhostUnknown("malformed", false);
            return await verifySelfhostVersionAbsence(
              versionMaterializer,
              parsed.script,
              parsed.versionId,
              input.descriptor,
              kind,
            );
          case "WorkerDeployment":
            if (!parsed.script) return selfhostUnknown("malformed", false);
            return await verifySelfhostDeploymentAbsence(
              dataRoot,
              parsed.script,
              input.descriptor,
              kind,
            );
          case "WorkerEndpoint":
          case "WorkerCustomDomain":
            if (!parsed.script) return selfhostUnknown("malformed", false);
            return await verifySelfhostRouteAbsence(
              dataRoot,
              parsed.script,
              parsed.hostname,
              input.descriptor,
              kind,
            );
          case "SQLiteDatabase":
          case "sql_database":
            return selfhostFileAbsence(
              "SQLiteDatabase",
              databasePath(parsed.databaseName ?? ""),
              input.descriptor,
              id,
            );
          // These declarations have no separate provider-native object on a
          // self-hosted machine. Their descriptor is still captured so the
          // Host can prove that no provider readback is required.
          case "ObjectBucket":
          case "object_bucket":
          case "EdgeKVNamespace":
          case "AtLeastOnceQueue":
          case "WorkerCronTrigger":
          case "QueueConsumer":
            return selfhostAbsence("absent", input.descriptor, kind, id, parsed.data);
          default:
            return selfhostUnknown("unsupported", false);
        }
      } catch (error) {
        // Filesystem errors are bounded to the closed provider vocabulary; no
        // path, credential, or raw diagnostic crosses the provider seam.
        if (error instanceof SelfhostReadbackMalformed) {
          return selfhostUnknown("malformed", false);
        }
        return selfhostUnknown("transport", true);
      }
    },

    async recoverApply(input): Promise<ProviderTicket> {
      if (dispatchKind(input.offering) === "WorkerEndpoint") {
        try {
          const worker = relationResource(input.relations, "/worker", "ModuleWorker");
          if (!worker) return failed("invalid_spec", "the Worker Endpoint is incomplete");
          const address = endpointAddress(input);
          const script = await scriptOf(input.identity.tenantRef, worker.metadata);
          const { state } = await readScriptState(script);
          if (state.endpointHostname !== address.hostname || !state.activeVersion) {
            return failed(
              "unavailable",
              "the Worker Endpoint apply outcome is indeterminate",
              true,
            );
          }
          if (
            !(await runtimeOperation(async () =>
              runtime.has(script, await runtimeGeneration(script, state)),
            ))
          ) {
            return failed("unavailable", "the Worker runtime is not serving the endpoint", true);
          }
          return succeeded({
            nativeId: nativeId(input, `selfhost-endpoint:${script}:${address.hostname}`),
            observed: {
              enabled: true,
              scriptName: script,
              assignmentDigest: address.assignmentDigest,
            },
            outputs: { hostname: address.hostname, url: address.url },
          });
        } catch (error) {
          if (error instanceof SelfhostFailure) return error.ticket;
          throw error;
        }
      }
      if (dispatchKind(input.offering) !== "WorkerVersion") {
        return failed(
          "unavailable",
          "self-host apply recovery is supported only for Worker Version or Endpoint materialization",
          true,
        );
      }
      try {
        return await recoverWorkerVersionApply(input);
      } catch (error) {
        if (error instanceof SelfhostFailure) return error.ticket;
        throw error;
      }
    },

    async convergeApply(input): Promise<ProviderTicket> {
      return await this.apply({ ...input, operationMode: "recovery" });
    },

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
            const materialized = await inspectVersion(script, versionId);
            if (materialized.state === "absent") {
              return failed("not_found", "the Worker Version is not materialized");
            }
            if (materialized.state === "corrupt") {
              return failed("provider_error", "the Worker Version materialization is corrupt");
            }
            return succeeded({
              nativeId: input.nativeId,
              observed: {
                scriptName: script,
                versionId,
                materialized: true,
                materializationDigest: materialized.digest,
              },
              outputs: {
                scriptName: script,
                versionId,
                materializationDigest: materialized.digest,
              },
            });
          }
          case "WorkerDeployment": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (!worker) return failed("not_found", "the Worker Deployment has no worker relation");
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const { state } = await readScriptState(script);
            const serving = await runtimeOperation(async () =>
              runtime.has(script, await runtimeGeneration(script, state)),
            );
            if (state.activeVersion && !serving) {
              return failed(
                "unavailable",
                "the Worker runtime is not serving the deployment",
                true,
              );
            }
            return succeeded({
              nativeId: input.nativeId,
              observed: {
                scriptName: script,
                ...(state.activeVersion ? { activeVersionId: state.activeVersion } : {}),
                serving,
              },
              outputs: {},
            });
          }
          case "WorkerEndpoint": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (!worker) return failed("not_found", "the Worker Endpoint has no worker relation");
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const { state } = await readScriptState(script);
            if (!state.endpointHostname || !state.activeVersion) {
              return failed("not_found", "the Worker endpoint is not durably attached");
            }
            if (
              !(await runtimeOperation(async () =>
                runtime.has(script, await runtimeGeneration(script, state)),
              ))
            ) {
              return failed("unavailable", "the Worker runtime is not serving the endpoint", true);
            }
            return succeeded({
              nativeId: input.nativeId,
              observed: { enabled: true, scriptName: script, serving: true },
              outputs: {
                hostname: state.endpointHostname,
                url: `https://${state.endpointHostname}/`,
              },
            });
          }
          case "WorkerCustomDomain": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            const hostname =
              typeof input.spec.hostname === "string"
                ? input.spec.hostname.toLowerCase().replace(/\.$/u, "")
                : null;
            if (!hostname) return failed("not_found", "the custom domain records no hostname");
            if (!worker) return failed("not_found", "the custom domain has no worker relation");
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const { state } = await readScriptState(script);
            if (!state.domains.includes(hostname) || !state.activeVersion) {
              return failed("not_found", "the custom domain is not durably attached");
            }
            if (
              !(await runtimeOperation(async () =>
                runtime.has(script, await runtimeGeneration(script, state)),
              ))
            ) {
              return failed(
                "unavailable",
                "the Worker runtime is not serving the custom domain",
                true,
              );
            }
            return succeeded({
              nativeId: input.nativeId,
              observed: { hostname, scriptName: script, serving: true },
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
      if (input.operationMode === "recovery" && !input.providerHandle) {
        return failed("unavailable", "provider mutation recovery requires an opaque handle", true);
      }
      if (input.providerHandle) {
        return failed("unavailable", "self-host delete recovery cannot poll this handle", true);
      }
      const done = (): ProviderTicket =>
        succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} });
      try {
        switch (dispatchKind(input.offering)) {
          case "ModuleWorker": {
            const script = await scriptOf(input.identity.tenantRef, {
              space: input.identity.space,
              name: input.identity.name,
            });
            await runtimeOperation(() => runtime.remove(script));
            await rm(join(versionsRoot, script), { recursive: true, force: true });
            await bindingStoreOperation(() => versionBindings.removeScript(script));
            await removeScriptState(script);
            await runtimeOperation(() => runtime.reload());
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
              const current = await readScriptState(script);
              if (current.state.activeVersion === versionId) {
                await writeScriptState(script, current, {
                  domains: current.state.domains,
                  ...(current.state.endpointHostname
                    ? { endpointHostname: current.state.endpointHostname }
                    : {}),
                });
                await rm(join(versionsRoot, script, versionId), { recursive: true, force: true });
                await bindingStoreOperation(() => versionBindings.remove(script, versionId));
                await republish(script);
              } else {
                await rm(join(versionsRoot, script, versionId), { recursive: true, force: true });
                await bindingStoreOperation(() => versionBindings.remove(script, versionId));
              }
            }
            return done();
          }
          case "WorkerDeployment": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (worker) {
              const script = await scriptOf(input.identity.tenantRef, worker.metadata);
              const current = await readScriptState(script);
              await writeScriptState(script, current, {
                domains: current.state.domains,
                ...(current.state.endpointHostname
                  ? { endpointHostname: current.state.endpointHostname }
                  : {}),
              });
              await republish(script);
            }
            return done();
          }
          case "WorkerEndpoint": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (worker) {
              const script = await scriptOf(input.identity.tenantRef, worker.metadata);
              const current = await readScriptState(script);
              await writeScriptState(script, current, {
                domains: current.state.domains,
                ...(current.state.activeVersion
                  ? { activeVersion: current.state.activeVersion }
                  : {}),
              });
              if (current.state.activeVersion) await republish(script);
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
              const current = await readScriptState(script);
              await writeScriptState(script, current, {
                ...current.state,
                domains: current.state.domains.filter((entry) => entry !== hostname),
              });
              if (current.state.activeVersion) await republish(script);
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

    /**
     * Read-only cancellation recovery for the local provider.
     *
     * A process can die after `delete` removed the files but before the Host
     * recorded its receipt. Replaying the local mutation would hide that
     * acknowledgement gap and could also remove a newer incarnation. The
     * recovery seam therefore checks only durable state plus runtime serving
     * truth; it never calls `remove`, rewrites desired state, or reloads.
     */
    async recoverDelete(input): Promise<ProviderTicket> {
      if (input.providerHandle) {
        return failed("unavailable", "self-host delete recovery cannot poll this handle", true);
      }
      const done = (): ProviderTicket =>
        succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} });
      const uncertain = (): ProviderTicket =>
        failed(
          "unavailable",
          "the local delete outcome is not proven; operator repair is required",
          true,
        );
      try {
        switch (dispatchKind(input.offering)) {
          case "ModuleWorker": {
            const script = await scriptOf(input.identity.tenantRef, {
              space: input.identity.space,
              name: input.identity.name,
            });
            const current = await readScriptState(script);
            const serving = await runtimeOperation(async () =>
              runtime.has(script, await runtimeGeneration(script, current.state)),
            );
            return current.revision === null && !serving ? done() : uncertain();
          }
          case "WorkerVersion": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (!worker) return failed("not_found", "the Worker Version has no worker relation");
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const versionId = await versionIdOf(input.identity.tenantRef, {
              space: input.identity.space,
              name: input.identity.name,
            });
            const current = await readScriptState(script);
            // The immutable local Version is gone only when its whole
            // materialization directory is absent and it is no longer the
            // durable active generation. A different active generation may
            // still serve, which is fine for this non-active Version.
            const materialized = existsSync(join(versionsRoot, script, versionId));
            return !materialized && current.state.activeVersion !== versionId
              ? done()
              : uncertain();
          }
          case "WorkerDeployment": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (!worker) return failed("not_found", "the Worker Deployment has no worker relation");
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const current = await readScriptState(script);
            const serving = await runtimeOperation(async () =>
              runtime.has(script, await runtimeGeneration(script, current.state)),
            );
            return current.state.activeVersion === undefined && !serving ? done() : uncertain();
          }
          case "WorkerEndpoint": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (!worker) return failed("not_found", "the Worker route has no worker relation");
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const parsed = parseSelfhostNativeId(
              "WorkerEndpoint",
              input.nativeId,
              input.spec,
              input.relations,
            );
            if (!parsed?.hostname || parsed.script !== script) {
              return failed("not_found", "the Worker Endpoint identity is malformed");
            }
            const current = await readScriptState(script);
            const manifest = await readSelfhostRuntimeManifest(dataRoot, script);
            return current.state.endpointHostname !== parsed.hostname &&
              manifest?.hostnames.includes(parsed.hostname) !== true
              ? done()
              : uncertain();
          }
          case "WorkerCustomDomain": {
            const worker = relationResource(input.relations, "/worker", "ModuleWorker");
            if (!worker) return failed("not_found", "the Worker route has no worker relation");
            const script = await scriptOf(input.identity.tenantRef, worker.metadata);
            const current = await readScriptState(script);
            const serving = await runtimeOperation(async () =>
              runtime.has(script, await runtimeGeneration(script, current.state)),
            );
            // Workerd's boolean seam reports script activation, not a
            // per-host route. When another route still serves the script we
            // cannot prove this route's absence, so fail closed.
            return !serving && current.state.domains.length === 0 ? done() : uncertain();
          }
          default:
            // Namespace resources have no mutable local object; their delete
            // is a durable declaration transition and has no residual bytes
            // for this provider to read back.
            return done();
        }
      } catch (error) {
        if (error instanceof SelfhostFailure) return error.ticket;
        throw error;
      }
    },

    async adopt(input): Promise<ProviderTicket> {
      if (input.operationMode === "recovery" && !input.providerHandle) {
        return failed("unavailable", "provider mutation recovery requires an opaque handle", true);
      }
      if (input.providerHandle) {
        return failed("unavailable", "self-host adopt recovery cannot poll this handle", true);
      }
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

interface SelfhostReadbackParsed {
  readonly data: JsonObject;
  readonly script?: string;
  readonly versionId?: string;
  readonly hostname?: string;
  readonly databaseName?: string;
}

/**
 * Native IDs are opaque outside this adapter, but a descriptor still needs a
 * bounded, path-safe projection so a forged value can never escape dataRoot.
 * Operation suffixes are intentionally ignored after the stable address.
 */
function parseSelfhostNativeId(
  kind: string,
  value: string,
  spec?: JsonObject,
  relations?: readonly ProviderRelation[],
): SelfhostReadbackParsed | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) return null;
  const parts = value.split(":");
  const script = safeSegment(parts[1]) ? parts[1] : undefined;
  const versionId = safeSegment(parts[2]) ? parts[2] : undefined;
  const workerRelation = relations?.find((relation) => relation.pointer === "/worker");
  const relationMeta = workerRelation?.resource.metadata;
  const relationData: JsonObject =
    relationMeta &&
    safeSegment(relationMeta.name) &&
    safeSegment(relationMeta.space) &&
    safeSegment(relationMeta.uid)
      ? {
          workerName: relationMeta.name,
          workerSpace: relationMeta.space,
          workerUid: relationMeta.uid,
        }
      : safeRelationData(spec);
  const relationScript =
    selfhostWorkerScript(relations) ??
    (safeSegment(spec?.scriptName) ? spec.scriptName : undefined) ??
    (safeSegment(spec?.workerScript) ? spec.workerScript : null);
  const endpointHostname = normalizedHostname(parts[2]);
  switch (kind) {
    case "ModuleWorker":
      return parts[0] === "selfhost-worker" && script
        ? { script, data: { scriptName: script } }
        : null;
    case "WorkerVersion":
      return parts[0] === "selfhost-version" && script && versionId
        ? {
            script,
            versionId,
            data: { scriptName: script, versionId, ...relationData },
          }
        : null;
    case "WorkerDeployment":
      return parts[0] === "selfhost-deployment" && script
        ? { script, data: { scriptName: script, ...relationData } }
        : null;
    case "WorkerEndpoint":
      return parts[0] === "selfhost-endpoint" && script && endpointHostname
        ? {
            script,
            hostname: endpointHostname,
            data: { scriptName: script, hostname: endpointHostname },
          }
        : null;
    case "WorkerCustomDomain": {
      const hostname = normalizedHostname(spec?.hostname);
      return parts[0] === "selfhost-domain" && hostname && relationScript && parts[1] === hostname
        ? {
            script: relationScript,
            hostname,
            data: { scriptName: relationScript, hostname, ...relationData },
          }
        : null;
    }
    case "WorkerCronTrigger": {
      const cron = optionalSafeString(spec?.cron);
      return parts[0] === "selfhost-cron" && script && cron
        ? { script, data: { scriptName: script, cron } }
        : null;
    }
    case "QueueConsumer": {
      const queue = safeSegment(parts[1]) ? parts[1] : undefined;
      const consumerScript = safeSegment(parts[2]) ? parts[2] : undefined;
      return parts[0] === "selfhost-consumer" && queue && consumerScript
        ? {
            script: consumerScript,
            data: { queueName: queue, scriptName: consumerScript, ...relationData },
          }
        : null;
    }
    case "ObjectBucket":
    case "object_bucket": {
      const name = parts[0] === "local-bucket" ? parts[1] : null;
      return name && safeSegment(name) ? { data: { bucketName: name } } : null;
    }
    case "EdgeKVNamespace":
      return parts[0] === "selfhost-kv" && safeSegment(parts[1])
        ? { data: { namespaceId: parts[1] as string } }
        : null;
    case "AtLeastOnceQueue":
      return parts[0] === "selfhost-queue" && safeSegment(parts[1])
        ? { data: { queueName: parts[1] as string } }
        : null;
    case "SQLiteDatabase":
    case "sql_database":
      return parts[0] === "selfhost-sqlite" && safeSegment(parts[1])
        ? { databaseName: parts[1] as string, data: { databaseName: parts[1] as string } }
        : null;
    default:
      return null;
  }
}

function selfhostWorkerScript(relations: readonly ProviderRelation[] | undefined): string | null {
  const nativeId = relations?.find((relation) => relation.pointer === "/worker")?.deployment
    ?.nativeId;
  if (typeof nativeId !== "string") return null;
  const parts = nativeId.split(":");
  return parts[0] === "selfhost-worker" && safeSegment(parts[1]) ? parts[1] : null;
}

function safeRelationData(spec: JsonObject | undefined): JsonObject {
  if (
    safeSegment(spec?.workerName) &&
    safeSegment(spec?.workerSpace) &&
    safeSegment(spec?.workerUid)
  ) {
    return {
      workerName: spec.workerName,
      workerSpace: spec.workerSpace,
      workerUid: spec.workerUid,
    };
  }
  return {};
}

function validateSelfhostReadbackDescriptor(
  provider: string,
  kind: string,
  descriptor: ProviderNativeReadbackDescriptor,
): SelfhostReadbackParsed | null {
  if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor)) {
    return null;
  }
  if (
    descriptor.apiVersion !== PROVIDER_READBACK_API_VERSION ||
    descriptor.provider !== provider ||
    descriptor.kind !== kind ||
    typeof descriptor.nativeId !== "string" ||
    descriptor.nativeId.length < 1 ||
    descriptor.nativeId.length > 4_096 ||
    !isJsonObject(descriptor.data)
  ) {
    return null;
  }
  const parsed = parseSelfhostNativeId(kind, descriptor.nativeId, descriptor.data);
  if (!parsed) return null;
  const matches =
    kind === "WorkerEndpoint"
      ? selfhostEndpointDataMatches(parsed, descriptor.data)
      : selfhostDataMatches(parsed.data, descriptor.data);
  if (!matches) return null;
  // The descriptor creator may include safe worker relation metadata. Reject
  // an incomplete relation tuple rather than allowing an ambiguous parent.
  const relationKeys = ["workerName", "workerSpace", "workerUid"];
  const relationPresent = relationKeys.some((key) => key in descriptor.data);
  if (
    relationPresent &&
    (!relationKeys.every((key) => typeof descriptor.data[key] === "string") ||
      relationKeys.some((key) => !safeSegment(String(descriptor.data[key]))))
  ) {
    return null;
  }
  return parsed;
}

function selfhostEndpointDataMatches(parsed: SelfhostReadbackParsed, actual: JsonObject): boolean {
  if (!parsed.script || !parsed.hostname || !normalizedHostname(actual.hostname)) return false;
  const keys = Object.keys(actual).sort();
  return (
    keys.length === 2 &&
    keys[0] === "hostname" &&
    keys[1] === "scriptName" &&
    actual.scriptName === parsed.script &&
    typeof actual.hostname === "string" &&
    actual.hostname === parsed.hostname
  );
}

function selfhostDataMatches(expected: JsonObject, actual: JsonObject): boolean {
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  if (
    expectedKeys.length !== actualKeys.length ||
    !expectedKeys.every((key, i) => key === actualKeys[i])
  ) {
    return false;
  }
  return expectedKeys.every((key) => actual[key] === expected[key]);
}

class SelfhostReadbackMalformed extends Error {}

interface ReadonlyScriptState {
  readonly exists: boolean;
  readonly activeVersion?: string;
  readonly endpointHostname?: string;
  readonly domains: readonly string[];
}

async function readSelfhostState(root: string, script: string): Promise<ReadonlyScriptState> {
  const path = join(root, `${script}.json`);
  const temporary = await readFile(`${path}.tmp`).catch(() => null);
  const bytes = await readFile(path).catch((error) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (temporary !== null) throw new SelfhostReadbackMalformed();
  if (bytes === null) return { exists: false, domains: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new SelfhostReadbackMalformed();
  }
  if (!isJsonObject(parsed) || !Array.isArray(parsed.domains)) {
    throw new SelfhostReadbackMalformed();
  }
  const activeVersion = parsed.activeVersion;
  const endpointHostname = parsed.endpointHostname;
  const domains = parsed.domains;
  if (
    (activeVersion !== undefined && !safeSegment(activeVersion)) ||
    (endpointHostname !== undefined && !normalizedHostname(endpointHostname)) ||
    domains.some((value) => !normalizedHostname(value)) ||
    Object.keys(parsed).some(
      (key) => key !== "activeVersion" && key !== "endpointHostname" && key !== "domains",
    )
  ) {
    throw new SelfhostReadbackMalformed();
  }
  return {
    exists: true,
    ...(typeof activeVersion === "string" ? { activeVersion } : {}),
    ...(typeof endpointHostname === "string" ? { endpointHostname } : {}),
    domains: domains.filter((value): value is string => typeof value === "string"),
  };
}

interface ReadonlyActivation {
  readonly present: boolean;
}

async function readSelfhostActivation(root: string, script: string): Promise<ReadonlyActivation> {
  const path = join(root, "workers", ".takoserver-active.json");
  const bytes = await readFile(path).catch((error) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (bytes === null) return { present: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new SelfhostReadbackMalformed();
  }
  if (!isJsonObject(parsed)) throw new SelfhostReadbackMalformed();
  for (const generation of Object.values(parsed)) {
    if (generation !== null && typeof generation !== "string") {
      throw new SelfhostReadbackMalformed();
    }
  }
  return { present: Object.hasOwn(parsed, script) };
}

interface ReadonlyRuntimeManifest {
  readonly hostnames: readonly string[];
}

async function readSelfhostRuntimeManifest(
  root: string,
  script: string,
): Promise<ReadonlyRuntimeManifest | null> {
  const directory = join(root, "workers", script);
  const path = join(directory, "takoserver-site.json");
  const bytes = await readFile(path).catch((error) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (bytes === null) {
    if (existsSync(directory)) throw new SelfhostReadbackMalformed();
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new SelfhostReadbackMalformed();
  }
  if (!isJsonObject(parsed) || !Array.isArray(parsed.hostnames)) {
    throw new SelfhostReadbackMalformed();
  }
  if (parsed.hostnames.some((hostname) => !normalizedHostname(hostname))) {
    throw new SelfhostReadbackMalformed();
  }
  return {
    hostnames: parsed.hostnames.filter(
      (hostname): hostname is string => typeof hostname === "string",
    ),
  };
}

async function verifySelfhostWorkerAbsence(
  root: string,
  scriptsRoot: string,
  versionsRoot: string,
  script: string,
  descriptor: ProviderNativeReadbackDescriptor,
  kind: string,
): Promise<ProviderNativeAbsence> {
  const state = await readSelfhostState(scriptsRoot, script);
  const activation = await readSelfhostActivation(root, script);
  const runtimeManifest = await readSelfhostRuntimeManifest(root, script);
  const versions = existsSync(join(versionsRoot, script));
  if (state.exists || activation.present || runtimeManifest !== null || versions) {
    return selfhostAbsence("present", descriptor, kind);
  }
  return selfhostAbsence("absent", descriptor, kind);
}

async function verifySelfhostVersionAbsence(
  versionMaterializer: ReturnType<typeof createSelfhostVersionMaterializer>,
  script: string,
  versionId: string | undefined,
  descriptor: ProviderNativeReadbackDescriptor,
  kind: string,
): Promise<ProviderNativeAbsence> {
  if (!versionId) return selfhostUnknown("malformed", false);
  const inspected = await versionMaterializer.inspect({ script, versionId });
  if (inspected.state === "absent") return selfhostAbsence("absent", descriptor, kind);
  if (inspected.state === "corrupt") return selfhostUnknown("malformed", false);
  return selfhostAbsence("present", descriptor, kind);
}

async function verifySelfhostDeploymentAbsence(
  root: string,
  script: string,
  descriptor: ProviderNativeReadbackDescriptor,
  kind: string,
): Promise<ProviderNativeAbsence> {
  const state = await readSelfhostState(join(root, "selfhost", "scripts"), script);
  const activation = await readSelfhostActivation(root, script);
  const manifest = await readSelfhostRuntimeManifest(root, script);
  return state.activeVersion || activation.present || manifest !== null
    ? selfhostAbsence("present", descriptor, kind)
    : selfhostAbsence("absent", descriptor, kind);
}

async function verifySelfhostRouteAbsence(
  root: string,
  script: string,
  hostname: string | undefined,
  descriptor: ProviderNativeReadbackDescriptor,
  kind: string,
): Promise<ProviderNativeAbsence> {
  if (!hostname) return selfhostUnknown("malformed", false);
  const state = await readSelfhostState(join(root, "selfhost", "scripts"), script);
  const manifest = await readSelfhostRuntimeManifest(root, script);
  const durable =
    kind === "WorkerEndpoint"
      ? state.endpointHostname === hostname
      : state.domains.includes(hostname);
  const serving = manifest?.hostnames.includes(hostname) === true;
  return durable || serving
    ? selfhostAbsence("present", descriptor, kind)
    : selfhostAbsence("absent", descriptor, kind);
}

function selfhostFileAbsence(
  kind: string,
  path: string,
  descriptor: ProviderNativeReadbackDescriptor,
  provider: string,
): ProviderNativeAbsence {
  return selfhostAbsence(existsSync(path) ? "present" : "absent", descriptor, kind, provider);
}

function selfhostAbsence(
  outcome: "absent" | "present",
  descriptor: ProviderNativeReadbackDescriptor,
  kind: string,
  provider = descriptor.provider,
  data: JsonObject = descriptor.data,
): ProviderNativeAbsence {
  // Descriptor data (script/version/bucket identifiers and parent relation)
  // remains Host-private. Public evidence is intentionally identifier-free.
  void data;
  return { outcome, evidence: { provider, kind, state: outcome } };
}

function selfhostUnknown(
  reason: ProviderNativeAbsenceUnknownReason,
  retryable: boolean,
): ProviderNativeAbsence {
  return { outcome: "unknown", reason, retryable };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSegment(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(value);
}

function optionalSafeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 ? value : undefined;
}

function normalizedHostname(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 255) return undefined;
  const hostname = value.toLowerCase().replace(/\.$/u, "");
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(hostname) ? hostname : undefined;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

/**
 * Whether the recorded environment is exactly the one this apply declares.
 *
 * Names only. A recovery compares what it can prove from durable state against
 * what the desired spec asks for; it never opens a value to do it.
 */
function sameBindingNames(
  recorded: StoredSelfhostVersionBindings | null,
  vars: readonly SelfhostVersionBinding[],
  sensitiveNames: readonly string[],
): boolean {
  const expectedVars = vars.map((binding) => binding.name).sort();
  const expectedSensitive = [...sensitiveNames].sort();
  const observedVars = (recorded?.vars ?? []).map((binding) => binding.name).sort();
  const observedSensitive = (recorded?.sensitiveVars ?? []).map((binding) => binding.name).sort();
  return (
    JSON.stringify(expectedVars) === JSON.stringify(observedVars) &&
    JSON.stringify(expectedSensitive) === JSON.stringify(observedSensitive)
  );
}

function materializationMessage(error: SelfhostVersionMaterializationError): string {
  switch (error.code) {
    case "invalid_spec":
      return "the Worker Version artifacts are invalid";
    case "conflict":
      return "the committed Worker Version materialization conflicts with this apply";
    case "unavailable":
      return "the Worker Version materialization is unavailable";
  }
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
