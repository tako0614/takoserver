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
  type ResourceIdentity,
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
  readonly observe?: Provider["observe"];
  readonly recoverDelete?: Provider["recoverDelete"];
  readonly activationFails?: boolean;
  readonly assignmentAckLost?: boolean;
  /** Fails the wallet capture, which is the one step after activation. */
  readonly captureFails?: boolean;
  /** Whether this installation derives its own endpoint address. */
  readonly hostMintsReservation?: boolean;
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
    async observe(observeInput) {
      if (input.observe) return await input.observe(observeInput);
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
  let releaseCalls = 0;
  let activateCalls = 0;
  let deactivateCalls = 0;
  const originReservations = {
    async mintForWorker() {
      events.push("reservation.mint");
      return input.hostMintsReservation === false
        ? null
        : ({
            organizationId: tenantId,
            reservationId: "hostmint-minted",
            canonicalPublicOrigin: exactAssignment.canonicalPublicOrigin,
            revision: "1",
            expiresAtEpochMilliseconds: Date.now() + 3_600_000,
            requestedSubdomain: "community",
            binding: {
              space: "default",
              workerName: "community",
              workerResourceUid: workerUid,
              workerResourceRevision: "1",
            },
            status: "bound",
            providerPackRef: "fake",
            providerInstallationRef: "fake.primary",
            offeringId: "fake.endpoint",
            offeringDigest: `sha256:${"a".repeat(64)}`,
          } as const);
    },
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
    async releaseEndpointAssignment(value: WorkerEndpointOriginAssignment) {
      expect(value).toEqual(exactAssignment);
      events.push("reservation.release");
      releaseCalls += 1;
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
  const ledger = createLedger(sql, clock);
  if (input.captureFails) {
    await ledger.fund({
      organizationId: tenantId,
      fundingRef: "funding-endpoint-release",
      amountMinor: 5_000,
    });
  }
  const driver = createProviderDriver({
    providers: [provider],
    catalog: createCatalog(input.priced ? [soldEndpoint(endpointOffering)] : []),
    ledger: input.captureFails
      ? {
          ...ledger,
          async capture() {
            events.push("ledger.capture-failed");
            throw new Error("wallet capture failed");
          },
        }
      : ledger,
    deployments,
    originReservations,
  });
  const applyInput = {
    operationId: "operation-endpoint",
    operationKey: "key-endpoint",
    executionAuthority: {
      tenantId,
      resourceUid: endpointUid,
      leaseToken: "lease-endpoint",
      fingerprint: "fingerprint-endpoint",
    },
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
    calls: () => ({ assignCalls, cancelCalls, releaseCalls, activateCalls, deactivateCalls }),
    setAssignmentLookup(value: WorkerEndpointOriginAssignment | null) {
      assignmentLookup = value;
    },
  };
}

/**
 * The reservation an ordinary organization API key never had.
 *
 * The reservation id is minted only through the reseller lane's scoped run
 * token, and the released provider's `takoform_worker_endpoint` has no input
 * for one, so an ordinary key could never create a WorkerEndpoint: the 14th
 * resource of a Worker graph was unreachable and `launch_url` never resolved.
 * On an installation whose endpoint address is derived from the Worker anyway,
 * the Host reserves on the caller's behalf and the apply consumes it exactly
 * as if a reseller had supplied one.
 */
test("an ordinary key gets a Host-minted reservation when the address is derived", async () => {
  const context = await fixture({});
  await context.driver.apply(context.applyInput);
  expect(context.events).toEqual([
    "reservation.mint",
    "reservation.assign",
    "provider.apply",
    "reservation.activate",
  ]);
});

test("WorkerEndpoint create is refused where no address is derived and none was supplied", async () => {
  const context = await fixture({ hostMintsReservation: false });
  await expect(context.driver.apply(context.applyInput)).rejects.toMatchObject({
    code: "unsupported_capability",
    status: 422,
  });
  expect(context.events).toEqual(["reservation.mint"]);
});

test("a supplied reservation is used as it is, and nothing is minted beside it", async () => {
  const context = await fixture({});
  await context.driver.apply({
    ...context.applyInput,
    workerEndpointOriginReservationId: "reservation-01",
  });
  expect(context.events).toEqual(["reservation.assign", "provider.apply", "reservation.activate"]);
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
    releaseCalls: 0,
    activateCalls: 0,
    deactivateCalls: 0,
  });
});

/**
 * An assignment that never activated is let go of, whatever the provider did.
 *
 * It used to be released only when the provider had not been entered, on the
 * reasoning that a dispatched mutation might have landed. What that left behind
 * was worse: the reservation stayed bound to an endpoint UID whose Resource was
 * never committed, whose deletion attestation was opened `live` by the
 * incarnation reservation and could therefore never close, so every later apply
 * — under the fresh UID a re-created resource always has — was refused
 * `resource_busy` 409 until the reservation aged out a day later.
 *
 * Releasing it reallocates nothing. The reservation stays bound and still owns
 * its canonical origin under the live uniqueness constraint; only the witness
 * for an endpoint this Host does not have goes. Activation still gates the
 * receipt, and the reservation id still never crosses the Provider port.
 */
test("releases an assignment the provider never got activated, and gates the receipt", async () => {
  const context = await fixture({ activationFails: true });
  await expect(
    context.driver.apply({
      ...context.applyInput,
      workerEndpointOriginReservationId: "reservation-01",
    }),
  ).rejects.toMatchObject({ code: "resource_busy", status: 409 });
  expect(context.events).toEqual([
    "reservation.assign",
    "provider.apply",
    "reservation.activate",
    "reservation.cancel",
  ]);
  expect(context.calls()).toEqual({
    assignCalls: 1,
    cancelCalls: 1,
    releaseCalls: 0,
    activateCalls: 1,
    deactivateCalls: 0,
  });
  expect(context.providerInputs[0]?.workerEndpointOriginAssignment).toEqual({
    canonicalPublicOrigin: "https://reserved.endpoint.test",
    assignmentDigest: `sha256:${"e".repeat(64)}`,
  });
  expect(context.providerInputs[0]).not.toHaveProperty("workerEndpointOriginReservationId");
});

/**
 * A receipt the Form cannot publish is refused before anything is activated.
 *
 * This is the exact shape a real self-host run left behind. The driver returned
 * outputs the released `WorkerEndpoint` Form refuses, the engine's own
 * projection check raised `invalid_argument` 400 — after the reservation had
 * been activated and the endpoint's deletion attestation opened — and the wire
 * told the operator "the host mutated nothing" while the ledger held an
 * activated reservation for an endpoint no `tf_resources` row would ever name.
 * That space could then never create the endpoint again: the reservation id is
 * derived from the Worker and an activated address is immutable.
 */
test("refuses a receipt its Form cannot publish before the assignment is activated", async () => {
  const context = await fixture({
    apply: async () =>
      succeeded({
        nativeId: `endpoint:${endpointUid}`,
        observed: { assigned: true },
        // `WorkerEndpoint@0.1.0` publishes `^https://<dotted-name>/$`.
        outputs: { hostname: "reserved.endpoint.test", url: "http://reserved.endpoint.test/" },
      }),
  });
  await expect(
    context.driver.apply({
      ...context.applyInput,
      workerEndpointOriginReservationId: "reservation-01",
    }),
  ).rejects.toMatchObject({ code: "invalid_argument", status: 400 });
  expect(context.events).toEqual(["reservation.assign", "provider.apply", "reservation.cancel"]);
  expect(context.calls()).toEqual({
    assignCalls: 1,
    cancelCalls: 1,
    releaseCalls: 0,
    activateCalls: 0,
    deactivateCalls: 0,
  });
});

/**
 * And when a refusal really does land after activation, it is given back.
 *
 * `cancelEndpointAssignment` pins the reservation revision it was handed, which
 * activation has already moved, so it could never reach an activated
 * assignment: the only path that existed did nothing at all. The wallet capture
 * is the one step this driver takes after activating, so it is the one that
 * proves the release.
 */
test("gives back an assignment whose mutation failed after it was activated", async () => {
  const context = await fixture({ priced: true, captureFails: true });
  await expect(
    context.driver.apply({
      ...context.applyInput,
      workerEndpointOriginReservationId: "reservation-01",
    }),
  ).rejects.toThrow("wallet capture failed");
  expect(context.events).toEqual([
    "reservation.assign",
    "provider.apply",
    "reservation.activate",
    "ledger.capture-failed",
    "reservation.release",
  ]);
  expect(context.calls()).toEqual({
    assignCalls: 1,
    cancelCalls: 0,
    releaseCalls: 1,
    activateCalls: 1,
    deactivateCalls: 0,
  });
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
    releaseCalls: 0,
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

test("observe forwards the exact deployment incarnation and Resource generation", async () => {
  let observedIdentity: ResourceIdentity | undefined;
  const context = await fixture({
    observe: async (input) => {
      observedIdentity = input.identity;
      return succeeded({ nativeId: input.nativeId, observed: {}, outputs: {} });
    },
  });
  await context.deployments.create({
    tenantId,
    id: "deployment-endpoint-observe",
    resourceUid: endpointUid,
    offeringId: "fake.endpoint",
    providerPackRef: "fake",
    providerInstallationRef: "fake.primary",
    nativeId: `endpoint:${endpointUid}`,
    state: "active",
    observed: {},
    outputs: {},
  });

  await context.driver.observe({
    tenantId,
    resourceUid: endpointUid,
    resource: endpointResource(context.endpoint),
    relations: [],
  });
  expect(observedIdentity).toEqual({
    tenantRef: tenantId,
    space: "default",
    name: "public",
    uid: endpointUid,
    incarnationId: "deployment-endpoint-observe",
    generation: "1",
  });
});

test("delete recovery settles the exact provider tombstone before reservation deactivation", async () => {
  let recoveredIdentity: ResourceIdentity | undefined;
  const context = await fixture({
    recoverDelete: async (input) => {
      recoveredIdentity = input.identity;
      return succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} });
    },
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
    executionAuthority: {
      tenantId,
      resourceUid: endpointUid,
      leaseToken: "lease-endpoint-delete",
      fingerprint: "fingerprint-endpoint-delete",
    },
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
  expect(recoveredIdentity).toEqual({
    tenantRef: tenantId,
    space: "default",
    name: "public",
    uid: endpointUid,
    incarnationId: "deployment-endpoint",
    generation: "1",
  });
});
