import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest, canonicalJson } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject } from "../src/ports.ts";
import { WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE } from "../src/providers/workerd-v2-private-binding-names.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { readV2ConfiguredPrivateInputs } from "../src/takoform-v2/configured-private-inputs.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { OBJECT_BUCKET_LIMITS } from "../src/takoform-v2/forms/object-bucket.ts";
import {
  OBJECT_BUCKET_EOF_COUNTED_FORM_URL,
  OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL,
} from "../src/takoform-v2/forms/object-bucket-binding-profile.ts";
import { STATIC_ASSET_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/static-asset-bundle.ts";
import { createStaticAssetBundleHost } from "../src/takoform-v2/forms/static-asset-bundle-backend.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleHost } from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import {
  FORWARD_WORKER_DEPLOYMENT_FORM_URL,
  FORWARD_WORKER_VERSION_FORM_URL,
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import { createForwardWorkerDeploymentForm } from "../src/takoform-v2/worker-deployment-backend.ts";
import {
  createInternalV2ForwardWorkerVersionForm,
  createV2CodeConfiguredInputReader,
  createV2ForwardCodeConfiguredInputReader,
} from "../src/takoform-v2/worker-lifecycle-backend.ts";
import { createWorkerPublicationSqlGuard } from "../src/takoform-v2/worker-publication-sql-guard.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";
import { createV2WorkerPublication } from "../src/takoform-v2/worker-static-publication.ts";
import {
  createV2ForwardWorkerVersionConfiguredInputSealer,
  createV2WorkerVersionConfiguredInputSealer,
} from "../src/takoform-v2/worker-version-configured-inputs.ts";
import type {
  WorkerdDeploymentPublication,
  WorkerdPublicationIdentity,
  WorkerdSite,
  WorkerdStaticSite,
} from "../src/workerd-runtime.ts";

const TARGET = "forward-materializer-fixture";
const URL = "https://artifact.example.test/manifest.json";
const MODULE = "https://artifact.example.test/index.js";
const bytes = new TextEncoder().encode("export default {fetch(){return new Response('held')}}");

async function fixture(secrets = false) {
  const root = mkdtempSync(join(tmpdir(), "takoserver-forward-materializer-"));
  const db = new Database(join(root, "core.sqlite"));
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  let readAllowed = true;
  const key = secrets
    ? await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ])
    : undefined;
  const comparison = secrets
    ? await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])
    : undefined;
  const keyring = key
    ? {
        current: { keyId: "synthetic-graph-key", key },
        keyForDecryption: (id: string) => (id === "synthetic-graph-key" ? key : undefined),
      }
    : undefined;
  const sealer = keyring ? createV2ForwardWorkerVersionConfiguredInputSealer(keyring) : undefined;
  const custody = {
    read: (identity: Parameters<typeof readV2ConfiguredPrivateInputs>[1]) =>
      readV2ConfiguredPrivateInputs(sql, identity),
  };
  const configured = sealer
    ? createV2ForwardCodeConfiguredInputReader({ sql, sealer, custody })
    : undefined;
  let sourceEnabled = true,
    sourceReads = 0,
    sendCount = 0,
    readbackUnknown = false;
  let identity: WorkerdPublicationIdentity | null = null;
  let sent: WorkerdDeploymentPublication<WorkerdSite | WorkerdStaticSite> | null = null;
  let beforeSend: (() => Promise<void>) | undefined;
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      entrypoint: "index.js",
      files: [
        {
          path: "index.js",
          url: MODULE,
          sha256: (await bytesDigest(bytes)).slice(7),
          mediaType: "application/javascript+module",
        },
      ],
    }),
  );
  const assetBytes = new TextEncoder().encode("<main>held forward static</main>");
  const assetManifest = new TextEncoder().encode(
    JSON.stringify({
      files: [
        {
          path: "index.html",
          url: "https://artifact.example.test/index.html",
          sha256: (await bytesDigest(assetBytes)).slice(7),
          mediaType: "text/html",
        },
      ],
    }),
  );
  const source = {
    async read({ url }: { url: string }) {
      sourceReads++;
      if (!sourceEnabled) throw new Error("source unavailable");
      if (url === URL) return manifest;
      if (url === MODULE) return bytes;
      if (url === "https://artifact.example.test/assets.json") return assetManifest;
      if (url === "https://artifact.example.test/index.html") return assetBytes;
      throw new Error("unexpected source");
    },
  };
  const bundle = createWorkerBundleHost({ sql, targetKey: TARGET, source });
  const assets = createStaticAssetBundleHost({ sql, targetKey: TARGET, source });
  const state = createV2WorkerPublicationState({
    sql,
    bundleCustody: bundle.custody,
    assetCustody: assets.custody,
  });
  // Explicit structural runtime/inspector: held bytes, Core and compiler are real;
  // this does not qualify native workerd, a filesystem body store, or R2.
  const runtime = {
    async inspectModule() {
      return { outcome: "valid" as const, exportedHandlers: ["fetch" as const] };
    },
    async publishFenced(
      _name: string,
      resolve: (
        current: WorkerdPublicationIdentity | null,
      ) => Promise<WorkerdDeploymentPublication<WorkerdSite | WorkerdStaticSite> | null>,
      current: () => Promise<boolean>,
    ) {
      if (!(await current())) throw new Error("stale pre-resolution");
      const desired = await resolve(identity);
      await beforeSend?.();
      if (!(await current())) throw new Error("stale pre-send");
      sendCount++;
      sent = desired;
      identity = desired
        ? {
            generation: desired.generation,
            workerResourceUid: desired.workerResourceUid,
            hostnames: [...desired.hostnames].sort(),
            versions: desired.versions
              .map(({ versionId, workerVersionUid, weight }) => ({
                versionId,
                workerVersionUid,
                weight,
              }))
              .sort((a, b) => a.workerVersionUid.localeCompare(b.workerVersionUid)),
          }
        : null;
    },
    async observeExactPublication(_name: string, expected: WorkerdPublicationIdentity | null) {
      return readbackUnknown
        ? ("unknown" as const)
        : canonicalJson(identity) === canonicalJson(expected)
          ? ("matches" as const)
          : ("different" as const);
    },
  };
  const publication = createV2WorkerPublication({
    targetKey: TARGET,
    publicationState: state,
    runtime,
    ...(configured ? { configuredInputs: configured } : {}),
    v2ObjectBucketBinding: {
      address: "127.0.0.1:4777",
      issueGrant() {
        return `e30.${"a".repeat(43)}`;
      },
      async resolveCurrentBucketBinding(claim, name) {
        const authority = (
          await import("../src/takoform-v2/forms/object-bucket-worker-binding-authority.ts")
        ).createObjectBucketWorkerBindingAuthority({
          sql,
          targetKey: TARGET,
          backendId: "fixture-bucket",
        });
        return authority.resolveCurrentBucketBinding(claim, name);
      },
    },
  });
  // Only Bucket metadata is substituted. No 03 body/MPU capability or Ready
  // registration is claimed; the production03 management factory remains gated.
  const metadata: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    backend: {
      id: "fixture-bucket",
      targetKey: TARGET,
      async execute(input) {
        return {
          kind: "complete",
          observed:
            input.form === MODULE_WORKER_FORM_URL
              ? { ready: true }
              : { bucketExists: true, ...OBJECT_BUCKET_LIMITS },
          output: {},
        };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    },
  };
  const version = createInternalV2ForwardWorkerVersionForm({
    sql,
    targetKey: TARGET,
    publicationState: state,
    retirement: {
      async observeRetired() {
        return { kind: "unknown" };
      },
    },
    inspectModule: runtime.inspectModule,
    ...(sealer ? { configuredInputSealer: sealer, configuredInputCustody: custody } : {}),
    v2ObjectBucketBinding: {
      address: "127.0.0.1:4777",
      expectedBackendId: "fixture-bucket",
      issueGrant() {
        return `e30.${"a".repeat(43)}`;
      },
      async resolveCurrentBucketBinding() {
        return null;
      },
    },
  });
  const deployment = createForwardWorkerDeploymentForm({
    targetKey: TARGET,
    publicationState: state,
    scheduledAttachments: {
      async requiresScheduledHandler() {
        return {
          kind: "ready",
          required: false,
          async stillCurrent() {
            return true;
          },
        };
      },
    },
    ownerForWorker(workerResourceUid) {
      return { workerResourceUid, execute: (execution) => publication.publish(execution) };
    },
  });
  const engine = createTakoformV2Engine({
    sql,
    authorize: async (_principal, _space, access) => access !== "read" || readAllowed,
    ...(key && comparison
      ? {
          privateInputCustody: {
            transfer: { current: { id: "synthetic-transfer", key } },
            comparison: { current: { id: "synthetic-comparison", key: comparison } },
            transferTtlSeconds: 60,
          },
        }
      : {}),
    replayWindowSeconds: 3600,
    leaseMilliseconds: 60000,
    forms: {
      [MODULE_WORKER_FORM_URL]: metadata,
      [WORKER_BUNDLE_FORM_URL]: bundle.form,
      [STATIC_ASSET_BUNDLE_FORM_URL]: assets.form,
      [OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL]: metadata,
      [OBJECT_BUCKET_EOF_COUNTED_FORM_URL]: metadata,
      [FORWARD_WORKER_VERSION_FORM_URL]: version,
      [FORWARD_WORKER_DEPLOYMENT_FORM_URL]: deployment,
    },
  });
  let serial = 0;
  async function create(
    form: string,
    name: string,
    spec: JsonObject,
    settle = true,
    privateInputs?: Readonly<Record<string, string>>,
  ) {
    const accepted = await engine.acceptCreate({
      principal: "alice",
      key: `materializer-${++serial}-create-key-0001`,
      input: {
        form,
        space: "space",
        name,
        spec,
        ...(privateInputs === undefined ? {} : { privateInputs }),
      },
    });
    if (settle) {
      for (let i = 0; i < 8; i++) {
        const result = await engine.runNext();
        expect(result?.id).toBe(accepted.id);
        if (result?.status === "succeeded") return accepted;
        if (result?.status === "failed") throw new Error("fixture acceptance failed");
      }
      throw new Error("fixture did not settle");
    }
    return accepted;
  }
  async function basics() {
    const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
    const artifact = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
      artifact: { url: URL, sha256: (await bytesDigest(manifest)).slice(7) },
    });
    const old = await create(OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL, "old", {});
    const next = await create(OBJECT_BUCKET_EOF_COUNTED_FORM_URL, "new", {});
    const v = await create(
      FORWARD_WORKER_VERSION_FORM_URL,
      "version",
      {
        worker: { resourceUid: worker.resourceUid },
        bundle: { resourceUid: artifact.resourceUid },
        handlers: ["fetch"],
        ...(secrets ? { requiredSensitiveVars: ["TOKEN"] } : {}),
        bucketBindings: [
          { name: "NEW", resource: { resourceUid: next.resourceUid } },
          { name: "OLD", resource: { resourceUid: old.resourceUid } },
        ],
      },
      true,
      secrets ? { TOKEN: "synthetic-forward-value" } : undefined,
    );
    const spec = {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: v.resourceUid }, weight: 10000 }],
    };
    return { worker, artifact, old, next, version: v, spec };
  }
  async function execution(id: string): Promise<V2Execution> {
    const store = createV2Store(sql);
    const op = await store.operation(id);
    if (!op) throw new Error("missing operation");
    const r = await store.resource(op.resource_uid);
    if (!r) throw new Error("missing resource");
    const now = Date.now(),
      lease = `fixture-${id}`;
    expect(await store.claim(id, lease, now, now + 60000)).toBe(true);
    expect(await store.markDispatch(id, lease, new Date().toISOString())).toBe(true);
    return {
      operationId: id,
      leaseToken: lease,
      resourceUid: r.uid,
      backendId: op.backend_id,
      backendKey: op.backend_key,
      targetKey: op.target_key,
      principal: op.principal,
      space: r.space,
      name: r.name,
      form: r.form_url,
      generation: op.generation,
      action: op.action,
      spec: JSON.parse(op.accepted_spec_json),
      previousObserved: JSON.parse(r.observed_json),
      previousOutput: JSON.parse(r.output_json),
    };
  }
  return {
    db,
    assetBytes,
    assetManifest,
    sql,
    engine,
    state,
    publication,
    configured,
    sealer,
    keyring,
    custody,
    denyRead() {
      readAllowed = false;
    },
    create,
    basics,
    execution,
    get sent() {
      return sent;
    },
    get sendCount() {
      return sendCount;
    },
    get sourceReads() {
      return sourceReads;
    },
    disableSource() {
      sourceEnabled = false;
    },
    loseReadback() {
      readbackUnknown = true;
    },
    beforeSend(fn: () => Promise<void>) {
      beforeSend = fn;
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("forward materializer uses real held bytes and actual graph renderer through acknowledged publication", async () => {
  const f = await fixture();
  try {
    const b = await f.basics();
    const reads = f.sourceReads;
    f.disableSource();
    const op = await f.create(FORWARD_WORKER_DEPLOYMENT_FORM_URL, "deployment", b.spec);
    expect(
      (await f.sql.query("SELECT status FROM tf_v2_operations WHERE id=?", [op.id]))[0]?.status,
    ).toBe("succeeded");
    expect(f.sendCount).toBe(1);
    expect(f.sourceReads).toBe(reads);
    const graph = f.sent?.versions[0];
    expect(graph?.modules?.get("index.js")).toEqual(bytes);
    const source = graph?.hostModules?.get(WORKERD_V2_PRIVATE_ENTRYPOINT_MODULE);
    expect(source).toBeDefined();
    expect(new TextDecoder().decode(source)).toContain(OBJECT_BUCKET_EOF_COUNTED_FORM_URL);
    expect(new TextDecoder().decode(source)).toContain(OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL);
  } finally {
    f.close();
  }
});

test("forward materializer refuses damaged held chunks before any sender despite verified metadata", async () => {
  const f = await fixture();
  try {
    const b = await f.basics();
    f.db.exec("DROP TRIGGER tf_v2_artifact_chunk_immutable");
    await f.sql.run("UPDATE tf_v2_artifact_chunks SET bytes=? WHERE resource_uid=?", [
      new Uint8Array([120]),
      b.artifact.resourceUid,
    ]);
    const op = await f.create(FORWARD_WORKER_DEPLOYMENT_FORM_URL, "deployment", b.spec, false);
    const execution = await f.execution(op.id);
    expect((await f.state.resolveForward({ execution })).kind).toBe("unresolved");
    expect(await f.publication.publish(execution)).toMatchObject({ kind: "not_dispatched" });
    expect(f.sendCount).toBe(0);
  } finally {
    f.close();
  }
});

test("forward materializer pre-send hold detects a concurrent target generation change", async () => {
  const f = await fixture();
  try {
    const b = await f.basics();
    f.beforeSend(async () => {
      const updated = await f.engine.acceptUpdate({
        principal: "alice",
        uid: b.next.resourceUid,
        key: "forward-materializer-change-key-0001",
        expectedGeneration: 1,
        spec: {},
      });
      expect((await f.engine.runNext())?.id).toBe(updated.id);
    });
    const op = await f.create(FORWARD_WORKER_DEPLOYMENT_FORM_URL, "deployment", b.spec, false);
    const execution = await f.execution(op.id);
    expect(await f.publication.publish(execution)).toMatchObject({ kind: "unknown" });
    expect(f.sendCount).toBe(0);
  } finally {
    f.close();
  }
});

test("forward materializer cannot settle complete after a lost exact runtime acknowledgement", async () => {
  const f = await fixture();
  try {
    const b = await f.basics();
    f.loseReadback();
    const op = await f.create(FORWARD_WORKER_DEPLOYMENT_FORM_URL, "deployment", b.spec, false);
    expect((await f.engine.runNext())?.status).not.toBe("succeeded");
    expect(f.sendCount).toBe(1);
    expect(
      (await f.sql.query("SELECT status,effect FROM tf_v2_operations WHERE id=?", [op.id]))[0],
    ).not.toEqual({ status: "succeeded", effect: "complete" });
  } finally {
    f.close();
  }
});

test("forward actual SQLite route CAS keeps the concurrent winner after accepted graph changes", async () => {
  const f = await fixture();
  try {
    const b = await f.basics();
    const op = await f.create(FORWARD_WORKER_DEPLOYMENT_FORM_URL, "deployment", b.spec, false);
    const execution = await f.execution(op.id);
    const result = await f.state.resolveForward({ execution });
    if (result.kind !== "ready") throw new Error("missing captured guard");
    f.db.exec(
      "CREATE TABLE fixture_route(singleton INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO fixture_route VALUES(1,'original')",
    );
    const run = () =>
      f.sql.run(
        `UPDATE fixture_route SET value='candidate' WHERE singleton=1 AND (${result.sqlGuard.sql})`,
        result.sqlGuard.params,
      );
    expect((await run()).changes).toBe(1);
    await f.sql.run("UPDATE fixture_route SET value='concurrent-winner'");
    const changed = await f.engine.acceptUpdate({
      principal: "alice",
      uid: b.next.resourceUid,
      key: "forward-guard-generation-key-0001",
      expectedGeneration: 1,
      spec: {},
    });
    expect((await f.engine.runNext())?.id).toBe(changed.id);
    expect((await run()).changes).toBe(0);
    expect(await f.sql.query("SELECT value FROM fixture_route")).toEqual([
      { value: "concurrent-winner" },
    ]);
    const legacy = createWorkerPublicationSqlGuard({
      execution: { ...execution, form: WORKER_DEPLOYMENT_FORM_URL },
      workerUid: b.worker.resourceUid,
      principal: "alice",
      space: "space",
      pendingIds: [],
      deploymentIds: [],
      endpointIds: [],
      inboundTargetIds: [],
      inboundEdges: [],
      referenceSetIds: [],
      evidence: {},
    });
    // Full SQL-byte golden derived statically from the frozen858 default builder;
    // empty evidence/sets keep the output independent of generated fixture UIDs.
    expect(createHash("sha256").update(legacy.sql).digest("hex")).toBe(
      "9f41be59d26c0bac63896b9926c82fb398202be76bc8fca8b22f975faa815b19",
    );
    const scopes = [
      WORKER_DEPLOYMENT_FORM_URL,
      "https://edge.forms.takoform.com/forms/WorkerEndpoint/0.3.0/",
    ];
    const expectedParams = [
      execution.operationId,
      execution.resourceUid,
      execution.principal,
      execution.backendKey,
      execution.backendId,
      execution.targetKey,
      execution.action,
      execution.generation,
      canonicalJson(execution.spec),
      execution.leaseToken,
      execution.principal,
      WORKER_DEPLOYMENT_FORM_URL,
      execution.space,
      execution.name,
      "[]",
      "[]",
      "[]",
      "[]",
      ...scopes.flatMap((form) => [
        form,
        "alice",
        "space",
        b.worker.resourceUid,
        "[]",
        form,
        "alice",
        "space",
        b.worker.resourceUid,
        "[]",
      ]),
      WORKER_DEPLOYMENT_FORM_URL,
      scopes[1],
      b.worker.resourceUid,
      "[]",
      WORKER_DEPLOYMENT_FORM_URL,
      scopes[1],
      b.worker.resourceUid,
      "[]",
    ];
    expect(legacy.params).toEqual(expectedParams);
    expect(legacy.params).toContain(WORKER_DEPLOYMENT_FORM_URL);
    expect(legacy.params).not.toContain(FORWARD_WORKER_DEPLOYMENT_FORM_URL);
    expect(() =>
      createWorkerPublicationSqlGuard({
        execution: { ...execution, form: WORKER_DEPLOYMENT_FORM_URL },
        forwardDeployment: true,
        workerUid: b.worker.resourceUid,
        principal: "alice",
        space: "space",
        pendingIds: [],
        deploymentIds: [],
        endpointIds: [],
        inboundTargetIds: [],
        inboundEdges: [],
        referenceSetIds: [],
        evidence: {},
      }),
    ).toThrow();
  } finally {
    f.close();
  }
});

test("forward07 CREATE seals synthetic sensitive vars and reads only the exact held owner", async () => {
  const f = await fixture(true);
  try {
    const b = await f.basics();
    const publicVersion = await f.engine.getResource({
      principal: "alice",
      uid: b.version.resourceUid,
    });
    expect(JSON.stringify(publicVersion)).not.toContain("synthetic-forward-value");
    const rows = await f.sql.query(
      "SELECT key_id,nonce,ciphertext FROM tf_v2_configured_private_inputs WHERE resource_uid=?",
      [b.version.resourceUid],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("synthetic-forward-value");
    const op = await f.create(FORWARD_WORKER_DEPLOYMENT_FORM_URL, "deployment", b.spec, false);
    const execution = await f.execution(op.id);
    const resolved = await f.state.resolveForward({ execution });
    if (resolved.kind !== "ready") throw new Error("missing genuine held graph");
    const version = resolved.snapshot.deployment?.versions[0];
    if (!version || !f.configured || !f.keyring) throw new Error("missing configured07 fixture");
    const input = {
      resourceUid: b.version.resourceUid,
      principal: "alice",
      space: "space",
      targetKey: TARGET,
      spec: version.spec,
      stillCurrent: resolved.stillCurrent,
    };
    expect(await f.configured.read(input)).toEqual({ TOKEN: "synthetic-forward-value" });
    expect(await f.configured.read({ ...input, principal: "mallory" })).toBeNull();
    expect(await f.configured.read({ ...input, space: "other" })).toBeNull();
    const old = createV2CodeConfiguredInputReader({
      sql: f.sql,
      sealer: createV2WorkerVersionConfiguredInputSealer(f.keyring),
      custody: f.custody,
    });
    expect(await old.read(input)).toBeNull();
    const deniedBefore = await f.sql.query("SELECT COUNT(*) AS n FROM tf_v2_operations");
    f.denyRead();
    await expect(
      f.engine.acceptCreate({
        principal: "alice",
        key: "denied-forward-secret-create-key-0001",
        input: {
          form: FORWARD_WORKER_VERSION_FORM_URL,
          space: "space",
          name: "denied",
          spec: version.spec,
          privateInputs: { TOKEN: "synthetic-forward-value" },
        },
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await f.sql.query("SELECT COUNT(*) AS n FROM tf_v2_operations")).toEqual(deniedBefore);
    expect(f.sendCount).toBe(0);
  } finally {
    f.close();
  }
});

test("forward07 static CREATE and06 publication use verified held assets without code material", async () => {
  const f = await fixture();
  try {
    const worker = await f.create(MODULE_WORKER_FORM_URL, "static-worker", {});
    const asset = await f.create(STATIC_ASSET_BUNDLE_FORM_URL, "assets", {
      artifact: {
        url: "https://artifact.example.test/assets.json",
        sha256: (await bytesDigest(f.assetManifest)).slice(7),
      },
    });
    const version = await f.create(FORWARD_WORKER_VERSION_FORM_URL, "static-version", {
      worker: { resourceUid: worker.resourceUid },
      handlers: [],
      assets: {
        bundle: { resourceUid: asset.resourceUid },
        runWorkerFirst: false,
        notFoundHandling: "none",
      },
    });
    const reads = f.sourceReads;
    f.disableSource();
    await f.create(FORWARD_WORKER_DEPLOYMENT_FORM_URL, "static-deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10000 }],
    });
    expect(f.sourceReads).toBe(reads);
    expect(f.sendCount).toBe(1);
    expect(f.sent?.versions[0]?.site.kind).toBe("static");
    expect(f.sent?.versions[0]?.modules.size).toBe(0);
    expect(f.sent?.versions[0]?.assets?.get("index.html")).toEqual(f.assetBytes);
  } finally {
    f.close();
  }
});
