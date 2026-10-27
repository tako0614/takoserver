import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTAINER_CONTRACT as C } from "../../src/container-contract.ts";
import { bytesDigest } from "../../src/json.ts";
import { migrateSqlite } from "../../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../../src/objects-fs.ts";
import type { JsonObject } from "../../src/ports.ts";
import {
  createSelfhostV2ForwardWorkerComposition,
  createSelfhostV2WorkerComposition,
  type SelfhostV2ForwardWorkerCompositionOptions,
} from "../../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../../src/takoform-v2/engine.ts";
import { createV2HeldArtifactSource } from "../../src/takoform-v2/forms/artifact-source.ts";
import {
  CONTAINER_0_2_FORM_URL,
  CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL,
  CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL,
} from "../../src/takoform-v2/forms/container-consumer-specs.ts";
import { OBJECT_BUCKET_LIMITS } from "../../src/takoform-v2/forms/object-bucket.ts";
import { OBJECT_BUCKET_BACKEND_ID } from "../../src/takoform-v2/forms/object-bucket-backend.ts";
import { OBJECT_BUCKET_EOF_COUNTED_FORM_URL } from "../../src/takoform-v2/forms/object-bucket-binding-profile.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../../src/takoform-v2/forms/static-asset-bundle.ts";
import {
  createStaticAssetBundleCustody,
  createStaticAssetBundleHost,
} from "../../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import { WORKER_BUNDLE_FORM_URL } from "../../src/takoform-v2/forms/worker-bundle.ts";
import {
  createWorkerBundleCustody,
  createWorkerBundleHost,
} from "../../src/takoform-v2/forms/worker-bundle-backend.ts";
import {
  CONTAINER_WORKER_VERSION_FORM_URL,
  FORWARD_WORKER_DEPLOYMENT_FORM_URL,
  FORWARD_WORKER_VERSION_FORM_URL,
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../../src/takoform-v2/forms/worker-specs.ts";
import { createV2ForwardContainerWorkerPublicationState } from "../../src/takoform-v2/index.ts";
import { createV2Store } from "../../src/takoform-v2/store.ts";
import type { V2BackendResult, V2Execution, V2Form } from "../../src/takoform-v2/types.ts";
import {
  createContainerConsumerWorkerCronTriggerAdmissionReader,
  createForwardWorkerCronTriggerAdmissionReader,
} from "../../src/takoform-v2/worker-cron-trigger-backend.ts";
import {
  createContainerConsumerWorkerDeploymentForm,
  createForwardWorkerDeploymentForm,
  createWorkerDeploymentForm,
} from "../../src/takoform-v2/worker-deployment-backend.ts";
import { createForwardWorkerEndpointForm } from "../../src/takoform-v2/worker-endpoint-backend.ts";
import {
  createInternalV2ContainerConsumerWorkerVersionForm,
  createInternalV2ForwardWorkerVersionForm,
} from "../../src/takoform-v2/worker-lifecycle-backend.ts";
import {
  createV2ForwardWorkerPublicationState,
  createV2WorkerPublicationState,
} from "../../src/takoform-v2/worker-publication-state.ts";
import {
  createV2ForwardWorkerVersionConfiguredInputSealer,
  createV2WorkerVersionConfiguredInputSealer,
} from "../../src/takoform-v2/worker-version-configured-inputs.ts";
import type { WorkerdWorkerRuntimeOwner } from "../../src/workerd-worker-runtime-owner.ts";

export const TARGET = "container-consumer-registration";
export const PRINCIPAL = "alice";
export const SPACE = "space";
/** Registered only so a Container-kind but unlisted Form version can be created and refused. */
export const CONTAINER_0_3_FORM_URL = "https://edge.forms.takoform.com/forms/Container/0.3.0/";

export type DeploymentMode = "complete" | "no_effect";

/**
 * Real v2 engine, real migrations and the PRODUCTION Form factories' admission surface
 * (validate / references / prepareAdmission, including the single-active predicate).
 *
 * Only the backends are labeled doubles: they report an already-ready observation so a
 * Resource can settle and later be updated, deleted or occupy a slot. They are acceptance
 * mechanics, not a native, owner or publication proof; owner/readback is covered by the
 * composition fixture that reaches the runtime-owner port.
 */
export function admissionFixture() {
  const root = mkdtempSync(join(tmpdir(), "container-consumer-registration-"));
  const db = new Database(join(root, "metadata.sqlite"));
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "0070_takoform_v2.sql",
    "0071_v2_sqlite_migration_set_custody.sql",
    "0073_v2_reference_acceptance.sql",
    "0081_v2_private_inputs.sql",
  ])
    db.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  const sql = createSqliteSql(db);
  const store = createV2Store(sql);
  const now = Date.now();
  let deploymentMode: DeploymentMode = "complete";

  const metadata = (id: string, observed: JsonObject = { ready: true }): V2Form => ({
    validateCreate() {},
    validateUpdate() {},
    backend: {
      id,
      targetKey: TARGET,
      async execute() {
        return { kind: "complete", observed, output: {} };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    },
  });
  const versionObserved = { ready: true, resolvedBindings: true, bundleVerified: true };
  // Keep the production admission surface; swap only the backend for a settling double.
  const withVersionDouble = (form: V2Form, id: string): V2Form => ({
    ...form,
    backend: {
      id,
      targetKey: TARGET,
      async execute() {
        return { kind: "complete", observed: versionObserved, output: {} };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    },
  });
  const deploymentBackend = (id: string): V2Form["backend"] => {
    const run = async (input: V2Execution): Promise<V2BackendResult> => {
      if (deploymentMode === "no_effect")
        return { kind: "no_effect", code: "fixture_refused", message: "fixture refusal" };
      const versions = input.action === "delete" ? [] : (input.spec.versions as JsonObject[]);
      return {
        kind: "complete",
        observed:
          input.action === "delete"
            ? { ready: false, active: false, selectedVersions: [] }
            : {
                ready: true,
                active: true,
                selectedVersions: versions.map(
                  (item): JsonObject => ({
                    resourceUid: (item.workerVersion as JsonObject).resourceUid ?? null,
                    weight: item.weight ?? null,
                  }),
                ),
              },
        output: {},
      };
    };
    return { id, targetKey: TARGET, execute: run, reconcile: run };
  };
  const withDeploymentDouble = (form: V2Form, id: string): V2Form => ({
    ...form,
    backend: deploymentBackend(id),
  });

  const reader = createV2WorkerPublicationState({ sql, now: () => new Date(now) });
  const productionVersion07 = createInternalV2ForwardWorkerVersionForm({ targetKey: TARGET });
  const productionVersion08 = createInternalV2ContainerConsumerWorkerVersionForm({
    targetKey: TARGET,
  });
  const productionDeployment06 = createForwardWorkerDeploymentForm({ targetKey: TARGET });
  const productionDeployment07 = createContainerConsumerWorkerDeploymentForm({
    targetKey: TARGET,
  });
  const legacyDeployment04 = withDeploymentDouble(
    createWorkerDeploymentForm({
      targetKey: TARGET,
      publicationState: reader,
      ownerForWorker() {
        throw new Error("native owner absent in the admission fixture");
      },
      scheduledAttachments: {
        async requiresScheduledHandler() {
          return { kind: "unknown" };
        },
      },
    }),
    "fixture-legacy-deployment",
  );
  const engine = createTakoformV2Engine({
    sql,
    now: () => new Date(now),
    replayWindowSeconds: 3600,
    authorize: async () => true,
    forms: {
      [MODULE_WORKER_FORM_URL]: metadata("fixture-worker"),
      [WORKER_BUNDLE_FORM_URL]: metadata("fixture-bundle"),
      [C.formUrl]: metadata("fixture-container-01", { ready: true, servingGeneration: 1 }),
      [CONTAINER_0_2_FORM_URL]: metadata("fixture-container-02", {
        ready: true,
        servingGeneration: 1,
      }),
      [CONTAINER_0_3_FORM_URL]: metadata("fixture-container-03", {
        ready: true,
        servingGeneration: 1,
      }),
      // A settled ObjectBucket target, as the bucket binding authority reads it.
      [OBJECT_BUCKET_EOF_COUNTED_FORM_URL]: metadata(OBJECT_BUCKET_BACKEND_ID, {
        bucketExists: true,
        ...OBJECT_BUCKET_LIMITS,
      }),
      [WORKER_VERSION_FORM_URL]: metadata("fixture-version-05", versionObserved),
      [CONTAINER_WORKER_VERSION_FORM_URL]: metadata("fixture-version-06", versionObserved),
      [FORWARD_WORKER_VERSION_FORM_URL]: withVersionDouble(
        productionVersion07,
        "fixture-version-07",
      ),
      [CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL]: withVersionDouble(
        productionVersion08,
        "fixture-version-08",
      ),
      [WORKER_DEPLOYMENT_FORM_URL]: legacyDeployment04,
      [FORWARD_WORKER_DEPLOYMENT_FORM_URL]: withDeploymentDouble(
        productionDeployment06,
        "fixture-deployment-06",
      ),
      [CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL]: withDeploymentDouble(
        productionDeployment07,
        "fixture-deployment-07",
      ),
    },
  });
  let serial = 0;
  async function accept(form: string, name: string, spec: JsonObject) {
    return await engine.acceptCreate({
      principal: PRINCIPAL,
      key: `container-consumer-registration-${++serial}-key-0001`,
      input: { form, space: SPACE, name, spec },
    });
  }
  /** Accept and run one create to a settled success (or return the settled op). */
  async function create(form: string, name: string, spec: JsonObject = {}, settle = true) {
    const op = await accept(form, name, spec);
    if (settle) expect(await engine.runNext()).toMatchObject({ id: op.id, status: "succeeded" });
    return op;
  }
  /** The engine's refusal for a create that must not be accepted; null if it was accepted. */
  async function refusal(form: string, name: string, spec: JsonObject) {
    try {
      await accept(form, name, spec);
      return null;
    } catch (error) {
      return error as { status?: number; code?: string };
    }
  }
  async function claim(id: string): Promise<V2Execution> {
    const op = await store.operation(id);
    if (!op) throw new Error("missing accepted Operation");
    const resource = await store.resource(op.resource_uid);
    if (!resource) throw new Error("missing Resource");
    const token = `registration-lease-${id}`;
    expect(await store.claim(id, token, now, now + 60_000)).toBe(true);
    expect(await store.markDispatch(id, token, new Date(now).toISOString())).toBe(true);
    return {
      operationId: id,
      leaseToken: token,
      backendKey: op.backend_key,
      backendId: op.backend_id,
      targetKey: op.target_key,
      resourceUid: resource.uid,
      principal: op.principal,
      action: op.action,
      generation: op.generation,
      form: resource.form_url,
      space: resource.space,
      name: resource.name,
      spec: JSON.parse(op.accepted_spec_json),
      previousObserved: JSON.parse(resource.observed_json),
      previousOutput: JSON.parse(resource.output_json),
    };
  }
  async function operationCount(): Promise<number> {
    return Number((await sql.query("SELECT COUNT(*) AS n FROM tf_v2_operations"))[0]?.n);
  }
  async function sealedForms(operationId: string): Promise<Record<string, string>> {
    const rows = await sql.query(
      "SELECT target_uid, form_url FROM tf_v2_operation_references WHERE operation_id = ? ORDER BY target_uid",
      [operationId],
    );
    return Object.fromEntries(rows.map((row) => [String(row.target_uid), String(row.form_url)]));
  }
  /** One Worker with a ready 0.5.0 Version, which every Deployment Form may select. */
  async function worker(label: string) {
    const w = await create(MODULE_WORKER_FORM_URL, `worker-${label}`);
    const bundle = await create(WORKER_BUNDLE_FORM_URL, `bundle-${label}`);
    const versionSpec = (): JsonObject => ({
      worker: { resourceUid: w.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
    });
    const v05 = await create(WORKER_VERSION_FORM_URL, `v05-${label}`, versionSpec());
    const deploymentSpec = (...versions: { resourceUid: string }[]): JsonObject => ({
      worker: { resourceUid: w.resourceUid },
      // Weights are integers summing to exactly 10000; the last one takes the remainder.
      versions: versions.map((version, index) => ({
        workerVersion: { resourceUid: version.resourceUid },
        weight:
          index === versions.length - 1
            ? 10_000 - Math.floor(10_000 / versions.length) * (versions.length - 1)
            : Math.floor(10_000 / versions.length),
      })),
    });
    return { worker: w, bundle, v05, versionSpec, deploymentSpec };
  }
  return {
    root,
    db,
    sql,
    store,
    engine,
    create,
    accept,
    refusal,
    claim,
    operationCount,
    sealedForms,
    worker,
    setDeploymentMode(mode: DeploymentMode) {
      deploymentMode = mode;
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export type AdmissionFixture = ReturnType<typeof admissionFixture>;

// ---------------------------------------------------------------------------------------
// Production composition fixture. Real SQL, real file-backed held objects, the real
// forward composition's Form registration and publication readers. The ONLY double is the
// runtime-owner port (`ownerForWorker`), clearly named `OwnerDouble`: it records what the
// production Deployment/Endpoint backends hand to the owner and answers with the receipt a
// real owner would compute from the accepted graph. No native, workerd or provider call.
// ---------------------------------------------------------------------------------------

export const ASSETS_MANIFEST_URL =
  "https://artifact.example.test/consumer-registration/assets.json";
const ASSET_URL = "https://artifact.example.test/consumer-registration/index.html";
export const BUNDLE_MANIFEST_HELD_URL =
  "https://artifact.example.test/consumer-registration/bundle.json";
const BUNDLE_MODULE_HELD_URL = "https://artifact.example.test/consumer-registration/index.mjs";

export interface OwnerCall {
  readonly form: string;
  readonly action: string;
  readonly operationId: string;
  readonly resourceUid: string;
  readonly spec: JsonObject;
}

/** Owner-port double: records each call and returns the receipt for the accepted graph. */
export class OwnerDouble {
  readonly calls: OwnerCall[] = [];
  /** When set, the next execute() answers with this instead of a confirmed receipt. */
  next: "confirm" | "throw" | "abandon" = "confirm";
  constructor(private readonly hostname: (resourceUid: string) => string) {}
  owner(workerUid: string): Pick<WorkerdWorkerRuntimeOwner, "workerResourceUid" | "execute"> {
    return {
      workerResourceUid: workerUid,
      execute: async (execution: V2Execution) => {
        this.calls.push({
          form: execution.form,
          action: execution.action,
          operationId: execution.operationId,
          resourceUid: execution.resourceUid,
          spec: structuredClone(execution.spec),
        });
        if (this.next === "throw") throw new Error("owner double refused");
        if (this.next === "abandon")
          return {
            kind: "abandoned_before_activation" as const,
            operationId: execution.operationId,
          };
        if (execution.action === "delete" && execution.form !== WORKER_ENDPOINT_FORM_URL)
          return {
            kind: "confirmed" as const,
            identity: null,
            deferRetirementUntilDeadline: false,
          };
        const deployment = this.deployments.get(workerUid);
        if (!deployment) throw new Error("owner double has no accepted graph");
        return {
          kind: "confirmed" as const,
          identity: {
            generation: `takoserver-v2-operation:${execution.operationId}`,
            workerResourceUid: workerUid,
            hostnames:
              execution.form === WORKER_ENDPOINT_FORM_URL
                ? [this.hostname(execution.resourceUid)]
                : (this.endpointHostnames.get(workerUid) ?? []),
            versions: deployment,
          },
          deferRetirementUntilDeadline: false,
        };
      },
    };
  }
  /** The weighted versions the accepted Deployment selects, as a real owner would pin them. */
  readonly deployments = new Map<
    string,
    { versionId: string; workerVersionUid: string; weight: number }[]
  >();
  readonly endpointHostnames = new Map<string, readonly string[]>();
}

export async function compositionFixture() {
  const root = mkdtempSync(join(tmpdir(), "container-consumer-composition-"));
  const db = new Database(join(root, "control.sqlite"));
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  const objects = createFileObjectStore({ root: join(root, "objects") });
  const clock = () => new Date();
  const asset = new TextEncoder().encode("consumer-registration-static");
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      files: [
        {
          path: "index.html",
          url: ASSET_URL,
          sha256: (await bytesDigest(asset)).slice(7),
          mediaType: "text/html",
        },
      ],
    }),
  );
  const moduleBytes = new TextEncoder().encode(
    "export default { fetch() { return new Response('held'); } };\n",
  );
  const bundleManifest = new TextEncoder().encode(
    JSON.stringify({
      entrypoint: "index.mjs",
      files: [
        {
          path: "index.mjs",
          url: BUNDLE_MODULE_HELD_URL,
          sha256: (await bytesDigest(moduleBytes)).slice(7),
          mediaType: "application/javascript+module",
        },
      ],
    }),
  );
  const entries = [] as {
    url: string;
    sha256: string;
    objectKey: string;
    grants: { principal: string; space: string }[];
  }[];
  for (const [url, bytes, objectKey] of [
    [ASSETS_MANIFEST_URL, manifest, "assets/manifest"],
    [ASSET_URL, asset, "assets/file"],
    [BUNDLE_MANIFEST_HELD_URL, bundleManifest, "bundle/manifest"],
    [BUNDLE_MODULE_HELD_URL, moduleBytes, "bundle/module"],
  ] as const) {
    await objects.create(objectKey, bytes);
    entries.push({
      url,
      sha256: (await bytesDigest(bytes)).slice(7),
      objectKey,
      grants: [{ principal: PRINCIPAL, space: SPACE }],
    });
  }
  const config = {
    cursorSigningKey: new Uint8Array(32).fill(0x52),
    documentation: "https://docs.example.test/v2",
    authenticationDocumentation: "https://docs.example.test/auth",
    workerBundle: { targetKey: TARGET, heldArtifacts: entries },
    staticAssetBundle: { targetKey: TARGET, heldArtifacts: entries },
  };
  // Synthetic, in-memory, non-extractable key: it only makes the 0.7.0 private-input surface exist
  // so the test can show 0.8.0 does not get one. No secret is read, minted or persisted.
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const keyring = {
    current: { keyId: "synthetic-registration", key },
    keyForDecryption: (id: string) => (id === "synthetic-registration" ? key : undefined),
  };
  const options: SelfhostV2ForwardWorkerCompositionOptions = {
    sql,
    objects,
    clock,
    config,
    configuredInputSealer: createV2WorkerVersionConfiguredInputSealer(keyring),
    forwardConfiguredInputSealer: createV2ForwardWorkerVersionConfiguredInputSealer(keyring),
    targetKey: TARGET,
    rootDirectory: join(root, "owners"),
    // No workerd: any code path that needs a real native owner must fail closed.
    workerdBinary: null,
    spawn() {
      throw new Error("the composition fixture never spawns workerd");
    },
  };
  const forward = createSelfhostV2ForwardWorkerComposition(options);
  const retained = createSelfhostV2WorkerComposition({
    ...options,
    rootDirectory: join(root, "retained-owners"),
  });
  await forward.restoreOwners();
  await retained.restoreOwners();
  const held = createV2HeldArtifactSource({ objects, entries });
  const assetHost = createStaticAssetBundleHost({ sql, targetKey: TARGET, source: held });
  const assetCustody = createStaticAssetBundleCustody({ sql, source: held });
  const bundleHost = createWorkerBundleHost({ sql, targetKey: TARGET, source: held });
  const bundleCustody = createWorkerBundleCustody({ sql, source: held });
  const publicationState = createV2ForwardWorkerPublicationState({
    sql,
    now: clock,
    assetCustody,
    bundleCustody,
  });
  const hostnameFor = (resourceUid: string) => `ep-${resourceUid.slice(0, 8)}.example.test`;
  const owner = new OwnerDouble(hostnameFor);
  const compositionForms = forward.internalFormFactory({ sql, objects, clock });
  const retainedForms = retained.internalFormFactory({ sql, objects, clock });
  const ownerForWorker = async (workerUid: string) => owner.owner(workerUid);
  // Production factories over the production publication state; only `ownerForWorker` differs
  // from the composition's own Deployment/Endpoint Forms (which would need a real native owner).
  const deployment07 = createContainerConsumerWorkerDeploymentForm({
    targetKey: TARGET,
    publicationState,
    scheduledAttachments: createContainerConsumerWorkerCronTriggerAdmissionReader({ sql }),
    ownerForWorker,
  });
  const deployment06 = createForwardWorkerDeploymentForm({
    targetKey: TARGET,
    publicationState,
    scheduledAttachments: createForwardWorkerCronTriggerAdmissionReader({ sql }),
    ownerForWorker,
  });
  const endpoint = createForwardWorkerEndpointForm({
    targetKey: TARGET,
    publicationState,
    ownerForWorker,
    assignHostname: ({ resourceUid }) => hostnameFor(resourceUid),
    observeTls: async (input) => ({ ...input, ready: true }),
    observeRouteAbsent: async (input) => ({ ...input, absent: true }),
  });
  const engineWith = (forms: Record<string, V2Form>) =>
    createTakoformV2Engine({
      sql,
      now: clock,
      replayWindowSeconds: 3600,
      leaseMilliseconds: 60_000,
      authorize: async () => true,
      forms: {
        ...forms,
        [STATIC_ASSET_BUNDLE_FORM_URL]: assetHost.form,
        [WORKER_BUNDLE_FORM_URL]: bundleHost.form,
      },
    });
  /** Owner double wired in for Deployment and Endpoint; Version/Worker are the composition's. */
  const engineForms: Record<string, V2Form> = {
    ...compositionForms,
    [CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL]: deployment07,
    [FORWARD_WORKER_DEPLOYMENT_FORM_URL]: deployment06,
    [WORKER_ENDPOINT_FORM_URL]: endpoint,
  };
  const engine = engineWith(engineForms);
  /**
   * The same production Deployment factories with NO owner available. Driving the composition's
   * own Deployment would open a real owner (and its lock file) with no workerd behind it, which
   * is outside what this fixture claims; an owner that cannot be opened is the same condition
   * seen from the backend, and it leaves no handle behind.
   */
  const unavailableOwner = async (): Promise<never> => {
    throw new Error("no native owner is available in this fixture");
  };
  const noOwnerEngine = engineWith({
    ...compositionForms,
    [CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL]: createContainerConsumerWorkerDeploymentForm({
      targetKey: TARGET,
      publicationState,
      scheduledAttachments: createContainerConsumerWorkerCronTriggerAdmissionReader({ sql }),
      ownerForWorker: unavailableOwner,
    }),
  });
  let serial = 0;
  async function create(
    target: typeof engine,
    form: string,
    name: string,
    spec: JsonObject,
    settle = true,
  ) {
    const op = await target.acceptCreate({
      principal: PRINCIPAL,
      key: `consumer-composition-${++serial}-key-0001`,
      input: { form, space: SPACE, name, spec },
    });
    if (settle) {
      const settled = await target.runNext();
      expect(settled).toMatchObject({ id: op.id });
      return { op, settled };
    }
    return { op, settled: null };
  }
  async function staticWorker(label: string, versionForm: string) {
    const worker = await create(engine, MODULE_WORKER_FORM_URL, `worker-${label}`, {});
    const assets = await create(engine, STATIC_ASSET_BUNDLE_FORM_URL, `assets-${label}`, {
      artifact: { url: ASSETS_MANIFEST_URL, sha256: (await bytesDigest(manifest)).slice(7) },
    });
    const version = await create(engine, versionForm, `version-${label}`, {
      worker: { resourceUid: worker.op.resourceUid },
      handlers: [],
      assets: {
        bundle: { resourceUid: assets.op.resourceUid },
        runWorkerFirst: false,
        notFoundHandling: "none",
      },
    });
    expect(version.settled).toMatchObject({ status: "succeeded", effect: "complete" });
    return { worker: worker.op, assets: assets.op, version: version.op };
  }
  const store = createV2Store(sql);
  /** Lease one accepted Operation exactly as the engine would, without running its backend. */
  async function claim(id: string): Promise<V2Execution> {
    const op = await store.operation(id);
    const resource = op ? await store.resource(op.resource_uid) : null;
    if (!op || !resource) throw new Error("missing accepted Operation");
    const at = Date.now();
    const token = `composition-lease-${id}`;
    expect(await store.claim(id, token, at, at + 60_000)).toBe(true);
    expect(await store.markDispatch(id, token, new Date(at).toISOString())).toBe(true);
    return {
      operationId: id,
      leaseToken: token,
      backendKey: op.backend_key,
      backendId: op.backend_id,
      targetKey: op.target_key,
      resourceUid: resource.uid,
      principal: op.principal,
      action: op.action,
      generation: op.generation,
      form: resource.form_url,
      space: resource.space,
      name: resource.name,
      spec: JSON.parse(op.accepted_spec_json),
      previousObserved: JSON.parse(resource.observed_json),
      previousOutput: JSON.parse(resource.output_json),
    };
  }
  async function versionId(uid: string, generation: number): Promise<string> {
    const digest = await bytesDigest(new TextEncoder().encode(`${uid}\u0000${generation}`));
    return `v2-${digest.slice("sha256:".length)}`;
  }
  return {
    root,
    db,
    sql,
    objects,
    clock,
    options,
    bundleSha256: (await bytesDigest(bundleManifest)).slice(7),
    forward,
    retained,
    compositionForms,
    retainedForms,
    publicationState,
    engine,
    engineForms,
    noOwnerEngine,
    owner,
    hostnameFor,
    create,
    claim,
    staticWorker,
    versionId,
    /**
     * `shutdownMayRefuse` is for the one test that deliberately leaves a Deployment `unknown`
     * (no workerd exists) and has already closed the owner it opened itself: the composition
     * refuses to suspend over an uncertain serving state by design. Nothing else is skipped,
     * and the fixture spawns no child whose quiescence this teardown could be mistaken for.
     */
    async close(shutdownMayRefuse = false) {
      try {
        await forward.suspendOwnersRetainingCustody();
      } catch (error) {
        if (!shutdownMayRefuse) throw error;
      }
      await retained.suspendOwnersRetainingCustody();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export type CompositionFixture = Awaited<ReturnType<typeof compositionFixture>>;

// ---------------------------------------------------------------------------------------
// Hosted-selection graph fixture: the read-only Forward Container publication state over a
// mixed Container 0.1 / 0.2 consumer graph. The Version backend is a labeled settling double
// standing in for the Hosted bridge; admission/reference sealing is the production factory's.
// ---------------------------------------------------------------------------------------

const BUNDLE_MODULE_URL = "https://artifacts.example.test/consumer-registration/index.js";
const BUNDLE_MANIFEST_URL = "https://artifacts.example.test/consumer-registration/manifest.json";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function containerGraphFixture() {
  const root = mkdtempSync(join(tmpdir(), "container-consumer-graph-"));
  const db = new Database(join(root, "metadata.sqlite"));
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  const store = createV2Store(sql);
  const nowMs = Date.now();
  const bytes = new TextEncoder().encode("export default {fetch(){return new Response('held')}}");
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      entrypoint: "index.js",
      files: [
        {
          path: "index.js",
          url: BUNDLE_MODULE_URL,
          sha256: sha256(bytes),
          mediaType: "application/javascript+module",
        },
      ],
    }),
  );
  const bundle = createWorkerBundleHost({
    sql,
    targetKey: TARGET,
    source: {
      async read({ url }) {
        if (url === BUNDLE_MODULE_URL) return bytes;
        if (url === BUNDLE_MANIFEST_URL) return manifest;
        throw new Error("fixture source unavailable");
      },
    },
  });
  const metadata = (id: string, observed: JsonObject): V2Form => ({
    validateCreate() {},
    validateUpdate() {},
    backend: {
      id,
      targetKey: TARGET,
      async execute() {
        return { kind: "complete", observed, output: {} };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    },
  });
  const settlingVersion = (form: V2Form, id: string): V2Form => ({
    ...form,
    backend: {
      id,
      targetKey: TARGET,
      async execute() {
        return {
          kind: "complete",
          observed: { ready: true, resolvedBindings: true, bundleVerified: true },
          output: {},
        };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    },
  });
  const forms = {
    [MODULE_WORKER_FORM_URL]: metadata("fixture-module", { ready: true }),
    [C.formUrl]: metadata("fixture-container-01", { ready: true, servingGeneration: 1 }),
    [CONTAINER_0_2_FORM_URL]: metadata("fixture-container-02", {
      ready: true,
      servingGeneration: 1,
    }),
    [WORKER_BUNDLE_FORM_URL]: bundle.form,
    [FORWARD_WORKER_VERSION_FORM_URL]: settlingVersion(
      createInternalV2ForwardWorkerVersionForm({ targetKey: TARGET }),
      "fixture-version-07",
    ),
    [CONTAINER_CONSUMER_WORKER_VERSION_FORM_URL]: settlingVersion(
      createInternalV2ContainerConsumerWorkerVersionForm({ targetKey: TARGET }),
      "fixture-version-08",
    ),
    [FORWARD_WORKER_DEPLOYMENT_FORM_URL]: createForwardWorkerDeploymentForm({ targetKey: TARGET }),
    [CONTAINER_CONSUMER_WORKER_DEPLOYMENT_FORM_URL]: createContainerConsumerWorkerDeploymentForm({
      targetKey: TARGET,
    }),
  };
  const engine = createTakoformV2Engine({
    sql,
    now: () => new Date(nowMs),
    replayWindowSeconds: 3600,
    authorize: async () => true,
    forms,
  });
  const options = { sql, now: () => new Date(nowMs), bundleCustody: bundle.custody };
  const nonContainer = createV2ForwardWorkerPublicationState(options);
  const hosted = createV2ForwardContainerWorkerPublicationState(options);
  const generic = createV2WorkerPublicationState(options);
  let serial = 0;
  async function create(form: string, name: string, spec: JsonObject, settle = true) {
    const accepted = await engine.acceptCreate({
      principal: PRINCIPAL,
      key: `container-consumer-graph-${++serial}-key-0001`,
      input: { form, name, space: SPACE, spec },
    });
    if (settle) expect((await engine.runNext())?.status).toBe("succeeded");
    return accepted;
  }
  async function claim(id: string): Promise<V2Execution> {
    const op = await store.operation(id);
    const resource = op ? await store.resource(op.resource_uid) : null;
    if (!op || !resource) throw new Error("fixture source unavailable");
    const token = `consumer-graph-lease-${id}`;
    expect(await store.claim(id, token, nowMs, nowMs + 60_000)).toBe(true);
    expect(await store.markDispatch(id, token, new Date(nowMs).toISOString())).toBe(true);
    return {
      operationId: id,
      leaseToken: token,
      backendKey: op.backend_key,
      backendId: op.backend_id,
      targetKey: op.target_key,
      resourceUid: resource.uid,
      principal: op.principal,
      action: op.action,
      generation: op.generation,
      form: resource.form_url,
      space: resource.space,
      name: resource.name,
      spec: JSON.parse(op.accepted_spec_json),
      previousObserved: JSON.parse(resource.observed_json),
      previousOutput: JSON.parse(resource.output_json),
    };
  }
  /**
   * Worker + bundle + Containers 0.1/0.2 + Version of `versionForm` bound to `bindings`, then a
   * Deployment of `deploymentForm` selecting it, claimed (not yet run) for the readers.
   */
  async function graph(input: {
    versionForm: string;
    deploymentForm: string;
    bindings: readonly ("c01" | "c02")[];
  }) {
    const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
    const c01 = await create(C.formUrl, "c01", {});
    const c02 = await create(CONTAINER_0_2_FORM_URL, "c02", {});
    const artifact = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
      artifact: { url: BUNDLE_MANIFEST_URL, sha256: sha256(manifest) },
    });
    const names = { c01: "APP", c02: "LEGACY" } as const;
    const targets = { c01, c02 };
    const version = await create(
      input.versionForm,
      "version",
      {
        worker: { resourceUid: worker.resourceUid },
        bundle: { resourceUid: artifact.resourceUid },
        handlers: ["fetch"],
        containerBindings: input.bindings.map((key) => ({
          name: names[key],
          resource: { resourceUid: targets[key].resourceUid },
        })),
      },
      false,
    );
    const versionExecution = await claim(version.id);
    expect(
      await store.settle({
        id: versionExecution.operationId,
        token: versionExecution.leaseToken,
        status: "succeeded",
        effect: "complete",
        at: new Date(nowMs).toISOString(),
        retainUntil: new Date(nowMs + 3_600_000).toISOString(),
        observedJson: JSON.stringify({
          ready: true,
          resolvedBindings: true,
          bundleVerified: true,
        }),
        outputJson: JSON.stringify({}),
      }),
    ).toBe(true);
    const deployment = await create(
      input.deploymentForm,
      "deployment",
      {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      },
      false,
    );
    return {
      worker,
      c01,
      c02,
      artifact,
      version,
      deployment,
      deploymentExecution: await claim(deployment.id),
    };
  }
  return {
    db,
    sql,
    store,
    nonContainer,
    hosted,
    generic,
    graph,
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
