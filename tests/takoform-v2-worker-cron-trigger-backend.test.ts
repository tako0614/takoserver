import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  parseWorkerCronTriggerSpec,
  WORKER_CRON_TRIGGER_FORM_URL,
  workerCronTriggerReferences,
} from "../src/takoform-v2/forms/worker-cron-trigger.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Execution, V2Form } from "../src/takoform-v2/types.ts";
import { createWorkerCronTriggerAdmissionReader } from "../src/takoform-v2/worker-cron-trigger-backend.ts";

const TARGET_KEY = "fixture-cron-admission";
const WORKER_SPEC = {};
const CRON_SPEC = { worker: { resourceUid: "worker-fixture" }, cron: "* * * * *" };

function fixture() {
  const db = new Database(":memory:");
  migrateSqlite(db);
  let keepDeploymentPending = false;
  let latestExecution: V2Execution | null = null;
  let onDeploymentExecution: ((input: V2Execution) => Promise<void>) | undefined;
  const backend = {
    id: "fixture-cron-admission",
    targetKey: TARGET_KEY,
    async execute(input: V2Execution) {
      latestExecution = input;
      if (input.form === WORKER_DEPLOYMENT_FORM_URL) await onDeploymentExecution?.(input);
      if (keepDeploymentPending && input.form === WORKER_DEPLOYMENT_FORM_URL) {
        return { kind: "unknown" as const };
      }
      return { kind: "complete" as const, observed: { ready: true }, output: {} };
    },
    async reconcile() {
      return { kind: "unknown" as const };
    },
  };
  const workerForm: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    backend,
  };
  const versionForm: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    references(spec) {
      const workerUid = (spec.worker as { resourceUid: string }).resourceUid;
      return [
        {
          resourceUid: workerUid,
          formUrl: MODULE_WORKER_FORM_URL,
          readiness: "observed",
        },
      ];
    },
    backend,
  };
  const deploymentForm: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    references(spec) {
      const workerUid = (spec.worker as { resourceUid: string }).resourceUid;
      const versions = spec.versions as {
        workerVersion: { resourceUid: string };
        weight: number;
      }[];
      const versionUid = versions[0]?.workerVersion.resourceUid;
      if (!versionUid) throw new TypeError("fixture deployment requires one Version");
      return [
        {
          resourceUid: workerUid,
          formUrl: MODULE_WORKER_FORM_URL,
          readiness: "observed",
        },
        {
          resourceUid: versionUid,
          formUrl: WORKER_VERSION_FORM_URL,
          readiness: "ready",
        },
      ];
    },
    backend,
  };
  const cronForm: V2Form = {
    validateCreate: parseWorkerCronTriggerSpec,
    validateUpdate: (_previous, next) => parseWorkerCronTriggerSpec(next),
    references(spec) {
      return workerCronTriggerReferences(parseWorkerCronTriggerSpec(spec));
    },
    backend,
  };
  const engine = createTakoformV2Engine({
    sql: createSqliteSql(db),
    forms: {
      [MODULE_WORKER_FORM_URL]: workerForm,
      [WORKER_VERSION_FORM_URL]: versionForm,
      [WORKER_DEPLOYMENT_FORM_URL]: deploymentForm,
      [WORKER_CRON_TRIGGER_FORM_URL]: cronForm,
    },
    replayWindowSeconds: 3600,
    now: () => new Date("2026-10-07T12:00:00.000Z"),
    authorize: async () => true,
  });
  return {
    db,
    engine,
    keepDeploymentPending(value: boolean) {
      keepDeploymentPending = value;
    },
    latestExecution() {
      return latestExecution;
    },
    onDeploymentExecution(callback: (input: V2Execution) => Promise<void>) {
      onDeploymentExecution = callback;
    },
  };
}

async function foundation(engine: ReturnType<typeof createTakoformV2Engine>) {
  const worker = await engine.acceptCreate({
    principal: "owner",
    key: "worker-create-key-001",
    input: { form: MODULE_WORKER_FORM_URL, space: "prod", name: "worker", spec: WORKER_SPEC },
  });
  await engine.runNext();
  const version = await engine.acceptCreate({
    principal: "owner",
    key: "version-create-key-001",
    input: {
      form: WORKER_VERSION_FORM_URL,
      space: "prod",
      name: "version",
      spec: { worker: { resourceUid: worker.resourceUid } },
    },
  });
  await engine.runNext();
  return { worker, version };
}

test("Cron and Deployment acceptance serialize in either order for one Worker", async () => {
  for (const order of ["cron-first", "deployment-first"] as const) {
    const { db, engine } = fixture();
    try {
      const { worker, version } = await foundation(engine);
      const cronSpec = { ...CRON_SPEC, worker: { resourceUid: worker.resourceUid } };
      const deploymentSpec = {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      };
      const createCron = () =>
        engine.acceptCreate({
          principal: "owner",
          key: "cron-attachment-key-001",
          input: {
            form: WORKER_CRON_TRIGGER_FORM_URL,
            space: "prod",
            name: "cron",
            spec: cronSpec,
          },
        });
      const createDeployment = () =>
        engine.acceptCreate({
          principal: "owner",
          key: "deployment-create-key-001",
          input: {
            form: WORKER_DEPLOYMENT_FORM_URL,
            space: "prod",
            name: "deployment",
            spec: deploymentSpec,
          },
        });

      if (order === "cron-first") {
        await createCron();
        await expect(createDeployment()).rejects.toMatchObject({
          code: "dependency_conflict",
          status: 409,
        });
      } else {
        await createDeployment();
        await expect(createCron()).rejects.toMatchObject({
          code: "dependency_conflict",
          status: 409,
        });
      }
    } finally {
      db.close();
    }
  }
});

test("Deployment admission reader proves the current claim and settled attachment set", async () => {
  const f = fixture();
  try {
    const { worker, version } = await foundation(f.engine);
    const cron = await f.engine.acceptCreate({
      principal: "owner",
      key: "cron-attachment-key-001",
      input: {
        form: WORKER_CRON_TRIGGER_FORM_URL,
        space: "prod",
        name: "cron",
        spec: { worker: { resourceUid: worker.resourceUid }, cron: "* * * * *" },
      },
    });
    await f.engine.runNext();
    const deployment = await f.engine.acceptCreate({
      principal: "owner",
      key: "deployment-create-key-001",
      input: {
        form: WORKER_DEPLOYMENT_FORM_URL,
        space: "prod",
        name: "deployment",
        spec: {
          worker: { resourceUid: worker.resourceUid },
          versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
        },
      },
    });
    const reader = createWorkerCronTriggerAdmissionReader({
      sql: createSqliteSql(f.db),
      now: () => new Date("2026-10-07T12:00:00.000Z"),
    });
    let admission: Awaited<ReturnType<typeof reader.requiresScheduledHandler>> | undefined;
    let currentDuringLease = false;
    f.onDeploymentExecution(async (execution) => {
      expect(execution.resourceUid).toBe(deployment.resourceUid);
      admission = await reader.requiresScheduledHandler({
        workerUid: worker.resourceUid,
        principal: execution.principal,
        space: execution.space,
        targetKey: execution.targetKey,
        sourceOperationId: execution.operationId,
        leaseToken: execution.leaseToken,
        backendId: execution.backendId,
        backendKey: execution.backendKey,
      });
      currentDuringLease = admission.kind === "ready" ? await admission.stillCurrent() : false;
    });
    f.keepDeploymentPending(true);
    await f.engine.runNext();
    expect(admission).toMatchObject({
      kind: "ready",
      required: true,
      attachmentUids: [cron.resourceUid],
    });
    if (admission?.kind !== "ready") {
      throw new Error("expected a fenced admission snapshot");
    }
    expect(currentDuringLease).toBe(true);
  } finally {
    f.db.close();
  }
});
