import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MIGRATIONS } from "../src/db-schema.ts";
import type { TakoformV1Alpha3FormRef } from "../src/form-ref.ts";
import { STABLE_PRODUCTION_TAKOFORM_CATALOG } from "../src/generated/takoform-stable-v1-catalog.ts";
import {
  createCatalog,
  createLedger,
  createResourceDeploymentStore,
  createWorkerEndpointOriginReservations,
  type Offering,
} from "../src/index.ts";
import { createProviderDriver } from "../src/provider-driver.ts";
import type { ApplyInput, Provider, ProviderOffering } from "../src/provider-port.ts";
import { succeeded } from "../src/provider-port.ts";
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
const TAKOSUMI_TENANT_SPACE = "tenant:tsh_2IS0Th3vfHv-B1kAAJfyNKHM79GJ0SxuZdRM147QfvI";
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
    canonicalPublicOrigin: "https://community-public.org-01.workers.test",
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

function soldEndpointOffering(id = "worker.endpoint.test"): Offering {
  return {
    ...sold(id),
    kind: "WorkerEndpoint",
    displayName: "Worker endpoint",
    form: ENDPOINT_FORM,
    resourceClass: "worker.endpoint",
  };
}

function technicalEndpointOffering(id = "worker.endpoint.test"): ProviderOffering {
  return {
    id,
    kind: "WorkerEndpoint",
    displayName: "Worker endpoint",
    form: ENDPOINT_FORM,
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
    /** What the installation says its own runtime serves. Absent is `https`. */
    readonly publishedScheme?: "https" | "http";
    /** `false` removes the capability; a string is the label it derives. */
    readonly hostMintedSubdomain?: string | false;
    readonly sql?: ReturnType<typeof createReservationV2Sql>;
    /** Replaces the fake provider's mutation, for driver-level cases. */
    readonly apply?: (input: ApplyInput) => ReturnType<Provider["apply"]>;
  } = {},
) {
  const sql = input.sql ?? createReservationV2Sql();
  let current = new Date("2026-08-31T12:00:00.000Z");
  const deriveCalls: { readonly tenantRef: string; readonly requestedSubdomain: string }[] = [];
  const base = new FakeProvider({ id: "fake", offerings: input.technical ?? [technical()] });
  const provider = Object.assign(base, {
    ...(input.apply ? { apply: input.apply } : {}),
    workerEndpointOriginReservations: {
      ...(input.publishedScheme ? { publishedScheme: input.publishedScheme } : {}),
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
            input.fixedOrigin ??
            // A real installation derives a DNS label; `org_01` is not one, and
            // the reservation authority now holds a derived address to the
            // grammar `WorkerEndpoint@0.1.0` publishes.
            `https://${requestedSubdomain}.${tenantRef.replaceAll("_", "-")}.workers.test`,
        };
      },
      // An installation whose endpoint address is derived from the Worker, the
      // way the self-host suffix and the ordinary-workers suffix are.
      ...(input.hostMintedSubdomain === false
        ? {}
        : {
            async hostMintedSubdomain({
              space,
              workerName,
            }: {
              tenantRef: string;
              space: string;
              workerName: string;
            }) {
              return typeof input.hostMintedSubdomain === "string"
                ? input.hostMintedSubdomain
                : `sw-${space}-${workerName}`;
            },
          }),
    },
  }) satisfies Provider;
  const catalog = createCatalog(input.offerings ?? [sold()]);
  const authority = createWorkerEndpointOriginReservations({
    sql,
    clock: () => current,
    catalog,
    providers: [provider],
    resources: createTakoformStore(sql, () => current),
    deployments: createResourceDeploymentStore(sql, () => current),
  });
  return {
    sql,
    authority,
    catalog,
    provider,
    clock: () => current,
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
    canonicalPublicOrigin: "https://community-public.org-01.workers.test",
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

/**
 * An address the published Form cannot carry is refused before anything exists.
 *
 * `WorkerEndpoint@0.1.0` publishes `^https://<dotted-name>/$` — no plaintext
 * address and no port — so a self-host on plain HTTP, or on a socket that is
 * not on 443, can create no `WorkerEndpoint` at all. That was discovered in the
 * middle of an apply: the Host minted, assigned, mutated, activated and
 * attested the endpoint, and only then refused its own driver's outputs against
 * the Form, leaving the space wedged. The rule therefore lives at the mint,
 * which is before any of that, and the refusal says which two things fix it.
 */
test("refuses an address the published WorkerEndpoint Form cannot carry, before it reserves one", async () => {
  const unpublishable = [
    // A certificate-less self-host: honest about its socket, unpublishable.
    { publishedScheme: "http" as const, origin: "http://sw-community.localhost:28988" },
    // The same host with the port normalized away. The scheme alone is enough.
    { publishedScheme: "http" as const, origin: "http://sw-community.localhost" },
    // TLS in workerd, but not on 443: the O-7 repair, which the Form forbids.
    { origin: "https://sw-community.e2e.selfhost.test:28988" },
    // And a suffix no DNS name can be made of.
    { origin: "https://sw-community.not_a_label" },
  ];
  for (const [index, entry] of unpublishable.entries()) {
    const harness = fixture({
      ...(entry.publishedScheme ? { publishedScheme: entry.publishedScheme } : {}),
      fixedOrigin: entry.origin,
    });
    const refusal = harness.authority.prepare({
      organizationId: "org_01",
      reservationId: `reservation_0${index}`,
      requestedSubdomain: REQUESTED_SUBDOMAIN,
      expiresInSeconds: 600,
    });
    await expect(refusal).rejects.toMatchObject({
      code: "unsupported_capability",
      status: 422,
    });
    await refusal.catch((error: unknown) => {
      const message = (error as { publicMessage?: string }).publicMessage ?? "";
      // Both remedies, named, in the sentence the operator actually reads.
      if (entry.origin.endsWith("not_a_label")) {
        expect(message).toContain("TAKOSERVER_WORKER_ENDPOINT_SUFFIX");
        return;
      }
      expect(message).toContain("TAKOSERVER_WORKERD_TLS_CERT_FILE");
      expect(message).toContain("TAKOSERVER_WORKERD_PORT=443");
      expect(message).toContain("TAKOSERVER_WORKER_ENDPOINT_PORT=443");
      // And it fits the wire, remedies included, rather than being truncated.
      expect(message.length).toBeLessThanOrEqual(400);
    });
    // Nothing was reserved, so nothing has to be let go of.
    expect(
      await harness.sql.query("SELECT reservation_id FROM worker_endpoint_origin_reservations"),
    ).toEqual([]);
  }
});

/**
 * The scheme of a published address is a fact about the socket that serves it,
 * and this ledger is the authority that accepts one.
 *
 * This fence is separate from the publication rule above and still load-bearing:
 * it is what stops an installation handing this Host an address in a scheme it
 * never said it serves. The publication rule then decides whether the address
 * can be published at all.
 */
test("holds a derived address to the scheme the installation says it serves", async () => {
  // The managed and ordinary-workers lanes declare nothing and stay https-only:
  // an installation that has not said it serves plain HTTP cannot hand this
  // ledger an `http` address, whatever it derives.
  const managed = fixture({ fixedOrigin: "http://sw-community.localhost" });
  await expect(
    managed.authority.prepare({
      organizationId: "org_01",
      reservationId: "reservation_01",
      requestedSubdomain: REQUESTED_SUBDOMAIN,
      expiresInSeconds: 600,
    }),
  ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });

  // And the declaration is exact in the other direction too.
  const mismatched = fixture({
    publishedScheme: "http",
    fixedOrigin: "https://sw-community.localhost",
  });
  await expect(
    mismatched.authority.prepare({
      organizationId: "org_01",
      reservationId: "reservation_01",
      requestedSubdomain: REQUESTED_SUBDOMAIN,
      expiresInSeconds: 600,
    }),
  ).rejects.toMatchObject({ code: "unsupported_capability", status: 422 });
});

/**
 * The whole publishable lane, end to end: mint, assign, apply, activate.
 *
 * The address is `https` with the port normalized away — a self-host that
 * terminates TLS on 443, natively or behind a front end that says so with
 * `TAKOSERVER_WORKER_ENDPOINT_PORT=443`. That is the one shape
 * `WorkerEndpoint@0.1.0` can carry, and it has to work with no `-target`
 * staging and no shim.
 */
test("creates a WorkerEndpoint on a self-host that terminates TLS on the default port", async () => {
  const origin = "https://sw-community.e2e.selfhost.test";
  const harness = fixture({
    offerings: [sold(), soldEndpointOffering()],
    technical: [technical(), technicalEndpointOffering()],
    fixedOrigin: origin,
    hostMintedSubdomain: "sw-community",
    apply: async (applyInput) =>
      succeeded({
        nativeId: `endpoint:${applyInput.identity.uid}`,
        observed: { assigned: true },
        outputs: {
          hostname: new URL(applyInput.workerEndpointOriginAssignment?.canonicalPublicOrigin ?? "")
            .hostname,
          url: `${applyInput.workerEndpointOriginAssignment?.canonicalPublicOrigin}/`,
        },
      }),
  });
  await seedWorker(harness.sql);
  const endpointForm = STABLE_PRODUCTION_TAKOFORM_CATALOG.forms.find(
    (candidate) => candidate.identity.formRef.kind === "WorkerEndpoint",
  );
  if (!endpointForm) throw new Error("WorkerEndpoint Form missing");
  const driver = createProviderDriver({
    providers: [harness.provider],
    catalog: harness.catalog,
    ledger: createLedger(harness.sql, harness.clock),
    deployments: createResourceDeploymentStore(harness.sql, harness.clock),
    originReservations: harness.authority,
  });

  const receipt = await driver.apply({
    operationId: "op-endpoint-http",
    operationKey: "key-endpoint-http",
    tenantId: "org_01",
    resourceUid: "uid-endpoint-01",
    executionAuthority: testExecutionAuthority("org_01", "uid-endpoint-01", "op-endpoint-http"),
    form: endpointForm,
    name: TARGET.endpointName,
    space: TARGET.space,
    spec: {
      worker: { apiVersion: FORM.apiVersion, kind: "ModuleWorker", name: TARGET.workerName },
    },
    relations: [
      {
        pointer: "/worker",
        relation: "/worker",
        targetUid: "uid-worker-01",
        resource: {
          apiVersion: FORM.apiVersion,
          kind: "ModuleWorker",
          form: { formRef: FORM },
          metadata: {
            name: TARGET.workerName,
            space: TARGET.space,
            uid: "uid-worker-01",
            generation: "1",
            revision: "1",
          },
          spec: {},
          status: { observedGeneration: "1", conditions: [] },
        },
      },
    ],
  });

  expect(receipt.outputs).toEqual({
    hostname: "sw-community.e2e.selfhost.test",
    url: `${origin}/`,
  });
  expect(
    await harness.sql.query(
      `SELECT canonical_public_origin, state, endpoint_resource_uid
       FROM worker_endpoint_origin_reservations`,
    ),
  ).toEqual([
    {
      canonical_public_origin: origin,
      state: "activated",
      endpoint_resource_uid: "uid-endpoint-01",
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
  // Not a web origin at all, and an origin with something after it: both are
  // shapes this ledger can never have written. `http` is no longer one of them
  // — a certificate-less self-host publishes the scheme its socket serves
  // (ADR 0009), and a row holding that address is a row, not corruption.
  for (const corrupt of [
    "ftp://community-public.workers.test",
    "https://community-public.workers.test/",
    "https://operator@community-public.workers.test",
  ]) {
    await sql.run(
      `UPDATE worker_endpoint_origin_reservations
       SET canonical_public_origin = ?
       WHERE organization_id = 'org_01' AND reservation_id = 'reservation_01'`,
      [corrupt],
    );
    await expect(authority.read("org_01", "reservation_01")).rejects.toMatchObject({
      code: "backend_unavailable",
      status: 503,
    });
  }

  await sql.run(
    `UPDATE worker_endpoint_origin_reservations
     SET canonical_public_origin = 'http://community-public.workers.test:28988'
     WHERE organization_id = 'org_01' AND reservation_id = 'reservation_01'`,
  );
  expect(await authority.read("org_01", "reservation_01")).toMatchObject({
    canonicalPublicOrigin: "http://community-public.workers.test:28988",
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
  await seedEndpoint(sql, "https://community-public.org-01.workers.test");
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
    canonicalPublicOrigin: "https://community-public.org-01.workers.test",
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
        hostname: "wrong.org-01.workers.test",
        url: "https://wrong.org-01.workers.test/",
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
      hostname: "community-public.org-01.workers.test",
      url: "https://community-public.org-01.workers.test/",
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

  const origin = "https://friendly-public-name.org-01.workers.test";
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
    "https://community-public.org-01.workers.test",
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
  await seedEndpoint(deleting.sql, "https://community-public.org-01.workers.test");
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
           '$.status.outputs.hostname', 'community-public.org-01.workers.test',
           '$.status.outputs.url', 'https://community-public.org-01.workers.test/'
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
  await seedEndpoint(sql, "https://community-public.org-01.workers.test", ENDPOINT_FORM, {
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

/**
 * The reservation an ordinary organization API key never had.
 *
 * The reseller lane sells a name and holds it before the Resource graph
 * exists, and the reservation is the authority for it. An ordinary key has no
 * such input — the released provider's `takoform_worker_endpoint` accepts only
 * `name` and `worker` — so on an installation whose endpoint address is derived
 * from the Worker anyway, this Host reserves on the caller's behalf.
 */
test("mints one bound reservation for a Ready Worker on an installation that derives its address", async () => {
  const { authority, sql } = fixture();
  await seedWorker(sql);
  const target = {
    organizationId: "org_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  } as const;

  const minted = await authority.mintForWorker(target);
  expect(minted).toMatchObject({
    organizationId: "org_01",
    status: "bound",
    canonicalPublicOrigin: `https://sw-${TARGET.space}-${TARGET.workerName}.org-01.workers.test`,
    binding: {
      space: TARGET.space,
      workerName: TARGET.workerName,
      workerResourceUid: "uid-worker-01",
      workerResourceRevision: "1",
    },
  });
  // Derived from the exact Worker incarnation, so a retry of the same apply
  // asks for the same reservation rather than a second origin.
  expect(minted?.reservationId).toMatch(/^hostmint-[0-9a-f]{40}$/u);
  expect((await authority.mintForWorker(target))?.reservationId).toBe(
    minted?.reservationId as string,
  );
  expect(
    await sql.query("SELECT reservation_id FROM worker_endpoint_origin_reservations"),
  ).toHaveLength(1);

  // One reservation per organization, Space and logical Worker: a second
  // Worker in the same Space gets its own, and its own origin.
  await seedWorker(sql, {
    organizationId: "org_01",
    space: TARGET.space,
    workerName: "other",
    workerResourceUid: "uid-worker-02",
  });
  const second = await authority.mintForWorker({
    organizationId: "org_01",
    space: TARGET.space,
    workerName: "other",
    workerResourceUid: "uid-worker-02",
  });
  expect(second?.reservationId).not.toBe(minted?.reservationId);
  expect(second?.canonicalPublicOrigin).not.toBe(minted?.canonicalPublicOrigin);
});

/**
 * A Space is an opaque Host API identifier, not a Resource metadata.name.
 * Takosumi's real tenant-scoped Spaces contain `:`, so applying the Resource
 * name grammar here made the first WorkerEndpoint in an otherwise healthy
 * fifteen-Resource graph fail before the provider mutation boundary.
 */
test("mints a WorkerEndpoint reservation in the tenant-scoped Space used by Takosumi", async () => {
  const space = TAKOSUMI_TENANT_SPACE;
  const { authority, sql } = fixture({ hostMintedSubdomain: "sw-community" });
  await seedWorker(sql, {
    organizationId: "org_01",
    space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  });

  const minted = await authority.mintForWorker({
    organizationId: "org_01",
    space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  });
  expect(minted).toMatchObject({
    status: "bound",
    binding: { space },
  });
});

/** The reservation ledger must carry every Space the stable Host wire admits. */
test("preserves a maximum-length Unicode Host API Space in a reservation", async () => {
  const space = `tenant:${"界".repeat(248)}`;
  expect([...space]).toHaveLength(255);
  const { authority, sql } = fixture({ hostMintedSubdomain: "sw-community" });
  await seedWorker(sql, {
    organizationId: "org_01",
    space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  });

  const minted = await authority.mintForWorker({
    organizationId: "org_01",
    space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  });
  expect(minted?.binding?.space).toBe(space);
  expect(
    await sql.query(
      "SELECT bound_space FROM worker_endpoint_origin_reservations WHERE organization_id = ?",
      ["org_01"],
    ),
  ).toEqual([{ bound_space: space }]);
});

test("rejects only non-Host Spaces at every reservation command boundary", async () => {
  const { authority } = fixture({ hostMintedSubdomain: "sw-community" });
  const invalidSpaces = [
    "",
    " leading",
    "trailing ",
    "tenant/child",
    "tenant:\u0000child",
    "界".repeat(256),
  ];
  for (const space of invalidSpaces) {
    const worker = {
      organizationId: "org_01",
      space,
      workerName: TARGET.workerName,
      workerResourceUid: "uid-worker-01",
    } as const;
    await expect(authority.mintForWorker(worker)).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
    });
    await expect(
      authority.inspectBound({ ...worker, reservationId: "reservation_01" }),
    ).rejects.toMatchObject({ code: "invalid_argument", status: 400 });
    await expect(
      authority.bind({ ...worker, reservationId: "reservation_01" }),
    ).rejects.toMatchObject({ code: "invalid_argument", status: 400 });
    await expect(
      authority.assignEndpoint({
        ...worker,
        reservationId: "reservation_01",
        endpointName: TARGET.endpointName,
        endpointResourceUid: "uid-endpoint-01",
        endpointResourceRevision: "1",
        providerPackRef: "fake",
        providerInstallationRef: "fake.primary",
      }),
    ).rejects.toMatchObject({ code: "invalid_argument", status: 400 });
  }
});

test("mints nothing where the installation does not derive its own endpoint address", async () => {
  const { authority, sql } = fixture({ hostMintedSubdomain: false });
  await seedWorker(sql);
  expect(
    await authority.mintForWorker({
      organizationId: "org_01",
      space: TARGET.space,
      workerName: TARGET.workerName,
      workerResourceUid: "uid-worker-01",
    }),
  ).toBeNull();
  expect(await sql.query("SELECT reservation_id FROM worker_endpoint_origin_reservations")).toEqual(
    [],
  );
});

test("refuses to mint against a Worker that is not the exact Ready incarnation", async () => {
  const { authority, sql } = fixture();
  await seedWorker(sql);
  await expect(
    authority.mintForWorker({
      organizationId: "org_01",
      space: TARGET.space,
      workerName: TARGET.workerName,
      workerResourceUid: "uid-worker-missing",
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
});

/**
 * Re-creating just the endpoint must not end the Worker's endpoint story.
 *
 * A derived reservation id can never be re-minted: `prepare` replays an
 * existing row and refuses a terminal one, and the id is a digest of the
 * address, so a released row is the end. Letting go of a settled endpoint
 * witness therefore has to happen in place — under the same fences a release
 * uses — rather than by releasing the reservation that is about to be prepared.
 */
test("re-creates an endpoint on the same Worker after the previous one is gone", async () => {
  const { authority, sql } = fixture();
  await seedWorker(sql);
  const target = {
    organizationId: "org_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  } as const;
  const minted = await authority.mintForWorker(target);
  if (!minted) throw new Error("the fixture installation derives its own address");
  await seedEndpoint(sql, minted.canonicalPublicOrigin);
  await authority.assignEndpoint({
    organizationId: "org_01",
    reservationId: minted.reservationId,
    space: TARGET.space,
    endpointName: TARGET.endpointName,
    endpointResourceUid: "uid-endpoint-01",
    endpointResourceRevision: "1",
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
    providerPackRef: "fake",
    providerInstallationRef: "fake.primary",
  });

  // While the endpoint is still there, the witness holds and the mint refuses
  // rather than pointing a second endpoint at an origin that is answering.
  await expect(authority.mintForWorker(target)).rejects.toMatchObject({
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

  const again = await authority.mintForWorker(target);
  expect(again).toMatchObject({
    reservationId: minted.reservationId,
    canonicalPublicOrigin: minted.canonicalPublicOrigin,
    status: "bound",
  });
  // Still one row, still live: nothing was released, so the address is still
  // this Worker's and can be minted a third time.
  expect(
    await sql.query("SELECT reservation_id, state FROM worker_endpoint_origin_reservations"),
  ).toEqual([{ reservation_id: minted.reservationId, state: "bound" }]);
  expect((await authority.mintForWorker(target))?.reservationId).toBe(minted.reservationId);
});

/**
 * A ModuleWorker's revision moves on its own — `withDerivedRendering` re-renders
 * it whenever a dependent appears or becomes Ready — and a binding records the
 * revision it was made at. Between a failed endpoint apply and its retry that
 * recorded revision is routinely stale, and refusing on it left the Worker
 * unable to get an endpoint until the reservation aged out a day later.
 */
test("advances its own binding when the Worker re-renders between attempts", async () => {
  const { authority, sql } = fixture();
  await seedWorker(sql);
  const target = {
    organizationId: "org_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  } as const;
  const minted = await authority.mintForWorker(target);
  expect(minted?.binding.workerResourceRevision).toBe("1");

  const [row] = await sql.query(
    "SELECT resource_json FROM tf_resources WHERE tenant_id = 'org_01' AND uid = 'uid-worker-01'",
  );
  const resource = JSON.parse(String(row?.resource_json)) as { metadata: { revision: string } };
  resource.metadata.revision = "2";
  await sql.run(
    "UPDATE tf_resources SET revision = '2', resource_json = ? WHERE tenant_id = 'org_01' AND uid = 'uid-worker-01'",
    [JSON.stringify(resource)],
  );

  const again = await authority.mintForWorker(target);
  expect(again).toMatchObject({
    reservationId: minted?.reservationId as string,
    status: "bound",
    binding: { workerResourceUid: "uid-worker-01", workerResourceRevision: "2" },
  });
  // The same Worker incarnation throughout: one reservation, advanced.
  expect(
    await sql.query("SELECT reservation_id, state FROM worker_endpoint_origin_reservations"),
  ).toEqual([{ reservation_id: minted?.reservationId as string, state: "bound" }]);
});

/**
 * A destroy followed by a re-apply asks for the same derived reservation with a
 * new Worker UID. Letting go of the old one is the fenced release of ADR 0004
 * and nothing weaker: while the old endpoint Resource is present, its deletion
 * attestation open, or a provider deployment still live, the origin stays where
 * it is and the mint fails rather than reallocating an address that may still
 * be serving.
 */
test("reclaims its own superseded reservation only through the release fences", async () => {
  const { authority, sql } = fixture();
  await seedWorker(sql);
  const minted = await authority.mintForWorker({
    organizationId: "org_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  });
  if (!minted) throw new Error("the fixture installation derives its own address");
  await seedEndpoint(sql, minted.canonicalPublicOrigin);
  await authority.assignEndpoint({
    organizationId: "org_01",
    reservationId: minted.reservationId,
    space: TARGET.space,
    endpointName: TARGET.endpointName,
    endpointResourceUid: "uid-endpoint-01",
    endpointResourceRevision: "1",
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
    providerPackRef: "fake",
    providerInstallationRef: "fake.primary",
  });

  // The Worker was destroyed and declared again: same address, new incarnation.
  await sql.run("DELETE FROM tf_resources WHERE tenant_id = 'org_01' AND uid = 'uid-worker-01'");
  await seedWorker(sql, {
    organizationId: "org_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-03",
  });
  const remint = {
    organizationId: "org_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-03",
  } as const;

  // The old endpoint is still present, so the origin is not free.
  await expect(authority.mintForWorker(remint)).rejects.toMatchObject({
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

  const reminted = await authority.mintForWorker(remint);
  expect(reminted).toMatchObject({
    canonicalPublicOrigin: minted.canonicalPublicOrigin,
    binding: { workerResourceUid: "uid-worker-03" },
    status: "bound",
  });
  // A different reservation: the old one stays as history of the address's
  // previous life, released rather than rewritten.
  expect(reminted?.reservationId).not.toBe(minted.reservationId);
  expect(
    await sql.query(
      "SELECT reservation_id, state FROM worker_endpoint_origin_reservations ORDER BY created_at",
    ),
  ).toEqual([
    { reservation_id: minted.reservationId, state: "released" },
    { reservation_id: reminted?.reservationId as string, state: "bound" },
  ]);
});

/** The stable WorkerEndpoint Form, as an installed definition the driver takes. */
function endpointFormDefinition() {
  const definition = STABLE_PRODUCTION_TAKOFORM_CATALOG.forms.find(
    (candidate) => candidate.identity.formRef.kind === "WorkerEndpoint",
  );
  if (!definition) throw new Error("WorkerEndpoint Form missing");
  return definition;
}

/** The `/worker` relation a `takoform_worker_endpoint` create carries. */
function workerRelation(space: string = TARGET.space) {
  return {
    pointer: "/worker",
    relation: "/worker",
    targetUid: "uid-worker-01",
    resource: {
      apiVersion: FORM.apiVersion,
      kind: "ModuleWorker",
      form: { formRef: FORM },
      metadata: {
        name: TARGET.workerName,
        space,
        uid: "uid-worker-01",
        generation: "1",
        revision: "1",
      },
      spec: {},
      status: { observedGeneration: "1", conditions: [] },
    },
  } as const;
}

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
  await seedServingDeployment(sql, identity);
}

/**
 * The Version and Deployment that make a Worker actually serve `fetch`.
 *
 * The reservation authority derives readiness rather than reading the cached
 * `Ready` condition on the Worker's row — that condition is refreshed only when
 * something reads the Worker, so through a whole first apply it still says the
 * Worker has no deployment. A seed that set the condition and nothing else
 * would therefore be testing a cache this code no longer consults.
 */
async function seedServingDeployment(
  sql: ReturnType<typeof createReservationV2Sql>,
  identity: {
    readonly organizationId: string;
    readonly space: string;
    readonly workerName: string;
    readonly workerResourceUid: string;
  },
): Promise<void> {
  const timestamp = Date.parse("2026-08-31T12:00:00.000Z");
  const versionName = `${identity.workerResourceUid}-version`;
  const versionUid = `uid-version-${identity.workerResourceUid}`;
  const write = async (
    kind: "WorkerVersion" | "WorkerDeployment",
    name: string,
    uid: string,
    spec: Record<string, unknown>,
    relations: readonly Record<string, unknown>[],
  ): Promise<void> => {
    const formRef = { ...FORM, kind };
    await sql.run(
      `INSERT INTO tf_resources
         (tenant_id, space, api_version, kind, name, uid, generation, revision,
          resource_json, relations_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '1', '1', ?, ?, ?)`,
      [
        identity.organizationId,
        identity.space,
        FORM.apiVersion,
        kind,
        name,
        uid,
        JSON.stringify({
          apiVersion: FORM.apiVersion,
          kind,
          form: { formRef },
          metadata: { name, space: identity.space, uid, generation: "1", revision: "1" },
          spec,
          status: { observedGeneration: "1", conditions: [] },
        }),
        JSON.stringify(relations),
        timestamp,
      ],
    );
  };
  await write("WorkerVersion", versionName, versionUid, { handlers: ["fetch"] }, []);
  await write(
    "WorkerDeployment",
    `${identity.workerResourceUid}-deployment`,
    `uid-deployment-${identity.workerResourceUid}`,
    {},
    [
      {
        pointer: "/worker",
        relation: "/worker",
        targetApiVersion: FORM.apiVersion,
        targetKind: "ModuleWorker",
        targetName: identity.workerName,
        targetUid: identity.workerResourceUid,
        targetFormRef: FORM,
      },
      {
        pointer: "/versions/0/workerVersion",
        relation: "/versions/*/workerVersion",
        targetApiVersion: FORM.apiVersion,
        targetKind: "WorkerVersion",
        targetName: versionName,
        targetUid: versionUid,
        targetFormRef: { ...FORM, kind: "WorkerVersion" },
      },
    ],
  );
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

/**
 * The whole Host-minted lane, driven the way a `takoform_worker_endpoint`
 * create drives it.
 *
 * This is the case the released provider actually makes: no reservation input,
 * a catalog that sells a ModuleWorker Offering *and* a WorkerEndpoint
 * Offering, and a mutation whose own Offering is the endpoint's. The mint has
 * to place the reservation on the Worker's Offering; naming the mutation's own
 * one looked it up in the ModuleWorker candidate list, never matched, and
 * refused every self-host WorkerEndpoint with `unsupported_capability` 422.
 */
for (const { label, space } of [
  { label: "ordinary", space: TARGET.space },
  { label: "Takosumi tenant-scoped", space: TAKOSUMI_TENANT_SPACE },
] as const) {
  test(`creates a WorkerEndpoint with no reservation in the ${label} Space`, async () => {
    const applied: ApplyInput[] = [];
    const harness = fixture({
      offerings: [sold(), soldEndpointOffering()],
      technical: [technical(), technicalEndpointOffering()],
      hostMintedSubdomain: "sw-community",
      apply: async (applyInput) => {
        applied.push(applyInput);
        const origin = applyInput.workerEndpointOriginAssignment?.canonicalPublicOrigin ?? "";
        return succeeded({
          nativeId: `endpoint:${applyInput.identity.uid}`,
          observed: { assigned: true },
          outputs: { hostname: new URL(origin).hostname, url: `${origin}/` },
        });
      },
    });
    await seedWorker(harness.sql, {
      organizationId: "org_01",
      space,
      workerName: TARGET.workerName,
      workerResourceUid: "uid-worker-01",
    });
    const endpointForm = STABLE_PRODUCTION_TAKOFORM_CATALOG.forms.find(
      (candidate) => candidate.identity.formRef.kind === "WorkerEndpoint",
    );
    if (!endpointForm) throw new Error("WorkerEndpoint Form missing");
    const driver = createProviderDriver({
      providers: [harness.provider],
      catalog: harness.catalog,
      ledger: createLedger(harness.sql, harness.clock),
      deployments: createResourceDeploymentStore(harness.sql, harness.clock),
      originReservations: harness.authority,
    });

    const receipt = await driver.apply({
      operationId: "op-endpoint-hostmint",
      operationKey: "key-endpoint-hostmint",
      tenantId: "org_01",
      resourceUid: "uid-endpoint-01",
      executionAuthority: testExecutionAuthority(
        "org_01",
        "uid-endpoint-01",
        "op-endpoint-hostmint",
      ),
      form: endpointForm,
      name: TARGET.endpointName,
      space,
      spec: {
        worker: { apiVersion: FORM.apiVersion, kind: "ModuleWorker", name: TARGET.workerName },
      },
      relations: [workerRelation(space)],
    });

    const origin = "https://sw-community.org-01.workers.test";
    expect(receipt.outputs).toEqual({
      hostname: "sw-community.org-01.workers.test",
      url: `${origin}/`,
    });
    expect(applied).toHaveLength(1);
    expect(applied[0]?.workerEndpointOriginAssignment?.canonicalPublicOrigin).toBe(origin);

    // The reservation this Host made for the caller: a derived id in the
    // Host-minted namespace, on the ModuleWorker's own Offering, activated by
    // the endpoint the provider just created.
    expect(
      await harness.sql.query(
        `SELECT reservation_id, offering_id, state, endpoint_resource_uid
       FROM worker_endpoint_origin_reservations`,
      ),
    ).toEqual([
      {
        reservation_id: expect.stringMatching(/^hostmint-[0-9a-f]{40}$/u),
        offering_id: "worker.module.test",
        state: "activated",
        endpoint_resource_uid: "uid-endpoint-01",
      },
    ]);
  });
}

/**
 * A create that fails after the provider was entered gives the origin back.
 *
 * It did not. The driver cancelled an endpoint assignment only when the
 * provider had *not* been entered, so a `WorkerEndpoint` whose provider refused
 * — a lost readiness race, on a real self-host — left the reservation bound to
 * an endpoint UID whose Resource was never committed. Its deletion attestation
 * was opened `live` by the incarnation reservation and could never close,
 * because a Resource that never existed is never deleted; so the witness stood,
 * and every later apply, which re-creates the endpoint under a fresh UID,
 * answered `resource_busy` 409. Five consecutive applies in three independent
 * Spaces, with no escape but a different Worker name or surgery on the row.
 */
test("re-binds after a WorkerEndpoint create the provider refused", async () => {
  let refuse = true;
  const harness = fixture({
    offerings: [sold(), soldEndpointOffering()],
    technical: [technical(), technicalEndpointOffering()],
    hostMintedSubdomain: "sw-community",
    apply: async (applyInput) => {
      if (refuse) {
        refuse = false;
        return {
          phase: "failed",
          failure: {
            code: "unavailable",
            message: "the Worker runtime did not confirm this publication is the one it serves",
            retryable: true,
          },
        };
      }
      const origin = applyInput.workerEndpointOriginAssignment?.canonicalPublicOrigin ?? "";
      return succeeded({
        nativeId: `endpoint:${applyInput.identity.uid}`,
        observed: { assigned: true },
        outputs: { hostname: new URL(origin).hostname, url: `${origin}/` },
      });
    },
  });
  await seedWorker(harness.sql);
  const driver = createProviderDriver({
    providers: [harness.provider],
    catalog: harness.catalog,
    ledger: createLedger(harness.sql, harness.clock),
    deployments: createResourceDeploymentStore(harness.sql, harness.clock),
    originReservations: harness.authority,
  });
  const create = (uid: string) =>
    driver.apply({
      operationId: `op-endpoint-${uid}`,
      operationKey: `key-endpoint-${uid}`,
      tenantId: "org_01",
      resourceUid: uid,
      executionAuthority: testExecutionAuthority("org_01", uid, `op-endpoint-${uid}`),
      form: endpointFormDefinition(),
      name: TARGET.endpointName,
      space: TARGET.space,
      spec: {
        worker: { apiVersion: FORM.apiVersion, kind: "ModuleWorker", name: TARGET.workerName },
      },
      relations: [workerRelation()],
    });

  await expect(create("uid-endpoint-01")).rejects.toMatchObject({
    name: "ProviderMutationRecoveryError",
    providerOutcome: "indeterminate",
  });
  // Bound, and free to take another endpoint: the origin was not reallocated,
  // only the witness for an endpoint that was never made was let go of.
  expect(
    await harness.sql.query(
      `SELECT state, bound_endpoint_name, endpoint_resource_uid
       FROM worker_endpoint_origin_reservations`,
    ),
  ).toEqual([{ state: "bound", bound_endpoint_name: null, endpoint_resource_uid: null }]);

  // The retry is a new incarnation, exactly as a re-created resource is.
  const receipt = await create("uid-endpoint-02");
  expect(receipt.outputs).toEqual({
    hostname: "sw-community.org-01.workers.test",
    url: "https://sw-community.org-01.workers.test/",
  });
  expect(
    await harness.sql.query(
      "SELECT state, endpoint_resource_uid FROM worker_endpoint_origin_reservations",
    ),
  ).toEqual([{ state: "activated", endpoint_resource_uid: "uid-endpoint-02" }]);
});

/**
 * And a witness that can never close is repaired rather than waited out.
 *
 * If the Host dies between the refusal and the release above, the row is left
 * exactly as the defect left it. `live` with no Resource row is an incarnation
 * that was reserved and never committed, so the next mint drops it — but only
 * while nothing is still working on that incarnation, which is what keeps a
 * create that is genuinely in flight from having its origin taken.
 */
test("drops a witness for an endpoint incarnation that was never committed", async () => {
  const { authority, sql } = fixture();
  await seedWorker(sql);
  const target = {
    organizationId: "org_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  } as const;
  const minted = await authority.mintForWorker(target);
  if (!minted) throw new Error("the fixture installation derives its own address");
  // What a create that never committed leaves: the incarnation reservation, and
  // nothing else.
  await sql.run(
    `INSERT INTO tf_resource_deletion_attestations
       (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
        state, closure_fence, effects_json, evidence_json, evidence_ref,
        evidence_effect_digest, evidence_checked_at, evidence_status, created_at, updated_at)
     VALUES ('org_01', 'uid-endpoint-phantom', ?, ?, 'WorkerEndpoint', ?, ?, 'live', 1, '[]',
             NULL, NULL, NULL, NULL, NULL, 0, 0)`,
    [TARGET.space, ENDPOINT_FORM.apiVersion, TARGET.endpointName, JSON.stringify(ENDPOINT_FORM)],
  );
  await authority.assignEndpoint({
    organizationId: "org_01",
    reservationId: minted.reservationId,
    space: TARGET.space,
    endpointName: TARGET.endpointName,
    endpointResourceUid: "uid-endpoint-phantom",
    endpointResourceRevision: "1",
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
    providerPackRef: "fake",
    providerInstallationRef: "fake.primary",
  });

  // While a provider effect is still open on that incarnation, the create may
  // yet land and the origin stays where it is.
  await sql.run(
    `INSERT INTO tf_resource_provider_effects
       (tenant_id, resource_uid, event_id, effect_id, effect_kind, phase,
        operation_mode, provider_pack_ref, provider_installation_ref,
        native_id, target_json, created_at)
     VALUES ('org_01', 'uid-endpoint-phantom', 'op-phantom:planned', 'op-phantom',
             'apply', 'planned', 'initial', NULL, NULL, NULL, '{}', 0)`,
  );
  await expect(authority.mintForWorker(target)).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  });

  await sql.run(
    `INSERT INTO tf_resource_provider_effects
       (tenant_id, resource_uid, event_id, effect_id, effect_kind, phase,
        operation_mode, provider_pack_ref, provider_installation_ref,
        native_id, target_json, created_at)
     VALUES ('org_01', 'uid-endpoint-phantom', 'op-phantom:cancelled', 'op-phantom',
             'apply', 'cancelled', 'initial', NULL, NULL, NULL, '{}', 0)`,
  );
  expect(await authority.mintForWorker(target)).toMatchObject({
    reservationId: minted.reservationId,
    canonicalPublicOrigin: minted.canonicalPublicOrigin,
    status: "bound",
  });
  expect(
    await sql.query("SELECT state, endpoint_resource_uid FROM worker_endpoint_origin_reservations"),
  ).toEqual([{ state: "bound", endpoint_resource_uid: null }]);
});

/**
 * The exact wedge a post-activation refusal used to leave, healed on upgrade.
 *
 * A real self-host run finished with `hostmint-…  state=activated`, a `live`
 * deletion attestation for `uid_c3f8c40a…`, no `tf_resources` row for it and no
 * open provider effect — while the wire had told the operator "the host mutated
 * nothing". That space could then never create the endpoint again: the
 * reservation id is derived from organization + space + Worker, and the address
 * of an activated reservation is immutable, so rebooting into a configuration
 * where every other space succeeded on the first attempt changed nothing.
 *
 * The refusal that produced it cannot happen any more, but a database that
 * already holds one has to come back, so the next mint repairs it under exactly
 * the fences a release goes through.
 */
test("repairs a reservation left activated for an endpoint that was never committed", async () => {
  const { authority, sql, advance } = fixture();
  await seedWorker(sql);
  const target = {
    organizationId: "org_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  } as const;
  const minted = await authority.mintForWorker(target);
  if (!minted) throw new Error("the fixture installation derives its own address");
  await sql.run(
    `INSERT INTO tf_resource_deletion_attestations
       (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
        state, closure_fence, effects_json, evidence_json, evidence_ref,
        evidence_effect_digest, evidence_checked_at, evidence_status, created_at, updated_at)
     VALUES ('org_01', 'uid-endpoint-wedged', ?, ?, 'WorkerEndpoint', ?, ?, 'live', 1, '[]',
             NULL, NULL, NULL, NULL, NULL, 0, 0)`,
    [TARGET.space, ENDPOINT_FORM.apiVersion, TARGET.endpointName, JSON.stringify(ENDPOINT_FORM)],
  );
  const assignment = await authority.assignEndpoint({
    organizationId: "org_01",
    reservationId: minted.reservationId,
    space: TARGET.space,
    endpointName: TARGET.endpointName,
    endpointResourceUid: "uid-endpoint-wedged",
    endpointResourceRevision: "1",
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
    providerPackRef: "fake",
    providerInstallationRef: "fake.primary",
  });
  await authority.activateEndpointAssignment({
    assignment,
    providerOutputs: {
      hostname: new URL(minted.canonicalPublicOrigin).hostname,
      url: `${minted.canonicalPublicOrigin}/`,
    },
  });
  expect(await sql.query("SELECT state FROM worker_endpoint_origin_reservations")).toEqual([
    { state: "activated" },
  ]);

  // A day later — long past the mint's own TTL, which is how an operator meets
  // this shape: after a restart, on the next apply.
  advance(25 * 60 * 60 * 1_000);
  expect(await authority.mintForWorker(target)).toMatchObject({
    reservationId: minted.reservationId,
    canonicalPublicOrigin: minted.canonicalPublicOrigin,
    status: "bound",
  });
  expect(
    await sql.query("SELECT state, endpoint_resource_uid FROM worker_endpoint_origin_reservations"),
  ).toEqual([{ state: "bound", endpoint_resource_uid: null }]);

  // And the same repair is refused while the endpoint may still be there: an
  // activated reservation for an endpoint that *is* committed stays activated.
  const live = fixture();
  await seedWorker(live.sql);
  const liveMint = await live.authority.mintForWorker(target);
  if (!liveMint) throw new Error("the fixture installation derives its own address");
  await seedEndpoint(live.sql, liveMint.canonicalPublicOrigin);
  const liveAssignment = await live.authority.assignEndpoint({
    organizationId: "org_01",
    reservationId: liveMint.reservationId,
    space: TARGET.space,
    endpointName: TARGET.endpointName,
    endpointResourceUid: "uid-endpoint-01",
    endpointResourceRevision: "1",
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
    providerPackRef: "fake",
    providerInstallationRef: "fake.primary",
  });
  await live.authority.activateEndpointAssignment({
    assignment: liveAssignment,
    providerOutputs: {
      hostname: new URL(liveMint.canonicalPublicOrigin).hostname,
      url: `${liveMint.canonicalPublicOrigin}/`,
    },
  });
  await expect(live.authority.mintForWorker(target)).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  });
  await expect(live.authority.releaseEndpointAssignment(liveAssignment)).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  });
  expect(
    await live.sql.query(
      "SELECT state, endpoint_resource_uid FROM worker_endpoint_origin_reservations",
    ),
  ).toEqual([{ state: "activated", endpoint_resource_uid: "uid-endpoint-01" }]);
});
/**
 * A database that already holds the wedge has to come back on upgrade.
 *
 * The fourth self-host run left one exactly like this. A `WorkerEndpoint`
 * create reached the provider, activated the reservation and opened the
 * endpoint's deletion attestation, and only then was the Host's own answer
 * refused against the Form — so the ledger held an `activated` reservation
 * naming an endpoint UID no `tf_resources` row would ever carry, its
 * attestation `live`, and its `apply` effect `dispatched` with no terminal
 * event. The refusal that produced it cannot happen any more, and the space was
 * still unable to create that endpoint on a Host rebooted into a configuration
 * where every other space succeeded on the first attempt: the derived id names
 * the destroyed Worker incarnation, so the next mint asks for a different
 * reservation, and release refuses an `activated` row outright.
 *
 * The incarnation provably produced nothing — no Resource, no live deployment,
 * and its one effect belongs to a command this Host itself refused and recorded
 * — and the address is derived, so the mint that takes it back publishes at the
 * identical origin. There is nothing to rob and nothing to reallocate.
 */
test("repairs a reservation activated on an endpoint incarnation that produced nothing", async () => {
  const { authority, sql } = fixture();
  await seedWorker(sql);
  const wedged = await authority.mintForWorker({
    organizationId: "org_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  });
  if (!wedged) throw new Error("the fixture installation derives its own address");
  await seedEndpoint(sql, wedged.canonicalPublicOrigin);
  const assignment = await authority.assignEndpoint({
    organizationId: "org_01",
    reservationId: wedged.reservationId,
    space: TARGET.space,
    endpointName: TARGET.endpointName,
    endpointResourceUid: "uid-endpoint-01",
    endpointResourceRevision: "1",
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
    providerPackRef: "fake",
    providerInstallationRef: "fake.primary",
  });
  await authority.activateEndpointAssignment({
    assignment,
    providerOutputs: {
      hostname: new URL(wedged.canonicalPublicOrigin).hostname,
      url: `${wedged.canonicalPublicOrigin}/`,
    },
  });

  // The wedge: the create was refused after activation, so no Resource and no
  // deployment were ever committed, and the `apply` effect stands dispatched
  // under a command that has not settled.
  await sql.run("DELETE FROM tf_resources WHERE tenant_id = 'org_01' AND uid = 'uid-endpoint-01'");
  await sql.run(
    "UPDATE tf_resource_deployments SET state = 'deleted' WHERE tenant_id = 'org_01' AND resource_uid = 'uid-endpoint-01'",
  );
  await sql.run(
    "DELETE FROM tf_resource_deployments WHERE tenant_id = 'org_01' AND resource_uid = 'uid-endpoint-01'",
  );
  for (const phase of ["planned", "dispatched"]) {
    await sql.run(
      `INSERT INTO tf_resource_provider_effects
         (tenant_id, resource_uid, event_id, effect_id, effect_kind, phase,
          operation_mode, provider_pack_ref, provider_installation_ref,
          native_id, target_json, created_at)
       VALUES ('org_01', 'uid-endpoint-01', ?, 'op_wedged', 'apply', ?, 'initial',
               NULL, NULL, NULL, NULL, ?)`,
      [`op_wedged:${phase}`, phase, Date.parse("2026-08-31T12:00:00.000Z")],
    );
  }
  // The Worker was destroyed and re-created, so the next mint derives a
  // different reservation id for the same address.
  await sql.run("DELETE FROM tf_resources WHERE tenant_id = 'org_01' AND uid = 'uid-worker-01'");
  await sql.run(
    "UPDATE tf_resource_deployments SET state = 'deleted' WHERE tenant_id = 'org_01' AND resource_uid = 'uid-worker-01'",
  );
  await seedWorker(sql, {
    organizationId: "org_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-02",
  });
  const target = {
    organizationId: "org_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-02",
  } as const;

  // While that command could still land, the address is not free. This is the
  // fence, and it is the same one that protects a genuinely in-flight create.
  await expect(authority.mintForWorker(target)).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  });
  expect(
    await sql.query(
      "SELECT state FROM worker_endpoint_origin_reservations WHERE reservation_id = ?",
      [wedged.reservationId],
    ),
  ).toEqual([{ state: "activated" }]);

  // The Host refused that command and said so in its own operation ledger.
  await sql.run(
    `INSERT INTO tf_operations (id, tenant_id, operation, state, resource_json, created_at, expires_at)
     VALUES ('op_wedged', 'org_01', 'apply', 'failed', NULL, '2026-08-31T12:00:00.000Z', ?)`,
    [Date.parse("2026-09-30T12:00:00.000Z")],
  );

  const repaired = await authority.mintForWorker(target);
  expect(repaired).toMatchObject({
    canonicalPublicOrigin: wedged.canonicalPublicOrigin,
    status: "bound",
    binding: { workerResourceUid: "uid-worker-02" },
  });
  expect(repaired?.reservationId).not.toBe(wedged.reservationId);
  expect(
    await sql.query(
      `SELECT reservation_id, state, endpoint_resource_uid
       FROM worker_endpoint_origin_reservations ORDER BY created_at`,
    ),
  ).toEqual([
    { reservation_id: wedged.reservationId, state: "released", endpoint_resource_uid: null },
    {
      reservation_id: repaired?.reservationId ?? "",
      state: "bound",
      endpoint_resource_uid: null,
    },
  ]);

  // And the repaired reservation is a reservation: the endpoint can be made,
  // at the same derived address.
  await seedEndpoint(sql, repaired?.canonicalPublicOrigin ?? "", ENDPOINT_FORM, {
    organizationId: "org_01",
    space: TARGET.space,
    endpointName: TARGET.endpointName,
    endpointResourceUid: "uid-endpoint-02",
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-02",
  });
  expect(
    await authority.assignEndpoint({
      organizationId: "org_01",
      reservationId: repaired?.reservationId ?? "",
      space: TARGET.space,
      endpointName: TARGET.endpointName,
      endpointResourceUid: "uid-endpoint-02",
      endpointResourceRevision: "1",
      workerName: TARGET.workerName,
      workerResourceUid: "uid-worker-02",
      providerPackRef: "fake",
      providerInstallationRef: "fake.primary",
    }),
  ).toMatchObject({ canonicalPublicOrigin: wedged.canonicalPublicOrigin });
});

/**
 * The sweep that takes the row is the mint's own, so the revival has to run
 * after it.
 *
 * The lane's only sweep is lazy: nothing ages a reservation on a timer, and the
 * row is moved to `expired` by the next call that reads it through `expire`.
 * Inside `mintForWorker` the only such call is `prepare`, which runs *after* the
 * revival — so the revival read a row that was still `bound`, declined it for
 * not being `expired`, and `prepare` then swept it and refused to replay a
 * terminal row. The state the revival was written for was unreachable from the
 * one caller that has it, and the first test to claim otherwise reached it by
 * asking `read` first, which a driver never does.
 *
 * The mint therefore sweeps its own row before asking whether to take it back.
 */
test("takes back its own aged-out reservation through the sweep the mint itself runs", async () => {
  const { authority, sql, advance } = fixture();
  await seedWorker(sql);
  const target = {
    organizationId: "org_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  } as const;
  const minted = await authority.mintForWorker(target);
  if (!minted) throw new Error("the fixture installation derives its own address");
  const created = await sql.query(
    "SELECT created_at, revision FROM worker_endpoint_origin_reservations",
  );

  advance(25 * 60 * 60 * 1_000);
  // Nothing has read the row, so nothing has swept it: this is exactly the
  // state an apply resumed the next morning finds.
  expect(
    await sql.query("SELECT state, endpoint_resource_uid FROM worker_endpoint_origin_reservations"),
  ).toEqual([{ state: "bound", endpoint_resource_uid: null }]);

  const again = await authority.mintForWorker(target);
  expect(again).toMatchObject({
    reservationId: minted.reservationId,
    canonicalPublicOrigin: minted.canonicalPublicOrigin,
    status: "bound",
    binding: { workerResourceUid: "uid-worker-01", workerResourceRevision: "1" },
  });
  // The same row, taken back — not a second reservation, and not a released one
  // replaced by a fresh id, which the derived id makes impossible anyway.
  expect(
    await sql.query(
      "SELECT reservation_id, state, created_at FROM worker_endpoint_origin_reservations",
    ),
  ).toEqual([
    {
      reservation_id: minted.reservationId,
      state: "bound",
      created_at: created[0]?.created_at ?? null,
    },
  ]);
  // Swept, then revived: two writes on top of the row the mint left.
  expect(
    Number(
      (await sql.query("SELECT revision FROM worker_endpoint_origin_reservations"))[0]?.revision,
    ),
  ).toBe(Number(created[0]?.revision) + 2);
  expect(
    Date.parse(String((await authority.read("org_01", minted.reservationId))?.expiresAt)),
  ).toBe(Date.parse("2026-09-01T13:00:00.000Z") + 24 * 60 * 60 * 1_000);

  // And it is still a reservation: the endpoint it was minted for can be made,
  // at the address the mint derived a day earlier.
  await seedEndpoint(sql, minted.canonicalPublicOrigin);
  expect(
    await authority.assignEndpoint({
      organizationId: "org_01",
      reservationId: minted.reservationId,
      space: TARGET.space,
      endpointName: TARGET.endpointName,
      endpointResourceUid: "uid-endpoint-01",
      endpointResourceRevision: "1",
      workerName: TARGET.workerName,
      workerResourceUid: "uid-worker-01",
      providerPackRef: "fake",
      providerInstallationRef: "fake.primary",
    }),
  ).toMatchObject({ canonicalPublicOrigin: minted.canonicalPublicOrigin });
});

/**
 * Expiry is not a licence to reallocate an address something is answering on.
 *
 * A reservation that *did* publish keeps the endpoint UID as a deletion
 * witness, and ADR 0004 keeps an expired row holding one inside both uniqueness
 * constraints. So the day-old row is taken back only on the same proof a
 * release needs: the endpoint Resource absent, its deletion attestation
 * settled, and no provider deployment outside `deleted`/`failed`.
 */
test("keeps an aged-out reservation that published an endpoint until that endpoint is gone", async () => {
  const { authority, sql, advance } = fixture();
  await seedWorker(sql);
  const target = {
    organizationId: "org_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  } as const;
  const minted = await authority.mintForWorker(target);
  if (!minted) throw new Error("the fixture installation derives its own address");
  await seedEndpoint(sql, minted.canonicalPublicOrigin);
  await authority.assignEndpoint({
    organizationId: "org_01",
    reservationId: minted.reservationId,
    space: TARGET.space,
    endpointName: TARGET.endpointName,
    endpointResourceUid: "uid-endpoint-01",
    endpointResourceRevision: "1",
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
    providerPackRef: "fake",
    providerInstallationRef: "fake.primary",
  });

  advance(25 * 60 * 60 * 1_000);
  expect(await authority.read("org_01", minted.reservationId)).toBeNull();
  expect(
    await sql.query("SELECT state, endpoint_resource_uid FROM worker_endpoint_origin_reservations"),
  ).toEqual([{ state: "expired", endpoint_resource_uid: "uid-endpoint-01" }]);
  // The endpoint is still there, so the origin is still spoken for.
  await expect(authority.mintForWorker(target)).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  });
  expect(
    await sql.query("SELECT state, endpoint_resource_uid FROM worker_endpoint_origin_reservations"),
  ).toEqual([{ state: "expired", endpoint_resource_uid: "uid-endpoint-01" }]);

  await sql.run("DELETE FROM tf_resources WHERE tenant_id = 'org_01' AND uid = 'uid-endpoint-01'");
  await sql.run(
    "UPDATE tf_resource_deployments SET state = 'deleted' WHERE tenant_id = 'org_01' AND resource_uid = 'uid-endpoint-01'",
  );
  await sql.run(
    "UPDATE tf_resource_deletion_attestations SET state = 'closed' WHERE tenant_id = 'org_01' AND resource_uid = 'uid-endpoint-01'",
  );
  expect(await authority.mintForWorker(target)).toMatchObject({
    reservationId: minted.reservationId,
    canonicalPublicOrigin: minted.canonicalPublicOrigin,
    status: "bound",
  });
  expect(
    await sql.query("SELECT state, endpoint_resource_uid FROM worker_endpoint_origin_reservations"),
  ).toEqual([{ state: "bound", endpoint_resource_uid: null }]);
});

/**
 * A Worker's readiness is derived, and the condition on its row is a cache.
 *
 * Nothing re-renders a ModuleWorker when a *dependent* is created, so through a
 * whole first `tofu apply` the row still says what it said when it was made:
 * "has no active WorkerDeployment". The deployment lands, the endpoint is
 * created a moment later, and a reservation that read the cache refused a
 * Worker that had been serving for a second — `resource_busy` 409 once, then
 * the identical apply succeeded, because the second run's refresh read the
 * Worker and re-rendered it.
 */
test("binds a Worker that is serving now, whatever its cached Ready condition still says", async () => {
  const { authority, sql } = fixture();
  await seedWorker(sql);
  await setWorkerCondition(sql, "uid-worker-01", {
    type: "Ready",
    status: "False",
    reason: "Provisioning",
    lastTransitionTime: "2026-08-31T12:00:00.000Z",
  });

  const minted = await authority.mintForWorker({
    organizationId: "org_01",
    space: TARGET.space,
    workerName: TARGET.workerName,
    workerResourceUid: "uid-worker-01",
  });
  expect(minted).toMatchObject({ status: "bound" });
});

test("refuses a Worker that is not serving, whatever its cached Ready condition claims", async () => {
  const { authority, sql } = fixture();
  await seedWorker(sql);
  // The cache says Ready. The deployment that made it so is gone, so the
  // Worker serves nothing and there is no address to reserve for it.
  await sql.run("DELETE FROM tf_resources WHERE kind = 'WorkerDeployment'");

  await expect(
    authority.mintForWorker({
      organizationId: "org_01",
      space: TARGET.space,
      workerName: TARGET.workerName,
      workerResourceUid: "uid-worker-01",
    }),
  ).rejects.toMatchObject({ code: "conflict", status: 409 });
});

async function setWorkerCondition(
  sql: ReturnType<typeof createReservationV2Sql>,
  uid: string,
  condition: Record<string, string>,
): Promise<void> {
  const rows = await sql.query("SELECT resource_json FROM tf_resources WHERE uid = ?", [uid]);
  const raw = rows[0]?.resource_json;
  if (typeof raw !== "string") throw new Error(`no resource row for ${uid}`);
  const resource = JSON.parse(raw) as { status: { conditions: unknown[] } };
  resource.status.conditions = [condition];
  await sql.run("UPDATE tf_resources SET resource_json = ? WHERE uid = ?", [
    JSON.stringify(resource),
    uid,
  ]);
}

function testExecutionAuthority(tenantId: string, resourceUid: string, operationId: string) {
  return {
    tenantId,
    resourceUid,
    leaseToken: `pmlease_${operationId}`,
    fingerprint: `test:${operationId}`,
  };
}
