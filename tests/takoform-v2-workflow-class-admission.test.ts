import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject, Sql } from "../src/ports.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { DURABLE_WORKFLOW_FORM_URL } from "../src/takoform-v2/forms/durable-workflow.ts";
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
import {
  createDurableWorkflowForm,
  DURABLE_WORKFLOW_BACKEND_ID,
} from "../src/takoform-v2/workflow-backend.ts";
import { createV2WorkflowClassAdmission } from "../src/takoform-v2/workflow-class-admission.ts";
import { createWorkerdWorkerModuleInspector } from "../src/workerd-worker-module-inspector.ts";
import { createWorkflowRuntime } from "../src/workflow-execution.ts";
import { createV2WorkflowResourceAuthority } from "../src/workflow-v2-resource-authority.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const PRINCIPAL = "org:workflow-admission";
const SPACE = "production";
const TARGET = "workflow-admission-local-target";
const SPEC_CLASS = "ReportWorkflow";

function fixture(sqlOverride?: Sql) {
  const db = new Database(":memory:");
  migrateSqlite(db);
  const sql = sqlOverride ?? createSqliteSql(db);
  const source = new Map<string, Uint8Array>();
  const bundleHost = createWorkerBundleHost({
    sql,
    targetKey: TARGET,
    source: {
      async read({ url }) {
        const bytes = source.get(url);
        if (!bytes) throw new Error("fixture artifact missing");
        return bytes;
      },
    },
  });
  const inspected: string[] = [];
  let verdict: "valid" | "invalid" | "unavailable" = "valid";
  const inspector = {
    async inspectWorkflowClass(input: {
      readonly className: string;
      readonly modules: readonly { readonly bytes: Uint8Array }[];
    }) {
      inspected.push(new TextDecoder().decode(input.modules[0]?.bytes));
      expect(input.className).toBe(SPEC_CLASS);
      return verdict === "valid"
        ? ({ outcome: "valid" } as const)
        : verdict === "invalid"
          ? ({ outcome: "invalid", error: "workflow_class_invalid" } as const)
          : ({ outcome: "unavailable", retryable: true } as const);
    },
  };
  const admission = createV2WorkflowClassAdmission({
    sql,
    targetKey: TARGET,
    bundleCustody: bundleHost.custody,
    inspector,
  });
  const runtime = createWorkflowRuntime({
    sql,
    clock: () => new Date(),
    randomId: () => "unused-workflow-owner",
    waitUntil: async () => {},
    v2ResourceAuthority: createV2WorkflowResourceAuthority(sql),
    host: {
      async openPaused() {
        throw new Error("no instance opened in class admission fixture");
      },
      async stop() {
        return "stopped" as const;
      },
    },
  });
  const backend = {
    id: "workflow-admission-fixture-only",
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
  const engine = createTakoformV2Engine({
    sql,
    replayWindowSeconds: 3_600,
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
      [DURABLE_WORKFLOW_FORM_URL]: createDurableWorkflowForm({
        sql,
        clock: () => new Date(),
        targetKey: TARGET,
        classAdmission: admission,
        runtime,
      }),
    },
  });
  async function create(formUrl: string, name: string, spec: JsonObject, settle = true) {
    const operation = await engine.acceptCreate({
      principal: PRINCIPAL,
      key: `workflow-admission-create-${name}`,
      input: { form: formUrl, space: SPACE, name, spec },
    });
    if (settle)
      expect(await engine.runNext()).toMatchObject({ id: operation.id, status: "succeeded" });
    return operation;
  }
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  async function version(workerUid: string, name: string) {
    const moduleUrl = `https://artifacts.example.test/${name}/index.mjs`;
    const manifestUrl = `https://artifacts.example.test/${name}/manifest.json`;
    const moduleBytes = new TextEncoder().encode(
      `// ${name}\nexport class ReportWorkflow { run() { return {}; } }`,
    );
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
  function request(workerUid: string) {
    return {
      principal: PRINCIPAL,
      space: SPACE,
      targetKey: TARGET,
      resourceUid: "workflow-new-resource",
      spec: { worker: { resourceUid: workerUid }, className: SPEC_CLASS },
    };
  }
  return {
    db,
    sql,
    engine,
    admission,
    bundleCustody: bundleHost.custody,
    create,
    version,
    request,
    inspected,
    setVerdict(value: typeof verdict) {
      verdict = value;
    },
    source,
  };
}

test("Durable Workflow Form accepts a terminate-only execution owner port", () => {
  const f = fixture();
  try {
    const runtime = {
      instances: { async terminate() {} },
      async retireExpiredForResourceDelete() {},
    } satisfies Parameters<typeof createDurableWorkflowForm>[0]["runtime"];
    const form = createDurableWorkflowForm({
      sql: f.sql,
      clock: () => new Date(),
      targetKey: TARGET,
      classAdmission: f.admission,
      runtime,
    });
    expect(form.backend.id).toBe(DURABLE_WORKFLOW_BACKEND_ID);
  } finally {
    f.db.close();
  }
});

test("active plus pending weighted allocations both enter the exact inspected graph", async () => {
  const f = fixture();
  try {
    const worker = await f.create(MODULE_WORKER_FORM_URL, "worker", {});
    const active = await f.version(worker.resourceUid, "active-version");
    const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: active.resourceUid }, weight: 10_000 }],
    });
    const pending = await f.version(worker.resourceUid, "pending-update-version");
    await f.engine.acceptUpdate({
      principal: PRINCIPAL,
      key: "workflow-deployment-pending-update",
      uid: deployment.resourceUid,
      expectedGeneration: 1,
      spec: {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: pending.resourceUid }, weight: 10_000 }],
      },
    });
    expect((await f.admission.prepare(f.request(worker.resourceUid))).kind).toBe("qualified");
    expect(f.inspected).toHaveLength(2);
    expect(f.inspected.join("\n")).toContain("active-version");
    expect(f.inspected.join("\n")).toContain("pending-update-version");
  } finally {
    f.db.close();
  }
});

const workerd = nativeEvidenceBinary("workerd-artifact") ?? null;
test.skipIf(workerd === null)(
  "pinned workerd qualifies the held accepted weighted Workflow class graph",
  async () => {
    const f = fixture();
    try {
      const worker = await f.create(MODULE_WORKER_FORM_URL, "worker", {});
      const version = await f.version(worker.resourceUid, "native-version");
      await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      });
      const native = createV2WorkflowClassAdmission({
        sql: f.sql,
        targetKey: TARGET,
        bundleCustody: f.bundleCustody,
        inspector: createWorkerdWorkerModuleInspector({ binary: workerd }),
      });
      f.source.clear();
      expect((await native.prepare(f.request(worker.resourceUid))).kind).toBe("qualified");
      expect(await native.observe(f.request(worker.resourceUid))).toBe("ready");
    } finally {
      f.db.close();
    }
  },
);

test("Workflow class admission allows pre-Deployment Resource and captures a new pending allocation", async () => {
  const f = fixture();
  try {
    const worker = await f.create(MODULE_WORKER_FORM_URL, "worker", {});
    const input = f.request(worker.resourceUid);
    const before = await f.admission.prepare(input);
    expect(before.kind).toBe("qualified");
    expect(await f.admission.observe(input)).toBe("not_ready");
    expect(f.inspected).toHaveLength(0);
    if (before.kind !== "qualified") throw new Error("expected qualified absence predicate");
    expect(
      await f.sql.query(`SELECT 1 WHERE ${before.predicate.sql}`, before.predicate.params),
    ).toHaveLength(1);
    const version = await f.version(worker.resourceUid, "pending-version");
    await f.create(
      WORKER_DEPLOYMENT_FORM_URL,
      "pending-deployment",
      {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      },
      false,
    );
    expect(
      await f.sql.query(`SELECT 1 WHERE ${before.predicate.sql}`, before.predicate.params),
    ).toHaveLength(0);
    const pending = await f.admission.prepare(input);
    expect(pending.kind).toBe("qualified");
    expect(f.inspected).toHaveLength(1);
    expect(f.inspected[0]).toContain("pending-version");
    expect(await f.admission.observe(input)).toBe("not_ready");
  } finally {
    f.db.close();
  }
});

test("all active weighted Versions use held bytes and distinguish incompatible from unavailable", async () => {
  const f = fixture();
  try {
    const worker = await f.create(MODULE_WORKER_FORM_URL, "worker", {});
    const first = await f.version(worker.resourceUid, "weighted-first");
    const second = await f.version(worker.resourceUid, "weighted-second");
    await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [
        { workerVersion: { resourceUid: first.resourceUid }, weight: 5_000 },
        { workerVersion: { resourceUid: second.resourceUid }, weight: 5_000 },
      ],
    });
    const input = f.request(worker.resourceUid);
    f.source.clear(); // A verified held artifact is independent of the original URL.
    expect((await f.admission.prepare(input)).kind).toBe("qualified");
    expect(f.inspected).toHaveLength(2);
    expect(await f.admission.observe(input)).toBe("ready");
    f.setVerdict("invalid");
    expect(await f.admission.prepare(input)).toEqual({ kind: "incompatible" });
    f.setVerdict("unavailable");
    expect(await f.admission.prepare(input)).toEqual({ kind: "unavailable" });
  } finally {
    f.db.close();
  }
});

test("accepted v2 Workflow Resource becomes Ready only after held weighted class inspection", async () => {
  const f = fixture();
  try {
    const worker = await f.create(MODULE_WORKER_FORM_URL, "worker", {});
    const version = await f.version(worker.resourceUid, "serving-version");
    await f.create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    });
    const spec = f.request(worker.resourceUid).spec;
    const workflow = await f.create(DURABLE_WORKFLOW_FORM_URL, "workflow", spec);
    expect(
      (await f.engine.getResource({ principal: PRINCIPAL, uid: workflow.resourceUid })).observed,
    ).toMatchObject({ ready: true, instanceCounts: { queued: 0 } });
    f.setVerdict("invalid");
    await expect(
      f.create(DURABLE_WORKFLOW_FORM_URL, "incompatible-workflow", spec, false),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
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

test("Miniflare D1 atomically accepts 1, 2, and 8 weighted Workflow class graphs and refuses drift", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "v2-workflow-class-admission-d1-test",
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
          env: { STATE_DB: { type: "d1", id: "v2-workflow-class-admission-d1-test" } },
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
    f = fixture(createD1Sql(database));
    for (const count of [1, 2, 8]) {
      const worker = await f.create(MODULE_WORKER_FORM_URL, `d1-worker-${count}`, {});
      const versions = [];
      for (let index = 0; index < count; index++) {
        versions.push(await f.version(worker.resourceUid, `d1-version-${count}-${index}`));
      }
      const weight = 10_000 / count;
      await f.create(WORKER_DEPLOYMENT_FORM_URL, `d1-deployment-${count}`, {
        worker: { resourceUid: worker.resourceUid },
        versions: versions.map((version) => ({
          workerVersion: { resourceUid: version.resourceUid },
          weight,
        })),
      });
      const prepared = await f.admission.prepare(f.request(worker.resourceUid));
      expect(prepared.kind).toBe("qualified");
      if (prepared.kind !== "qualified") throw new Error("expected qualified D1 graph");
      expect(
        await f.sql.query(`SELECT 1 WHERE ${prepared.predicate.sql}`, prepared.predicate.params),
      ).toHaveLength(1);
      await f.create(
        DURABLE_WORKFLOW_FORM_URL,
        `d1-workflow-${count}`,
        f.request(worker.resourceUid).spec,
      );
      expect(await f.admission.observe(f.request(worker.resourceUid))).toBe("ready");
      await f.sql.run("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?", [
        '{"ready":false}',
        versions[0]?.resourceUid ?? "",
      ]);
      expect(
        await f.sql.query(`SELECT 1 WHERE ${prepared.predicate.sql}`, prepared.predicate.params),
      ).toHaveLength(0);
    }
  } finally {
    f?.db.close();
    await runtime.dispose();
  }
}, 120_000);
