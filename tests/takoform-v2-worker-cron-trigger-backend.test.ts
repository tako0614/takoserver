import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
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
import {
  createWorkerCronTriggerAdmissionReader,
  createWorkerCronTriggerForm,
  type WorkerCronTriggerCapabilityReader,
} from "../src/takoform-v2/worker-cron-trigger-backend.ts";

const TARGET_KEY = "fixture-cron-admission";
const WORKER_SPEC = {};
const CRON_SPEC = { worker: { resourceUid: "worker-fixture" }, cron: "* * * * *" };

function fixture(cronCapability?: WorkerCronTriggerCapabilityReader) {
  const db = new Database(":memory:");
  migrateSqlite(db);
  let keepDeploymentPending = false;
  let activeDeploymentUid: string | null = null;
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
      if (input.form === MODULE_WORKER_FORM_URL) {
        return {
          kind: "complete" as const,
          observed: { ready: true, ...(activeDeploymentUid ? { activeDeploymentUid } : {}) },
          output: {},
        };
      }
      if (input.form === WORKER_DEPLOYMENT_FORM_URL) {
        const versions = (
          input.spec.versions as {
            workerVersion: { resourceUid: string };
            weight: number;
          }[]
        ).map((version) => ({
          resourceUid: version.workerVersion.resourceUid,
          weight: version.weight,
        }));
        return {
          kind: "complete" as const,
          observed: { ready: true, active: true, selectedVersions: versions },
          output: {},
        };
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
      const references: {
        resourceUid: string;
        formUrl: string;
        readiness: "observed";
      }[] = [
        {
          resourceUid: workerUid,
          formUrl: MODULE_WORKER_FORM_URL,
          readiness: "observed",
        },
      ];
      if (typeof spec.bundle === "object" && spec.bundle !== null) {
        references.push({
          resourceUid: (spec.bundle as { resourceUid: string }).resourceUid,
          formUrl: WORKER_BUNDLE_FORM_URL,
          readiness: "observed",
        });
      }
      return references;
    },
    backend,
  };
  const bundleForm: V2Form = {
    validateCreate() {},
    validateUpdate() {},
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
          targetSpecMatch: {
            path: ["worker", "resourceUid"],
            equals: workerUid,
          },
        },
      ];
    },
    backend,
  };
  const cronForm: V2Form = cronCapability
    ? createWorkerCronTriggerForm({
        sql: createSqliteSql(db),
        targetKey: TARGET_KEY,
        capability: cronCapability,
        now: () => new Date("2026-10-07T12:00:00.000Z"),
      })
    : {
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
      [WORKER_BUNDLE_FORM_URL]: bundleForm,
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
    createCronEngineForTarget(targetKey: string, capability: WorkerCronTriggerCapabilityReader) {
      return createTakoformV2Engine({
        sql: createSqliteSql(db),
        forms: {
          [WORKER_CRON_TRIGGER_FORM_URL]: createWorkerCronTriggerForm({
            sql: createSqliteSql(db),
            targetKey,
            capability,
            now: () => new Date("2026-10-07T12:00:00.000Z"),
          }),
        },
        replayWindowSeconds: 3600,
        now: () => new Date("2026-10-07T12:00:00.000Z"),
        authorize: async () => true,
      });
    },
    keepDeploymentPending(value: boolean) {
      keepDeploymentPending = value;
    },
    setActiveDeploymentUid(uid: string) {
      activeDeploymentUid = uid;
    },
    latestExecution() {
      return latestExecution;
    },
    onDeploymentExecution(callback: (input: V2Execution) => Promise<void>) {
      onDeploymentExecution = callback;
    },
  };
}

async function foundation(
  engine: ReturnType<typeof createTakoformV2Engine>,
  versionSpec: Record<string, unknown> = { worker: { resourceUid: "worker-fixture" } },
) {
  const worker = await engine.acceptCreate({
    principal: "owner",
    key: "worker-create-key-001",
    input: { form: MODULE_WORKER_FORM_URL, space: "prod", name: "worker", spec: WORKER_SPEC },
  });
  await engine.runNext();
  const bundle = await engine.acceptCreate({
    principal: "owner",
    key: "bundle-create-key-0001",
    input: {
      form: WORKER_BUNDLE_FORM_URL,
      space: "prod",
      name: "bundle",
      spec: {},
    },
  });
  await engine.runNext();
  const version = await engine.acceptCreate({
    principal: "owner",
    key: "version-create-key-001",
    input: {
      form: WORKER_VERSION_FORM_URL,
      space: "prod",
      name: "version",
      spec: {
        ...versionSpec,
        worker: { resourceUid: worker.resourceUid },
        bundle: { resourceUid: bundle.resourceUid },
      },
    },
  });
  await engine.runNext();
  return { worker, version, bundle };
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

test("WorkerCronTrigger Resource supports settled create, same-Worker update, and delete", async () => {
  let serving: {
    readonly deploymentUid: string;
    readonly deploymentGeneration: number;
    readonly versions: readonly {
      readonly workerVersionUid: string;
      readonly generation: number;
      readonly weight: number;
    }[];
  } | null = null;
  const f = fixture({
    async observeScheduledCapability() {
      return serving
        ? {
            kind: "confirmed" as const,
            servingSourceOperationId: "fixture-serving-operation",
            ...serving,
            async stillCurrent() {
              return true;
            },
          }
        : { kind: "unknown" as const };
    },
  });
  try {
    const { worker, version } = await foundation(f.engine, { handlers: ["scheduled"] });
    const deploymentOperation = await f.engine.acceptCreate({
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
    await f.engine.runNext();
    const deployment = await f.engine.getResource({
      principal: "owner",
      uid: deploymentOperation.resourceUid,
    });
    f.setActiveDeploymentUid(deployment.uid);
    const workerUpdate = await f.engine.acceptUpdate({
      principal: "owner",
      key: "worker-update-key-001",
      uid: worker.resourceUid,
      expectedGeneration: worker.generation,
      spec: WORKER_SPEC,
    });
    await f.engine.runNext();
    const settledVersion = await f.engine.getResource({
      principal: "owner",
      uid: version.resourceUid,
    });
    const settledDeployment = await f.engine.getResource({
      principal: "owner",
      uid: deployment.uid,
    });
    expect((await f.engine.getOperation({ principal: "owner", id: workerUpdate.id })).status).toBe(
      "succeeded",
    );
    serving = {
      deploymentUid: settledDeployment.uid,
      deploymentGeneration: settledDeployment.generation,
      versions: [
        {
          workerVersionUid: settledVersion.uid,
          generation: settledVersion.generation,
          weight: 10_000,
        },
      ],
    };

    const create = await f.engine.acceptCreate({
      principal: "owner",
      key: "cron-create-key-0001",
      input: {
        form: WORKER_CRON_TRIGGER_FORM_URL,
        space: "prod",
        name: "cron",
        spec: { worker: { resourceUid: worker.resourceUid }, cron: "*/2 * * * *" },
      },
    });
    await f.engine.runNext();
    expect((await f.engine.getOperation({ principal: "owner", id: create.id })).status).toBe(
      "succeeded",
    );
    const created = await f.engine.getResource({ principal: "owner", uid: create.resourceUid });
    expect(created.observed).toMatchObject({
      cron: "*/2 * * * *",
      timezone: "UTC",
      scheduleReady: true,
    });

    const update = await f.engine.acceptUpdate({
      principal: "owner",
      key: "cron-update-key-0001",
      uid: created.uid,
      expectedGeneration: created.generation,
      spec: { worker: { resourceUid: worker.resourceUid }, cron: "*/3 * * * *" },
    });
    await f.engine.runNext();
    expect((await f.engine.getOperation({ principal: "owner", id: update.id })).status).toBe(
      "succeeded",
    );
    expect(
      (await f.engine.getResource({ principal: "owner", uid: created.uid })).observed,
    ).toMatchObject({
      cron: "*/3 * * * *",
      scheduleReady: true,
    });

    const current = await f.engine.getResource({ principal: "owner", uid: created.uid });
    const deletion = await f.engine.acceptDelete({
      principal: "owner",
      key: "cron-delete-key-0001",
      uid: created.uid,
      expectedGeneration: current.generation,
    });
    await f.engine.runNext();
    expect((await f.engine.getOperation({ principal: "owner", id: deletion.id })).status).toBe(
      "succeeded",
    );
    await expect(
      f.engine.getResource({ principal: "owner", uid: created.uid }),
    ).rejects.toMatchObject({
      code: "gone",
      status: 410,
    });
  } finally {
    f.db.close();
  }
});

test("WorkerCronTrigger refuses a Worker from a different execution target before capability use", async () => {
  const f = fixture();
  try {
    const { worker, version } = await foundation(f.engine, { handlers: ["scheduled"] });
    const deploymentOperation = await f.engine.acceptCreate({
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
    await f.engine.runNext();
    f.setActiveDeploymentUid(deploymentOperation.resourceUid);
    await f.engine.acceptUpdate({
      principal: "owner",
      key: "worker-update-key-001",
      uid: worker.resourceUid,
      expectedGeneration: worker.generation,
      spec: WORKER_SPEC,
    });
    await f.engine.runNext();

    let capabilityCalls = 0;
    const otherTarget = f.createCronEngineForTarget("other-cron-target", {
      async observeScheduledCapability() {
        capabilityCalls += 1;
        return { kind: "unknown" as const };
      },
    });
    const create = await otherTarget.acceptCreate({
      principal: "owner",
      key: "cross-target-cron-key",
      input: {
        form: WORKER_CRON_TRIGGER_FORM_URL,
        space: "prod",
        name: "cross-target-cron",
        spec: { worker: { resourceUid: worker.resourceUid }, cron: "* * * * *" },
      },
    });
    await otherTarget.runNext();
    expect((await otherTarget.getOperation({ principal: "owner", id: create.id })).status).toBe(
      "reconciling",
    );
    expect(capabilityCalls).toBe(0);
  } finally {
    f.db.close();
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
    const additionalCrons = 128;
    for (let index = 0; index < additionalCrons; index += 1) {
      const suffix = String(index).padStart(3, "0");
      await f.engine.acceptCreate({
        principal: "owner",
        key: `cron-attachment-extra-key-${suffix}`,
        input: {
          form: WORKER_CRON_TRIGGER_FORM_URL,
          space: "prod",
          name: `cron-${suffix}`,
          spec: { worker: { resourceUid: worker.resourceUid }, cron: "* * * * *" },
        },
      });
      await f.engine.runNext();
    }
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
    let reopenedAdmission: Awaited<ReturnType<typeof reader.requiresScheduledHandler>> | undefined;
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
      const reopenedReader = createWorkerCronTriggerAdmissionReader({
        sql: createSqliteSql(f.db),
        now: () => new Date("2026-10-07T12:00:00.000Z"),
      });
      reopenedAdmission = await reopenedReader.requiresScheduledHandler({
        workerUid: worker.resourceUid,
        principal: execution.principal,
        space: execution.space,
        targetKey: execution.targetKey,
        sourceOperationId: execution.operationId,
        leaseToken: execution.leaseToken,
        backendId: execution.backendId,
        backendKey: execution.backendKey,
      });
    });
    f.keepDeploymentPending(true);
    await f.engine.runNext();
    expect(admission).toMatchObject({
      kind: "ready",
      required: true,
    });
    expect(reopenedAdmission).toMatchObject({
      kind: "ready",
      required: true,
    });
    if (admission?.kind !== "ready" || reopenedAdmission?.kind !== "ready") {
      throw new Error("expected fenced admission snapshots from both readers");
    }
    expect(admission.attachmentUids).toHaveLength(additionalCrons + 1);
    expect(admission.attachmentUids).toContain(cron.resourceUid);
    expect(reopenedAdmission.attachmentUids).toEqual(admission.attachmentUids);
    expect(currentDuringLease).toBe(true);
  } finally {
    f.db.close();
  }
});
