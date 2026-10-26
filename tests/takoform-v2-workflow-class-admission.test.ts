import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Miniflare } from "miniflare";
import type { Sql, SqlParam, SqlStatement, SqlWrite } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { DURABLE_WORKFLOW_FORM_URL } from "../src/takoform-v2/forms/durable-workflow.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import {
  createDurableWorkflowForm,
  DURABLE_WORKFLOW_BACKEND_ID,
} from "../src/takoform-v2/workflow-backend.ts";
import { createV2WorkflowClassAdmission } from "../src/takoform-v2/workflow-class-admission.ts";
import { createWorkerdWorkerModuleInspector } from "../src/workerd-worker-module-inspector.ts";
import { migrateSqliteDatabase } from "./helpers/migrated-database.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";
import {
  createWorkflowAdmissionFixture,
  PRINCIPAL,
  SPEC_CLASS,
  TARGET,
} from "./helpers/workflow-class-admission-fixture.ts";
import type { WorkflowWorkerObservation } from "./helpers/workflow-class-admission-worker.ts";

function fixture() {
  const db = migrateSqliteDatabase();
  return { db, ...createWorkflowAdmissionFixture(createSqliteSql(db)) };
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

test("Miniflare D1 atomically accepts 1 and 8 weighted Workflow class graphs and refuses drift", async () => {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "helpers/workflow-class-admission-worker.ts")],
    target: "browser",
    format: "esm",
  });
  if (!build.success) throw new Error(build.logs.map(String).join("\n"));
  const bundle = build.outputs[0];
  if (!bundle) throw new Error("Workflow admission Worker bundle is unavailable");
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
                contents: await bundle.text(),
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "v2-workflow-class-admission-d1-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const response = await runtime.dispatchFetch(
      "https://workflow-admission.test/__test/workflow-admission",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const observation = (await response.json()) as WorkflowWorkerObservation;
    expect(observation.graphs).toHaveLength(2);
    for (const [index, count] of [1, 8].entries()) {
      const graph = observation.graphs[index];
      if (!graph) throw new Error(`missing ${count}-Version Worker observation`);
      expect(graph.count).toBe(count);
      expect(graph.versionCount).toBe(count);
      expect(graph.weights).toEqual(Array(count).fill(10_000 / count));
      expect(graph.preparedKind).toBe("qualified");
      expect(graph.predicateBeforeCount).toBe(1);
      expect(graph.observed).toBe("ready");
      expect(graph.predicateAfterCount).toBe(0);
      expect(graph.inspectedClassNames.length).toBeGreaterThan(0);
      for (const className of graph.inspectedClassNames) expect(className).toBe(SPEC_CLASS);
      expect(graph.settlements).toHaveLength(3 + 2 * count);
      for (const settlement of graph.settlements)
        expect({ id: settlement.actualId, status: settlement.status }).toMatchObject({
          id: settlement.acceptedId,
          status: "succeeded",
        });
    }
  } finally {
    await runtime.dispose();
  }
}, 120_000);

function measuredReadFixture() {
  const db = migrateSqliteDatabase();
  const original = createSqliteSql(db);
  let roundtrips = 0;
  let fault: "truncated" | "extra-result" | "malformed-rows" | null = null;
  const sql: Sql = {
    async query(statement, params) {
      roundtrips++;
      return await original.query(statement, params);
    },
    run: original.run.bind(original),
    async batch(statements: readonly SqlStatement[]) {
      roundtrips++;
      const results = await original.batch(statements);
      if (fault && statements.every(({ sql }) => /^\s*SELECT\b/iu.test(sql))) {
        if (fault === "truncated") return results.slice(1);
        if (fault === "extra-result") return [...results, ...results.slice(0, 1)];
        return results.map((result, index) =>
          index === 0 ? { ...result, rows: { 0: result.rows[0], length: 1 } } : result,
        ) as unknown as readonly SqlWrite[];
      }
      return results;
    },
  };
  return {
    db,
    original,
    ...createWorkflowAdmissionFixture(sql),
    resetRoundtrips() {
      roundtrips = 0;
    },
    get roundtrips() {
      return roundtrips;
    },
    setFault(value: typeof fault) {
      fault = value;
    },
  };
}

async function createMeasuredGraph(f: ReturnType<typeof measuredReadFixture>, count: number) {
  const worker = await f.create(MODULE_WORKER_FORM_URL, `read-plan-worker-${count}`, {});
  const versions = [];
  for (let index = 0; index < count; index++)
    versions.push(await f.version(worker.resourceUid, `read-plan-version-${count}-${index}`));
  const deployment = await f.create(WORKER_DEPLOYMENT_FORM_URL, `read-plan-deployment-${count}`, {
    worker: { resourceUid: worker.resourceUid },
    versions: versions.map((version) => ({
      workerVersion: { resourceUid: version.resourceUid },
      weight: 10_000 / count,
    })),
  });
  return { worker, versions, deployment };
}

test("Workflow currentness bounds roundtrips for one and eight Versions", async () => {
  const f = measuredReadFixture();
  const roundtrips: number[] = [];
  try {
    for (const count of [1, 8]) {
      const { worker } = await createMeasuredGraph(f, count);
      f.resetRoundtrips();
      expect((await f.admission.prepare(f.request(worker.resourceUid))).kind).toBe("qualified");
      roundtrips.push(f.roundtrips);
    }
    // Every boundary still checks the full graph; it must not pay one D1
    // request per row again for every inspected Version.
    expect(roundtrips[1]).toBeLessThan((roundtrips[0] ?? 0) * 12);
  } finally {
    f.db.close();
  }
});

for (const fault of ["truncated", "extra-result", "malformed-rows"] as const) {
  test(`Workflow currentness refuses fresh read acknowledgement: ${fault}`, async () => {
    const f = measuredReadFixture();
    try {
      const { worker } = await createMeasuredGraph(f, 1);
      f.setFault(fault);
      expect((await f.admission.prepare(f.request(worker.resourceUid))).kind).toBe("unavailable");
    } finally {
      f.db.close();
    }
  });
}

test("Workflow currentness re-reads the graph after awaited class inspection", async () => {
  const f = measuredReadFixture();
  try {
    const { worker, versions } = await createMeasuredGraph(f, 1);
    let inspections = 0;
    const admission = createV2WorkflowClassAdmission({
      sql: f.sql,
      targetKey: TARGET,
      bundleCustody: f.bundleCustody,
      inspector: {
        async inspectWorkflowClass() {
          inspections++;
          await f.original.run("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?", [
            '{"ready":false}',
            versions[0]?.resourceUid ?? "",
          ]);
          return { outcome: "valid" };
        },
      },
    });
    expect((await admission.prepare(f.request(worker.resourceUid))).kind).toBe("unavailable");
    expect(inspections).toBe(1);
  } finally {
    f.db.close();
  }
});

test("Workflow currentness retains the ambiguous completed-history refusal", async () => {
  const f = measuredReadFixture();
  try {
    const { worker, deployment } = await createMeasuredGraph(f, 1);
    let inspections = 0;
    const admission = createV2WorkflowClassAdmission({
      sql: f.sql,
      targetKey: TARGET,
      bundleCustody: f.bundleCustody,
      inspector: {
        async inspectWorkflowClass() {
          inspections++;
          const [operation] = await f.original.query(
            "SELECT * FROM tf_v2_operations WHERE id = ?",
            [deployment.id],
          );
          if (!operation) throw new Error("missing completed Deployment");
          // The schema permits direct terminal inserts even though the ordinary
          // writer only mints queued Operations. Keep the recapture's refusal.
          const extra = {
            ...operation,
            id: "read-plan-ambiguous-completed-operation",
            replay_key: "read-plan-ambiguous-completed-key",
            backend_key: "read-plan-ambiguous-completed-backend",
            acceptance_order: null,
          };
          const columns = Object.keys(extra);
          await f.original.run(
            `INSERT INTO tf_v2_operations (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
            Object.values(extra) as SqlParam[],
          );
          const [count] = await f.original.query(
            "SELECT count(*) AS n FROM tf_v2_operations WHERE resource_uid = ? AND generation = 1 AND action IN ('create','update') AND status = 'succeeded' AND effect = 'complete'",
            [deployment.resourceUid],
          );
          expect(count?.n).toBe(2);
          return { outcome: "valid" };
        },
      },
    });
    expect((await admission.prepare(f.request(worker.resourceUid))).kind).toBe("unavailable");
    expect(inspections).toBe(1);
  } finally {
    f.db.close();
  }
});
