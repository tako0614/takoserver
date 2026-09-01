import { expect, test } from "bun:test";
import { buildEdgeForms, edgeProviderOffering } from "../src/edge-forms.ts";
import {
  createCatalog,
  createEphemeralSql,
  createLedger,
  createResourceDeploymentStore,
  type InstalledTakoformForm,
  type Offering,
} from "../src/index.ts";
import { createProviderDriver } from "../src/provider-driver.ts";
import {
  type ApplyInput,
  failed,
  type Provider,
  type ProviderOffering,
  succeeded,
} from "../src/provider-port.ts";
import type { TakoformDriverRelation, TakoformStoredResource } from "../src/takoform/types.ts";
import {
  type WorkerEndpointOriginAssignment,
  WorkerEndpointOriginReservationError,
} from "../src/worker-endpoint-origin-reservations.ts";

const clock = () => new Date("2026-09-01T00:00:00.000Z");
const tenantId = "org_endpoint_assignment";
const workerUid = "uid-worker";
const endpointUid = "uid-endpoint";

function workerRelation(worker: InstalledTakoformForm): TakoformDriverRelation {
  return {
    pointer: "/worker",
    relation: "/worker",
    targetUid: workerUid,
    resource: {
      apiVersion: worker.identity.formRef.apiVersion,
      kind: "ModuleWorker",
      form: worker.identity,
      metadata: {
        name: "community",
        space: "default",
        uid: workerUid,
        generation: "1",
        revision: "1",
      },
      spec: {},
      status: { observedGeneration: "1", conditions: [] },
    },
  };
}

function endpointResource(endpoint: InstalledTakoformForm): TakoformStoredResource {
  return {
    apiVersion: endpoint.identity.formRef.apiVersion,
    kind: "WorkerEndpoint",
    form: endpoint.identity,
    metadata: {
      name: "public",
      space: "default",
      uid: endpointUid,
      generation: "1",
      revision: "1",
    },
    spec: {
      worker: {
        apiVersion: "edge.forms.takoform.com/v1beta1",
        kind: "ModuleWorker",
        name: "community",
      },
    },
    status: { observedGeneration: "1", conditions: [] },
  };
}

function assignment(): WorkerEndpointOriginAssignment {
  return {
    format: "takoserver.worker-endpoint-origin-assignment.v1",
    organizationId: tenantId,
    reservationId: "reservation-01",
    reservationRevision: "3",
    canonicalPublicOrigin: "https://reserved.endpoint.test",
    assignmentDigest: `sha256:${"e".repeat(64)}`,
    endpoint: { space: "default", name: "public", uid: endpointUid, revision: "1" },
    worker: { name: "community", uid: workerUid, revision: "1" },
    placement: { providerPackRef: "fake", providerInstallationRef: "fake.primary" },
  };
}

function soldEndpoint(offering: ProviderOffering): Offering {
  return {
    id: offering.id,
    providerPackRef: "fake",
    providerInstallationRef: "fake.primary",
    supplyContractRef: "fake.endpoint.contract",
    pricePlanRef: "fake.endpoint.price",
    resourceClass: "worker.endpoint",
    deliveryMode: "managed-endpoint",
    supportPolicyRef: "support:test",
    abusePolicyRef: "abuse:test",
    kind: offering.kind,
    displayName: offering.displayName,
    form: offering.form,
    pricePlan: {
      id: "fake.endpoint.price",
      currency: "USD",
      provisioning: { meter: "resource.create", amountMinor: 500 },
      meters: [],
    },
    providedInterfaces: [],
    bindingRefs: [],
    regions: [],
    portability: { api: "portable", exportFormats: [], importFormats: [], migrationModes: [] },
    isolation: "shared-resource",
    available: true,
  };
}

async function fixture(input: {
  readonly priced?: boolean;
  readonly apply?: (input: ApplyInput) => ReturnType<Provider["apply"]>;
  readonly recoverDelete?: Provider["recoverDelete"];
  readonly activationFails?: boolean;
  readonly assignmentAckLost?: boolean;
}) {
  const sql = createEphemeralSql();
  const deployments = createResourceDeploymentStore(sql, clock);
  const bundle = await buildEdgeForms();
  const worker = bundle.forms.find(
    (candidate) => candidate.identity.formRef.kind === "ModuleWorker",
  );
  const endpoint = bundle.forms.find(
    (candidate) => candidate.identity.formRef.kind === "WorkerEndpoint",
  );
  if (!worker || !endpoint) throw new Error("released Worker Forms missing");
  const endpointOffering = edgeProviderOffering(endpoint, { id: "fake.endpoint" });
  const recoverDelete = input.recoverDelete;
  const events: string[] = [];
  const providerInputs: ApplyInput[] = [];
  const provider: Provider = {
    id: "fake",
    offerings: [endpointOffering],
    async apply(providerInput) {
      events.push("provider.apply");
      providerInputs.push(providerInput);
      if (input.apply) return await input.apply(providerInput);
      return succeeded({
        nativeId: `endpoint:${endpointUid}`,
        observed: { assigned: true },
        outputs: { hostname: "reserved.endpoint.test", url: "https://reserved.endpoint.test/" },
      });
    },
    async recoverApply() {
      events.push("provider.recover-read-only");
      return failed("not_found", "read-only recovery must not resume the command");
    },
    async convergeApply(providerInput) {
      events.push("provider.converge");
      providerInputs.push(providerInput);
      return succeeded({
        nativeId: `endpoint:${endpointUid}`,
        observed: { assigned: true },
        outputs: { hostname: "reserved.endpoint.test", url: "https://reserved.endpoint.test/" },
      });
    },
    async observe() {
      return failed("not_found", "not used");
    },
    async delete(deleteInput) {
      events.push("provider.delete");
      return succeeded({
        nativeId: deleteInput.nativeId,
        observed: { deleted: true },
        outputs: {},
      });
    },
    ...(recoverDelete
      ? {
          async recoverDelete(deleteInput) {
            events.push("provider.recoverDelete");
            return await recoverDelete(deleteInput);
          },
        }
      : {}),
  };
  const exactAssignment = assignment();
  let assignmentLookup: WorkerEndpointOriginAssignment | null = exactAssignment;
  let assignCalls = 0;
  let cancelCalls = 0;
  let activateCalls = 0;
  let deactivateCalls = 0;
  const originReservations = {
    async assignEndpoint() {
      events.push("reservation.assign");
      assignCalls += 1;
      if (input.assignmentAckLost && assignCalls === 1) {
        // The row was committed by the reservation authority, but the Worker
        // process disappeared before receiving the assignment projection.
        assignmentLookup = exactAssignment;
        throw new WorkerEndpointOriginReservationError("backend_unavailable", 503);
      }
      return exactAssignment;
    },
    async cancelEndpointAssignment(value: WorkerEndpointOriginAssignment) {
      expect(value).toEqual(exactAssignment);
      events.push("reservation.cancel");
      cancelCalls += 1;
    },
    async activateEndpointAssignment(value: {
      readonly assignment: WorkerEndpointOriginAssignment;
      readonly providerOutputs: Readonly<Record<string, unknown>>;
    }) {
      expect(value.assignment).toEqual(exactAssignment);
      events.push("reservation.activate");
      activateCalls += 1;
      if (input.activationFails) {
        throw new WorkerEndpointOriginReservationError("conflict", 409);
      }
      return exactAssignment;
    },
    async endpointAssignment() {
      events.push("reservation.lookup");
      return assignmentLookup;
    },
    async deactivateEndpointAssignment(value: WorkerEndpointOriginAssignment) {
      expect(value).toEqual(exactAssignment);
      events.push("reservation.deactivate");
      deactivateCalls += 1;
    },
  };
  await deployments.create({
    tenantId,
    id: "deployment-worker",
    resourceUid: workerUid,
    offeringId: "fake.worker",
    providerPackRef: "fake",
    providerInstallationRef: "fake.primary",
    nativeId: `worker:${workerUid}`,
    state: "active",
    observed: {},
    outputs: { scriptName: "community" },
  });
  const driver = createProviderDriver({
    providers: [provider],
    catalog: createCatalog(input.priced ? [soldEndpoint(endpointOffering)] : []),
    ledger: createLedger(sql, clock),
    deployments,
    originReservations,
  });
  const applyInput = {
    operationId: "operation-endpoint",
    operationKey: "key-endpoint",
    tenantId,
    resourceUid: endpointUid,
    form: endpoint,
    name: "public",
    space: "default",
    spec: endpointResource(endpoint).spec,
    relations: [workerRelation(worker)],
  } as const;
  return {
    driver,
    deployments,
    endpoint,
    applyInput,
    events,
    providerInputs,
    calls: () => ({ assignCalls, cancelCalls, activateCalls, deactivateCalls }),
    setAssignmentLookup(value: WorkerEndpointOriginAssignment | null) {
      assignmentLookup = value;
    },
  };
}

test("WorkerEndpoint create requires a private reservation before provider dispatch", async () => {
  const context = await fixture({});
  await expect(context.driver.apply(context.applyInput)).rejects.toMatchObject({
    code: "unsupported_capability",
    status: 422,
  });
  expect(context.events).toEqual([]);
});

test("a priced pre-dispatch refusal exact-cancels the assigned endpoint", async () => {
  const context = await fixture({ priced: true });
  await expect(
    context.driver.apply({
      ...context.applyInput,
      workerEndpointOriginReservationId: "reservation-01",
    }),
  ).rejects.toMatchObject({ code: "insufficient_funds", status: 402 });
  expect(context.events).toEqual(["reservation.assign", "reservation.cancel"]);
  expect(context.calls()).toEqual({
    assignCalls: 1,
    cancelCalls: 1,
    activateCalls: 0,
    deactivateCalls: 0,
  });
});

test("provider dispatch never cancels and activation gates the successful receipt", async () => {
  const context = await fixture({ activationFails: true });
  await expect(
    context.driver.apply({
      ...context.applyInput,
      workerEndpointOriginReservationId: "reservation-01",
    }),
  ).rejects.toMatchObject({ code: "resource_busy", status: 409 });
  expect(context.events).toEqual(["reservation.assign", "provider.apply", "reservation.activate"]);
  expect(context.calls()).toEqual({
    assignCalls: 1,
    cancelCalls: 0,
    activateCalls: 1,
    deactivateCalls: 0,
  });
  expect(context.providerInputs[0]?.workerEndpointOriginAssignment).toEqual({
    canonicalPublicOrigin: "https://reserved.endpoint.test",
    assignmentDigest: `sha256:${"e".repeat(64)}`,
  });
  expect(context.providerInputs[0]).not.toHaveProperty("workerEndpointOriginReservationId");
});

test("WorkerEndpoint updates re-resolve the durable assignment instead of a logical hostname", async () => {
  const context = await fixture({});
  await context.driver.apply({
    ...context.applyInput,
    workerEndpointOriginReservationId: "reservation-01",
  });
  context.events.length = 0;
  await context.driver.apply({
    ...context.applyInput,
    operationId: "operation-endpoint-update",
    operationKey: "key-endpoint-update",
  });
  expect(context.events).toEqual(["reservation.lookup", "provider.apply", "reservation.activate"]);
  expect(context.providerInputs[1]?.workerEndpointOriginAssignment).toEqual(
    context.providerInputs[0]?.workerEndpointOriginAssignment,
  );
});

test("recovery convergence resumes the exact assignment after process death before provider call", async () => {
  const context = await fixture({ assignmentAckLost: true });
  const command = {
    ...context.applyInput,
    workerEndpointOriginReservationId: "reservation-01",
  } as const;
  await expect(context.driver.apply(command)).rejects.toMatchObject({
    code: "backend_unavailable",
    status: 503,
  });
  expect(context.events).toEqual(["reservation.assign"]);

  const recovered = await context.driver.apply({ ...command, operationMode: "recovery" });
  expect(recovered.outputs).toMatchObject({ hostname: "reserved.endpoint.test" });
  expect(context.events).toEqual([
    "reservation.assign",
    "reservation.assign",
    "provider.converge",
    "reservation.activate",
  ]);
  expect(context.calls()).toEqual({
    assignCalls: 2,
    cancelCalls: 0,
    activateCalls: 1,
    deactivateCalls: 0,
  });
  expect(context.providerInputs).toHaveLength(1);
  expect(context.providerInputs[0]?.operationId).toBe(command.operationId);
  expect(context.providerInputs[0]?.workerEndpointOriginAssignment).toEqual({
    canonicalPublicOrigin: "https://reserved.endpoint.test",
    assignmentDigest: `sha256:${"e".repeat(64)}`,
  });
});

test("delete recovery settles the exact provider tombstone before reservation deactivation", async () => {
  const context = await fixture({
    recoverDelete: async (input) =>
      succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} }),
  });
  await context.deployments.create({
    tenantId,
    id: "deployment-endpoint",
    resourceUid: endpointUid,
    offeringId: "fake.endpoint",
    providerPackRef: "fake",
    providerInstallationRef: "fake.primary",
    nativeId: `endpoint:${endpointUid}`,
    state: "active",
    observed: {},
    outputs: {},
  });
  const worker = (await buildEdgeForms()).forms.find(
    (candidate) => candidate.identity.formRef.kind === "ModuleWorker",
  );
  if (!worker) throw new Error("released ModuleWorker Form missing");
  await context.driver.delete({
    operationId: "operation-endpoint-delete",
    operationMode: "recovery",
    tenantId,
    resourceUid: endpointUid,
    resource: endpointResource(context.endpoint),
    relations: [workerRelation(worker)],
  });
  expect(context.events).toEqual([
    "reservation.lookup",
    "provider.recoverDelete",
    "reservation.deactivate",
  ]);
  expect(context.calls().deactivateCalls).toBe(1);
});
