import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { prepareV2ActorNamespaceAdmission } from "../src/takoform-v2/actor-namespace-admission.ts";
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

function fixture() {
  const db = new Database(":memory:");
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  const source = new Map<string, Uint8Array>();
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
  const actor = form({
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
    setInspection(value: typeof inspection) {
      inspection = value;
    },
    onInspect(callback: () => Promise<void>) {
      onInspect = callback;
    },
    inspections() {
      return inspected;
    },
  };
}

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
