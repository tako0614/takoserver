import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MIGRATIONS } from "../src/db-schema.ts";
import type { TakoformV1Alpha3FormRef } from "../src/form-ref.ts";
import { STABLE_PRODUCTION_TAKOFORM_CATALOG } from "../src/generated/takoform-stable-v1-catalog.ts";
import {
  createCatalog,
  createResourceDeploymentStore,
  createWorkerEndpointOriginReservations,
  type Offering,
} from "../src/index.ts";
import type { Provider, ProviderOffering } from "../src/provider-port.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
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
const REQUESTED_SUBDOMAIN = "community-public";
const RESERVATION_V2_MIGRATION_NAME = "0035_worker_endpoint_origin_reservation_v2.sql";
const RESERVATION_V2_MIGRATION = readFileSync(
  new URL(`../migrations/${RESERVATION_V2_MIGRATION_NAME}`, import.meta.url),
  "utf8",
);

function createReservationV2Sql() {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS) database.exec(migration.sql);
  if (!MIGRATIONS.some((migration) => migration.name === RESERVATION_V2_MIGRATION_NAME)) {
    database.exec(RESERVATION_V2_MIGRATION);
  }
  return createSqliteSql(database);
}

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
    requestedSubdomain: REQUESTED_SUBDOMAIN,
    canonicalPublicOrigin: "https://community-public.org_01.workers.test",
    revision: "2",
    expiresAtEpochMilliseconds: Date.parse("2026-08-31T12:10:00.000Z"),
    binding: {
      space: TARGET.space,
      workerName: TARGET.workerName,
      workerResourceUid: "uid-worker-01",
      workerResourceRevision: "1",
    },
    status: "bound",
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
    readonly sql?: ReturnType<typeof createReservationV2Sql>;
  } = {},
) {
  const sql = input.sql ?? createReservationV2Sql();
  let current = new Date("2026-08-31T12:00:00.000Z");
  const deriveCalls: { readonly tenantRef: string; readonly requestedSubdomain: string }[] = [];
  const base = new FakeProvider({ id: "fake", offerings: input.technical ?? [technical()] });
  const provider = Object.assign(base, {
    workerEndpointOriginReservations: {
      async derive({
        tenantRef,
        requestedSubdomain,
      }: {
        tenantRef: string;
        requestedSubdomain: string;
      }) {
        deriveCalls.push({ tenantRef, requestedSubdomain });
        return {
          canonicalPublicOrigin:
            input.fixedOrigin ?? `https://${requestedSubdomain}.${tenantRef}.workers.test`,
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
    deriveCalls,
    advance(milliseconds: number) {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

test("reserves one exact future Worker endpoint origin without manufacturing a Resource identity", async () => {
  const { authority, sql, deriveCalls } = fixture();
  const input = {
    organizationId: "org_01",
    reservationId: "reservation_01",
    requestedSubdomain: REQUESTED_SUBDOMAIN,
    expiresInSeconds: 600,
  } as const;
  const prepared = await authority.prepare(input);
  expect(prepared).toEqual({
    format: "takoserver.worker-endpoint-origin-reservation.v2",
    reservationId: "reservation_01",
    requestedSubdomain: REQUESTED_SUBDOMAIN,
    canonicalPublicOrigin: "https://community-public.org_01.workers.test",
    revision: "1",
    expiresAt: "2026-08-31T12:10:00.000Z",
    status: "prepared",
  });
  expect(await authority.prepare(input)).toEqual(prepared);
  await expect(authority.prepare({ ...input, requestedSubdomain: "other" })).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  });
  await expect(authority.prepare({ ...input, expiresInSeconds: 601 })).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  });

  expect(deriveCalls).toEqual([
    { tenantRef: "org_01", requestedSubdomain: REQUESTED_SUBDOMAIN },
    { tenantRef: "org_01", requestedSubdomain: REQUESTED_SUBDOMAIN },
    { tenantRef: "org_01", requestedSubdomain: "other" },
    { tenantRef: "org_01", requestedSubdomain: REQUESTED_SUBDOMAIN },
  ]);
  expect(JSON.stringify(deriveCalls)).not.toMatch(/identity|space|workerName|endpointName/);

  expect(
    await sql.query(
      `SELECT provider_pack_ref, provider_installation_ref, offering_id,
              legacy_space, legacy_worker_name, legacy_endpoint_name,
              bound_space, bound_worker_name, worker_resource_uid, bound_endpoint_name,
              endpoint_resource_uid
       FROM worker_endpoint_origin_reservations`,
    ),
  ).toEqual([
    {
      provider_pack_ref: "fake",
      provider_installation_ref: "fake.primary",
      offering_id: "worker.module.test",
      legacy_space: null,
      legacy_worker_name: null,
      legacy_endpoint_name: null,
      bound_space: null,
      bound_worker_name: null,
      worker_resource_uid: null,
      bound_endpoint_name: null,
      endpoint_resource_uid: null,
    },
  ]);
});

test("accepts exactly one lowercase DNS label", async () => {
  const { authority, deriveCalls } = fixture();
  for (const invalid of [
    "Community",
    "community.public",
    "-community",
    "community-",
    "",
    "a".repeat(64),
  ]) {
    await expect(
      authority.prepare({
        organizationId: "org_01",
        reservationId: `reservation_${deriveCalls.length}`,
        requestedSubdomain: invalid,
        expiresInSeconds: 600,
      }),
    ).rejects.toMatchObject({ code: "invalid_argument", status: 400 });
  }
  expect(deriveCalls).toEqual([]);
  expect(
    await authority.prepare({
      organizationId: "org_01",
      reservationId: "reservation_valid",
      requestedSubdomain: "a".repeat(63),
      expiresInSeconds: 600,
    }),
  ).toMatchObject({ requestedSubdomain: "a".repeat(63), status: "prepared" });
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
    requestedSubdomain: REQUESTED_SUBDOMAIN,
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

test("fences both the requested subdomain and canonical origin to one live reservation", async () => {
  const logical = fixture();
  await logical.authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    requestedSubdomain: REQUESTED_SUBDOMAIN,
    expiresInSeconds: 600,
  });
  await expect(
    logical.authority.prepare({
      organizationId: "org_01",
      reservationId: "reservation_02",
      requestedSubdomain: REQUESTED_SUBDOMAIN,
      expiresInSeconds: 600,
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });

  const origin = fixture({ fixedOrigin: "https://one.workers.test" });
  await origin.authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    requestedSubdomain: REQUESTED_SUBDOMAIN,
    expiresInSeconds: 600,
  });
  await expect(
    origin.authority.prepare({
      organizationId: "org_02",
      reservationId: "reservation_02",
      requestedSubdomain: "another",
      expiresInSeconds: 600,
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
});

test("expires a value-free reservation and releases its logical/origin ownership", async () => {
  const { authority, advance } = fixture();
  await authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    requestedSubdomain: REQUESTED_SUBDOMAIN,
    expiresInSeconds: 60,
  });
  advance(60_001);
  expect(
    await authority.prepare({
      organizationId: "org_01",
      reservationId: "reservation_02",
      requestedSubdomain: REQUESTED_SUBDOMAIN,
      expiresInSeconds: 60,
    }),
  ).toMatchObject({ reservationId: "reservation_02", status: "prepared" });
  expect(await authority.read("org_01", "reservation_01")).toBeNull();
  await expect(
    authority.prepare({
      organizationId: "org_01",
      reservationId: "reservation_01",
      requestedSubdomain: REQUESTED_SUBDOMAIN,
      expiresInSeconds: 60,
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
});

test("fails closed when durable origin state is corrupted", async () => {
  const { authority, sql } = fixture();
  await authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    requestedSubdomain: REQUESTED_SUBDOMAIN,
    expiresInSeconds: 600,
  });
  await sql.run(
    `UPDATE worker_endpoint_origin_reservations
     SET canonical_public_origin = 'http://community-public.workers.test'
     WHERE organization_id = 'org_01' AND reservation_id = 'reservation_01'`,
  );
  await expect(authority.read("org_01", "reservation_01")).rejects.toMatchObject({
    code: "backend_unavailable",
    status: 503,
  });
});

test("expiry cannot release an origin retained by a deactivated endpoint", async () => {
  const { authority, sql, advance } = fixture();
  await authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    requestedSubdomain: REQUESTED_SUBDOMAIN,
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
  await seedEndpoint(sql, "https://community-public.org_01.workers.test");
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
      requestedSubdomain: REQUESTED_SUBDOMAIN,
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
      requestedSubdomain: REQUESTED_SUBDOMAIN,
      expiresInSeconds: 60,
    }),
  ).toMatchObject({ reservationId: "reservation_02", status: "prepared" });
});

test("binds one exact Ready ModuleWorker and rejects placement or revision drift", async () => {
  const { authority, sql } = fixture();
  await authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    requestedSubdomain: REQUESTED_SUBDOMAIN,
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
    requestedSubdomain: REQUESTED_SUBDOMAIN,
    binding: {
      space: TARGET.space,
      workerName: TARGET.workerName,
      workerResourceUid: "uid-worker-01",
      workerResourceRevision: "1",
    },
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

test("CAS-assigns exactly one endpoint, replays it, and fences placement drift", async () => {
  const { authority, sql } = fixture();
  await authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    requestedSubdomain: REQUESTED_SUBDOMAIN,
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
  const base = {
    organizationId: "org_01",
    reservationId: "reservation_01",
    space: TARGET.space,
    endpointResourceRevision: "1",
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
    providerPackRef: "fake",
    providerInstallationRef: "fake.primary",
  } as const;
  const claims = [
    { ...base, endpointName: "public-a", endpointResourceUid: "uid-endpoint-a" },
    { ...base, endpointName: "public-b", endpointResourceUid: "uid-endpoint-b" },
  ] as const;

  const outcomes = await Promise.allSettled(claims.map((claim) => authority.assignEndpoint(claim)));
  expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
  const winnerIndex = outcomes.findIndex(({ status }) => status === "fulfilled");
  const winner = outcomes[winnerIndex];
  if (winner?.status !== "fulfilled" || winnerIndex < 0) {
    throw new Error("one endpoint assignment must win");
  }
  const winningClaim = claims[winnerIndex];
  if (!winningClaim) throw new Error("the winning endpoint claim is missing");
  const losing = outcomes[1 - winnerIndex];
  expect(losing?.status === "rejected" ? losing.reason : null).toMatchObject({
    code: "conflict",
    status: 409,
  });
  expect(winner.value).toMatchObject({
    format: "takoserver.worker-endpoint-origin-assignment.v1",
    canonicalPublicOrigin: "https://community-public.org_01.workers.test",
    endpoint: {
      space: TARGET.space,
      name: claims[winnerIndex]?.endpointName,
      uid: claims[winnerIndex]?.endpointResourceUid,
      revision: "1",
    },
    worker: { name: TARGET.workerName, uid: "uid-worker-01", revision: "1" },
    placement: { providerPackRef: "fake", providerInstallationRef: "fake.primary" },
  });
  expect(winner.value.assignmentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(await authority.assignEndpoint(winningClaim)).toEqual(winner.value);
  await expect(
    authority.assignEndpoint({
      ...winningClaim,
      providerInstallationRef: "fake.drifted",
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
});

test("cancels only an unchanged pre-dispatch assignment and activates exact provider output", async () => {
  const { authority, sql } = fixture();
  await authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    requestedSubdomain: REQUESTED_SUBDOMAIN,
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
  const claim = {
    organizationId: "org_01",
    reservationId: "reservation_01",
    space: TARGET.space,
    endpointName: TARGET.endpointName,
    endpointResourceUid: "uid-endpoint-01",
    endpointResourceRevision: "1",
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
    providerPackRef: "fake",
    providerInstallationRef: "fake.primary",
  } as const;
  const first = await authority.assignEndpoint(claim);
  await expect(
    authority.activateEndpointAssignment({
      assignment: first,
      providerOutputs: {
        hostname: "wrong.org_01.workers.test",
        url: "https://wrong.org_01.workers.test/",
      },
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });

  await authority.cancelEndpointAssignment(first);
  await expect(authority.cancelEndpointAssignment(first)).resolves.toBeUndefined();
  expect(
    await sql.query(
      `SELECT state, bound_endpoint_name, endpoint_resource_uid, endpoint_resource_revision
       FROM worker_endpoint_origin_reservations
       WHERE organization_id = 'org_01' AND reservation_id = 'reservation_01'`,
    ),
  ).toEqual([
    {
      state: "bound",
      bound_endpoint_name: null,
      endpoint_resource_uid: null,
      endpoint_resource_revision: null,
    },
  ]);

  const reassigned = await authority.assignEndpoint(claim);
  expect(reassigned.assignmentDigest).toBe(first.assignmentDigest);
  await expect(authority.cancelEndpointAssignment(first)).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  });
  const activated = await authority.activateEndpointAssignment({
    assignment: reassigned,
    providerOutputs: {
      hostname: "community-public.org_01.workers.test",
      url: "https://community-public.org_01.workers.test/",
    },
  });
  expect(activated.assignmentDigest).toBe(reassigned.assignmentDigest);
  expect(await authority.read("org_01", "reservation_01")).toMatchObject({
    status: "activated",
  });
  await expect(authority.cancelEndpointAssignment(reassigned)).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  });

  await authority.deactivateEndpointAssignment(activated);
  await authority.deactivateEndpointAssignment(activated);
  await sql.run(
    `UPDATE tf_resources SET revision = '2'
     WHERE tenant_id = 'org_01' AND uid = 'uid-worker-01'`,
  );
  expect(await authority.endpointAssignment("org_01", "uid-endpoint-01")).toMatchObject({
    assignmentDigest: reassigned.assignmentDigest,
    endpoint: { uid: "uid-endpoint-01" },
  });
  expect(await authority.read("org_01", "reservation_01")).toMatchObject({ status: "bound" });
  await expect(authority.cancelEndpointAssignment(reassigned)).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  });
});

test("binds and activates only authoritative post-Plan identities unrelated to the subdomain", async () => {
  const { authority, sql } = fixture();
  const worker = {
    organizationId: "org_01",
    space: "production-edge",
    workerName: "actual-runtime-worker",
    workerResourceUid: "uid-actual-worker-77",
  } as const;
  const endpoint = {
    organizationId: "org_01",
    space: worker.space,
    endpointName: "actual-endpoint-resource",
    endpointResourceUid: "uid-actual-endpoint-88",
    workerName: worker.workerName,
    workerResourceUid: "uid-wrong-worker",
  } as const;
  await authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    requestedSubdomain: "friendly-public-name",
    expiresInSeconds: 600,
  });
  await seedWorker(sql, worker);

  await expect(
    authority.bind({
      organizationId: "org_01",
      reservationId: "reservation_01",
      space: worker.space,
      workerName: "friendly-public-name",
      workerResourceUid: worker.workerResourceUid,
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
  const bound = await authority.bind({
    organizationId: "org_01",
    reservationId: "reservation_01",
    space: worker.space,
    workerName: worker.workerName,
    workerResourceUid: worker.workerResourceUid,
  });
  expect(bound.binding).toEqual({
    space: worker.space,
    workerName: worker.workerName,
    workerResourceUid: worker.workerResourceUid,
    workerResourceRevision: "1",
  });

  const origin = "https://friendly-public-name.org_01.workers.test";
  await seedEndpoint(sql, origin, ENDPOINT_FORM, endpoint);
  await expect(
    authority.activate({
      organizationId: "org_01",
      reservationId: "reservation_01",
      endpointResourceUid: endpoint.endpointResourceUid,
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });

  await sql.run(
    `UPDATE tf_resources SET relations_json = ?
     WHERE tenant_id = ? AND uid = ?`,
    [
      JSON.stringify([
        {
          pointer: "/worker",
          relation: "/worker",
          targetApiVersion: FORM.apiVersion,
          targetKind: "ModuleWorker",
          targetName: worker.workerName,
          targetUid: worker.workerResourceUid,
          targetFormRef: FORM,
        },
      ]),
      worker.organizationId,
      endpoint.endpointResourceUid,
    ],
  );
  expect(
    await authority.activate({
      organizationId: "org_01",
      reservationId: "reservation_01",
      endpointResourceUid: endpoint.endpointResourceUid,
    }),
  ).toMatchObject({
    status: "activated",
    requestedSubdomain: "friendly-public-name",
    canonicalPublicOrigin: origin,
    binding: {
      space: worker.space,
      workerName: worker.workerName,
      workerResourceUid: worker.workerResourceUid,
      endpointName: endpoint.endpointName,
      endpointResourceUid: endpoint.endpointResourceUid,
    },
  });
});

test("two reservations cannot bind the same exact ModuleWorker", async () => {
  const { authority, sql } = fixture();
  await authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    requestedSubdomain: "first-endpoint",
    expiresInSeconds: 600,
  });
  await authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_02",
    requestedSubdomain: "second-endpoint",
    expiresInSeconds: 600,
  });
  await seedWorker(sql);
  const identity = {
    organizationId: "org_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  } as const;
  await authority.bind({ ...identity, reservationId: "reservation_01" });
  await expect(
    authority.bind({ ...identity, reservationId: "reservation_02" }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
});

test("cannot bind a ModuleWorker whose deletion has started", async () => {
  const { authority, sql } = fixture();
  await authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    requestedSubdomain: REQUESTED_SUBDOMAIN,
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
    requestedSubdomain: REQUESTED_SUBDOMAIN,
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
    "https://community-public.org_01.workers.test",
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
    requestedSubdomain: REQUESTED_SUBDOMAIN,
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
  await seedEndpoint(deleting.sql, "https://community-public.org_01.workers.test");
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
    requestedSubdomain: REQUESTED_SUBDOMAIN,
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

  await sql.run(
    `UPDATE tf_resources
     SET revision = '2',
         resource_json = json_set(
           resource_json,
           '$.metadata.revision', '2',
           '$.status.outputs.hostname', 'community-public.org_01.workers.test',
           '$.status.outputs.url', 'https://community-public.org_01.workers.test/'
         ),
         updated_at = updated_at + 1
     WHERE tenant_id = 'org_01' AND uid = 'uid-endpoint-01'`,
  );
  const activated = await authority.activate({
    organizationId: "org_01",
    reservationId: "reservation_01",
    endpointResourceUid: "uid-endpoint-01",
  });
  expect(activated).toMatchObject({
    status: "activated",
    binding: {
      endpointName: TARGET.endpointName,
      endpointResourceUid: "uid-endpoint-01",
      endpointResourceRevision: "2",
    },
  });
  expect(
    await authority.activate({
      organizationId: "org_01",
      reservationId: "reservation_01",
      endpointResourceUid: "uid-endpoint-01",
    }),
  ).toEqual(activated);

  const deactivated = await authority.deactivate({
    organizationId: "org_01",
    reservationId: "reservation_01",
    endpointResourceUid: "uid-endpoint-01",
  });
  expect(deactivated).toMatchObject({
    status: "bound",
    binding: { endpointName: TARGET.endpointName, endpointResourceUid: "uid-endpoint-01" },
  });
  expect(
    await authority.deactivate({
      organizationId: "org_01",
      reservationId: "reservation_01",
      endpointResourceUid: "uid-endpoint-01",
    }),
  ).toEqual(deactivated);
  await seedEndpoint(sql, "https://community-public.org_01.workers.test", ENDPOINT_FORM, {
    organizationId: "org_01",
    space: TARGET.space,
    endpointName: "replacement",
    endpointResourceUid: "uid-endpoint-02",
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  });
  await expect(
    authority.activate({
      organizationId: "org_01",
      reservationId: "reservation_01",
      endpointResourceUid: "uid-endpoint-02",
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
  await expect(authority.release("org_01", "reservation_01")).resolves.toBeUndefined();
  await expect(authority.release("org_01", "reservation_01")).resolves.toBeUndefined();
  expect(await authority.read("org_01", "reservation_01")).toBeNull();
});

test("a live runtime-input claim fences both expiry and release", async () => {
  const { authority, sql, advance } = fixture();
  await authority.prepare({
    organizationId: "org_01",
    reservationId: "reservation_01",
    requestedSubdomain: REQUESTED_SUBDOMAIN,
    expiresInSeconds: 60,
  });
  await seedWorker(sql);
  const bound = await authority.bind({
    organizationId: "org_01",
    reservationId: "reservation_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  });
  const timestamp = Date.parse("2026-08-31T12:00:00.000Z");
  await sql.run(
    `INSERT INTO worker_runtime_input_preparations
       (organization_id, operation_id, preparation_id, preparation_commitment,
        material_set_id, material_set_nonce, space, worker_name, endpoint_name,
        worker_resource_uid, worker_resource_revision, bundle_name,
        origin_reservation_id, origin_reservation_revision, canonical_public_origin,
        provider_pack_ref, provider_installation_ref, offering_id, offering_digest,
        binding_names_json, sealed_payload, seal_nonce, seal_key_id,
        state, fence, claim_owner, claim_expires_at, claimed_resource_uid,
        dispatched_operation_id, consumed_receipt_digest,
        expires_at, created_at, updated_at, consumed_at, revoked_at)
     VALUES (?, 'runtime-operation-01', 'prep-00000000000000000000000000000000', ?,
             'material-set-01', 'nonce-01', ?, ?, ?, ?, ?, 'bundle-01',
             ?, ?, ?, ?, ?, ?, ?, '["ENCRYPTION_KEY"]',
             'sealed', 'seal-nonce', 'test-seal-key',
             'claimed', 2, 'claim-owner', ?, 'uid-worker-version-01',
             NULL, NULL, ?, ?, ?, NULL, NULL)`,
    [
      "org_01",
      `sha256:${"1".repeat(64)}`,
      TARGET.space,
      TARGET.workerName,
      TARGET.endpointName,
      bound.binding.workerResourceUid,
      bound.binding.workerResourceRevision,
      bound.reservationId,
      Number(bound.revision),
      bound.canonicalPublicOrigin,
      bound.providerPackRef,
      bound.providerInstallationRef,
      bound.offeringId,
      bound.offeringDigest,
      timestamp + 120_000,
      timestamp + 600_000,
      timestamp,
      timestamp,
    ],
  );
  advance(60_001);
  expect(await authority.read("org_01", "reservation_01")).toMatchObject({ status: "bound" });
  await expect(authority.release("org_01", "reservation_01")).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  });
  await sql.run(
    `UPDATE worker_runtime_input_preparations
     SET state = 'revoked', fence = fence + 1, sealed_payload = NULL,
         seal_nonce = NULL, seal_key_id = NULL, claim_owner = NULL,
         claim_expires_at = NULL, claimed_resource_uid = NULL,
         revoked_at = ?, updated_at = ?
     WHERE organization_id = 'org_01' AND operation_id = 'runtime-operation-01'`,
    [timestamp, timestamp],
  );
  await expect(authority.release("org_01", "reservation_01")).resolves.toBeUndefined();
  expect(await authority.read("org_01", "reservation_01")).toBeNull();
});

test("migrates a durable v1 row for read and drain lifecycle without reopening its writer", async () => {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS) {
    if (migration.name === RESERVATION_V2_MIGRATION_NAME) break;
    database.exec(migration.sql);
  }
  const catalog = createCatalog([sold()]);
  const offeringDigest = await catalog.digest(sold());
  const timestamp = Date.parse("2026-08-31T12:00:00.000Z");
  database
    .query(
      `INSERT INTO worker_endpoint_origin_reservations
         (organization_id, reservation_id, space, worker_name, endpoint_name,
          canonical_public_origin, provider_pack_ref, provider_installation_ref,
          offering_id, offering_digest, requested_ttl_seconds, expires_at,
          state, revision, worker_resource_uid, worker_resource_revision,
          endpoint_resource_uid, endpoint_resource_revision,
          created_at, updated_at, released_at)
       VALUES (?, ?, ?, ?, ?, ?, 'fake', 'fake.primary', ?, ?, 600, ?,
               'prepared', 1, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
    )
    .run(
      "org_01",
      "legacy_reservation_01",
      TARGET.space,
      TARGET.workerName,
      TARGET.endpointName,
      "https://legacy-public.workers.test",
      "worker.module.test",
      offeringDigest,
      timestamp + 600_000,
      timestamp,
      timestamp,
    );

  database.exec(RESERVATION_V2_MIGRATION);
  const sql = createSqliteSql(database);
  expect(
    await sql.query(
      `SELECT reservation_format, legacy_space, legacy_worker_name, legacy_endpoint_name,
              requested_subdomain, bound_space, bound_worker_name
       FROM worker_endpoint_origin_reservations
       WHERE organization_id = 'org_01' AND reservation_id = 'legacy_reservation_01'`,
    ),
  ).toEqual([
    {
      reservation_format: "takoserver.worker-endpoint-origin-reservation.v1",
      legacy_space: TARGET.space,
      legacy_worker_name: TARGET.workerName,
      legacy_endpoint_name: TARGET.endpointName,
      requested_subdomain: null,
      bound_space: null,
      bound_worker_name: null,
    },
  ]);

  const { authority } = fixture({ sql });
  expect(await authority.read("org_01", "legacy_reservation_01")).toEqual({
    format: "takoserver.worker-endpoint-origin-reservation.v1",
    reservationId: "legacy_reservation_01",
    canonicalPublicOrigin: "https://legacy-public.workers.test",
    revision: "1",
    expiresAt: "2026-08-31T12:10:00.000Z",
    target: TARGET,
    status: "prepared",
  });
  await expect(
    authority.prepare({
      organizationId: "org_01",
      reservationId: "legacy_reservation_01",
      requestedSubdomain: "legacy-public",
      expiresInSeconds: 600,
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });

  const unrelatedWorker = {
    organizationId: "org_01",
    space: "different-space",
    workerName: "different-worker",
    workerResourceUid: "uid-different-worker",
  } as const;
  await seedWorker(sql, unrelatedWorker);
  await expect(
    authority.bind({
      ...unrelatedWorker,
      reservationId: "legacy_reservation_01",
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });

  await seedWorker(sql);
  await authority.prepare({
    organizationId: "org_01",
    reservationId: "current_reservation_02",
    requestedSubdomain: "current-public",
    expiresInSeconds: 600,
  });
  const currentBinding = {
    organizationId: "org_01",
    reservationId: "current_reservation_02",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  } as const;
  await expect(authority.bind(currentBinding)).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  });
  expect(
    await authority.bind({
      organizationId: "org_01",
      reservationId: "legacy_reservation_01",
      space: TARGET.space,
      workerName: TARGET.workerName,
      workerResourceUid: "uid-worker-01",
    }),
  ).toMatchObject({ status: "bound", binding: { workerResourceUid: "uid-worker-01" } });
  await seedEndpoint(sql, "https://legacy-public.workers.test");
  expect(
    await authority.activate({
      organizationId: "org_01",
      reservationId: "legacy_reservation_01",
      endpointResourceUid: "uid-endpoint-01",
    }),
  ).toMatchObject({
    format: "takoserver.worker-endpoint-origin-reservation.v1",
    status: "activated",
    endpointResourceUid: "uid-endpoint-01",
  });
  const legacyAssignment = await authority.endpointAssignment("org_01", "uid-endpoint-01");
  expect(legacyAssignment).toMatchObject({
    canonicalPublicOrigin: "https://legacy-public.workers.test",
    endpoint: {
      space: TARGET.space,
      name: TARGET.endpointName,
      uid: "uid-endpoint-01",
      revision: "1",
    },
    worker: { name: TARGET.workerName, uid: "uid-worker-01", revision: "1" },
    placement: { providerPackRef: "fake", providerInstallationRef: "fake.primary" },
  });
  expect(legacyAssignment?.assignmentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  if (!legacyAssignment) throw new Error("the migrated v1 assignment is missing");
  await authority.deactivateEndpointAssignment(legacyAssignment);
  await authority.deactivate({
    organizationId: "org_01",
    reservationId: "legacy_reservation_01",
    endpointResourceUid: "uid-endpoint-01",
  });
  await sql.run("DELETE FROM tf_resources WHERE tenant_id = 'org_01' AND uid = 'uid-endpoint-01'");
  await sql.run(
    "UPDATE tf_resource_deployments SET state = 'deleted' WHERE tenant_id = 'org_01' AND resource_uid = 'uid-endpoint-01'",
  );
  await sql.run(
    "UPDATE tf_resource_deletion_attestations SET state = 'closed' WHERE tenant_id = 'org_01' AND resource_uid = 'uid-endpoint-01'",
  );
  await authority.release("org_01", "legacy_reservation_01");
  expect(await authority.read("org_01", "legacy_reservation_01")).toBeNull();
  expect(await authority.bind(currentBinding)).toMatchObject({
    status: "bound",
    requestedSubdomain: "current-public",
  });
});

async function seedWorker(
  sql: ReturnType<typeof createReservationV2Sql>,
  identity: {
    readonly organizationId: string;
    readonly space: string;
    readonly workerName: string;
    readonly workerResourceUid: string;
  } = {
    organizationId: "org_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  },
): Promise<void> {
  await seedResource(sql, {
    organizationId: identity.organizationId,
    space: identity.space,
    uid: identity.workerResourceUid,
    kind: "ModuleWorker",
    name: identity.workerName,
    form: FORM,
    outputs: {},
    relations: [],
    deployment: {
      id: `deployment-${identity.workerResourceUid}`,
      offeringId: "worker.module.test",
      nativeId: `worker:${identity.workerResourceUid}`,
    },
  });
}

async function seedEndpoint(
  sql: ReturnType<typeof createReservationV2Sql>,
  origin: string,
  form: TakoformV1Alpha3FormRef = ENDPOINT_FORM,
  identity: {
    readonly organizationId: string;
    readonly space: string;
    readonly endpointName: string;
    readonly endpointResourceUid: string;
    readonly workerName: string;
    readonly workerResourceUid: string;
  } = {
    organizationId: "org_01",
    space: TARGET.space,
    endpointName: TARGET.endpointName,
    endpointResourceUid: "uid-endpoint-01",
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  },
): Promise<void> {
  const hostname = new URL(origin).hostname;
  await seedResource(sql, {
    organizationId: identity.organizationId,
    space: identity.space,
    uid: identity.endpointResourceUid,
    kind: "WorkerEndpoint",
    name: identity.endpointName,
    workerName: identity.workerName,
    form,
    outputs: { hostname, url: `${origin}/` },
    relations: [
      {
        pointer: "/worker",
        relation: "/worker",
        targetApiVersion: FORM.apiVersion,
        targetKind: "ModuleWorker",
        targetName: identity.workerName,
        targetUid: identity.workerResourceUid,
        targetFormRef: FORM,
      },
    ],
    deployment: {
      id: `deployment-${identity.endpointResourceUid}`,
      offeringId: "worker.endpoint.test",
      nativeId: `endpoint:${identity.endpointResourceUid}`,
    },
  });
}

async function seedResource(
  sql: ReturnType<typeof createReservationV2Sql>,
  input: {
    readonly organizationId: string;
    readonly space: string;
    readonly uid: string;
    readonly kind: "ModuleWorker" | "WorkerEndpoint";
    readonly name: string;
    readonly workerName?: string;
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
      space: input.space,
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
              name: input.workerName,
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
     VALUES (?, ?, ?, ?, ?, ?, '1', '1', ?, ?, ?)`,
    [
      input.organizationId,
      input.space,
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
     VALUES (?, ?, ?, ?, 'fake', 'fake.primary', ?, 0, 'active', '{}', '{}', ?, ?)`,
    [
      input.organizationId,
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
     VALUES (?, ?, ?, ?, ?, ?, ?, 'live', 1, '[]',
             NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    [
      input.organizationId,
      input.uid,
      input.space,
      input.form.apiVersion,
      input.kind,
      input.name,
      JSON.stringify(input.form),
      timestamp,
      timestamp,
    ],
  );
}
