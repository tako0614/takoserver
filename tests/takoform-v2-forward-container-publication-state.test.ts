import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTAINER_CONTRACT as C, V2_CONTAINER_F2_FORM } from "../src/container-contract.ts";
import type { JsonObject } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleHost } from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import {
  fixedReferencesForForwardWorkerVersion,
  prepareForwardWorkerVersionReferences,
} from "../src/takoform-v2/forms/worker-references.ts";
import {
  FORWARD_WORKER_DEPLOYMENT_FORM_URL,
  FORWARD_WORKER_VERSION_FORM_URL,
  MODULE_WORKER_FORM_URL,
  parseForwardWorkerVersionSpec,
  validateForwardWorkerVersionUpdate,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createV2ForwardContainerWorkerPublicationState } from "../src/takoform-v2/index.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import { createForwardWorkerDeploymentForm } from "../src/takoform-v2/worker-deployment-backend.ts";
import {
  createV2ForwardWorkerPublicationState,
  createV2WorkerPublicationState,
} from "../src/takoform-v2/worker-publication-state.ts";
import { writeMigrateSqliteFile } from "./helpers/migrated-database.ts";

const TARGET = "forward-container-publication-fixture";
const PRINCIPAL = "alice";
const SPACE = "space";
const MODULE_URL = "https://artifacts.example.test/forward-container/index.js";
const MANIFEST_URL = "https://artifacts.example.test/forward-container/manifest.json";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "forward-container-publication-"));
  const path = join(root, "metadata.sqlite");
  writeMigrateSqliteFile(path);
  const db = new Database(path);
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
          url: MODULE_URL,
          sha256: digest(bytes),
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
        if (url === MODULE_URL) return bytes;
        if (url === MANIFEST_URL) return manifest;
        throw new Error("fixture source unavailable");
      },
    },
  });
  let heldAvailable = true;
  const bundleCustody = {
    async readHeldVerified(input: Parameters<typeof bundle.custody.readHeldVerified>[0]) {
      if (!heldAvailable) throw new Error("fixture held bytes unavailable");
      return bundle.custody.readHeldVerified(input);
    },
  };
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
  const forwardVersion: V2Form = {
    validateCreate: parseForwardWorkerVersionSpec,
    validateUpdate: validateForwardWorkerVersionUpdate,
    references: (spec) =>
      fixedReferencesForForwardWorkerVersion(parseForwardWorkerVersionSpec(spec)),
    prepareAdmission: prepareForwardWorkerVersionReferences,
    backend: {
      id: "fixture-forward-version",
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
  };
  const engine = createTakoformV2Engine({
    sql,
    now: () => new Date(nowMs),
    replayWindowSeconds: 3600,
    authorize: async () => true,
    forms: {
      [MODULE_WORKER_FORM_URL]: metadata("fixture-module", { ready: true }),
      [C.formUrl]: metadata("fixture-container", { ready: true, servingGeneration: 1 }),
      [WORKER_BUNDLE_FORM_URL]: bundle.form,
      [FORWARD_WORKER_VERSION_FORM_URL]: forwardVersion,
      [FORWARD_WORKER_DEPLOYMENT_FORM_URL]: createForwardWorkerDeploymentForm({
        targetKey: TARGET,
      }),
    },
  });
  const options = { sql, now: () => new Date(nowMs), bundleCustody };
  const old = createV2ForwardWorkerPublicationState(options);
  const fresh = createV2ForwardContainerWorkerPublicationState(options);
  const generic = createV2WorkerPublicationState(options);
  let serial = 0;
  async function create(form: string, name: string, spec: JsonObject, settle = true) {
    const accepted = await engine.acceptCreate({
      principal: PRINCIPAL,
      key: `forward-container-publication-${++serial}-key`,
      input: { form, name, space: SPACE, spec },
    });
    if (settle) expect((await engine.runNext())?.status).toBe("succeeded");
    return accepted;
  }
  async function claim(id: string): Promise<V2Execution> {
    const op = await store.operation(id);
    const resource = op ? await store.resource(op.resource_uid) : null;
    if (!op || !resource) throw new Error("fixture source unavailable");
    const token = `fixture-lease-${id}`;
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
  async function settle(execution: V2Execution, observed: JsonObject) {
    expect(
      await store.settle({
        id: execution.operationId,
        token: execution.leaseToken,
        status: "succeeded",
        effect: "complete",
        at: new Date(nowMs).toISOString(),
        retainUntil: new Date(nowMs + 3_600_000).toISOString(),
        observedJson: JSON.stringify(observed),
        outputJson: JSON.stringify({}),
      }),
    ).toBe(true);
  }
  async function graph(withContainer = true) {
    const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
    const container = await create(C.formUrl, "container", {
      image: `registry.example.test/app@sha256:${"a".repeat(64)}`,
      httpPort: 8080,
      healthPath: "/health",
      workloadRevision: "rev1",
    });
    const artifact = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
      artifact: { url: MANIFEST_URL, sha256: digest(manifest) },
    });
    const versionSpec: JsonObject = {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: artifact.resourceUid },
      handlers: ["fetch"],
      ...(withContainer
        ? {
            containerBindings: [{ name: "APP", resource: { resourceUid: container.resourceUid } }],
          }
        : {}),
    };
    const version = await create(FORWARD_WORKER_VERSION_FORM_URL, "version", versionSpec, false);
    const versionExecution = await claim(version.id);
    const preVersion = await old.resolveForwardVersion({ execution: versionExecution });
    await settle(versionExecution, {
      ready: true,
      resolvedBindings: true,
      bundleVerified: true,
    });
    const deployment = await create(
      FORWARD_WORKER_DEPLOYMENT_FORM_URL,
      "deployment",
      {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      },
      false,
    );
    const deploymentExecution = await claim(deployment.id);
    return { worker, container, artifact, version, deployment, deploymentExecution, preVersion };
  }
  return {
    db,
    sql,
    old,
    fresh,
    generic,
    graph,
    settle,
    setHeldAvailable(value: boolean) {
      heldAvailable = value;
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("source-selected Forward Container publication retains the actual Core graph and held bytes", async () => {
  const f = fixture();
  try {
    const graph = await f.graph();
    expect(graph.preVersion.kind).toBe("ready");
    if (graph.preVersion.kind !== "ready") return;
    expect(graph.preVersion.snapshot.version.spec).toMatchObject({
      containerBindings: [{ name: "APP", resource: { resourceUid: graph.container.resourceUid } }],
    });
    expect(await graph.preVersion.stillCurrent()).toBe(false);
    const input = { execution: graph.deploymentExecution };
    expect((await f.old.resolveForward(input)).kind).toBe("unresolved");
    expect((await f.generic.resolveForward(input)).kind).toBe("unresolved");
    const result = await f.fresh.resolveForward(input);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.snapshot.deployment?.versions[0]?.spec).toMatchObject({
      containerBindings: [{ name: "APP", resource: { resourceUid: graph.container.resourceUid } }],
    });
    expect(await result.stillCurrent()).toBe(true);
    expect((await result.readVersionMaterials(graph.version.resourceUid)).bundle?.files[0]).toEqual(
      new TextEncoder().encode("export default {fetch(){return new Response('held')}}"),
    );
    await f.settle(graph.deploymentExecution, {
      ready: true,
      active: true,
      selectedVersions: [{ resourceUid: graph.version.resourceUid, weight: 10_000 }],
    });
    const servingInput = {
      workerUid: graph.worker.resourceUid,
      targetKey: TARGET,
      sourceOperationId: graph.deployment.id,
      expectedIdentity: {
        generation: `takoserver-v2-operation:${graph.deployment.id}`,
        workerResourceUid: graph.worker.resourceUid,
        hostnames: [],
        versions: [{ workerVersionUid: graph.version.resourceUid, weight: 10_000 }],
      },
    };
    expect((await f.old.resolveCurrentServing(servingInput)).kind).toBe("unresolved");
    const serving = await f.fresh.resolveCurrentServing(servingInput);
    expect(serving.kind).toBe("ready");
    if (serving.kind === "ready") {
      expect(serving.snapshot.deployment?.versions[0]?.spec).toMatchObject({
        containerBindings: [{ name: "APP" }],
      });
      expect(await serving.stillCurrent()).toBe(true);
      f.db
        .query("UPDATE tf_v2_resources SET output_json = ? WHERE uid = ?")
        .run('{"changed":true}', graph.container.resourceUid);
      expect(await serving.stillCurrent()).toBe(false);
    }
  } finally {
    f.close();
  }
});

test("non-Container Forward graph has the existing behavior in both constructors", async () => {
  const f = fixture();
  try {
    const graph = await f.graph(false);
    expect((await f.old.resolveForward({ execution: graph.deploymentExecution })).kind).toBe(
      "ready",
    );
    expect((await f.fresh.resolveForward({ execution: graph.deploymentExecution })).kind).toBe(
      "ready",
    );
  } finally {
    f.close();
  }
});

test("Container target scope, sealed graph, generation and material drift fail closed", async () => {
  for (const mutation of ["missing", "reference", "form", "f2", "owner", "target", "generation"]) {
    const f = fixture();
    try {
      const graph = await f.graph();
      const target = graph.container.resourceUid;
      if (mutation === "missing")
        f.db
          .query("DELETE FROM tf_v2_resource_references WHERE referrer_uid = ? AND target_uid = ?")
          .run(graph.version.resourceUid, target);
      if (mutation === "reference") {
        // Simulate corrupted sealed SQL despite Core's immutable-row trigger.
        f.db.exec("DROP TRIGGER tf_v2_operation_reference_immutable");
        f.db
          .query(
            "UPDATE tf_v2_operation_references SET form_url = ? WHERE operation_id = ? AND target_uid = ?",
          )
          .run(MODULE_WORKER_FORM_URL, graph.version.id, target);
      }
      if (mutation === "form" || mutation === "f2" || mutation === "owner" || mutation === "target")
        f.db.exec("DROP TRIGGER tf_v2_resource_identity_immutable");
      if (mutation === "form")
        f.db
          .query("UPDATE tf_v2_resources SET form_url = ? WHERE uid = ?")
          .run(MODULE_WORKER_FORM_URL, target);
      if (mutation === "f2")
        f.db
          .query("UPDATE tf_v2_resources SET form_url = ? WHERE uid = ?")
          .run(V2_CONTAINER_F2_FORM, target);
      if (mutation === "owner")
        f.db.query("UPDATE tf_v2_resources SET principal = ? WHERE uid = ?").run("bob", target);
      if (mutation === "target")
        f.db
          .query("UPDATE tf_v2_resources SET target_key = ? WHERE uid = ?")
          .run("elsewhere", target);
      if (mutation === "generation")
        f.db
          .query("UPDATE tf_v2_resources SET observed_generation = ? WHERE uid = ?")
          .run(0, target);
      expect((await f.fresh.resolveForward({ execution: graph.deploymentExecution })).kind).toBe(
        "unresolved",
      );
    } finally {
      f.close();
    }
  }
  const f = fixture();
  try {
    const graph = await f.graph();
    const result = await f.fresh.resolveForward({ execution: graph.deploymentExecution });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    f.db
      .query("UPDATE tf_v2_resources SET output_json = ? WHERE uid = ?")
      .run('{"changed":true}', graph.container.resourceUid);
    expect(await result.stillCurrent()).toBe(false);
  } finally {
    f.close();
  }
  const damaged = fixture();
  try {
    const graph = await damaged.graph();
    const result = await damaged.fresh.resolveForward({ execution: graph.deploymentExecution });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    damaged.setHeldAvailable(false);
    expect(await result.stillCurrent()).toBe(false);
    await expect(result.readVersionMaterials(graph.version.resourceUid)).rejects.toThrow();
    expect(
      (await damaged.fresh.resolveForward({ execution: graph.deploymentExecution })).kind,
    ).toBe("unresolved");
  } finally {
    damaged.close();
  }
});
