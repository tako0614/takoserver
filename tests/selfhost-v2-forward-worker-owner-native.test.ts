import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import type { JsonObject } from "../src/ports.ts";
import {
  createSelfhostV2ForwardWorkerComposition,
  createSelfhostV2WorkerComposition,
  type SelfhostV2ForwardWorkerCompositionOptions,
} from "../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { readV2ConfiguredPrivateInputs } from "../src/takoform-v2/configured-private-inputs.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { createV2HeldArtifactSource } from "../src/takoform-v2/forms/artifact-source.ts";
import { OBJECT_BUCKET_EOF_COUNTED_FORM_URL } from "../src/takoform-v2/forms/object-bucket-binding-profile.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleHost } from "../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleHost } from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import { WORKER_CRON_TRIGGER_FORM_URL } from "../src/takoform-v2/forms/worker-cron-trigger.ts";
import {
  FORWARD_WORKER_DEPLOYMENT_FORM_URL,
  FORWARD_WORKER_VERSION_FORM_URL,
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
import {
  createForwardWorkerCronTriggerAdmissionReader,
  createWorkerCronTriggerAdmissionReader,
} from "../src/takoform-v2/worker-cron-trigger-backend.ts";
import {
  createV2ForwardWorkerVersionConfiguredInputSealer,
  createV2WorkerVersionConfiguredInputSealer,
} from "../src/takoform-v2/worker-version-configured-inputs.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { spawnWorkerdWithParentDeath } from "../src/workerd-linux-process.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const TARGET = "forward-owner-fixture";
const MANIFEST = "https://artifact.example.test/forward-owner/manifest.json";
const MODULE = "https://artifact.example.test/forward-owner/index.mjs";
const ASSETS = "https://artifact.example.test/forward-owner/assets.json";
const ASSET = "https://artifact.example.test/forward-owner/index.html";

// Real Core, on-disk SQLite, FS held bytes and configured-input cryptography.
// Only native-gated cases select/inspect/spawn actual pinned workerd. The
// component cases never use a stand-in native sender or claim native readiness.
async function fixture(nativeBinary: string | null = null) {
  const root = await mkdtemp(join(tmpdir(), "takoserver-forward-owner-"));
  const db = new Database(join(root, "control.sqlite"));
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  const objects = createFileObjectStore({ root: join(root, "objects") });
  const clock = () => new Date();
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const comparison = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
  const keyring = {
    current: { keyId: "synthetic-forward-owner", key },
    keyForDecryption: (id: string) => (id === "synthetic-forward-owner" ? key : undefined),
  };
  const forwardSealer = createV2ForwardWorkerVersionConfiguredInputSealer(keyring);
  const source = new TextEncoder().encode(`export default {
    fetch(request, env) {
      if (new URL(request.url).pathname === "/stream") return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode("first"));}}));
      return new Response("native:" + env.TOKEN);
    }
  };`);
  const asset = new TextEncoder().encode("forward-held-static");
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      entrypoint: "index.mjs",
      files: [
        {
          path: "index.mjs",
          url: MODULE,
          sha256: (await bytesDigest(source)).slice(7),
          mediaType: "application/javascript+module",
        },
      ],
    }),
  );
  const assetManifest = new TextEncoder().encode(
    JSON.stringify({
      files: [
        {
          path: "index.html",
          url: ASSET,
          sha256: (await bytesDigest(asset)).slice(7),
          mediaType: "text/html",
        },
      ],
    }),
  );
  const entries = [];
  for (const [url, bytes, objectKey] of [
    [MANIFEST, manifest, "bundle/manifest"],
    [MODULE, source, "bundle/module"],
    [ASSETS, assetManifest, "assets/manifest"],
    [ASSET, asset, "assets/file"],
  ] as const) {
    await objects.create(objectKey, bytes);
    entries.push({
      url,
      sha256: (await bytesDigest(bytes)).slice(7),
      objectKey,
      grants: [{ principal: "alice", space: "space" }],
    });
  }
  const config = {
    documentation: "https://docs.example.test/v2",
    authenticationDocumentation: "https://docs.example.test/auth",
    workerBundle: { targetKey: TARGET, heldArtifacts: entries },
    staticAssetBundle: { targetKey: TARGET, heldArtifacts: entries },
  };
  let binary: string | null = null;
  if (nativeBinary !== null) {
    const selected = await selectClosedGraphWorkerd({
      binary: nativeBinary,
      privateRoot: join(root, "selected-workerd"),
    });
    if (!selected.binary)
      throw new Error(selected.diagnostic ?? "pinned native workerd unavailable");
    binary = selected.binary;
  }
  const children: ReturnType<typeof spawnWorkerdWithParentDeath>[] = [];
  let composition: ReturnType<typeof createSelfhostV2ForwardWorkerComposition>;
  const options: SelfhostV2ForwardWorkerCompositionOptions = {
    sql,
    objects,
    clock,
    config,
    targetKey: TARGET,
    rootDirectory: join(root, "owners"),
    workerdBinary: binary,
    configuredInputSealer: createV2WorkerVersionConfiguredInputSealer(keyring),
    forwardConfiguredInputSealer: forwardSealer,
    endpoint: {
      assignHostname({ resourceUid }) {
        return `fw-${resourceUid.slice(0, 8)}.example.test`;
      },
      async observeTls(input) {
        const owner = await composition.ownerForWorkerUid(input.workerUid);
        const serving = await owner.observeServing({
          workerResourceUid: input.workerUid,
          targetKey: TARGET,
        });
        return {
          ...input,
          ready: serving.kind === "serving" && serving.hostnames.includes(input.hostname),
        };
      },
      async observeRouteAbsent(input) {
        const owner = await composition.ownerForWorkerUid(input.workerUid);
        const serving = await owner.observeServing({
          workerResourceUid: input.workerUid,
          targetKey: TARGET,
        });
        return {
          ...input,
          absent: serving.kind === "serving" && !serving.hostnames.includes(input.hostname),
        };
      },
    },
    spawn(command: readonly string[]) {
      const child = spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "inherit" });
      children.push(child);
      return child;
    },
  };
  composition = createSelfhostV2ForwardWorkerComposition(options);
  await composition.restoreOwners();
  const held = createV2HeldArtifactSource({ objects, entries });
  const bundleHost = createWorkerBundleHost({ sql, targetKey: TARGET, source: held });
  const assetHost = createStaticAssetBundleHost({ sql, targetKey: TARGET, source: held });
  let readAllowed = true;
  function makeEngine() {
    return createTakoformV2Engine({
      sql,
      authorize: async (_p, _s, access) => access !== "read" || readAllowed,
      privateInputCustody: {
        transfer: { current: { id: "synthetic-transfer", key } },
        comparison: { current: { id: "synthetic-comparison", key: comparison } },
        transferTtlSeconds: 60,
      },
      replayWindowSeconds: 3600,
      leaseMilliseconds: 60000,
      forms: {
        ...composition.internalFormFactory({ sql, objects, clock }),
        [WORKER_BUNDLE_FORM_URL]: bundleHost.form,
        [STATIC_ASSET_BUNDLE_FORM_URL]: assetHost.form,
      },
    });
  }
  let engine = makeEngine();
  let serial = 0;
  async function create(
    form: string,
    name: string,
    spec: JsonObject,
    privateInputs?: Readonly<Record<string, string>>,
    settle = true,
  ) {
    const accepted = await engine.acceptCreate({
      principal: "alice",
      key: `forward-owner-create-${++serial}-key-0001`,
      input: { form, space: "space", name, spec, ...(privateInputs ? { privateInputs } : {}) },
    });
    if (settle)
      expect(await engine.runNext()).toMatchObject({
        id: accepted.id,
        status: "succeeded",
        effect: "complete",
      });
    return accepted;
  }
  async function basics(settleVersion = true, withSecret = true) {
    const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
    const bundle = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
      artifact: { url: MANIFEST, sha256: (await bytesDigest(manifest)).slice(7) },
    });
    const spec = {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
      ...(withSecret ? { requiredSensitiveVars: ["TOKEN"] } : {}),
    };
    const version = await create(
      FORWARD_WORKER_VERSION_FORM_URL,
      "version",
      spec,
      withSecret ? { TOKEN: "synthetic-forward-secret" } : undefined,
      settleVersion,
    );
    return { worker, bundle, version, spec };
  }
  async function remove(uid: string, generation = 1) {
    const op = await engine.acceptDelete({
      principal: "alice",
      uid,
      key: `forward-owner-delete-${++serial}-key-0001`,
      expectedGeneration: generation,
    });
    expect(await engine.runNext()).toMatchObject({
      id: op.id,
      status: "succeeded",
      effect: "complete",
    });
    return op;
  }
  return {
    root,
    assetManifest,
    db,
    sql,
    objects,
    options,
    config,
    clock,
    forwardSealer,
    keyring,
    create,
    basics,
    remove,
    children,
    get composition() {
      return composition;
    },
    get engine() {
      return engine;
    },
    denyRead() {
      readAllowed = false;
    },
    async reopen() {
      await composition.suspendOwnersRetainingCustody();
      composition = createSelfhostV2ForwardWorkerComposition(options);
      const restored = await composition.restoreOwners();
      engine = makeEngine();
      return restored;
    },
    async close(allowUnsettledWithoutNative = false) {
      try {
        await composition.suspendOwnersRetainingCustody();
      } catch (error) {
        // SQL-only claim tests intentionally retain pending Operations. This
        // local teardown proves no native child existed; it is not a product
        // quiescence/cleanup receipt for those unsettled Operations.
        if (!allowUnsettledWithoutNative || children.length !== 0) throw error;
      } finally {
        for (const child of children)
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await Promise.all(children.map((child) => child.exited));
        db.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

test("forward owner component named factories keep retained defaults and refuse03 registration", async () => {
  const f = await fixture();
  const retained = createSelfhostV2WorkerComposition({
    ...f.options,
    rootDirectory: join(f.root, "retained-owners"),
  });
  try {
    await retained.restoreOwners();
    const old = retained.internalFormFactory({ sql: f.sql, objects: f.objects, clock: f.clock });
    const next = f.composition.internalFormFactory({
      sql: f.sql,
      objects: f.objects,
      clock: f.clock,
    });
    expect(Object.hasOwn(old, WORKER_VERSION_FORM_URL)).toBe(true);
    expect(Object.hasOwn(old, WORKER_DEPLOYMENT_FORM_URL)).toBe(true);
    expect(Object.hasOwn(old, FORWARD_WORKER_VERSION_FORM_URL)).toBe(false);
    expect(Object.hasOwn(old, FORWARD_WORKER_DEPLOYMENT_FORM_URL)).toBe(false);
    expect(Object.hasOwn(next, FORWARD_WORKER_VERSION_FORM_URL)).toBe(true);
    expect(Object.hasOwn(next, FORWARD_WORKER_DEPLOYMENT_FORM_URL)).toBe(true);
    expect(Object.hasOwn(next, OBJECT_BUCKET_EOF_COUNTED_FORM_URL)).toBe(false);
    expect(() =>
      f.composition.internalFormFactory({ ...f.options, clock: () => new Date() }),
    ).toThrow();
  } finally {
    await retained.suspendOwnersRetainingCustody();
    await f.close();
  }
});

test("forward owner component07 CREATE seals real custody and denies cross-owner read admission", async () => {
  const f = await fixture();
  try {
    const b = await f.basics(false);
    const identity = {
      principal: "alice",
      space: "space",
      name: "version",
      form: FORWARD_WORKER_VERSION_FORM_URL,
      resourceUid: b.version.resourceUid,
      spec: b.spec,
    };
    const sealed = await readV2ConfiguredPrivateInputs(f.sql, identity);
    expect(sealed).not.toBeNull();
    if (!sealed) throw new Error("missing actual CREATE ciphertext custody");
    expect(JSON.stringify(sealed)).not.toContain("synthetic-forward-secret");
    expect(await f.forwardSealer.open(identity, sealed)).toEqual({
      TOKEN: "synthetic-forward-secret",
    });
    expect(
      await createV2WorkerVersionConfiguredInputSealer(f.keyring).open(
        { ...identity, form: WORKER_VERSION_FORM_URL },
        sealed,
      ),
    ).toBeNull();
    const refs = await f.sql.query(
      "SELECT target_uid,form_url FROM tf_v2_operation_references WHERE operation_id=? ORDER BY target_uid",
      [b.version.id],
    );
    expect(refs).toHaveLength(2);
    expect(refs).toContainEqual({
      target_uid: b.worker.resourceUid,
      form_url: MODULE_WORKER_FORM_URL,
    });
    expect(refs).toContainEqual({
      target_uid: b.bundle.resourceUid,
      form_url: WORKER_BUNDLE_FORM_URL,
    });
    const no07Options = { ...f.options, rootDirectory: join(f.root, "missing07-owners") };
    delete no07Options.forwardConfiguredInputSealer;
    const missing07 = createSelfhostV2ForwardWorkerComposition(no07Options);
    try {
      await missing07.restoreOwners();
      const form = missing07.internalFormFactory({
        sql: f.sql,
        objects: f.objects,
        clock: f.clock,
      })[FORWARD_WORKER_VERSION_FORM_URL];
      if (!form?.validateCreate) throw new Error("missing actual07 admission form");
      expect(() => form.validateCreate?.(b.spec)).toThrow();
    } finally {
      await missing07.suspendOwnersRetainingCustody();
    }
    f.denyRead();
    await expect(
      f.create(FORWARD_WORKER_VERSION_FORM_URL, "denied", b.spec, { TOKEN: "other" }, false),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.children).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("forward owner component06 actual Cron claim inventory preserves04 and detects accepted attachments", async () => {
  const f = await fixture();
  try {
    const worker = await f.create(MODULE_WORKER_FORM_URL, "scheduled-worker", {});
    const assets = await f.create(STATIC_ASSET_BUNDLE_FORM_URL, "scheduled-assets", {
      artifact: { url: ASSETS, sha256: (await bytesDigest(f.assetManifest)).slice(7) },
    });
    const version = await f.create(FORWARD_WORKER_VERSION_FORM_URL, "static-version", {
      worker: { resourceUid: worker.resourceUid },
      handlers: [],
      assets: {
        bundle: { resourceUid: assets.resourceUid },
        runWorkerFirst: false,
        notFoundHandling: "none",
      },
    });
    const oldWorker = await f.create(MODULE_WORKER_FORM_URL, "old-worker", {});
    const oldVersion = await f.create(WORKER_VERSION_FORM_URL, "old-static", {
      worker: { resourceUid: oldWorker.resourceUid },
      handlers: [],
      assets: {
        bundle: { resourceUid: assets.resourceUid },
        runWorkerFirst: false,
        notFoundHandling: "none",
      },
    });
    const deployment = await f.create(
      FORWARD_WORKER_DEPLOYMENT_FORM_URL,
      "pending06",
      {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10000 }],
      },
      undefined,
      false,
    );
    const store = createV2Store(f.sql);
    const op = await store.operation(deployment.id);
    if (!op) throw new Error("missing genuine accepted06 operation");
    const lease = "component-real06-claim";
    const at = Date.now();
    expect(await store.claim(op.id, lease, at, at + 60000)).toBe(true);
    expect(await store.markDispatch(op.id, lease, new Date().toISOString())).toBe(true);
    const input = {
      workerUid: worker.resourceUid,
      principal: "alice",
      space: "space",
      targetKey: TARGET,
      sourceOperationId: op.id,
      leaseToken: lease,
      backendId: op.backend_id,
      backendKey: op.backend_key,
    };
    const resource = await store.resource(deployment.resourceUid);
    if (!resource) throw new Error("missing accepted06 resource");
    const execution: V2Execution = {
      operationId: op.id,
      leaseToken: lease,
      backendKey: op.backend_key,
      backendId: op.backend_id,
      targetKey: op.target_key,
      resourceUid: resource.uid,
      principal: op.principal,
      space: resource.space,
      name: resource.name,
      form: resource.form_url,
      generation: op.generation,
      action: op.action,
      spec: JSON.parse(op.accepted_spec_json),
      previousObserved: JSON.parse(resource.observed_json),
      previousOutput: JSON.parse(resource.output_json),
    };
    const resolved = await f.composition.endpointPublicationState.resolve({ execution });
    expect(resolved.kind).toBe("ready");
    if (resolved.kind !== "ready") throw new Error(`actual06 source unresolved: ${resolved.code}`);
    expect(await resolved.stillCurrent()).toBe(true);
    expect(
      await f.sql.query(
        `SELECT 1 AS ready WHERE ${resolved.sqlGuard.sql}`,
        resolved.sqlGuard.params,
      ),
    ).toEqual([{ ready: 1 }]);
    const reader = createForwardWorkerCronTriggerAdmissionReader({ sql: f.sql });
    const empty = await reader.requiresScheduledHandler(input);
    expect(empty).toMatchObject({ kind: "ready", required: false, attachmentUids: [] });
    if (empty.kind !== "ready") throw new Error("actual06 empty attachment inventory unavailable");
    expect(await empty.stillCurrent()).toBe(true);
    expect(
      await createWorkerCronTriggerAdmissionReader({ sql: f.sql }).requiresScheduledHandler(input),
    ).toEqual({ kind: "unknown" });
    expect(await reader.requiresScheduledHandler({ ...input, leaseToken: "wrong" })).toEqual({
      kind: "unknown",
    });
    const cron = await f.create(
      WORKER_CRON_TRIGGER_FORM_URL,
      "accepted-cron",
      { worker: { resourceUid: worker.resourceUid }, cron: "* * * * *" },
      undefined,
      false,
    );
    expect(await empty.stillCurrent()).toBe(false);
    expect(await resolved.stillCurrent()).toBe(false);
    expect(
      await f.sql.query(
        `SELECT 1 AS ready WHERE ${resolved.sqlGuard.sql}`,
        resolved.sqlGuard.params,
      ),
    ).toEqual([]);
    const attached = await reader.requiresScheduledHandler(input);
    expect(attached).toMatchObject({
      kind: "ready",
      required: true,
      attachmentUids: [cron.resourceUid],
    });
    if (attached.kind !== "ready") throw new Error("accepted Cron was omitted");
    expect(await attached.stillCurrent()).toBe(true);
    await f.create(
      WORKER_CRON_TRIGGER_FORM_URL,
      "second-cron",
      { worker: { resourceUid: worker.resourceUid }, cron: "0 * * * *" },
      undefined,
      false,
    );
    expect(await attached.stillCurrent()).toBe(false);
    const oldDeployment = await f.create(
      WORKER_DEPLOYMENT_FORM_URL,
      "pending04",
      {
        worker: { resourceUid: oldWorker.resourceUid },
        versions: [{ workerVersion: { resourceUid: oldVersion.resourceUid }, weight: 10000 }],
      },
      undefined,
      false,
    );
    const oldOp = await store.operation(oldDeployment.id);
    if (!oldOp) throw new Error("missing accepted04 control");
    const oldLease = "component-real04-claim";
    expect(await store.claim(oldOp.id, oldLease, at, at + 60000)).toBe(true);
    expect(await store.markDispatch(oldOp.id, oldLease, new Date().toISOString())).toBe(true);
    const oldInput = {
      ...input,
      workerUid: oldWorker.resourceUid,
      sourceOperationId: oldOp.id,
      leaseToken: oldLease,
      backendId: oldOp.backend_id,
      backendKey: oldOp.backend_key,
    };
    const old = await createWorkerCronTriggerAdmissionReader({
      sql: f.sql,
    }).requiresScheduledHandler(oldInput);
    expect(old).toMatchObject({ kind: "ready", required: false, attachmentUids: [] });
    expect(await reader.requiresScheduledHandler(oldInput)).toEqual({ kind: "unknown" });
    expect(f.children).toHaveLength(0);
  } finally {
    await f.close(true);
  }
});

const native = nativeEvidenceBinary("workerd-artifact");
test.skipIf(native === undefined)(
  "forward actual native owner07 secret/06 ACK survives suspend and SQL-held recovery",
  async () => {
    const f = await fixture(native);
    try {
      const b = await f.basics();
      const deployment = await f.create(FORWARD_WORKER_DEPLOYMENT_FORM_URL, "deployment", {
        worker: { resourceUid: b.worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: b.version.resourceUid }, weight: 10000 }],
      });
      const owner = await f.composition.ownerForWorkerUid(b.worker.resourceUid);
      expect(
        await owner.observeServing({ workerResourceUid: b.worker.resourceUid, targetKey: TARGET }),
      ).toMatchObject({ kind: "serving", sourceOperationId: deployment.id });
      const endpoint = await f.create(WORKER_ENDPOINT_FORM_URL, "endpoint", {
        worker: { resourceUid: b.worker.resourceUid },
      });
      const address = `https://fw-${endpoint.resourceUid.slice(0, 8)}.example.test/`;
      expect(await (await owner.fetch(new Request(address))).text()).toBe(
        "native:synthetic-forward-secret",
      );
      const count = f.children.length;
      expect(await f.reopen()).toContain(b.worker.resourceUid);
      expect(f.children.length).toBe(count + 1);
      const reopened = await f.composition.ownerForWorkerUid(b.worker.resourceUid);
      expect(
        await reopened.observeServing({
          workerResourceUid: b.worker.resourceUid,
          targetKey: TARGET,
        }),
      ).toMatchObject({ kind: "serving", sourceOperationId: deployment.id });
      expect(await (await reopened.fetch(new Request(address))).text()).toBe(
        "native:synthetic-forward-secret",
      );
      await f.remove(endpoint.resourceUid);
      await f.remove(deployment.resourceUid);
      expect(
        await reopened.observeRetirement({ workerVersionUid: b.version.resourceUid }),
      ).toMatchObject({ kind: "confirmed_absent" });
      expect(reopened.dispatchServiceBinding(new Request("https://fixture.example.test/"))).toEqual(
        { kind: "not_dispatched" },
      );
    } finally {
      await f.close();
    }
  },
);

test.skipIf(native === undefined)(
  "forward actual native owner06 DELETE cancels retained body before retirement ACK",
  async () => {
    const f = await fixture(native);
    try {
      const b = await f.basics();
      const deployment = await f.create(FORWARD_WORKER_DEPLOYMENT_FORM_URL, "deployment", {
        worker: { resourceUid: b.worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: b.version.resourceUid }, weight: 10000 }],
      });
      const owner = await f.composition.ownerForWorkerUid(b.worker.resourceUid);
      const dispatched = owner.dispatchServiceBinding(
        new Request("https://fixture.example.test/stream"),
      );
      if (dispatched.kind !== "dispatched") throw new Error("native stream was refused");
      const response = await dispatched.response;
      if (!response.body) throw new Error("native stream has no body");
      const reader = response.body.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
      const tail = reader.read().then(
        (value) => ({ kind: "eof", done: value.done }),
        () => ({ kind: "canceled" }),
      );
      await f.remove(deployment.resourceUid);
      expect(await tail).toMatchObject({ kind: "canceled" });
      reader.releaseLock();
      expect(
        await owner.observeRetirement({ workerVersionUid: b.version.resourceUid }),
      ).toMatchObject({ kind: "confirmed_absent" });
      const states = await f.sql.query("SELECT status,effect FROM tf_v2_operations WHERE id=?", [
        deployment.id,
      ]);
      expect(states).toEqual([{ status: "succeeded", effect: "complete" }]);
    } finally {
      await f.close();
    }
  },
);
