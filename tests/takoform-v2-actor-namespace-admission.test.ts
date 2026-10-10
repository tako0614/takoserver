import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject, Sql } from "../src/ports.ts";
import { createSelfhostActorExecutionHost } from "../src/selfhost-actor-execution-host.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createV2ActorBindingAuthority } from "../src/takoform-v2/actor-binding-authority.ts";
import { createV2ActorForwardBoot } from "../src/takoform-v2/actor-forward-runtime.ts";
import { prepareV2ActorNamespaceAdmission } from "../src/takoform-v2/actor-namespace-admission.ts";
import {
  createV2ActorNamespaceForm,
  V2_ACTOR_NAMESPACE_BACKEND_ID,
  type V2ActorNamespaceNativeSnapshot,
  type V2ActorNamespaceProviderPort,
} from "../src/takoform-v2/actor-namespace-backend.ts";
import { createV2ActorNamespaceGraphAuthority } from "../src/takoform-v2/actor-namespace-graph-authority.ts";
import {
  createV2ActorNamespaceSqlGraphReader,
  type V2ActorAcceptedDeleteClaim,
} from "../src/takoform-v2/actor-namespace-sql-graph.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  ACTOR_NAMESPACE_FORM_URL,
  parseActorNamespaceSpec,
  referencesForActorNamespace,
  validateActorNamespaceUpdate,
} from "../src/takoform-v2/forms/actor-namespace.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleHost } from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import {
  referencesForWorkerDeployment,
  referencesForWorkerVersion,
} from "../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseWorkerDeploymentSpec,
  parseWorkerVersionSpec,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const PRINCIPAL = "org:actor-admission";
const SPACE = "production";
const TARGET = "actor-admission-local-target";

function fixture(
  physicalRoot?: string,
  providerNative?: V2ActorNamespaceProviderPort,
  sqlOverride?: Sql,
) {
  const db = new Database(":memory:");
  migrateSqlite(db);
  const rawSql = sqlOverride ?? createSqliteSql(db);
  let beforeActorBatch: (() => Promise<void>) | undefined;
  let afterActorForget: (() => Promise<void>) | undefined;
  const sql: Sql = {
    query: rawSql.query,
    run: rawSql.run,
    async batch(statements) {
      if (
        beforeActorBatch &&
        statements.some((statement) =>
          statement.sql.includes("SELECT COUNT(*) FROM tf_v2_resources WHERE form_url"),
        )
      ) {
        const callback = beforeActorBatch;
        beforeActorBatch = undefined;
        await callback();
      }
      return rawSql.batch(statements);
    },
  };
  const source = new Map<string, Uint8Array>();
  let acceptedAuthorityOverride: string | null = null;
  const bundleHost = createWorkerBundleHost({
    sql,
    targetKey: TARGET,
    source: {
      async read({ url }) {
        const bytes = source.get(url);
        if (!bytes) throw new Error("missing fixture source");
        return bytes;
      },
    },
  });
  let inspection: "valid" | "invalid" | "unavailable" | "second-invalid" | "mixed" = "valid";
  let inspected = 0;
  let onInspect: (() => Promise<void>) | undefined;
  const inspector = {
    async inspectActorClass(input: { modules: readonly { bytes: Uint8Array }[] }) {
      inspected += 1;
      const callback = onInspect;
      onInspect = undefined;
      await callback?.();
      const second = input.modules.some((module) =>
        new TextDecoder().decode(module.bytes).includes("version-second"),
      );
      const invalid =
        inspection === "invalid" ||
        (inspection === "second-invalid" && second) ||
        (inspection === "mixed" && !second);
      return inspection === "valid" || (inspection === "second-invalid" && !second)
        ? ({ outcome: "valid" } as const)
        : invalid
          ? ({ outcome: "invalid", error: "actor_class_invalid" } as const)
          : ({ outcome: "unavailable", retryable: true } as const);
    },
  };
  const backend = {
    id: "actor-admission-test-only",
    targetKey: TARGET,
    async execute(input: { form: string; spec: JsonObject }) {
      return {
        kind: "complete" as const,
        observed:
          input.form === WORKER_VERSION_FORM_URL
            ? { ready: true, resolvedBindings: true, bundleVerified: true }
            : input.form === WORKER_DEPLOYMENT_FORM_URL
              ? {
                  ready: true,
                  active: true,
                  selectedVersions: parseWorkerDeploymentSpec(input.spec).versions.map(
                    ({ workerVersion, weight }) => ({
                      resourceUid: workerVersion.resourceUid,
                      weight,
                    }),
                  ),
                }
              : { ready: true },
        output: {},
      };
    },
    async reconcile() {
      return { kind: "unknown" as const };
    },
  };
  const form = (extras: Partial<V2Form> = {}): V2Form => ({
    validateCreate() {},
    validateUpdate() {},
    backend,
    ...extras,
  });
  const physical = physicalRoot
    ? createSelfhostActorExecutionHost({
        runtimeRoot: join(physicalRoot, "runtime"),
        storageRoot: join(physicalRoot, "actor"),
        binary: "/unused/workerd",
        authority: createV2ActorNamespaceGraphAuthority({
          sql,
          targetKey: TARGET,
          owner: { ownerForWorker: async () => null },
        }),
      })
    : null;
  const registrations: Array<{
    scope: { tenantId: string; namespaceResourceUid: string };
    operation: { operationId: string; leaseToken: string };
  }> = [];
  const deletions: V2ActorAcceptedDeleteClaim[] = [];
  const fixtureActor = form({
    validateCreate: parseActorNamespaceSpec,
    validateUpdate: validateActorNamespaceUpdate,
    references: referencesForActorNamespace,
    prepareAdmission(input) {
      return admission(input);
    },
  });
  function admission(input: {
    principal: string;
    space: string;
    resourceUid: string;
    spec: JsonObject;
  }) {
    return prepareV2ActorNamespaceAdmission({
      ...input,
      sql,
      bundleCustody: bundleHost.custody,
      inspector,
      targetKey: TARGET,
    });
  }
  const actorOptions: Parameters<typeof createV2ActorNamespaceForm>[0] | null = physical
    ? {
        sql,
        targetKey: TARGET,
        bundleCustody: bundleHost.custody,
        inspector,
        physical: {
          ...physical,
          async registerNamespace(scope, operation) {
            registrations.push({ scope, operation });
            await physical.registerNamespace(scope);
          },
          async forgetNamespace(scope, claim) {
            deletions.push(claim);
            await physical.forgetNamespace(scope);
            await afterActorForget?.();
          },
        },
        ...(providerNative
          ? {
              providerNative,
              acceptedGraph: {
                async readAcceptedOperationGraph(scope, operation) {
                  const reader = createV2ActorNamespaceSqlGraphReader({ sql, targetKey: TARGET });
                  const graph = await reader.readAcceptedOperationGraph(scope, operation);
                  return graph && acceptedAuthorityOverride !== null
                    ? { ...graph, authorityKey: acceptedAuthorityOverride }
                    : graph;
                },
              },
            }
          : {}),
      }
    : null;
  const actor = actorOptions ? createV2ActorNamespaceForm(actorOptions) : fixtureActor;
  const engine = createTakoformV2Engine({
    sql,
    replayWindowSeconds: 3600,
    leaseMilliseconds: 60_000,
    authorize: async () => true,
    forms: {
      [MODULE_WORKER_FORM_URL]: form(),
      [WORKER_BUNDLE_FORM_URL]: bundleHost.form,
      [WORKER_VERSION_FORM_URL]: form({
        references: (spec) => referencesForWorkerVersion(parseWorkerVersionSpec(spec)),
      }),
      [WORKER_DEPLOYMENT_FORM_URL]: form({
        references: (spec) => referencesForWorkerDeployment(parseWorkerDeploymentSpec(spec)),
      }),
      [ACTOR_NAMESPACE_FORM_URL]: actor,
    },
  });
  async function create(formUrl: string, name: string, spec: JsonObject, settle = true) {
    const operation = await engine.acceptCreate({
      principal: PRINCIPAL,
      key: `create-${name}-key-0001`,
      input: { form: formUrl, space: SPACE, name, spec },
    });
    if (settle)
      expect(await engine.runNext()).toMatchObject({ id: operation.id, status: "succeeded" });
    return operation;
  }
  async function worker() {
    return create(MODULE_WORKER_FORM_URL, "worker", {});
  }
  async function version(workerUid: string, name: string) {
    const moduleUrl = `https://artifacts.example.test/${name}/index.mjs`;
    const manifestUrl = `https://artifacts.example.test/${name}/manifest.json`;
    const moduleBytes = new TextEncoder().encode(
      `// ${name}\nexport class CounterActor {
        fetch() { return new Response("ok"); }
        alarm() {}
        socketMessage() {}
        socketClose() {}
        socketError() {}
      }`,
    );
    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({
        entrypoint: "index.mjs",
        files: [
          {
            path: "index.mjs",
            url: moduleUrl,
            sha256: digest(moduleBytes),
            mediaType: "application/javascript+module",
          },
        ],
      }),
    );
    source.set(moduleUrl, moduleBytes);
    source.set(manifestUrl, manifestBytes);
    const bundle = await create(WORKER_BUNDLE_FORM_URL, `${name}-bundle`, {
      artifact: { url: manifestUrl, sha256: digest(manifestBytes) },
    });
    return create(WORKER_VERSION_FORM_URL, name, {
      worker: { resourceUid: workerUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
    });
  }
  return {
    db,
    sql,
    engine,
    create,
    worker,
    version,
    admission,
    physical,
    registrations,
    deletions,
    mutateActorComposition(targetKey: string, provider: V2ActorNamespaceProviderPort) {
      if (!actorOptions) throw new Error("Actor composition unavailable");
      Object.assign(actorOptions, { targetKey, providerNative: provider });
    },
    setAcceptedAuthorityOverride(value: string) {
      acceptedAuthorityOverride = value;
    },
    setInspection(value: typeof inspection) {
      inspection = value;
    },
    onInspect(callback: () => Promise<void>) {
      onInspect = callback;
    },
    onActorBatch(callback: () => Promise<void>) {
      beforeActorBatch = callback;
    },
    onActorForget(callback: () => Promise<void>) {
      afterActorForget = callback;
    },
    inspections() {
      return inspected;
    },
  };
}

test("Actor Binding accepts a Host-owned Version identity strategy without selfhost graph coupling", async () => {
  const root = mkdtempSync(join(tmpdir(), "actor-binding-sdk-"));
  const f = fixture(root);
  try {
    const worker = await f.worker();
    const namespace = await f.create(ACTOR_NAMESPACE_FORM_URL, "binding-namespace", {
      worker: { resourceUid: worker.resourceUid },
      className: "CounterActor",
    });
    const code = await f.version(worker.resourceUid, "binding-code");
    const [codeRow] = await f.sql.query("SELECT spec_json FROM tf_v2_resources WHERE uid = ?", [
      code.resourceUid,
    ]);
    if (typeof codeRow?.spec_json !== "string" || !f.physical)
      throw new Error("binding fixture source/physical registration unavailable");
    const codeSpec = parseWorkerVersionSpec(JSON.parse(codeRow.spec_json));
    if (!codeSpec.bundle) throw new Error("binding fixture bundle unavailable");
    const version = await f.create(WORKER_VERSION_FORM_URL, "binding-version", {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: codeSpec.bundle.resourceUid },
      handlers: ["fetch"],
      actorBindings: [{ name: "ACTOR", resource: { resourceUid: namespace.resourceUid } }],
    });
    const sqlGraph = createV2ActorNamespaceSqlGraphReader({ sql: f.sql, targetKey: TARGET });
    const identity = `provider-version:${version.resourceUid}:${version.id}`;
    const authority = createV2ActorBindingAuthority({
      sql: f.sql,
      targetKey: TARGET,
      namespaceGraph: sqlGraph,
      physical: f.physical,
      versionIdentity: async (source) => {
        expect(Object.isFrozen(source)).toBe(true);
        expect(source).toEqual({
          principal: PRINCIPAL,
          space: SPACE,
          targetKey: TARGET,
          workerUid: worker.resourceUid,
          workerVersionUid: version.resourceUid,
          workerVersionOperationId: version.id,
          workerVersionGeneration: 1,
          actorBindings: [{ name: "ACTOR", resourceUid: namespace.resourceUid }],
        });
        expect(Object.isFrozen(source.actorBindings)).toBe(true);
        expect(Object.isFrozen(source.actorBindings[0])).toBe(true);
        return identity;
      },
    });
    const claim = {
      principal: PRINCIPAL,
      space: SPACE,
      targetKey: TARGET,
      workerUid: worker.resourceUid,
      workerVersionUid: version.resourceUid,
      workerVersionOperationId: version.id,
      nativeVersionId: identity,
      bindings: [{ name: "ACTOR", resourceUid: namespace.resourceUid }],
    };
    expect(await authority.resolveCurrentBinding(claim, "ACTOR")).toMatchObject({
      tenantId: PRINCIPAL,
      namespaceResourceUid: namespace.resourceUid,
      className: "CounterActor",
    });
    expect(
      await authority.resolveCurrentBinding(
        { ...claim, nativeVersionId: "foreign-version" },
        "ACTOR",
      ),
    ).toBeNull();
    const selfhost = createV2ActorBindingAuthority({
      sql: f.sql,
      targetKey: TARGET,
      namespaceGraph: sqlGraph,
      physical: f.physical,
    });
    const selfhostIdentity = `v2-${createHash("sha256")
      .update(`${version.resourceUid}\u00001`)
      .digest("hex")}`;
    expect(await selfhost.resolveCurrentBinding(claim, "ACTOR")).toBeNull();
    expect(
      await selfhost.resolveCurrentBinding(
        { ...claim, nativeVersionId: selfhostIdentity },
        "ACTOR",
      ),
    ).toMatchObject({ namespaceResourceUid: namespace.resourceUid });
    expect(
      await authority.resolveCurrentBinding({ ...claim, principal: "foreign-org" }, "ACTOR"),
    ).toBeNull();
    expect(
      await authority.resolveCurrentBinding(
        { ...claim, workerVersionOperationId: code.id },
        "ACTOR",
      ),
    ).toBeNull();
    expect(
      await authority.resolveCurrentBinding(
        { ...claim, bindings: [{ name: "ACTOR", resourceUid: "foreign-namespace" }] },
        "ACTOR",
      ),
    ).toBeNull();
  } finally {
    f.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Actor Namespace admission allows pre-Deployment create, but not a duplicate Worker/class", async () => {
  const f = fixture();
  try {
    const worker = await f.worker();
    const spec = { worker: { resourceUid: worker.resourceUid }, className: "CounterActor" };
    const first = await f.create(ACTOR_NAMESPACE_FORM_URL, "namespace-first", spec, false);
    expect(first.status).toBe("queued");
    expect(f.inspections()).toBe(0);
    await expect(
      f.create(ACTOR_NAMESPACE_FORM_URL, "namespace-duplicate", spec, false),
    ).rejects.toMatchObject({
      code: "dependency_conflict",
    });
    expect(
      await f.sql.query("SELECT uid FROM tf_v2_resources WHERE form_url = ?", [
        ACTOR_NAMESPACE_FORM_URL,
      ]),
    ).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("new pending Deployment after final Actor graph capture is retryable without acceptance", async () => {
  const f = fixture();
  try {
    const worker = await f.worker();
    const version = await f.version(worker.resourceUid, "late-pending-version");
    const spec = { worker: { resourceUid: worker.resourceUid }, className: "CounterActor" };
    const request = {
      principal: PRINCIPAL,
      key: "actor-late-pending-admission-0001",
      input: { form: ACTOR_NAMESPACE_FORM_URL, space: SPACE, name: "late-pending-actor", spec },
    };
    f.onActorBatch(async () => {
      const pending = await f.create(
        WORKER_DEPLOYMENT_FORM_URL,
        "late-pending-deployment",
        {
          worker: { resourceUid: worker.resourceUid },
          versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
        },
        false,
      );
      expect(pending.status).toBe("queued");
    });
    await expect(f.engine.acceptCreate(request)).rejects.toMatchObject({
      code: "resource_busy",
      status: 409,
    });
    expect(
      await f.sql.query("SELECT uid FROM tf_v2_resources WHERE form_url = ?", [
        ACTOR_NAMESPACE_FORM_URL,
      ]),
    ).toHaveLength(0);
    const accepted = await f.engine.acceptCreate(request);
    expect(accepted.status).toBe("queued");
    expect((await f.engine.acceptCreate(request)).id).toBe(accepted.id);
  } finally {
    f.db.close();
  }
});

test("accepted Worker/class duplicate remains definite when Version inspection is unavailable", async () => {
  const f = fixture();
  try {
    const worker = await f.worker();
    const spec = { worker: { resourceUid: worker.resourceUid }, className: "CounterActor" };
    await f.create(ACTOR_NAMESPACE_FORM_URL, "existing-namespace", spec);
    const version = await f.version(worker.resourceUid, "duplicate-unavailable-version");
    await f.create(WORKER_DEPLOYMENT_FORM_URL, "duplicate-deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    });
    f.setInspection("unavailable");
    await expect(
      f.create(ACTOR_NAMESPACE_FORM_URL, "duplicate-unavailable", spec, false),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
  } finally {
    f.db.close();
  }
});

test("pre-Deployment Actor backend settles only after durable physical namespaceEmpty proof", async () => {
  const root = mkdtempSync(join(tmpdir(), "actor-v2-empty-"));
  const f = fixture(root);
  if (!f.physical) throw new Error("physical Actor host fixture missing");
  try {
    const worker = await f.worker();
    const spec = { worker: { resourceUid: worker.resourceUid }, className: "CounterActor" };
    const created = await f.create(ACTOR_NAMESPACE_FORM_URL, "empty-namespace", spec, false);
    expect(await f.engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
    const scope = { tenantId: PRINCIPAL, namespaceResourceUid: created.resourceUid };
    expect(f.registrations).toEqual([
      {
        scope,
        operation: {
          operationId: created.id,
          leaseToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
        },
      },
    ]);
    expect(await f.physical.namespaceEmpty(scope)).toBe(true);
    expect(
      await f.sql.query("SELECT observed_json FROM tf_v2_resources WHERE uid = ?", [
        created.resourceUid,
      ]),
    ).toEqual([
      {
        observed_json: JSON.stringify({
          activeActorCount: 0,
          openSocketCount: 0,
          pendingAlarmCount: 0,
          ready: false,
        }),
      },
    ]);
    const updated = await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "empty-namespace-update-0001",
      uid: created.resourceUid,
      expectedGeneration: 1,
      spec,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: updated.id, status: "succeeded" });
    expect(f.registrations).toEqual([
      {
        scope,
        operation: {
          operationId: created.id,
          leaseToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
        },
      },
      {
        scope,
        operation: {
          operationId: updated.id,
          leaseToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
        },
      },
    ]);
    const sourceVersion = await f.version(worker.resourceUid, "unweighted-source-version");
    const versionRow = (
      await f.sql.query("SELECT spec_json FROM tf_v2_resources WHERE uid = ?", [
        sourceVersion.resourceUid,
      ])
    )[0];
    const bundleUid = parseWorkerVersionSpec(JSON.parse(String(versionRow?.spec_json))).bundle
      ?.resourceUid;
    if (!bundleUid) throw new Error("fixture Bundle missing");
    const binding = await f.create(WORKER_VERSION_FORM_URL, "unweighted-actor-binding", {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: bundleUid },
      handlers: ["fetch"],
      actorBindings: [{ name: "ACTOR", resource: { resourceUid: created.resourceUid } }],
    });
    await expect(
      f.engine.acceptDelete({
        principal: PRINCIPAL,
        key: "bound-empty-namespace-delete-0001",
        uid: created.resourceUid,
        expectedGeneration: 2,
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict" });
    const removedBinding = await f.engine.acceptDelete({
      principal: PRINCIPAL,
      key: "unweighted-actor-binding-delete-0001",
      uid: binding.resourceUid,
      expectedGeneration: 1,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: removedBinding.id, status: "succeeded" });
    const deleted = await f.engine.acceptDelete({
      principal: PRINCIPAL,
      key: "empty-namespace-delete-0001",
      uid: created.resourceUid,
      expectedGeneration: 2,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: deleted.id, status: "succeeded" });
    expect(f.deletions).toEqual([
      expect.objectContaining({
        scope,
        space: SPACE,
        backendId: V2_ACTOR_NAMESPACE_BACKEND_ID,
        workerUid: worker.resourceUid,
        className: "CounterActor",
        operationId: deleted.id,
        leaseToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
        generation: 3,
        registeredOperationId: updated.id,
        registeredGeneration: 2,
      }),
    ]);
    expect(typeof f.deletions[0]?.authorityKey).toBe("string");
    expect(f.deletions[0]?.authorityKey.length).toBeGreaterThan(0);
    expect(await f.physical.namespaceAbsent(scope)).toBe(true);
    const authority = createV2ActorBindingAuthority({
      sql: f.sql,
      targetKey: TARGET,
      namespaceGraph: createV2ActorNamespaceGraphAuthority({
        sql: f.sql,
        targetKey: TARGET,
        owner: { ownerForWorker: async () => null },
      }),
      physical: f.physical,
    });
    const target = {
      principal: PRINCIPAL,
      space: SPACE,
      targetKey: TARGET,
      workerUid: worker.resourceUid,
      namespaceResourceUid: created.resourceUid,
    };
    expect(await authority.resolveTarget(target)).toBeNull();
    const replacement = await f.create(ACTOR_NAMESPACE_FORM_URL, "replacement-namespace", spec);
    expect(replacement.resourceUid).not.toBe(created.resourceUid);
    expect(await authority.resolveTarget(target)).toBeNull();
    expect(
      await authority.resolveTarget({ ...target, namespaceResourceUid: replacement.resourceUid }),
    ).not.toBeNull();
  } finally {
    await f.physical.close();
    f.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Actor DELETE remains unconfirmed when its lease expires during physical retirement", async () => {
  const root = mkdtempSync(join(tmpdir(), "actor-v2-delete-lease-"));
  const f = fixture(root);
  if (!f.physical) throw new Error("physical Actor host fixture missing");
  try {
    const worker = await f.worker();
    const namespace = await f.create(ACTOR_NAMESPACE_FORM_URL, "lease-namespace", {
      worker: { resourceUid: worker.resourceUid },
      className: "CounterActor",
    });
    const scope = { tenantId: PRINCIPAL, namespaceResourceUid: namespace.resourceUid };
    f.onActorForget(async () => {
      const operationId = f.deletions[0]?.operationId;
      if (!operationId) throw new Error("missing held Actor DELETE claim");
      f.db.query("UPDATE tf_v2_operations SET lease_until_ms = 0 WHERE id = ?").run(operationId);
    });
    const deleted = await f.engine.acceptDelete({
      principal: PRINCIPAL,
      key: "lease-namespace-delete-0001",
      uid: namespace.resourceUid,
      expectedGeneration: 1,
    });
    const outcome = await f.engine.runNext();
    expect(outcome).toMatchObject({ id: deleted.id, status: "reconciling" });
    expect(f.deletions).toHaveLength(1);
    expect(await f.physical.namespaceAbsent(scope)).toBe(true);
    const resource = await f.sql.query("SELECT deleted_at FROM tf_v2_resources WHERE uid = ?", [
      namespace.resourceUid,
    ]);
    expect(resource[0]?.deleted_at).toBeNull();
  } finally {
    await f.physical.close();
    f.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepted sealed WorkerVersion Actor binding resolves its exact physical namespace", async () => {
  const root = mkdtempSync(join(tmpdir(), "actor-v2-binding-"));
  const f = fixture(root);
  if (!f.physical) throw new Error("physical Actor host fixture missing");
  try {
    const worker = await f.worker();
    const namespace = await f.create(ACTOR_NAMESPACE_FORM_URL, "bound-namespace", {
      worker: { resourceUid: worker.resourceUid },
      className: "CounterActor",
    });
    const caller = await f.create(MODULE_WORKER_FORM_URL, "caller", {});
    const sourceVersion = await f.version(caller.resourceUid, "bound-source");
    const row = (
      await f.sql.query("SELECT spec_json FROM tf_v2_resources WHERE uid = ?", [
        sourceVersion.resourceUid,
      ])
    )[0];
    const bundleUid = parseWorkerVersionSpec(JSON.parse(String(row?.spec_json))).bundle
      ?.resourceUid;
    if (!bundleUid) throw new Error("fixture Bundle missing");
    const binding = { name: "ACTOR", resource: { resourceUid: namespace.resourceUid } };
    const version = await f.create(WORKER_VERSION_FORM_URL, "bound-version", {
      worker: { resourceUid: caller.resourceUid },
      bundle: { resourceUid: bundleUid },
      handlers: ["fetch"],
      actorBindings: [binding],
    });
    const graph = createV2ActorNamespaceGraphAuthority({
      sql: f.sql,
      targetKey: TARGET,
      owner: { ownerForWorker: async () => null },
    });
    const authority = createV2ActorBindingAuthority({
      sql: f.sql,
      targetKey: TARGET,
      namespaceGraph: graph,
      physical: f.physical,
    });
    expect(
      await authority.resolveTarget({
        principal: PRINCIPAL,
        space: SPACE,
        targetKey: TARGET,
        workerUid: caller.resourceUid,
        namespaceResourceUid: namespace.resourceUid,
      }),
    ).toMatchObject({
      tenantId: PRINCIPAL,
      namespaceResourceUid: namespace.resourceUid,
      className: "CounterActor",
    });
    const nativeVersionId = `v2-${createHash("sha256")
      .update(`${version.resourceUid}\u00001`)
      .digest("hex")}`;
    const claim = {
      principal: PRINCIPAL,
      space: SPACE,
      targetKey: TARGET,
      workerUid: caller.resourceUid,
      workerVersionUid: version.resourceUid,
      workerVersionOperationId: version.id,
      nativeVersionId,
      bindings: [{ name: "ACTOR", resourceUid: namespace.resourceUid }],
    };
    expect(await authority.resolveCurrentBinding(claim, "ACTOR")).toMatchObject({
      tenantId: PRINCIPAL,
      namespaceResourceUid: namespace.resourceUid,
      className: "CounterActor",
    });
    for (const foreign of [
      { principal: `${PRINCIPAL}-other` },
      { space: `${SPACE}-other` },
      { targetKey: `${TARGET}-other` },
      { workerUid: worker.resourceUid },
    ]) {
      expect(await authority.resolveCurrentBinding({ ...claim, ...foreign }, "ACTOR")).toBeNull();
    }
    const forward = createV2ActorForwardBoot({
      sql: f.sql,
      targetKey: TARGET,
      authority,
      physical: f.physical,
      privateSocketDirectory: join(root, "brokers"),
    }).openIncarnation({
      principal: PRINCIPAL,
      space: SPACE,
      workerUid: caller.resourceUid,
      sourceOperationId: "8c44e450-1765-4366-919a-4c022f48d97c",
      eventToken: "a".repeat(64),
      scriptName: "actor-binding-test-script",
    });
    const issued = await forward.issueBinding(claim, "ACTOR");
    expect(issued).toMatchObject({
      publicName: "ACTOR",
      tenantId: PRINCIPAL,
      namespaceResourceUid: namespace.resourceUid,
    });
    expect(issued?.token).toMatch(/^[a-f0-9]{64}$/u);
    if (!issued) throw new Error("Actor private grant unavailable");
    const publication = {
      script: "actor-binding-test-script",
      workerResourceUid: caller.resourceUid,
      versionId: nativeVersionId,
      workerVersionResourceUid: version.resourceUid,
      bindings: [
        {
          publicName: issued.publicName,
          tenantId: issued.tenantId,
          namespaceResourceUid: issued.namespaceResourceUid,
          httpService: "actor-test-http",
          upgradeService: "actor-test-upgrade",
          token: issued.token,
          runtimeClassRef: issued.runtimeClassRef,
        },
      ],
    };
    await forward.actorForwardLifecycle.prepare([publication]);
    expect(forward.actorForwardSockets()).toMatchObject([
      {
        tenantId: PRINCIPAL,
        namespaceResourceUid: namespace.resourceUid,
        token: issued.token,
      },
    ]);
    forward.actorForwardLifecycle.activated([publication]);
    await f.sql.run(
      "DELETE FROM tf_v2_resource_references WHERE referrer_uid = ? AND target_uid = ?",
      [version.resourceUid, namespace.resourceUid],
    );
    expect(await authority.resolveCurrentBinding(claim, "ACTOR")).toBeNull();
    await expect(forward.actorForwardLifecycle.prepare([publication])).rejects.toThrow();
    forward.actorForwardLifecycle.uncertain();
    await forward.close();
  } finally {
    await f.physical.close();
    f.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Actor backend does not synthesize counts or settle an active Deployment", async () => {
  const root = mkdtempSync(join(tmpdir(), "actor-v2-active-"));
  const f = fixture(root);
  if (!f.physical) throw new Error("physical Actor host fixture missing");
  try {
    const worker = await f.worker();
    const version = await f.version(worker.resourceUid, "version-active");
    await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment-active", {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    });
    const namespace = await f.create(
      ACTOR_NAMESPACE_FORM_URL,
      "namespace-active",
      { worker: { resourceUid: worker.resourceUid }, className: "CounterActor" },
      false,
    );
    expect(await f.engine.runNext()).toMatchObject({ id: namespace.id, status: "reconciling" });
    expect(
      await f.sql.query("SELECT observed_json FROM tf_v2_resources WHERE uid = ?", [
        namespace.resourceUid,
      ]),
    ).toEqual([{ observed_json: "{}" }]);
    expect(
      await f.physical.hasNamespace({
        tenantId: PRINCIPAL,
        namespaceResourceUid: namespace.resourceUid,
      }),
    ).toBe(false);
  } finally {
    await f.physical.close();
    f.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of [
  "positive",
  "unknown",
  "stale-source",
  "foreign-target",
  "invalid-version",
  "changed-version",
  "wrong-weight",
  "changed-native",
  "lost-lease",
  "mutated-composition",
  "changed-accepted-graph",
  "aliased-observation",
] as const) {
  test(`provider-neutral Actor active observation ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "actor-v2-provider-"));
    let current: V2ActorNamespaceNativeSnapshot | null = null;
    let warmed = false;
    let warmCount = 0;
    let onWarm:
      | ((graph: { readonly authorityKey: string; readonly scope: object }) => Promise<void>)
      | undefined;
    let acceptedOperationId = "";
    let observationCalls = 0;
    let foreignProviderCalls = 0;
    const confirmed = {
      kind: "confirmed" as const,
      epoch: "native-epoch",
      observedAt: 1,
      activeActorCount: 2,
      pendingAlarmCount: 1,
      openSocketCount: 3,
    };
    const providerNative: V2ActorNamespaceProviderPort = {
      async observeNativeForAcceptedOperation(input) {
        expect(Object.isFrozen(input.operation)).toBe(true);
        expect(input.operation.operationId).toBe(acceptedOperationId);
        expect(input.operation.leaseToken.length).toBeGreaterThan(0);
        return current && mode !== "unknown"
          ? { kind: "ready", snapshot: current }
          : { kind: "unknown" };
      },
      async observeNamespaceRuntimeForAcceptedOperation(_scope, snapshot) {
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.scope)).toBe(true);
        expect(Object.isFrozen(snapshot.versions)).toBe(true);
        if (mode === "aliased-observation") {
          observationCalls += 1;
          if (observationCalls === 2) {
            confirmed.epoch = "changed-epoch";
            confirmed.activeActorCount = 99;
          }
        }
        return warmed || mode === "aliased-observation" ? confirmed : { kind: "unknown" };
      },
      async warmNamespaceForAcceptedOperation(_scope, candidate, signal) {
        warmCount += 1;
        if (!(await candidate.stillAuthorized(signal))) return { kind: "unknown" };
        await onWarm?.(candidate.graph);
        warmed = true;
        return confirmed;
      },
    };
    const f = fixture(root, providerNative);
    if (!f.physical) throw new Error("physical fixture missing");
    try {
      const worker = await f.worker();
      const version = await f.version(worker.resourceUid, "provider-version");
      const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "provider-deployment", {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      });
      const namespace = await f.create(
        ACTOR_NAMESPACE_FORM_URL,
        "provider-namespace",
        { worker: { resourceUid: worker.resourceUid }, className: "CounterActor" },
        false,
      );
      acceptedOperationId = namespace.id;
      current = {
        scope: { tenantId: PRINCIPAL, namespaceResourceUid: namespace.resourceUid },
        workerUid: worker.resourceUid,
        className: "CounterActor",
        targetKey: TARGET,
        sourceOperationId: deployment.id,
        incarnationId: `incarnation:${deployment.id}`,
        generation: `takoserver-v2-operation:${deployment.id}`,
        generationKey: `generation:${deployment.id}`,
        hostnames: [],
        versions: [
          {
            versionId: `native:${version.resourceUid}`,
            workerVersionUid: version.resourceUid,
            weight: 10_000,
          },
        ],
      };
      if (mode === "stale-source") current = { ...current, sourceOperationId: "stale-op" };
      if (mode === "foreign-target") current = { ...current, targetKey: "foreign-target" };
      const weightedVersion = current.versions[0];
      if (!weightedVersion) throw new Error("fixture native Version missing");
      if (mode === "invalid-version")
        current = { ...current, versions: [{ ...weightedVersion, versionId: "" }] };
      if (mode === "wrong-weight")
        current = { ...current, versions: [{ ...weightedVersion, weight: 9_999 }] };
      if (mode === "changed-native")
        onWarm = async () => {
          if (!current) throw new Error("fixture native snapshot missing");
          current = { ...current, incarnationId: "changed-incarnation" };
        };
      if (mode === "changed-version")
        onWarm = async () => {
          if (!current) throw new Error("fixture native snapshot missing");
          current = {
            ...current,
            versions: [{ ...weightedVersion, versionId: "replaced-native-version" }],
          };
        };
      if (mode === "lost-lease")
        onWarm = async () => {
          await f.sql.run("UPDATE tf_v2_operations SET lease_token = ? WHERE id = ?", [
            "lost-lease",
            namespace.id,
          ]);
        };
      if (mode === "changed-accepted-graph")
        onWarm = async (graph) => {
          expect(Object.isFrozen(graph)).toBe(true);
          expect(Object.isFrozen(graph.scope)).toBe(true);
          expect(() => Object.assign(graph, { authorityKey: "changed-accepted" })).toThrow();
          f.setAcceptedAuthorityOverride("changed-accepted");
        };
      if (mode === "mutated-composition") {
        const foreignProvider: V2ActorNamespaceProviderPort = {
          async observeNativeForAcceptedOperation() {
            foreignProviderCalls += 1;
            return { kind: "unknown" };
          },
          async observeNamespaceRuntimeForAcceptedOperation() {
            foreignProviderCalls += 1;
            return { kind: "unknown" };
          },
          async warmNamespaceForAcceptedOperation() {
            foreignProviderCalls += 1;
            return { kind: "unknown" };
          },
        };
        f.onInspect(async () => {
          f.mutateActorComposition("foreign-target", foreignProvider);
        });
      }
      const result = await f.engine.runNext();
      expect(result?.id).toBe(namespace.id);
      if (mode === "positive" || mode === "mutated-composition") {
        expect(result?.status).toBe("succeeded");
        expect(warmCount).toBe(1);
        expect(foreignProviderCalls).toBe(0);
        expect(
          await f.sql.query("SELECT observed_json FROM tf_v2_resources WHERE uid = ?", [
            namespace.resourceUid,
          ]),
        ).toEqual([
          {
            observed_json: JSON.stringify({
              activeActorCount: 2,
              openSocketCount: 3,
              pendingAlarmCount: 1,
              ready: true,
            }),
          },
        ]);
      } else {
        expect(result?.status).not.toBe("succeeded");
        expect(
          await f.sql.query("SELECT observed_json FROM tf_v2_resources WHERE uid = ?", [
            namespace.resourceUid,
          ]),
        ).toEqual([{ observed_json: "{}" }]);
      }
    } finally {
      await f.physical.close();
      f.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("an unrelated Worker's unresolved Deployment does not block pre-Deployment Actor Namespace", async () => {
  const f = fixture();
  try {
    const own = await f.worker();
    const other = await f.create(MODULE_WORKER_FORM_URL, "other-worker", {});
    const otherVersion = await f.version(other.resourceUid, "other-version");
    const spec = {
      worker: { resourceUid: other.resourceUid },
      versions: [{ workerVersion: { resourceUid: otherVersion.resourceUid }, weight: 10_000 }],
    };
    const otherDeployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "other-deployment", spec);
    await f.sql.run("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?", [
      JSON.stringify({ active: true, ready: false, selectedVersions: [] }),
      otherDeployment.resourceUid,
    ]);
    const first = await f.create(
      ACTOR_NAMESPACE_FORM_URL,
      "own-before-deployment",
      { worker: { resourceUid: own.resourceUid }, className: "CounterActor" },
      false,
    );
    expect(first.status).toBe("queued");
    expect(f.inspections()).toBe(0);
    const pending = await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "other-deployment-pending-update-0001",
      uid: otherDeployment.resourceUid,
      expectedGeneration: 1,
      spec,
    });
    await f.sql.run("UPDATE tf_v2_operations SET status = 'running' WHERE id = ?", [pending.id]);
    await f.sql.run(
      "UPDATE tf_v2_operations SET status = 'reconciling', effect = 'unknown' WHERE id = ?",
      [pending.id],
    );
    const second = await f.create(
      ACTOR_NAMESPACE_FORM_URL,
      "own-before-deployment-two",
      { worker: { resourceUid: own.resourceUid }, className: "OtherActor" },
      false,
    );
    expect(second.status).toBe("queued");
    expect(f.inspections()).toBe(0);
  } finally {
    f.db.close();
  }
});

test("Actor admission treats missing held Bundle bytes as resource_busy, not a proven invalid class", async () => {
  const f = fixture();
  try {
    const worker = await f.worker();
    const version = await f.version(worker.resourceUid, "version-held-loss");
    await f.create(
      WORKER_DEPLOYMENT_FORM_URL,
      "deployment-held-loss",
      {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      },
      false,
    );
    const versionRow = (
      await f.sql.query("SELECT spec_json FROM tf_v2_resources WHERE uid = ?", [
        version.resourceUid,
      ])
    )[0];
    const bundleUid = parseWorkerVersionSpec(JSON.parse(String(versionRow?.spec_json))).bundle
      ?.resourceUid;
    if (!bundleUid) throw new Error("fixture Bundle missing");
    await f.sql.run("DELETE FROM tf_v2_artifact_chunks WHERE resource_uid = ?", [bundleUid]);
    await expect(
      f.create(
        ACTOR_NAMESPACE_FORM_URL,
        "namespace-held-loss",
        { worker: { resourceUid: worker.resourceUid }, className: "CounterActor" },
        false,
      ),
    ).rejects.toMatchObject({ code: "resource_busy" });
    expect(f.inspections()).toBe(0);
    expect(
      await f.sql.query("SELECT uid FROM tf_v2_resources WHERE form_url = ?", [
        ACTOR_NAMESPACE_FORM_URL,
      ]),
    ).toHaveLength(0);
  } finally {
    f.db.close();
  }
});

test("Actor admission fences both active and earlier accepted pending allocations in Core CAS", async () => {
  const f = fixture();
  try {
    const worker = await f.worker();
    const first = await f.version(worker.resourceUid, "version-first");
    const second = await f.version(worker.resourceUid, "version-second");
    const activeSpec = {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: first.resourceUid }, weight: 10_000 }],
    };
    const pendingSpec = {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: second.resourceUid }, weight: 10_000 }],
    };
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", activeSpec);
    const pending = await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "deployment-pending-update-0001",
      uid: deployment.resourceUid,
      expectedGeneration: 1,
      spec: pendingSpec,
    });
    expect(pending.status).toBe("queued");
    const namespaceSpec = {
      worker: { resourceUid: worker.resourceUid },
      className: "CounterActor",
    };
    f.setInspection("second-invalid");
    await expect(
      f.create(ACTOR_NAMESPACE_FORM_URL, "namespace-pending-invalid", namespaceSpec, false),
    ).rejects.toMatchObject({ code: "dependency_conflict" });
    expect(f.inspections()).toBe(2);
    f.setInspection("valid");
    f.onInspect(async () => {
      await f.create(WORKER_DEPLOYMENT_FORM_URL, "competing-deployment", pendingSpec, false);
    });
    await expect(
      f.create(ACTOR_NAMESPACE_FORM_URL, "namespace-raced", namespaceSpec, false),
    ).rejects.toMatchObject({ code: "resource_busy" });
    expect(
      await f.sql.query("SELECT uid FROM tf_v2_resources WHERE form_url = ?", [
        ACTOR_NAMESPACE_FORM_URL,
      ]),
    ).toHaveLength(0);
    const predicate = await f.admission({
      principal: PRINCIPAL,
      space: SPACE,
      resourceUid: "namespace-not-yet-accepted",
      spec: namespaceSpec,
    });
    if (!predicate) throw new Error("valid Actor admission missing");
    expect(
      (await f.sql.query(`SELECT (${predicate.sql}) AS admitted`, predicate.params))[0]?.admitted,
    ).toBe(1);
    await f.create(WORKER_DEPLOYMENT_FORM_URL, "later-deployment", pendingSpec, false);
    expect(
      (await f.sql.query(`SELECT (${predicate.sql}) AS admitted`, predicate.params))[0]?.admitted,
    ).toBe(0);
  } finally {
    f.db.close();
  }
});

test("Actor admission inspects held bytes for every accepted pending weighted Version before any Namespace effect", async () => {
  const f = fixture();
  try {
    const worker = await f.worker();
    const first = await f.version(worker.resourceUid, "version-first");
    const second = await f.version(worker.resourceUid, "version-second");
    const deployment = await f.create(
      WORKER_DEPLOYMENT_FORM_URL,
      "deployment",
      {
        worker: { resourceUid: worker.resourceUid },
        versions: [
          { workerVersion: { resourceUid: first.resourceUid }, weight: 4000 },
          { workerVersion: { resourceUid: second.resourceUid }, weight: 6000 },
        ],
      },
      false,
    );
    const spec = { worker: { resourceUid: worker.resourceUid }, className: "CounterActor" };
    f.setInspection("invalid");
    await expect(
      f.create(ACTOR_NAMESPACE_FORM_URL, "namespace-invalid", spec, false),
    ).rejects.toMatchObject({
      code: "dependency_conflict",
    });
    expect(f.inspections()).toBe(2);
    f.setInspection("mixed");
    await expect(
      f.create(ACTOR_NAMESPACE_FORM_URL, "namespace-mixed", spec, false),
    ).rejects.toMatchObject({ code: "dependency_conflict" });
    expect(f.inspections()).toBe(4);
    expect(
      await f.sql.query("SELECT uid FROM tf_v2_resources WHERE form_url = ?", [
        ACTOR_NAMESPACE_FORM_URL,
      ]),
    ).toHaveLength(0);
    expect(
      await f.sql.query("SELECT status FROM tf_v2_operations WHERE id = ?", [deployment.id]),
    ).toEqual([{ status: "queued" }]);
    f.setInspection("unavailable");
    await expect(
      f.create(ACTOR_NAMESPACE_FORM_URL, "namespace-unavailable", spec, false),
    ).rejects.toMatchObject({
      code: "resource_busy",
    });
    f.setInspection("valid");
    const accepted = await f.create(ACTOR_NAMESPACE_FORM_URL, "namespace-valid", spec, false);
    expect(accepted.status).toBe("queued");
  } finally {
    f.db.close();
  }
});

function splitMigration(source: string): readonly string[] {
  const statements: string[] = [];
  let rest = source.replace(/^\s*--.*$/gmu, "").trim();
  while (rest.length > 0) {
    if (/^CREATE\s+(?:TEMP\s+)?TRIGGER\b/iu.test(rest)) {
      const end = /^END\s*;/imu.exec(rest);
      if (!end || end.index === undefined) throw new Error("incomplete migration trigger");
      const boundary = end.index + end[0].length;
      statements.push(rest.slice(0, boundary).trim());
      rest = rest.slice(boundary).trim();
      continue;
    }
    const boundary = rest.indexOf(";");
    if (boundary < 0) {
      statements.push(rest);
      break;
    }
    const statement = rest.slice(0, boundary).trim();
    if (statement) statements.push(statement);
    rest = rest.slice(boundary + 1).trim();
  }
  return statements;
}

test("Miniflare D1 accepts one weighted Actor class in the Host INSERT and refuses exact graph drift", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "v2-actor-namespace-admission-d1-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "v2-actor-namespace-admission-d1-test" } },
          triggers: [],
        },
      },
    ],
  });
  let f: ReturnType<typeof fixture> | undefined;
  try {
    const database = await runtime.getD1Database("STATE_DB");
    for (const migration of MIGRATIONS) {
      for (const statement of splitMigration(migration.sql))
        await database.prepare(statement).run();
    }
    f = fixture(undefined, undefined, createD1Sql(database));
    const worker = await f.worker();
    const version = await f.version(worker.resourceUid, "d1-version");
    await f.create(WORKER_DEPLOYMENT_FORM_URL, "d1-deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    });
    const spec = { worker: { resourceUid: worker.resourceUid }, className: "CounterActor" };
    const predicate = await f.admission({
      principal: PRINCIPAL,
      space: SPACE,
      resourceUid: "actor-d1-predicate-probe",
      spec,
    });
    if (!predicate) throw new Error("Actor class unexpectedly incompatible");
    const query = `SELECT 1 AS admitted WHERE ${predicate.sql}`;
    expect(await f.sql.query(query, predicate.params)).toEqual([{ admitted: 1 }]);
    const [versionRow] = await f.sql.query(
      "SELECT observed_json FROM tf_v2_resources WHERE uid = ?",
      [version.resourceUid],
    );
    if (typeof versionRow?.observed_json !== "string") throw new Error("missing Version row");
    await f.sql.run("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?", [
      '{"ready":false}',
      version.resourceUid,
    ]);
    expect(await f.sql.query(query, predicate.params)).toHaveLength(0);
    await f.sql.run("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?", [
      versionRow.observed_json,
      version.resourceUid,
    ]);
    expect(await f.sql.query(query, predicate.params)).toEqual([{ admitted: 1 }]);
    await f.sql.run(
      "UPDATE tf_v2_operations SET lease_token = ?, lease_until_ms = ? WHERE id = ?",
      ["temporary-lease", 1000, version.id],
    );
    expect(await f.sql.query(query, predicate.params)).toHaveLength(0);
    await f.sql.run(
      "UPDATE tf_v2_operations SET lease_token = NULL, lease_until_ms = NULL WHERE id = ?",
      [version.id],
    );
    expect(await f.sql.query(query, predicate.params)).toEqual([{ admitted: 1 }]);
    const otherWorker = await f.create(MODULE_WORKER_FORM_URL, "d1-other-worker", {});
    const otherVersion = await f.version(otherWorker.resourceUid, "d1-other-version");
    await f.create(
      WORKER_DEPLOYMENT_FORM_URL,
      "d1-added-deployment",
      {
        worker: { resourceUid: otherWorker.resourceUid },
        versions: [{ workerVersion: { resourceUid: otherVersion.resourceUid }, weight: 10_000 }],
      },
      false,
    );
    expect(await f.sql.query(query, predicate.params)).toHaveLength(0);
    expect((await f.create(ACTOR_NAMESPACE_FORM_URL, "d1-namespace", spec, false)).status).toBe(
      "queued",
    );
  } finally {
    f?.db.close();
    await runtime.dispose();
  }
}, 120_000);
