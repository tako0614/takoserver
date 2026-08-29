import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type AttachmentRebinding, createAttachmentStore } from "../src/attachments.ts";
import { createCatalog, type Offering } from "../src/catalog.ts";
import type { TakoformV1Alpha3FormRef } from "../src/form-ref.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createProviderPack, type ProviderPackDefinition } from "../src/provider-pack.ts";
import {
  type ApplyInput,
  type Provider,
  type ProviderOffering,
  type ProviderTicket,
  running,
  succeeded,
} from "../src/provider-port.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import {
  createResourceMigrationService,
  createResourceMigrationStore,
} from "../src/resource-migrations.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformStore } from "../src/takoform/store.ts";

const FORM = {
  apiVersion: "data.forms.takoform.com/v1alpha1",
  kind: "SqliteDatabase",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
} as const;

const FORMAT = "sqlite.sql-dump.takoform.com/v1";

const WORKER_VERSION_FORM = {
  apiVersion: "workers.forms.takoform.com/v1alpha1",
  kind: "WorkerVersion",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"b".repeat(64)}`,
} as const;

function providerOffering(id: string, form: TakoformV1Alpha3FormRef = FORM): ProviderOffering {
  return {
    id,
    kind: "sqlite_database",
    displayName: id,
    form,
    providedInterfaces: [],
    bindingRefs: [],
    capabilities: ["create", "update", "delete", "import", "observe"],
  };
}

function sold(
  id: string,
  pack: string,
  installation: string,
  form: TakoformV1Alpha3FormRef = FORM,
): Offering {
  return {
    id,
    providerPackRef: pack,
    providerInstallationRef: installation,
    supplyContractRef: `${pack}.contract`,
    pricePlanRef: `${id}.price`,
    resourceClass: "database.sqlite",
    deliveryMode: "managed-endpoint",
    supportPolicyRef: "support:test",
    abusePolicyRef: "abuse:test",
    kind: "sqlite_database",
    displayName: id,
    form,
    pricePlan: {
      id: `${id}.price`,
      currency: "USD",
      provisioning: { meter: "resource.create", amountMinor: 500 },
      meters: [],
    },
    providedInterfaces: [],
    bindingRefs: [],
    regions: ["test"],
    portability: {
      api: "portable",
      exportFormats: [FORMAT],
      importFormats: [FORMAT],
      migrationModes: ["offline"],
    },
    isolation: "dedicated-resource",
    available: true,
  };
}

function fixture(
  options: {
    attachments?: readonly string[];
    rebindings?: readonly AttachmentRebinding[];
    verifies?: boolean;
    form?: TakoformV1Alpha3FormRef;
    targetProvider?: (offering: ProviderOffering) => Provider;
    sourceEndpoint?: Partial<ProviderPackDefinition["transferEndpoints"][number]>;
    targetEndpoint?: Partial<ProviderPackDefinition["transferEndpoints"][number]>;
    executionLeaseMilliseconds?: number;
    leaveExecutionLeaseOnFailure?: boolean;
  } = {},
) {
  let current = 1_700_000_000_000;
  const clock = () => new Date(current);
  const database = new Database(":memory:");
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  const deployments = createResourceDeploymentStore(sql, clock);
  const attachmentStore = createAttachmentStore(sql, clock);
  const form = options.form ?? FORM;
  const sourceOffering = providerOffering("database.sqlite.source.standard", form);
  const targetOffering = providerOffering("database.sqlite.target.standard", form);
  const calls: string[] = [];
  const pack = (
    id: string,
    offering: ProviderOffering,
    endpoint: Partial<ProviderPackDefinition["transferEndpoints"][number]> = {},
    provisioner?: Provider,
  ) =>
    createProviderPack({
      id,
      providerType: id,
      provisioners: [provisioner ?? new FakeProvider({ id, offerings: [offering] })],
      attachmentFactories: [],
      transferEndpoints: [
        {
          id: `${id}-transfer`,
          exportFormats: [FORMAT],
          importFormats: [FORMAT],
          migrationModes: ["offline"],
          export: async () => {
            calls.push(`${id}:export`);
            return { transferRef: "transfer:sqlite:one" };
          },
          import: async ({ transferRef }) => {
            calls.push(`${id}:import:${transferRef}`);
          },
          verify: async () => {
            calls.push(`${id}:verify`);
            return {
              schema: options.verifies ?? true,
              rowCounts: options.verifies ?? true,
              checksums: options.verifies ?? true,
              evidenceDigest: `sha256:${"d".repeat(64)}`,
            };
          },
          ...endpoint,
        },
      ],
      credentialIssuers: [],
      meterSources: [],
      costEstimators: [],
    });
  const sourcePack = pack("source", sourceOffering, options.sourceEndpoint);
  const targetPack = pack(
    "target",
    targetOffering,
    options.targetEndpoint,
    options.targetProvider?.(targetOffering),
  );
  const catalog = createCatalog([
    sold(sourceOffering.id, "source", "source.primary", form),
    sold(targetOffering.id, "target", "target.primary", form),
  ]);
  const store = createResourceMigrationStore(sql, clock);
  const effects = createTakoformStore(sql, clock);
  const serviceOptions: Parameters<typeof createResourceMigrationService>[0] = {
    store: options.leaveExecutionLeaseOnFailure
      ? { ...store, releaseExecution: async () => false }
      : store,
    deployments,
    catalog,
    packs: [sourcePack, targetPack],
    resource: async (tenantId, uid) =>
      tenantId === "org_1" && uid === "uid_main"
        ? { uid, form, space: "default", name: "main", spec: { sizeGiB: 10 } }
        : null,
    attachments: {
      blocksDeletion: async (tenantId, uid) => [
        ...(await attachmentStore.blocking(tenantId, uid)),
        ...(options.attachments ?? []),
      ],
      prepareMigrationRebindings: async () => {
        if (options.rebindings) return options.rebindings;
        if ((options.attachments?.length ?? 0) > 0) throw new Error("cannot rebind fixture");
        return [];
      },
    },
    clock,
    rollbackWindowMilliseconds: 60_000,
    sleep: async () => undefined,
    ...(options.executionLeaseMilliseconds === undefined
      ? {}
      : { executionLeaseMilliseconds: options.executionLeaseMilliseconds }),
    effects,
  };
  const createService = () => createResourceMigrationService(serviceOptions);
  const service = createService();
  return {
    service,
    restart: createService,
    store,
    effects,
    sql,
    deployments,
    attachmentStore,
    calls,
    advance(milliseconds: number) {
      current += milliseconds;
    },
  };
}

function migrationProvider(
  offering: ProviderOffering,
  apply: (input: ApplyInput) => Promise<ProviderTicket>,
  poll?: Provider["poll"],
): Provider {
  return {
    id: "target",
    offerings: [offering],
    apply,
    ...(poll ? { poll } : {}),
    observe: async (input) =>
      succeeded({
        nativeId: input.nativeId,
        observed: structuredClone(input.spec),
        outputs: {},
      }),
    delete: async (input) =>
      succeeded({
        nativeId: input.nativeId,
        observed: { deleted: true },
        outputs: {},
      }),
  };
}

function pendingGate(): {
  readonly entered: Promise<void>;
  readonly wait: Promise<void>;
  readonly signal: () => void;
  readonly release: () => void;
} {
  let signal!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      signal = resolve;
    }),
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    signal: () => signal(),
    release: () => release(),
  };
}

async function source(deployments: ReturnType<typeof createResourceDeploymentStore>) {
  await deployments.create({
    tenantId: "org_1",
    id: "dep_source",
    resourceUid: "uid_main",
    offeringId: "database.sqlite.source.standard",
    providerPackRef: "source",
    providerInstallationRef: "source.primary",
    nativeId: "source:main",
    state: "active",
    observed: {},
    outputs: {},
  });
}

const PLAN = {
  tenantId: "org_1",
  id: "mig_main_to_target",
  resourceUid: "uid_main",
  targetOfferingId: "database.sqlite.target.standard",
  commercialAuthorizationRef: "reservation_migration_1",
  commercialTenantRef: "tenant_main",
  mode: "offline" as const,
  transferFormat: FORMAT,
};

describe("Resource Migration", () => {
  test("rejects source catalog or installation drift before any provider call", async () => {
    let providerCalls = 0;
    const { service, deployments, sql, calls } = fixture({
      targetProvider: (offering) =>
        migrationProvider(offering, async (input) => {
          providerCalls += 1;
          return succeeded({
            nativeId: "target:drift",
            observed: structuredClone(input.spec),
            outputs: {},
          });
        }),
    });
    await source(deployments);
    await sql.run(
      `UPDATE tf_resource_deployments
       SET provider_installation_ref = 'source.replaced'
       WHERE tenant_id = 'org_1' AND id = 'dep_source'`,
    );

    await expect(service.plan(PLAN)).rejects.toMatchObject({ code: "offering_invalid" });
    expect(providerCalls).toBe(0);
    expect(calls).toEqual([]);
  });

  test("admits exactly one provider operation and candidate under concurrent execution", async () => {
    const gate = pendingGate();
    let providerOperations = 0;
    const { service, deployments } = fixture({
      targetProvider: (offering) =>
        migrationProvider(offering, async (input) => {
          providerOperations += 1;
          if (providerOperations === 1) {
            gate.signal();
            await gate.wait;
          }
          return succeeded({
            nativeId: "target:main",
            observed: structuredClone(input.spec),
            outputs: {},
          });
        }),
    });
    await source(deployments);
    await service.plan(PLAN);

    const first = service.execute("org_1", PLAN.id);
    await gate.entered;
    const second = service.execute("org_1", PLAN.id);
    const [secondOutcome] = await Promise.allSettled([second]);
    gate.release();
    const [firstOutcome] = await Promise.allSettled([first]);
    const outcomes = [firstOutcome, secondOutcome];

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
    const conflict = outcomes.find((outcome) => outcome.status === "rejected");
    expect(conflict?.status === "rejected" ? conflict.reason : undefined).toMatchObject({
      code: "migration_conflict",
    });
    expect(providerOperations).toBe(1);
    expect(
      (await deployments.forResource("org_1", "uid_main")).filter(
        (deployment) => deployment.id === `dep_${PLAN.id}_target`,
      ),
    ).toHaveLength(1);
  });

  test("fails closed when a WorkerVersion apply acknowledgement is lost without a handle", async () => {
    const operationModes: Array<"initial" | "recovery" | undefined> = [];
    let providerMutations = 0;
    const { service, deployments, effects, advance } = fixture({
      form: WORKER_VERSION_FORM,
      executionLeaseMilliseconds: 1_000,
      leaveExecutionLeaseOnFailure: true,
      targetProvider: (offering) =>
        migrationProvider(offering, async (input) => {
          operationModes.push(input.operationMode);
          if (input.operationMode === "initial") {
            providerMutations += 1;
            throw new Error("provider applied but its acknowledgement was lost");
          }
          return succeeded({
            nativeId: "version:script-name:version-one",
            observed: structuredClone(input.spec),
            outputs: { versionId: "version-one" },
          });
        }),
    });
    await source(deployments);
    await service.plan(PLAN);

    await expect(service.execute("org_1", PLAN.id)).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    await expect(service.execute("org_1", PLAN.id)).rejects.toMatchObject({
      code: "migration_conflict",
    });
    advance(1_001);
    await expect(service.execute("org_1", PLAN.id)).rejects.toMatchObject({
      code: "recovery_required",
    });

    expect(operationModes).toEqual(["initial"]);
    expect(providerMutations).toBe(1);
    expect(
      (await effects.readResourceEffectLedger("org_1", "uid_main"))
        .filter((effect) => effect.operationId === `${PLAN.id}:provision`)
        .map((effect) => effect.phase)
        .sort(
          (left, right) =>
            ["planned", "dispatched", "succeeded", "cancelled"].indexOf(left) -
            ["planned", "dispatched", "succeeded", "cancelled"].indexOf(right),
        ),
    ).toEqual(["planned", "dispatched"]);
    expect(
      (await deployments.forResource("org_1", "uid_main")).filter(
        (deployment) => deployment.id === `dep_${PLAN.id}_target`,
      ),
    ).toHaveLength(0);
  });

  test("resumes a persisted provider handle by polling instead of applying again", async () => {
    let applyCalls = 0;
    let pollCalls = 0;
    const { service, deployments } = fixture({
      targetProvider: (offering) =>
        migrationProvider(
          offering,
          async (input) => {
            applyCalls += 1;
            expect(input.operationMode).toBe("initial");
            return running("provision-handle", 0);
          },
          async (input) => {
            pollCalls += 1;
            expect(input).toEqual({
              operationId: `${PLAN.id}:provision`,
              handle: "provision-handle",
            });
            if (pollCalls === 1) throw new Error("poll acknowledgement was lost");
            return succeeded({
              nativeId: "target:main",
              observed: { sizeGiB: 10 },
              outputs: {},
            });
          },
        ),
    });
    await source(deployments);
    await service.plan(PLAN);

    await expect(service.execute("org_1", PLAN.id)).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    expect((await service.execute("org_1", PLAN.id)).state).toBe("verified");
    expect(applyCalls).toBe(1);
    expect(pollCalls).toBe(2);
  });

  test("adopts an export whose acknowledgement was lost without exporting again after restart", async () => {
    let providerMutations = 0;
    const operationModes: Array<"initial" | "recovery"> = [];
    const { service, restart, deployments } = fixture({
      sourceEndpoint: {
        export: async ({ operationMode }) => {
          operationModes.push(operationMode);
          providerMutations += 1;
          throw new Error("provider exported data but its acknowledgement was lost");
        },
        recoverExport: async ({ operationMode, handle }) => {
          operationModes.push(operationMode);
          expect(handle).toBeUndefined();
          return {
            phase: "succeeded",
            receipt: { transferRef: "transfer:durable:one" },
          };
        },
      },
    });
    await source(deployments);
    await service.plan(PLAN);

    await expect(service.execute("org_1", PLAN.id)).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    expect((await restart().execute("org_1", PLAN.id)).state).toBe("verified");
    expect(providerMutations).toBe(1);
    expect(operationModes).toEqual(["initial", "recovery"]);
  });

  test("adopts an import whose acknowledgement was lost without mutating again after restart", async () => {
    let exports = 0;
    let providerMutations = 0;
    const operationModes: Array<"initial" | "recovery"> = [];
    const { service, restart, deployments } = fixture({
      sourceEndpoint: {
        export: async () => {
          exports += 1;
          return { transferRef: "transfer:durable:one" };
        },
      },
      targetEndpoint: {
        import: async ({ transferRef, operationMode }) => {
          operationModes.push(operationMode);
          providerMutations += 1;
          expect(transferRef).toBe("transfer:durable:one");
          throw new Error("provider imported data but its acknowledgement was lost");
        },
        recoverImport: async ({ transferRef, operationMode, handle }) => {
          operationModes.push(operationMode);
          expect(transferRef).toBe("transfer:durable:one");
          expect(handle).toBeUndefined();
          return { phase: "succeeded", receipt: {} };
        },
      },
    });
    await source(deployments);
    await service.plan(PLAN);

    await expect(service.execute("org_1", PLAN.id)).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    expect((await restart().execute("org_1", PLAN.id)).state).toBe("verified");
    expect(exports).toBe(1);
    expect(providerMutations).toBe(1);
    expect(operationModes).toEqual(["initial", "recovery"]);
  });

  test("adopts verification whose acknowledgement was lost without starting it again", async () => {
    let providerOperations = 0;
    const operationModes: Array<"initial" | "recovery"> = [];
    const { service, restart, deployments } = fixture({
      targetEndpoint: {
        verify: async ({ operationMode }) => {
          operationModes.push(operationMode);
          providerOperations += 1;
          throw new Error("provider verified data but its acknowledgement was lost");
        },
        recoverVerify: async ({ operationMode, handle }) => {
          operationModes.push(operationMode);
          expect(handle).toBeUndefined();
          return {
            phase: "succeeded",
            receipt: {
              schema: true,
              rowCounts: true,
              checksums: true,
              evidenceDigest: `sha256:${"d".repeat(64)}`,
            },
          };
        },
      },
    });
    await source(deployments);
    await service.plan(PLAN);

    await expect(service.execute("org_1", PLAN.id)).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    expect((await restart().execute("org_1", PLAN.id)).state).toBe("verified");
    expect(providerOperations).toBe(1);
    expect(operationModes).toEqual(["initial", "recovery"]);
  });

  test("lets recovery finish a long import while the expired executor stays fenced", async () => {
    const gate = pendingGate();
    let providerMutations = 0;
    let recoveries = 0;
    const operationModes: Array<"initial" | "recovery"> = [];
    const { service, restart, deployments, advance } = fixture({
      executionLeaseMilliseconds: 1_000,
      targetEndpoint: {
        import: async ({ operationMode }) => {
          operationModes.push(operationMode);
          providerMutations += 1;
          gate.signal();
          await gate.wait;
          return { phase: "succeeded", receipt: { receiptRef: "stale-ack" } };
        },
        recoverImport: async ({ operationMode }) => {
          operationModes.push(operationMode);
          recoveries += 1;
          return { phase: "succeeded", receipt: { receiptRef: "recovered-ack" } };
        },
      },
    });
    await source(deployments);
    await service.plan(PLAN);

    const staleExecutor = service.execute("org_1", PLAN.id);
    await gate.entered;
    advance(1_001);
    const recovered = await restart().execute("org_1", PLAN.id);
    gate.release();

    await expect(staleExecutor).rejects.toMatchObject({ code: "migration_conflict" });
    expect(recovered.state).toBe("verified");
    expect((await restart().execute("org_1", PLAN.id)).state).toBe("verified");
    expect(providerMutations).toBe(1);
    expect(recoveries).toBe(1);
    expect(operationModes).toEqual(["initial", "recovery"]);
  });

  test("requires explicit recovery when an import endpoint cannot observe or adopt", async () => {
    let providerMutations = 0;
    const { service, restart, deployments } = fixture({
      targetEndpoint: {
        import: async () => {
          providerMutations += 1;
          throw new Error("provider imported data but returned no acknowledgement");
        },
      },
    });
    await source(deployments);
    await service.plan(PLAN);

    await expect(service.execute("org_1", PLAN.id)).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    await expect(restart().execute("org_1", PLAN.id)).rejects.toMatchObject({
      code: "recovery_required",
    });
    await expect(restart().execute("org_1", PLAN.id)).rejects.toMatchObject({
      code: "recovery_required",
    });
    expect(providerMutations).toBe(1);
  });

  test("polls a persisted import handle after the executor restarts", async () => {
    let providerMutations = 0;
    let recoveryPolls = 0;
    const { service, restart, deployments } = fixture({
      targetEndpoint: {
        import: async ({ operationMode }) => {
          expect(operationMode).toBe("initial");
          providerMutations += 1;
          return { phase: "running", handle: "import-handle-one", pollAfterMs: 0 };
        },
        recoverImport: async ({ operationMode, handle }) => {
          expect(operationMode).toBe("recovery");
          expect(handle).toBe("import-handle-one");
          recoveryPolls += 1;
          if (recoveryPolls === 1) throw new Error("status acknowledgement was lost");
          return { phase: "succeeded", receipt: { receiptRef: "import-receipt-one" } };
        },
      },
    });
    await source(deployments);
    await service.plan(PLAN);

    await expect(service.execute("org_1", PLAN.id)).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    expect((await restart().execute("org_1", PLAN.id)).state).toBe("verified");
    expect(providerMutations).toBe(1);
    expect(recoveryPolls).toBe(2);
  });

  test("creates a candidate, verifies data, cuts over, and retains the source", async () => {
    const { service, deployments, calls } = fixture();
    await source(deployments);

    expect((await service.plan(PLAN)).state).toBe("planned");
    const verified = await service.execute("org_1", PLAN.id);
    expect(verified.state).toBe("verified");
    expect(verified.verification).toMatchObject({
      schema: true,
      rowCounts: true,
      checksums: true,
    });
    expect(calls).toEqual(["source:export", "target:import:transfer:sqlite:one", "target:verify"]);
    expect((await deployments.find("org_1", verified.targetDeploymentId))?.state).toBe("candidate");

    expect((await service.cutover("org_1", PLAN.id)).state).toBe("completed");
    expect((await deployments.active("org_1", "uid_main"))?.id).toBe(verified.targetDeploymentId);
    expect((await deployments.find("org_1", "dep_source"))?.state).toBe("retained");
  });

  test("rolls back inside the window without changing logical Resource identity", async () => {
    const { service, deployments } = fixture();
    await source(deployments);
    await service.plan(PLAN);
    await service.execute("org_1", PLAN.id);
    await service.cutover("org_1", PLAN.id);

    expect((await service.rollback("org_1", PLAN.id)).state).toBe("rolled_back");
    expect((await deployments.active("org_1", "uid_main"))?.id).toBe("dep_source");
  });

  test("atomically re-resolves Attachments at cutover and restores them on rollback", async () => {
    const rebindings: readonly AttachmentRebinding[] = [
      {
        id: "att_api_main_db",
        oldProviderDeploymentId: "dep_source",
        oldConsumerDeploymentId: "dep_api",
        oldResolution: { kind: "endpoint-ref", ref: "endpoint:source" },
        newProviderDeploymentId: "dep_mig_main_to_target_target",
        newConsumerDeploymentId: "dep_api",
        newResolution: { kind: "endpoint-ref", ref: "endpoint:target" },
      },
    ];
    const { service, deployments, attachmentStore } = fixture({ rebindings });
    await source(deployments);
    await deployments.create({
      tenantId: "org_1",
      id: "dep_api",
      resourceUid: "uid_api",
      offeringId: "compute.vm.standard",
      providerPackRef: "compute",
      providerInstallationRef: "compute.primary",
      nativeId: "vm:api",
      state: "active",
      observed: {},
      outputs: {},
    });
    await attachmentStore.create({
      tenantId: "org_1",
      id: "att_api_main_db",
      consumerResourceUid: "uid_api",
      providerResourceUid: "uid_main",
      interfaceRef: {
        apiVersion: "interfaces.takoform.com/v1alpha1",
        name: "sql.sqlite.takoform.com",
        version: "1.0.0",
        schemaDigest: `sha256:${"e".repeat(64)}`,
      },
      target: "DATABASE",
      permissions: ["query"],
      state: "active",
      providerDeploymentId: "dep_source",
      consumerDeploymentId: "dep_api",
      resolution: { kind: "endpoint-ref", ref: "endpoint:source" },
      createdAt: new Date(1_700_000_000_000).toISOString(),
      updatedAt: new Date(1_700_000_000_000).toISOString(),
    });

    await service.plan(PLAN);
    await service.execute("org_1", PLAN.id);
    const completed = await service.cutover("org_1", PLAN.id);
    expect(completed.attachmentRebindings).toEqual(rebindings);
    expect(await attachmentStore.read("org_1", "att_api_main_db")).toMatchObject({
      providerDeploymentId: "dep_mig_main_to_target_target",
      resolution: { kind: "endpoint-ref", ref: "endpoint:target" },
    });

    await service.rollback("org_1", PLAN.id);
    expect(await attachmentStore.read("org_1", "att_api_main_db")).toMatchObject({
      providerDeploymentId: "dep_source",
      resolution: { kind: "endpoint-ref", ref: "endpoint:source" },
    });
  });

  test("does not cut over attached resources until bindings are re-resolved", async () => {
    const { service, deployments } = fixture({ attachments: ["att_api_main"] });
    await source(deployments);
    await service.plan(PLAN);
    await service.execute("org_1", PLAN.id);

    await expect(service.cutover("org_1", PLAN.id)).rejects.toMatchObject({
      code: "attachment_rebind_required",
    });
    expect((await deployments.active("org_1", "uid_main"))?.id).toBe("dep_source");
  });

  test("keeps the source active when verification fails", async () => {
    const { service, deployments } = fixture({ verifies: false });
    await source(deployments);
    await service.plan(PLAN);

    await expect(service.execute("org_1", PLAN.id)).rejects.toMatchObject({
      code: "verification_failed",
    });
    expect((await deployments.active("org_1", "uid_main"))?.id).toBe("dep_source");
  });

  test("cancels a plan without creating provider capacity", async () => {
    const { service, deployments } = fixture();
    await source(deployments);
    await service.plan(PLAN);

    expect((await service.cancel("org_1", PLAN.id)).state).toBe("failed");
    expect((await service.cancel("org_1", PLAN.id)).state).toBe("failed");
    expect(await deployments.find("org_1", `dep_${PLAN.id}_target`)).toBeNull();
    expect((await deployments.active("org_1", "uid_main"))?.id).toBe("dep_source");
  });

  test("deletes a verified candidate before cancelling the Migration", async () => {
    const { service, deployments } = fixture();
    await source(deployments);
    await service.plan(PLAN);
    const verified = await service.execute("org_1", PLAN.id);

    expect((await service.cancel("org_1", PLAN.id)).state).toBe("failed");
    expect((await deployments.find("org_1", verified.targetDeploymentId))?.state).toBe("deleted");
    expect((await deployments.active("org_1", "uid_main"))?.id).toBe("dep_source");
  });

  test("persists a cancellation delete handle and retries by polling after a lost acknowledgement", async () => {
    let deleteCalls = 0;
    let pollCalls = 0;
    let losePollAcknowledgement = true;
    const { service, restart, deployments } = fixture({
      targetProvider: (offering) => ({
        ...migrationProvider(
          offering,
          async (input) =>
            succeeded({
              nativeId: "target:main",
              observed: structuredClone(input.spec),
              outputs: {},
            }),
          async ({ operationId, handle }) => {
            if (operationId !== `${PLAN.id}:cancel-target`) {
              return succeeded({ nativeId: "target:main", observed: { sizeGiB: 10 }, outputs: {} });
            }
            expect(handle).toBe("delete-handle");
            pollCalls += 1;
            if (losePollAcknowledgement) {
              losePollAcknowledgement = false;
              throw new Error("delete poll acknowledgement was lost");
            }
            return succeeded({
              nativeId: "target:main",
              observed: { deleted: true },
              outputs: {},
            });
          },
        ),
        async delete(input) {
          deleteCalls += 1;
          expect(input.operationMode).toBe("initial");
          return running("delete-handle", 0);
        },
      }),
    });
    await source(deployments);
    await service.plan(PLAN);
    await service.execute("org_1", PLAN.id);

    await expect(service.cancel("org_1", PLAN.id)).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    const recovered = await restart().cancel("org_1", PLAN.id);
    // The restarted service polls the durable handle and then performs the
    // guarded candidate/migration transition.
    expect(recovered?.state).toBe("failed");
    expect(deleteCalls).toBe(1);
    expect(pollCalls).toBe(2);
    expect((await deployments.find("org_1", `dep_${PLAN.id}_target`))?.state).toBe("deleted");
  });

  test("fails closed on a cancellation dispatch acknowledgement gap", async () => {
    let deleteCalls = 0;
    const { service, restart, deployments } = fixture({
      targetProvider: (offering) => ({
        ...migrationProvider(offering, async (input) =>
          succeeded({
            nativeId: "target:main",
            observed: structuredClone(input.spec),
            outputs: {},
          }),
        ),
        async delete() {
          deleteCalls += 1;
          throw new Error("delete response lost after dispatch");
        },
      }),
    });
    await source(deployments);
    await service.plan(PLAN);
    await service.execute("org_1", PLAN.id);

    await expect(service.cancel("org_1", PLAN.id)).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    await expect(restart().cancel("org_1", PLAN.id)).rejects.toMatchObject({
      code: "recovery_required",
    });
    expect(deleteCalls).toBe(1);
    expect((await deployments.find("org_1", `dep_${PLAN.id}_target`))?.state).toBe("candidate");
  });

  test("recovers a lost cancellation acknowledgement by readback without a second DELETE", async () => {
    let deleteCalls = 0;
    let recoverCalls = 0;
    let absent = false;
    const { service, restart, deployments } = fixture({
      targetProvider: (offering) => ({
        ...migrationProvider(offering, async (input) =>
          succeeded({
            nativeId: "target:main",
            observed: structuredClone(input.spec),
            outputs: {},
          }),
        ),
        async delete() {
          deleteCalls += 1;
          absent = true;
          throw new Error("delete response lost after provider commit");
        },
        async recoverDelete(input) {
          recoverCalls += 1;
          expect(input.operationMode).toBe("recovery");
          expect(input.providerHandle).toBeUndefined();
          return absent
            ? succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} })
            : running("unexpected", 0);
        },
      }),
    });
    await source(deployments);
    await service.plan(PLAN);
    await service.execute("org_1", PLAN.id);

    await expect(service.cancel("org_1", PLAN.id)).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    const recovered = await restart().cancel("org_1", PLAN.id);
    expect(recovered.state).toBe("failed");
    expect(deleteCalls).toBe(1);
    expect(recoverCalls).toBe(1);
    expect((await deployments.find("org_1", `dep_${PLAN.id}_target`))?.state).toBe("deleted");
  });

  test("fences cancellation behind an executor's live migration lease", async () => {
    const gate = pendingGate();
    const { service, deployments } = fixture({
      targetProvider: (offering) =>
        migrationProvider(offering, async (input) => {
          gate.signal();
          await gate.wait;
          return succeeded({
            nativeId: "target:main",
            observed: structuredClone(input.spec),
            outputs: {},
          });
        }),
    });
    await source(deployments);
    await service.plan(PLAN);
    const executing = service.execute("org_1", PLAN.id);
    await gate.entered;
    await expect(service.cancel("org_1", PLAN.id)).rejects.toMatchObject({
      code: "migration_conflict",
    });
    gate.release();
    await executing;
  });

  test("does not cancel a Migration after cutover", async () => {
    const { service, deployments } = fixture();
    await source(deployments);
    await service.plan(PLAN);
    await service.execute("org_1", PLAN.id);
    await service.cutover("org_1", PLAN.id);

    await expect(service.cancel("org_1", PLAN.id)).rejects.toMatchObject({
      code: "migration_conflict",
    });
  });

  test("rejects malformed persisted verification and Attachment rebinding evidence", async () => {
    const { service, deployments, sql } = fixture();
    await source(deployments);
    await service.plan(PLAN);

    await sql.run(
      `UPDATE tf_resource_migrations
       SET verification_json = ?, attachment_rebindings_json = ?
       WHERE tenant_id = ? AND id = ?`,
      [
        JSON.stringify({
          schema: true,
          rowCounts: true,
          checksums: true,
          evidenceDigest: "not-a-digest",
        }),
        JSON.stringify([
          {
            id: "att_main",
            oldProviderDeploymentId: "dep_source",
            oldConsumerDeploymentId: "dep_api",
            oldResolution: { kind: "endpoint-ref", ref: "endpoint:source" },
            newProviderDeploymentId: "dep_target",
            newConsumerDeploymentId: "dep_api",
            newResolution: { kind: "endpoint-ref", ref: "endpoint:target" },
            injected: true,
          },
        ]),
        "org_1",
        PLAN.id,
      ],
    );

    await expect(service.read("org_1", PLAN.id)).rejects.toThrow("resource_migration_row_invalid");
  });

  test("rejects malformed persisted migration execution evidence", async () => {
    const { service, deployments, sql } = fixture();
    await source(deployments);
    await service.plan(PLAN);

    await sql.run(
      `UPDATE tf_resource_migrations
       SET execution_json = ?
       WHERE tenant_id = ? AND id = ?`,
      [
        JSON.stringify({
          provision: {
            phase: "running",
            handle: "opaque-handle",
            pollAfterMs: 1_000,
            injected: true,
          },
        }),
        "org_1",
        PLAN.id,
      ],
    );

    await expect(service.read("org_1", PLAN.id)).rejects.toThrow("resource_migration_row_invalid");
  });
});
