import { MIGRATIONS } from "../../src/db-schema.ts";
import { createD1Sql, type D1DatabaseLike } from "../../src/sql-d1.ts";
import { DURABLE_WORKFLOW_FORM_URL } from "../../src/takoform-v2/forms/durable-workflow.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
} from "../../src/takoform-v2/forms/worker-specs.ts";
import { createWorkflowAdmissionFixture } from "./workflow-class-admission-fixture.ts";

export interface WorkflowGraphObservation {
  readonly count: number;
  readonly versionCount: number;
  readonly weights: readonly number[];
  readonly preparedKind: string;
  readonly predicateBeforeCount: number | null;
  readonly observed: string | null;
  readonly predicateAfterCount: number | null;
  readonly inspectedClassNames: readonly string[];
  readonly settlements: readonly {
    readonly acceptedId: string;
    readonly actualId: string | null;
    readonly status: string | null;
  }[];
}

export interface WorkflowWorkerObservation {
  readonly graphs: readonly WorkflowGraphObservation[];
}

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

export default {
  async fetch(request: Request, env: { readonly STATE_DB: D1DatabaseLike }): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/__test/workflow-admission")
      return new Response(null, { status: 404 });

    const database = env.STATE_DB;
    for (const migration of MIGRATIONS)
      await database.batch(
        splitMigration(migration.sql).map((statement) => database.prepare(statement)),
      );
    const f = createWorkflowAdmissionFixture(createD1Sql(database));
    const graphs: WorkflowGraphObservation[] = [];
    // This is the original one- and eight-Version scenario. Every operation,
    // predicate, observation, and drift SQL uses this Worker's STATE_DB binding.
    for (const count of [1, 8]) {
      const settlementStart = f.settlements.length;
      const inspectionStart = f.inspectedClassNames.length;
      const worker = await f.create(MODULE_WORKER_FORM_URL, `d1-worker-${count}`, {});
      const versions = [];
      for (let index = 0; index < count; index++) {
        versions.push(await f.version(worker.resourceUid, `d1-version-${count}-${index}`));
      }
      const weight = 10_000 / count;
      const weights = versions.map(() => weight);
      await f.create(WORKER_DEPLOYMENT_FORM_URL, `d1-deployment-${count}`, {
        worker: { resourceUid: worker.resourceUid },
        versions: versions.map((version) => ({
          workerVersion: { resourceUid: version.resourceUid },
          weight,
        })),
      });
      const prepared = await f.admission.prepare(f.request(worker.resourceUid));
      if (prepared.kind !== "qualified") {
        graphs.push({
          count,
          versionCount: versions.length,
          weights,
          preparedKind: prepared.kind,
          predicateBeforeCount: null,
          observed: null,
          predicateAfterCount: null,
          inspectedClassNames: f.inspectedClassNames.slice(inspectionStart),
          settlements: f.settlements.slice(settlementStart),
        });
        break;
      }
      const predicateBeforeCount = (
        await f.sql.query(`SELECT 1 WHERE ${prepared.predicate.sql}`, prepared.predicate.params)
      ).length;
      await f.create(
        DURABLE_WORKFLOW_FORM_URL,
        `d1-workflow-${count}`,
        f.request(worker.resourceUid).spec,
      );
      const observed = await f.admission.observe(f.request(worker.resourceUid));
      await f.sql.run("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?", [
        '{"ready":false}',
        versions[0]?.resourceUid ?? "",
      ]);
      const predicateAfterCount = (
        await f.sql.query(`SELECT 1 WHERE ${prepared.predicate.sql}`, prepared.predicate.params)
      ).length;
      graphs.push({
        count,
        versionCount: versions.length,
        weights,
        preparedKind: prepared.kind,
        predicateBeforeCount,
        observed,
        predicateAfterCount,
        inspectedClassNames: f.inspectedClassNames.slice(inspectionStart),
        settlements: f.settlements.slice(settlementStart),
      });
    }
    return Response.json({ graphs } satisfies WorkflowWorkerObservation);
  },
};
