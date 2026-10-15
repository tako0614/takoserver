import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { JsonObject, Sql } from "../src/ports.ts";
import {
  selfhostWorkerPreludeModuleName,
  selfhostWorkerPreludeSource,
} from "../src/providers/selfhost-worker-prelude.ts";
import {
  SELFHOST_DATA_PLANE_OBJECT_BODY_FORMAT,
  SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER,
  SELFHOST_WORKER_DATA_SERVICE_BINDING,
  SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND,
  selfhostWorkerForwardObjectBucketEntrypointSource,
} from "../src/providers/selfhost-worker-wrapper.ts";
import { decodeSelfhostObjectBodyFrames } from "../src/selfhost-object-store.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { OBJECT_BUCKET_LIMITS } from "../src/takoform-v2/forms/object-bucket.ts";
import {
  OBJECT_BUCKET_EOF_COUNTED_FORM_URL,
  OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL,
} from "../src/takoform-v2/forms/object-bucket-binding-profile.ts";
import {
  CONTAINER_WORKER_DEPLOYMENT_FORM_URL,
  CONTAINER_WORKER_VERSION_FORM_URL,
  FORWARD_WORKER_DEPLOYMENT_FORM_URL,
  FORWARD_WORKER_VERSION_FORM_URL,
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import {
  createForwardWorkerDeploymentForm,
  createWorkerDeploymentForm,
} from "../src/takoform-v2/worker-deployment-backend.ts";
import { createInternalV2ForwardWorkerVersionForm } from "../src/takoform-v2/worker-lifecycle-backend.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";

const BUNDLE = "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/";
const OTHER = "https://forms.example.test/NotAnObjectBucket/1.0.0/";
const TARGET = "forward-family-fixture";

function deferred() {
  let resolve: () => void = () => {
    throw new Error("uninitialized gate");
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "takoserver-forward-family-"));
  const db = new Database(join(root, "metadata.sqlite"));
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "0070_takoform_v2.sql",
    "0071_v2_sqlite_migration_set_custody.sql",
    "0073_v2_reference_acceptance.sql",
    "0081_v2_private_inputs.sql",
  ])
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  const raw = createSqliteSql(db);
  let gate:
    | { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }
    | undefined;
  let lookups = 0;
  const sql: Sql = {
    async query(query, params) {
      if (query.includes("WHERE uid = ? AND principal = ? AND space = ?")) lookups++;
      return raw.query(query, params);
    },
    run: raw.run,
    async batch(statements) {
      if (
        gate &&
        statements.some((statement) => /INSERT INTO tf_v2_operations\b/u.test(statement.sql))
      ) {
        const waiting = gate;
        gate = undefined;
        waiting.entered.resolve();
        await waiting.release.promise;
      }
      return raw.batch(statements);
    },
  };
  const store = createV2Store(sql);
  const now = Date.now();
  let readAllowed = true;
  let serial = 0;
  // These are metadata fixture observations, not native/body capability proofs.
  // In particular this does NOT qualify createObjectBucketStreamForm's port.
  const metadataTarget: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    backend: {
      id: "fixture-metadata-only",
      targetKey: TARGET,
      async execute(input) {
        return {
          kind: "complete",
          observed:
            input.form === OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL ||
            input.form === OBJECT_BUCKET_EOF_COUNTED_FORM_URL
              ? { bucketExists: true, ...OBJECT_BUCKET_LIMITS }
              : { ready: true },
          output: {},
        };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    },
  };
  const reader = createV2WorkerPublicationState({ sql, now: () => new Date(now) });
  const legacyDeployment = createWorkerDeploymentForm({
    targetKey: TARGET,
    publicationState: reader,
    ownerForWorker() {
      throw new Error("native owner absent in metadata fixture");
    },
    scheduledAttachments: {
      async requiresScheduledHandler() {
        return { kind: "unknown" };
      },
    },
  });
  const version = createInternalV2ForwardWorkerVersionForm({ targetKey: TARGET });
  const deployment = createForwardWorkerDeploymentForm({ targetKey: TARGET });
  const engine = createTakoformV2Engine({
    sql,
    now: () => new Date(now),
    replayWindowSeconds: 3600,
    authorize: async (_principal, _space, access) => access !== "read" || readAllowed,
    forms: {
      [MODULE_WORKER_FORM_URL]: metadataTarget,
      [BUNDLE]: metadataTarget,
      [OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL]: metadataTarget,
      [OBJECT_BUCKET_EOF_COUNTED_FORM_URL]: metadataTarget,
      [OTHER]: metadataTarget,
      [WORKER_VERSION_FORM_URL]: metadataTarget,
      [CONTAINER_WORKER_VERSION_FORM_URL]: metadataTarget,
      [WORKER_DEPLOYMENT_FORM_URL]: legacyDeployment,
      [CONTAINER_WORKER_DEPLOYMENT_FORM_URL]: metadataTarget,
      [FORWARD_WORKER_VERSION_FORM_URL]: version,
      [FORWARD_WORKER_DEPLOYMENT_FORM_URL]: deployment,
    },
  });
  async function create(
    form: string,
    name: string,
    spec: JsonObject = {},
    settle = true,
    principal = "alice",
    space = "space",
  ) {
    const op = await engine.acceptCreate({
      principal,
      key: `forward-create-${++serial}-key-0001`,
      input: { form, space, name, spec },
    });
    if (settle) expect(await engine.runNext()).toMatchObject({ id: op.id, status: "succeeded" });
    return op;
  }
  async function basics() {
    const worker = await create(MODULE_WORKER_FORM_URL, "worker");
    const bundle = await create(BUNDLE, "bundle");
    const old = await create(OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL, "old");
    const next = await create(OBJECT_BUCKET_EOF_COUNTED_FORM_URL, "new");
    const spec: JsonObject = {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
      bucketBindings: [
        { name: "OLD", resource: { resourceUid: old.resourceUid } },
        { name: "NEW", resource: { resourceUid: next.resourceUid } },
      ],
    };
    return { worker, bundle, old, next, spec };
  }
  async function claim(id: string): Promise<V2Execution> {
    const op = await store.operation(id);
    if (!op) throw new Error("missing accepted Operation");
    const resource = await store.resource(op.resource_uid);
    if (!resource) throw new Error("missing Resource");
    const token = `forward-lease-${id}`;
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
  return {
    root,
    db,
    sql,
    engine,
    reader,
    version,
    deployment,
    create,
    basics,
    claim,
    lookupCount() {
      return lookups;
    },
    pauseAcceptance() {
      const waiting = { entered: deferred(), release: deferred() };
      gate = waiting;
      return waiting;
    },
    allowRead(value: boolean) {
      readAllowed = value;
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function refused(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({ status: 409 });
}

test("forward family actual Core seals mixed bucket Forms and reopens only accepted target semantics", async () => {
  const f = fixture();
  try {
    const b = await f.basics();
    const op = await f.create(FORWARD_WORKER_VERSION_FORM_URL, "version", b.spec, false);
    const refs = await f.sql.query(
      "SELECT target_uid,form_url FROM tf_v2_operation_references WHERE operation_id=? ORDER BY target_uid",
      [op.id],
    );
    expect(refs.find((row) => row.target_uid === b.old.resourceUid)?.form_url).toBe(
      OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL,
    );
    expect(refs.find((row) => row.target_uid === b.next.resourceUid)?.form_url).toBe(
      OBJECT_BUCKET_EOF_COUNTED_FORM_URL,
    );
    expect(refs).toHaveLength(4);
    const execution = await f.claim(op.id);
    const result = await f.reader.resolveForwardFamilyProfile({ execution });
    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") throw new Error("missing captured profile");
    expect(result.profile.bucketBindings).toEqual([
      {
        publicName: "NEW",
        resourceUid: b.next.resourceUid,
        formUrl: OBJECT_BUCKET_EOF_COUNTED_FORM_URL,
      },
      {
        publicName: "OLD",
        resourceUid: b.old.resourceUid,
        formUrl: OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL,
      },
    ]);
    expect(await result.stillCurrent()).toBe(true);
    expect(
      await f.reader.resolveForwardFamilyProfile({
        execution: { ...execution, form: WORKER_VERSION_FORM_URL },
      }),
    ).toEqual({ kind: "unknown" });
    expect(await f.version.backend.execute(execution)).toMatchObject({
      kind: "unknown",
      code: "worker_forward_materializer_unavailable",
    });
    const changed = await f.engine.acceptUpdate({
      principal: "alice",
      uid: b.next.resourceUid,
      key: "forward-target-update-key-0001",
      expectedGeneration: 1,
      spec: {},
    });
    expect(changed.resourceUid).toBe(b.next.resourceUid);
    expect(await result.stillCurrent()).toBe(false);
    expect(await f.reader.resolveForwardFamilyProfile({ execution })).toEqual({ kind: "unknown" });
  } finally {
    f.close();
  }
});

test("forward family rejects wrong, missing and cross-owner target Forms atomically", async () => {
  const f = fixture();
  try {
    const b = await f.basics();
    const wrong = await f.create(OTHER, "wrong");
    const foreign = await f.create(OBJECT_BUCKET_EOF_COUNTED_FORM_URL, "foreign", {}, true, "bob");
    const otherSpace = await f.create(
      OBJECT_BUCKET_EOF_COUNTED_FORM_URL,
      "other-space",
      {},
      true,
      "alice",
      "other",
    );
    for (const uid of [
      wrong.resourceUid,
      foreign.resourceUid,
      otherSpace.resourceUid,
      "missing-uid",
    ]) {
      const before = await f.sql.query("SELECT COUNT(*) AS n FROM tf_v2_operations");
      await refused(
        f.create(
          FORWARD_WORKER_VERSION_FORM_URL,
          `rejected-${uid}`,
          { ...b.spec, bucketBindings: [{ name: "BAD", resource: { resourceUid: uid } }] },
          false,
        ),
      );
      expect(await f.sql.query("SELECT COUNT(*) AS n FROM tf_v2_operations")).toEqual(before);
    }
  } finally {
    f.close();
  }
});

test("forward family authenticates before lookup and exact replay preserves the sealed selection", async () => {
  const f = fixture();
  try {
    const b = await f.basics();
    const key = "forward-version-replay-key-0001";
    const input = {
      form: FORWARD_WORKER_VERSION_FORM_URL,
      space: "space",
      name: "version",
      spec: b.spec,
    };
    const first = await f.engine.acceptCreate({ principal: "alice", key, input });
    const lookups = f.lookupCount();
    expect(lookups).toBe(2);
    f.allowRead(false);
    expect(await f.engine.acceptCreate({ principal: "alice", key, input })).toMatchObject({
      id: first.id,
    });
    await expect(
      f.engine.acceptCreate({
        principal: "alice",
        key: "forward-no-read-key-0001",
        input: { ...input, name: "another" },
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.lookupCount()).toBe(lookups);
  } finally {
    f.close();
  }
});

test("forward Deployment uses the closed Version Forms and the existing single-active owner", async () => {
  const f = fixture();
  try {
    const worker = await f.create(MODULE_WORKER_FORM_URL, "worker");
    const old = await f.create(WORKER_VERSION_FORM_URL, "old-version", {
      worker: { resourceUid: worker.resourceUid },
    });
    const container = await f.create(CONTAINER_WORKER_VERSION_FORM_URL, "container-version", {
      worker: { resourceUid: worker.resourceUid },
    });
    const spec: JsonObject = {
      worker: { resourceUid: worker.resourceUid },
      versions: [
        { workerVersion: { resourceUid: old.resourceUid }, weight: 5000 },
        { workerVersion: { resourceUid: container.resourceUid }, weight: 5000 },
      ],
    };
    const op = await f.create(FORWARD_WORKER_DEPLOYMENT_FORM_URL, "deployment", spec, false);
    const result = await f.reader.resolveForwardFamilyProfile({ execution: await f.claim(op.id) });
    expect(result.kind).toBe("captured");
    if (result.kind !== "captured") throw new Error("missing Deployment profile");
    expect(result.profile.versionTargets.map((target) => target.formUrl).sort()).toEqual(
      [WORKER_VERSION_FORM_URL, CONTAINER_WORKER_VERSION_FORM_URL].sort(),
    );
    await refused(
      f.create(FORWARD_WORKER_DEPLOYMENT_FORM_URL, "duplicate-deployment", spec, false),
    );
  } finally {
    f.close();
  }

  // An old Deployment cannot use the mixed 0.5/0.6 selection above. Establish
  // that this 0.5-only candidate is admissible before testing the shared owner.
  // These targets are settled metadata fixtures, not native held artifacts.
  for (const forwardIncumbent of [false, true]) {
    const legacy = fixture();
    try {
      const worker = await legacy.create(MODULE_WORKER_FORM_URL, "worker");
      const bundle = await legacy.create(BUNDLE, "bundle");
      const version = await legacy.create(WORKER_VERSION_FORM_URL, "version", {
        worker: { resourceUid: worker.resourceUid },
        bundle: { resourceUid: bundle.resourceUid },
        handlers: ["fetch"],
      });
      const candidate = {
        form: WORKER_DEPLOYMENT_FORM_URL,
        space: "space",
        name: "legacy-candidate",
        spec: {
          worker: { resourceUid: worker.resourceUid },
          versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10000 }],
        },
      };
      if (forwardIncumbent)
        await legacy.create(
          FORWARD_WORKER_DEPLOYMENT_FORM_URL,
          "forward-incumbent",
          candidate.spec,
          false,
        );
      const snapshot = async () => {
        const rows = [];
        for (const table of [
          "tf_v2_resources",
          "tf_v2_operations",
          "tf_v2_resource_references",
          "tf_v2_operation_reference_sets",
          "tf_v2_operation_references",
          "tf_v2_migration_set_owners",
          "tf_v2_migration_set_chunks",
          "tf_v2_private_inputs",
          "tf_v2_configured_private_inputs",
        ])
          rows.push([table, await legacy.sql.query(`SELECT * FROM ${table} ORDER BY rowid`)]);
        return rows;
      };
      const before = await snapshot();
      const accepted = legacy.engine.acceptCreate({
        principal: "alice",
        key: "legacy-valid-domain-control-key-0001",
        input: candidate,
      });
      if (forwardIncumbent) {
        await refused(accepted);
        // Every fixture Core table, including all Operation/ref/custody rows,
        // remains unchanged. Admission never reaches a native materializer.
        expect(await snapshot()).toEqual(before);
      } else {
        const operation = await accepted;
        expect(operation).toMatchObject({ action: "create", status: "pending" });
        expect(
          await legacy.sql.query(
            "SELECT form_url FROM tf_v2_operation_references WHERE operation_id=? AND target_uid=?",
            [operation.id, version.resourceUid],
          ),
        ).toEqual([{ form_url: WORKER_VERSION_FORM_URL }]);
        expect(
          await legacy.sql.query(
            "SELECT sealed FROM tf_v2_operation_reference_sets WHERE operation_id=?",
            [operation.id],
          ),
        ).toEqual([{ sealed: 1 }]);
      }
    } finally {
      legacy.close();
    }
  }
});

test("forward Deployment refuses an incumbent old Deployment UID through the common predicate", async () => {
  for (const form of [WORKER_DEPLOYMENT_FORM_URL, CONTAINER_WORKER_DEPLOYMENT_FORM_URL]) {
    const f = fixture();
    try {
      const worker = await f.create(MODULE_WORKER_FORM_URL, "worker");
      const version = await f.create(WORKER_VERSION_FORM_URL, "version", {
        worker: { resourceUid: worker.resourceUid },
      });
      const spec: JsonObject = {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10000 }],
      };
      await f.create(form, "old-deployment", spec, false);
      await refused(f.create(FORWARD_WORKER_DEPLOYMENT_FORM_URL, "new-deployment", spec, false));
    } finally {
      f.close();
    }
  }
});

test("actual Core reference profile drives the actual generated forward renderer component", async () => {
  const f = fixture();
  try {
    const b = await f.basics();
    const op = await f.create(FORWARD_WORKER_VERSION_FORM_URL, "version", b.spec, false);
    const captured = await f.reader.resolveForwardFamilyProfile({
      execution: await f.claim(op.id),
    });
    if (captured.kind !== "captured") throw new Error("missing actual Core profile");
    const forms = captured.profile.bucketBindings;
    const source = selfhostWorkerForwardObjectBucketEntrypointSource({
      source: {
        originalMainModule: "index.js",
        publication: "forward-core-component",
        probeHostname: "forward.selfhost-internal.invalid",
        declaredHandlers: ["fetch"],
        bindings: forms.map((row) => ({
          kind: SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND,
          publicName: row.publicName,
        })),
      },
      objectBucketBindings: forms,
    });
    await Bun.write(
      join(f.root, selfhostWorkerPreludeModuleName("index.js")),
      selfhostWorkerPreludeSource(),
    );
    await Bun.write(
      join(f.root, "index.js"),
      `export default {async fetch(request,env){const result={};const body=()=>new ReadableStream({pull(c){c.enqueue(new Uint8Array([97,98,99]));c.close()}},{highWaterMark:0});try{await env.OLD.put("key",body())}catch(e){result.old=e.name}result.next=await env.NEW.put("key",body());return Response.json(result)}}`,
    );
    const entry = join(f.root, "wrapper.mjs");
    await Bun.write(entry, source);
    const loaded = await import(pathToFileURL(entry).href);
    const documents: Record<string, unknown>[] = [];
    const service = {
      async fetch(_url: string, init: RequestInit) {
        const encoded = new Headers(init.headers).get(SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER);
        if (!encoded) throw new Error("missing object metadata");
        const document = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        if (!(init.body instanceof ReadableStream)) throw new Error("expected stream");
        const body =
          document.bodyFormat === SELFHOST_DATA_PLANE_OBJECT_BODY_FORMAT
            ? decodeSelfhostObjectBodyFrames(init.body)
            : init.body;
        const bytes = await new Response(body).arrayBuffer();
        documents.push(document);
        return Response.json({ ok: true, value: { etag: "fixture-etag", size: bytes.byteLength } });
      },
    };
    const response = await loaded.default.fetch(
      new Request("https://example.com"),
      { [SELFHOST_WORKER_DATA_SERVICE_BINDING]: service },
      {
        waitUntil(promise: Promise<unknown>) {
          void promise.catch(() => undefined);
        },
      },
    );
    expect(await response.json()).toEqual({
      old: "invalid_body",
      next: { etag: "fixture-etag", size: 3 },
    });
    expect(documents).toHaveLength(1);
    expect(documents[0]?.binding).toBe("NEW");
    expect(Object.hasOwn(documents[0] ?? {}, "contentLength")).toBe(false);
  } finally {
    f.close();
  }
});

test("forward family exact target generation changed after chooser rolls back acceptance", async () => {
  const f = fixture();
  try {
    const b = await f.basics();
    const waiting = f.pauseAcceptance();
    const accepting = f.create(FORWARD_WORKER_VERSION_FORM_URL, "racing-version", b.spec, false);
    await waiting.entered.promise;
    const changed = await f.engine.acceptUpdate({
      principal: "alice",
      uid: b.next.resourceUid,
      key: "forward-preimage-race-update-0001",
      expectedGeneration: 1,
      spec: {},
    });
    expect(await f.engine.runNext()).toMatchObject({ id: changed.id, status: "succeeded" });
    waiting.release.resolve();
    await refused(accepting);
    expect(
      await f.sql.query("SELECT uid FROM tf_v2_resources WHERE name = ?", ["racing-version"]),
    ).toEqual([]);
  } finally {
    f.close();
  }
});
