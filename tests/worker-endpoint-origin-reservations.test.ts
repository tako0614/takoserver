import { expect, test } from "bun:test";
import type { TakoformV1Alpha3FormRef } from "../src/form-ref.ts";
import { STABLE_PRODUCTION_TAKOFORM_CATALOG } from "../src/generated/takoform-stable-v1-catalog.ts";
import {
  createCatalog,
  createEphemeralSql,
  createResourceDeploymentStore,
  createRuntimeInputAuthority,
  createWorkerEndpointOriginReservations,
  deriveRuntimeInputReference,
  type Offering,
} from "../src/index.ts";
import type { Provider, ProviderOffering } from "../src/provider-port.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { createTakoformStore } from "../src/takoform/store.ts";
import { createWorkerEndpointOriginReservationBindingHandle } from "../src/worker-endpoint-origin-reservations.ts";

const FORM = (() => {
  const form = STABLE_PRODUCTION_TAKOFORM_CATALOG.forms.find(
    (candidate) => candidate.identity.formRef.kind === "ModuleWorker",
  )?.identity.formRef;
  if (!form) throw new Error("ModuleWorker Form missing");
  return form;
})();
const ENDPOINT_FORM = (() => {
  const form = STABLE_PRODUCTION_TAKOFORM_CATALOG.forms.find(
    (candidate) => candidate.identity.formRef.kind === "WorkerEndpoint",
  )?.identity.formRef;
  if (!form) throw new Error("WorkerEndpoint Form missing");
  return form;
})();

const TARGET = { space: "default", workerName: "community", endpointName: "public" } as const;

test("connects the narrow runtime binding authority exactly once and fails closed before it", async () => {
  const handle = createWorkerEndpointOriginReservationBindingHandle();
  const input = {
    organizationId: "org_01",
    reservationId: "reservation_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  } as const;
  await expect(handle.port.inspectBound(input)).rejects.toMatchObject({
    code: "backend_unavailable",
    status: 503,
  });

  const projection = {
    organizationId: "org_01",
    reservationId: "reservation_01",
    canonicalPublicOrigin: "https://org_01-default-community.workers.test",
    revision: "2",
    expiresAtEpochMilliseconds: Date.parse("2026-08-31T12:10:00.000Z"),
    target: TARGET,
    status: "bound",
    workerResourceUid: "uid-worker-01",
    workerResourceRevision: "1",
    providerPackRef: "fake",
    providerInstallationRef: "fake.primary",
    offeringId: "worker.module.test",
    offeringDigest: `sha256:${"0".repeat(64)}`,
  } as const;
  const authority = {
    async bind() {
      return projection;
    },
    async inspectBound() {
      return projection;
    },
  };
  handle.connect(authority);
  expect(await handle.port.inspectBound(input)).toEqual(projection);
  expect(() => handle.connect(authority)).toThrow("already connected");
});

function sold(id = "worker.module.test"): Offering {
  return {
    id,
    providerPackRef: "fake",
    providerInstallationRef: "fake.primary",
    supplyContractRef: "fake.contract",
    pricePlanRef: `${id}.price`,
    resourceClass: "worker.module",
    deliveryMode: "managed-endpoint",
    supportPolicyRef: "support:test",
    abusePolicyRef: "abuse:test",
    kind: "ModuleWorker",
    displayName: "Module Worker",
    form: FORM,
    pricePlan: {
      id: `${id}.price`,
      currency: "USD",
      provisioning: { meter: "resource.create", amountMinor: 0 },
      meters: [],
    },
    providedInterfaces: [],
    bindingRefs: [],
    regions: [],
    portability: {
      api: "portable",
      exportFormats: [],
      importFormats: [],
      migrationModes: ["offline"],
    },
    isolation: "shared-resource",
    available: true,
  };
}

function technical(id = "worker.module.test"): ProviderOffering {
  return {
    id,
    kind: "ModuleWorker",
    displayName: "Module Worker",
    form: FORM,
    providedInterfaces: [],
    bindingRefs: [],
    capabilities: ["create", "delete", "observe"],
  };
}

function fixture(
  input: {
    readonly offerings?: readonly Offering[];
    readonly technical?: readonly ProviderOffering[];
    readonly fixedOrigin?: string;
  } = {},
) {
  const sql = createEphemeralSql();
  let current = new Date("2026-08-31T12:00:00.000Z");
  const base = new FakeProvider({ id: "fake", offerings: input.technical ?? [technical()] });
  const provider = Object.assign(base, {
    workerEndpointOriginReservations: {
      async derive({ identity }: { identity: { tenantRef: string; space: string; name: string } }) {
        return {
          canonicalPublicOrigin:
            input.fixedOrigin ??
            `https://${identity.tenantRef}-${identity.space}-${identity.name}.workers.test`,
        };
      },
    },
  }) satisfies Provider;
  const authority = createWorkerEndpointOriginReservations({
    sql,
    clock: () => current,
    catalog: createCatalog(input.offerings ?? [sold()]),
    providers: [provider],
    resources: createTakoformStore(sql, () => current),
    deployments: createResourceDeploymentStore(sql, () => current),
  });
  return {
    sql,
    authority,
    advance(milliseconds: number) {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

test("reserves one exact future Worker endpoint origin and replays only the exact request", async () => {
  const { authority, sql } = fixture();
  const input = {
    organizationId: "org_01",
    reservationId: "reservation_01",
    target: TARGET,
    expiresInSeconds: 600,
  } as const;
  const prepared = await authority.prepare(input);
  expect(prepared).toEqual({
    format: "takoserver.worker-endpoint-origin-reservation.v1",
    reservationId: "reservation_01",
    canonicalPublicOrigin: "https://org_01-default-community.workers.test",
    revision: "1",
    expiresAt: "2026-08-31T12:10:00.000Z",
    target: TARGET,
    status: "prepared",
  });
  expect(await authority.prepare(input)).toEqual(prepared);
  await expect(
    authority.prepare({ ...input, target: { ...TARGET, endpointName: "other" } }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });

  expect(
    await sql.query(
      "SELECT provider_pack_ref, provider_installation_ref, offering_id FROM worker_endpoint_origin_reservations",
    ),
  ).toEqual([
    {
      provider_pack_ref: "fake",
      provider_installation_ref: "fake.primary",
      offering_id: "worker.module.test",
    },
  ]);
});

test("requires an explicit offering when more than one ModuleWorker offering is eligible", async () => {
  const second = sold("worker.module.other");
  const { authority } = fixture({
    offerings: [sold(), second],
    technical: [technical(), technical(second.id)],
  });
  const input = {
    organizationId: "org_01",
    reservationId: "reservation_01",
    target: TARGET,
    expiresInSeconds: 600,
  } as const;
  await expect(authority.prepare(input)).rejects.toMatchObject({
    code: "unsupported_capability",
    status: 422,
  });
  expect(await authority.prepare({ ...input, offeringId: second.id })).toMatchObject({
    status: "prepared",
  });
});

test("fences both the logical worker and canonical origin to one live reservation", async () => {
  const logical = fixture();
  await logical.authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    target: TARGET,
    expiresInSeconds: 600,
  });
  await expect(
    logical.authority.prepare({
      organizationId: "org_01",
      reservationId: "reservation_02",
      target: { ...TARGET, endpointName: "other" },
      expiresInSeconds: 600,
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });

  const origin = fixture({ fixedOrigin: "https://one.workers.test" });
  await origin.authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    target: TARGET,
    expiresInSeconds: 600,
  });
  await expect(
    origin.authority.prepare({
      organizationId: "org_02",
      reservationId: "reservation_02",
      target: { ...TARGET, workerName: "another" },
      expiresInSeconds: 600,
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
});

test("expires a value-free reservation and releases its logical/origin ownership", async () => {
  const { authority, advance } = fixture();
  await authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    target: TARGET,
    expiresInSeconds: 60,
  });
  advance(60_001);
  expect(
    await authority.prepare({
      organizationId: "org_01",
      reservationId: "reservation_02",
      target: TARGET,
      expiresInSeconds: 60,
    }),
  ).toMatchObject({ reservationId: "reservation_02", status: "prepared" });
  expect(await authority.read("org_01", "reservation_01")).toBeNull();
  await expect(
    authority.prepare({
      organizationId: "org_01",
      reservationId: "reservation_01",
      target: TARGET,
      expiresInSeconds: 60,
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
});

test("expiry cannot release an origin retained by a deactivated endpoint", async () => {
  const { authority, sql, advance } = fixture();
  await authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    target: TARGET,
    expiresInSeconds: 60,
  });
  await seedWorker(sql);
  await authority.bind({
    organizationId: "org_01",
    reservationId: "reservation_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  });
  await seedEndpoint(sql, "https://org_01-default-community.workers.test");
  await authority.activate({
    organizationId: "org_01",
    reservationId: "reservation_01",
    endpointResourceUid: "uid-endpoint-01",
  });
  await authority.deactivate({
    organizationId: "org_01",
    reservationId: "reservation_01",
    endpointResourceUid: "uid-endpoint-01",
  });

  advance(60_001);
  expect(await authority.read("org_01", "reservation_01")).toBeNull();
  await expect(
    authority.prepare({
      organizationId: "org_01",
      reservationId: "reservation_02",
      target: TARGET,
      expiresInSeconds: 60,
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
  await expect(authority.release("org_01", "reservation_01")).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  });

  await sql.run("DELETE FROM tf_resources WHERE tenant_id = 'org_01' AND uid = 'uid-endpoint-01'");
  await sql.run(
    "UPDATE tf_resource_deployments SET state = 'deleted' WHERE tenant_id = 'org_01' AND resource_uid = 'uid-endpoint-01'",
  );
  await sql.run(
    "UPDATE tf_resource_deletion_attestations SET state = 'closed' WHERE tenant_id = 'org_01' AND resource_uid = 'uid-endpoint-01'",
  );
  await authority.release("org_01", "reservation_01");
  expect(
    await authority.prepare({
      organizationId: "org_01",
      reservationId: "reservation_02",
      target: TARGET,
      expiresInSeconds: 60,
    }),
  ).toMatchObject({ reservationId: "reservation_02", status: "prepared" });
});

test("binds one exact Ready ModuleWorker and rejects placement or revision drift", async () => {
  const { authority, sql } = fixture();
  await authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    target: TARGET,
    expiresInSeconds: 600,
  });
  await seedWorker(sql);
  const bound = await authority.bind({
    organizationId: "org_01",
    reservationId: "reservation_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  });
  expect(bound).toMatchObject({
    status: "bound",
    workerResourceUid: "uid-worker-01",
    workerResourceRevision: "1",
    providerPackRef: "fake",
    providerInstallationRef: "fake.primary",
    offeringId: "worker.module.test",
  });
  expect(
    await authority.bind({
      organizationId: "org_01",
      reservationId: "reservation_01",
      space: TARGET.space,
      workerName: TARGET.workerName,
      workerResourceUid: "uid-worker-01",
    }),
  ).toEqual(bound);

  await sql.run(
    "UPDATE tf_resources SET revision = '2' WHERE tenant_id = 'org_01' AND uid = 'uid-worker-01'",
  );
  await expect(
    authority.inspectBound({
      organizationId: "org_01",
      reservationId: "reservation_01",
      space: TARGET.space,
      workerName: TARGET.workerName,
      workerResourceUid: "uid-worker-01",
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
});

test("cannot bind a ModuleWorker whose deletion has started", async () => {
  const { authority, sql } = fixture();
  await authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    target: TARGET,
    expiresInSeconds: 600,
  });
  await seedWorker(sql);
  await sql.run(
    "UPDATE tf_resource_deletion_attestations SET state = 'pending' WHERE tenant_id = 'org_01' AND resource_uid = 'uid-worker-01'",
  );
  await expect(
    authority.bind({
      organizationId: "org_01",
      reservationId: "reservation_01",
      space: TARGET.space,
      workerName: TARGET.workerName,
      workerResourceUid: "uid-worker-01",
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
});

test("activates only the stable WorkerEndpoint Form before deletion starts", async () => {
  const nonCanonicalEndpointForm = {
    ...ENDPOINT_FORM,
    definitionVersion: "0.0.0",
    schemaDigest: `sha256:${"9".repeat(64)}` as `sha256:${string}`,
  };
  const wrongForm = fixture();
  await wrongForm.authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    target: TARGET,
    expiresInSeconds: 600,
  });
  await seedWorker(wrongForm.sql);
  await wrongForm.authority.bind({
    organizationId: "org_01",
    reservationId: "reservation_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  });
  await seedEndpoint(
    wrongForm.sql,
    "https://org_01-default-community.workers.test",
    nonCanonicalEndpointForm,
  );
  await expect(
    wrongForm.authority.activate({
      organizationId: "org_01",
      reservationId: "reservation_01",
      endpointResourceUid: "uid-endpoint-01",
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });

  const deleting = fixture();
  await deleting.authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    target: TARGET,
    expiresInSeconds: 600,
  });
  await seedWorker(deleting.sql);
  await deleting.authority.bind({
    organizationId: "org_01",
    reservationId: "reservation_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  });
  await seedEndpoint(deleting.sql, "https://org_01-default-community.workers.test");
  await deleting.sql.run(
    "UPDATE tf_resource_deletion_attestations SET state = 'pending' WHERE tenant_id = 'org_01' AND resource_uid = 'uid-endpoint-01'",
  );
  await expect(
    deleting.authority.activate({
      organizationId: "org_01",
      reservationId: "reservation_01",
      endpointResourceUid: "uid-endpoint-01",
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
});

test("activates only the exact Ready endpoint and retains its deletion witness on deactivation", async () => {
  const { authority, sql } = fixture();
  await authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    target: TARGET,
    expiresInSeconds: 600,
  });
  await seedWorker(sql);
  await authority.bind({
    organizationId: "org_01",
    reservationId: "reservation_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  });
  await seedEndpoint(sql, "https://wrong.workers.test");
  await expect(
    authority.activate({
      organizationId: "org_01",
      reservationId: "reservation_01",
      endpointResourceUid: "uid-endpoint-01",
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });

  await sql.run("DELETE FROM tf_resources WHERE tenant_id = 'org_01' AND uid = 'uid-endpoint-01'");
  await sql.run(
    "DELETE FROM tf_resource_deployments WHERE tenant_id = 'org_01' AND resource_uid = 'uid-endpoint-01'",
  );
  await sql.run(
    "DELETE FROM tf_resource_deletion_attestations WHERE tenant_id = 'org_01' AND resource_uid = 'uid-endpoint-01'",
  );
  await seedEndpoint(sql, "https://org_01-default-community.workers.test");
  expect(
    await authority.activate({
      organizationId: "org_01",
      reservationId: "reservation_01",
      endpointResourceUid: "uid-endpoint-01",
    }),
  ).toMatchObject({ status: "activated", endpointResourceUid: "uid-endpoint-01" });

  const deactivated = await authority.deactivate({
    organizationId: "org_01",
    reservationId: "reservation_01",
    endpointResourceUid: "uid-endpoint-01",
  });
  expect(deactivated).toMatchObject({ status: "bound", endpointResourceUid: "uid-endpoint-01" });
  await expect(authority.release("org_01", "reservation_01")).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  });

  await sql.run("DELETE FROM tf_resources WHERE tenant_id = 'org_01' AND uid = 'uid-endpoint-01'");
  await sql.run(
    "UPDATE tf_resource_deployments SET state = 'deleted' WHERE tenant_id = 'org_01' AND resource_uid = 'uid-endpoint-01'",
  );
  await sql.run(
    "UPDATE tf_resource_deletion_attestations SET state = 'closed' WHERE tenant_id = 'org_01' AND resource_uid = 'uid-endpoint-01'",
  );
  await expect(authority.release("org_01", "reservation_01")).resolves.toBeUndefined();
  expect(await authority.read("org_01", "reservation_01")).toBeNull();
});

test("refuses release while an exact runtime-input claim holds the reservation", async () => {
  const { authority, sql } = fixture();
  await authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    target: TARGET,
    expiresInSeconds: 600,
  });
  await seedWorker(sql);
  await authority.bind({
    organizationId: "org_01",
    reservationId: "reservation_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  });
  const sealKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const bindings = { ENCRYPTION_KEY: "high-entropy-placeholder" };
  const reference = await deriveRuntimeInputReference({
    format: "takoserver.worker-runtime-input-preflight.v1",
    materialSetNonce: "nonce-01",
    target: {
      space: TARGET.space,
      workerName: TARGET.workerName,
      bundleName: "bundle-01",
      endpointName: TARGET.endpointName,
      originReservationId: "reservation_01",
      canonicalPublicOrigin: "https://org_01-default-community.workers.test",
    },
    bindings,
  });
  const runtimeInputs = createRuntimeInputAuthority({
    sql,
    sealKeys: { current: { keyId: "test-seal-key", key: sealKey } },
    originReservations: authority,
    clock: () => new Date("2026-08-31T12:00:00.000Z"),
    randomId: () => "unused",
  });
  const prepared = await runtimeInputs.preparations.prepare({
    organizationId: "org_01",
    operationId: "runtime-operation-01",
    materialSetId: "material-set-01",
    materialSetNonce: "nonce-01",
    runtimeInputReference: reference.runtimeInputReference,
    target: {
      space: TARGET.space,
      workerName: TARGET.workerName,
      workerResourceUid: "uid-worker-01",
      bundleName: "bundle-01",
      originReservationId: "reservation_01",
    },
    bindings,
  });
  const lease = await runtimeInputs.leases.acquire({
    organizationId: "org_01",
    operationId: "worker-version-operation-01",
    resourceUid: "uid-worker-version-01",
    reference: prepared.runtimeInputReference,
    target: {
      space: TARGET.space,
      workerName: TARGET.workerName,
      workerResourceUid: "uid-worker-01",
      bundleName: "bundle-01",
    },
    bindingNames: ["ENCRYPTION_KEY"],
  });
  await expect(authority.release("org_01", "reservation_01")).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  });
  await lease.abort();
  await expect(authority.release("org_01", "reservation_01")).resolves.toBeUndefined();
});

async function seedWorker(sql: ReturnType<typeof createEphemeralSql>): Promise<void> {
  await seedResource(sql, {
    uid: "uid-worker-01",
    kind: "ModuleWorker",
    name: TARGET.workerName,
    form: FORM,
    outputs: {},
    relations: [],
    deployment: {
      id: "deployment-worker-01",
      offeringId: "worker.module.test",
      nativeId: "worker:native-01",
    },
  });
}

async function seedEndpoint(
  sql: ReturnType<typeof createEphemeralSql>,
  origin: string,
  form: TakoformV1Alpha3FormRef = ENDPOINT_FORM,
): Promise<void> {
  const hostname = new URL(origin).hostname;
  await seedResource(sql, {
    uid: "uid-endpoint-01",
    kind: "WorkerEndpoint",
    name: TARGET.endpointName,
    form,
    outputs: { hostname, url: `${origin}/` },
    relations: [
      {
        pointer: "/worker",
        relation: "/worker",
        targetApiVersion: FORM.apiVersion,
        targetKind: "ModuleWorker",
        targetName: TARGET.workerName,
        targetUid: "uid-worker-01",
        targetFormRef: FORM,
      },
    ],
    deployment: {
      id: "deployment-endpoint-01",
      offeringId: "worker.endpoint.test",
      nativeId: "endpoint:native-01",
    },
  });
}

async function seedResource(
  sql: ReturnType<typeof createEphemeralSql>,
  input: {
    readonly uid: string;
    readonly kind: "ModuleWorker" | "WorkerEndpoint";
    readonly name: string;
    readonly form: TakoformV1Alpha3FormRef;
    readonly outputs: Record<string, string>;
    readonly relations: readonly Record<string, unknown>[];
    readonly deployment: {
      readonly id: string;
      readonly offeringId: string;
      readonly nativeId: string;
    };
  },
): Promise<void> {
  const timestamp = Date.parse("2026-08-31T12:00:00.000Z");
  const resource = {
    apiVersion: input.form.apiVersion,
    kind: input.kind,
    form: { formRef: input.form },
    metadata: {
      name: input.name,
      space: TARGET.space,
      uid: input.uid,
      generation: "1",
      revision: "1",
    },
    spec:
      input.kind === "WorkerEndpoint"
        ? {
            worker: {
              apiVersion: FORM.apiVersion,
              kind: "ModuleWorker",
              name: TARGET.workerName,
            },
          }
        : {},
    status: {
      observedGeneration: "1",
      conditions: [
        {
          type: "Ready",
          status: "True",
          reason: "Available",
          lastTransitionTime: "2026-08-31T12:00:00.000Z",
        },
      ],
      outputs: input.outputs,
    },
  };
  await sql.run(
    `INSERT INTO tf_resources
       (tenant_id, space, api_version, kind, name, uid, generation, revision,
        resource_json, relations_json, updated_at)
     VALUES ('org_01', ?, ?, ?, ?, ?, '1', '1', ?, ?, ?)`,
    [
      TARGET.space,
      input.form.apiVersion,
      input.kind,
      input.name,
      input.uid,
      JSON.stringify(resource),
      JSON.stringify(input.relations),
      timestamp,
    ],
  );
  await sql.run(
    `INSERT INTO tf_resource_deployments
       (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
        provider_installation_ref, native_id, native_claimed, state,
        observed_json, outputs_json, created_at, updated_at)
     VALUES ('org_01', ?, ?, ?, 'fake', 'fake.primary', ?, 0, 'active', '{}', '{}', ?, ?)`,
    [
      input.deployment.id,
      input.uid,
      input.deployment.offeringId,
      input.deployment.nativeId,
      timestamp,
      timestamp,
    ],
  );
  await sql.run(
    `INSERT INTO tf_resource_deletion_attestations
       (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
        state, closure_fence, effects_json, evidence_json, evidence_ref,
        evidence_effect_digest, evidence_checked_at, evidence_status, created_at, updated_at)
     VALUES ('org_01', ?, ?, ?, ?, ?, ?, 'live', 1, '[]',
             NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    [
      input.uid,
      TARGET.space,
      input.form.apiVersion,
      input.kind,
      input.name,
      JSON.stringify(input.form),
      timestamp,
      timestamp,
    ],
  );
}
