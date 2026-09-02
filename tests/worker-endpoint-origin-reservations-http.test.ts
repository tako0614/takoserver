import { expect, test } from "bun:test";
import type { Accounts } from "../src/auth.ts";
import { createControlRoutes } from "../src/control.ts";
import { createRouter } from "../src/router.ts";
import {
  WORKER_ENDPOINT_ORIGIN_RESERVATION_ACTIVATION_FORMAT,
  WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
  WorkerEndpointOriginReservationError,
  type WorkerEndpointOriginReservations,
} from "../src/worker-endpoint-origin-reservations.ts";

const PROJECTION = {
  format: WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
  reservationId: "reservation_01",
  requestedSubdomain: "community-public",
  canonicalPublicOrigin: "https://community-public.workers.test",
  revision: "1",
  expiresAt: "2026-08-31T12:10:00.000Z",
  status: "prepared",
} as const;

function fixture(prepareRefusal?: WorkerEndpointOriginReservationError) {
  const prepareCalls: unknown[] = [];
  const activationCalls: unknown[] = [];
  const originReservations: WorkerEndpointOriginReservations = {
    async prepare(input) {
      prepareCalls.push(input);
      if (prepareRefusal) throw prepareRefusal;
      return PROJECTION;
    },
    async read() {
      return PROJECTION;
    },
    async release() {},
    async mintForWorker() {
      throw new Error("not called");
    },
    async bind() {
      throw new Error("not called");
    },
    async inspectBound() {
      throw new Error("not called");
    },
    async activate(input) {
      activationCalls.push(input);
      return PROJECTION;
    },
    async deactivate(input) {
      activationCalls.push(input);
      return PROJECTION;
    },
    async assignEndpoint() {
      throw new Error("not called");
    },
    async cancelEndpointAssignment() {
      throw new Error("not called");
    },
    async releaseEndpointAssignment() {
      throw new Error("not called");
    },
    async activateEndpointAssignment() {
      throw new Error("not called");
    },
    async endpointAssignment() {
      throw new Error("not called");
    },
    async deactivateEndpointAssignment() {
      throw new Error("not called");
    },
  };
  const accounts = {
    async authenticate(authorization: string | null) {
      if (authorization !== "Bearer organization-key") return null;
      return {
        hostPrincipalId: "api-key-principal",
        principalId: "owner-principal",
        organizationId: "org_from_key",
        scopes: ["resources:write"],
        kind: "api_key",
      } as const;
    },
  } as Pick<Accounts, "authenticate"> as Accounts;
  const control = createControlRoutes({
    accounts,
    inventory: {} as never,
    deployments: {} as never,
    attachments: {} as never,
    migrations: {} as never,
    forms: [],
    identityProviders: [],
    ledger: {} as never,
    catalog: {} as never,
    reseller: {} as never,
    tokens: {} as never,
    settlement: {} as never,
    clock: () => new Date("2026-08-31T12:00:00.000Z"),
    originReservations,
  });
  return {
    prepareCalls,
    activationCalls,
    fetch: createRouter({ control, publicOrigin: "https://api.example.test" }),
  };
}

function request(body: unknown, suffix = ""): Request {
  return new Request(
    `https://api.example.test/v1/worker-endpoint-origin-reservations/reservation_01${suffix}`,
    {
      method: "PUT",
      headers: {
        authorization: "Bearer organization-key",
        "content-type": "application/json",
        origin: "https://generic-client.example",
      },
      body: JSON.stringify(body),
    },
  );
}

test("HTTP prepare accepts only a requested subdomain and derives organization authority from auth", async () => {
  const { fetch, prepareCalls } = fixture();
  const response = await fetch(
    request({
      format: WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
      requestedSubdomain: "community-public",
      offeringId: "worker.module.test",
      expiresInSeconds: 600,
    }),
  );

  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(PROJECTION);
  expect(prepareCalls).toEqual([
    {
      organizationId: "org_from_key",
      reservationId: "reservation_01",
      requestedSubdomain: "community-public",
      offeringId: "worker.module.test",
      expiresInSeconds: 600,
    },
  ]);
  expect(JSON.stringify(prepareCalls)).not.toMatch(/target|space|workerName|endpointName/);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

test("HTTP prepare rejects the retired v1 target and any body organization override", async () => {
  const { fetch, prepareCalls } = fixture();
  for (const body of [
    {
      format: "takoserver.worker-endpoint-origin-reservation.v1",
      target: { space: "default", workerName: "community", endpointName: "public" },
      expiresInSeconds: 600,
    },
    {
      format: WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
      organizationId: "org_from_body",
      requestedSubdomain: "community-public",
      expiresInSeconds: 600,
    },
  ]) {
    const response = await fetch(request(body));
    expect(response.status).toBe(400);
  }
  expect(prepareCalls).toEqual([]);
});

test("HTTP activation accepts only the endpoint UID and never a restated worker identity", async () => {
  const { fetch, activationCalls } = fixture();
  const activated = await fetch(
    request(
      {
        format: WORKER_ENDPOINT_ORIGIN_RESERVATION_ACTIVATION_FORMAT,
        endpointResourceUid: "uid-endpoint-01",
      },
      "/activation",
    ),
  );
  expect(activated.status).toBe(200);
  expect(activationCalls).toEqual([
    {
      organizationId: "org_from_key",
      reservationId: "reservation_01",
      endpointResourceUid: "uid-endpoint-01",
    },
  ]);

  const restated = await fetch(
    request(
      {
        format: WORKER_ENDPOINT_ORIGIN_RESERVATION_ACTIVATION_FORMAT,
        endpointResourceUid: "uid-endpoint-01",
        workerName: "community",
      },
      "/activation",
    ),
  );
  expect(restated.status).toBe(400);
  expect(activationCalls).toHaveLength(1);
});

/**
 * A Host-minted reservation is one no caller may write to, and one every
 * caller may read.
 *
 * Writing is what the fence is for: the id is derived from an address the
 * tenant knows, so a row a caller planted at that id would be adopted as one
 * this Host made. Reading it is the tenant's own derived origin, already scoped
 * to the authenticated organization — and refusing that would leave a tenant
 * unable to see the address their own Worker was given.
 */
test("the Host-minted namespace refuses every write and answers a read", async () => {
  const { fetch, prepareCalls, activationCalls } = fixture();
  const minted = "hostmint-0000000000000000000000000000000000000000";
  const call = (method: string, suffix = "", body?: unknown) =>
    fetch(
      new Request(
        `https://api.example.test/v1/worker-endpoint-origin-reservations/${minted}${suffix}`,
        {
          method,
          headers: {
            authorization: "Bearer organization-key",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      ),
    );

  for (const [method, suffix, body] of [
    [
      "PUT",
      "",
      {
        format: WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
        requestedSubdomain: "community-public",
        expiresInSeconds: 600,
      },
    ],
    ["DELETE", "", undefined],
    [
      "PUT",
      "/activation",
      {
        format: WORKER_ENDPOINT_ORIGIN_RESERVATION_ACTIVATION_FORMAT,
        endpointResourceUid: "uid-endpoint-01",
      },
    ],
    [
      "DELETE",
      "/activation",
      {
        format: WORKER_ENDPOINT_ORIGIN_RESERVATION_ACTIVATION_FORMAT,
        endpointResourceUid: "uid-endpoint-01",
      },
    ],
  ] as const) {
    expect((await call(method, suffix, body)).status).toBe(404);
  }
  expect(prepareCalls).toEqual([]);
  expect(activationCalls).toEqual([]);

  expect((await call("GET")).status).toBe(200);
});

/**
 * The reseller reading this route gets the same sentence as everybody else.
 *
 * A reservation refused because *this deployment* cannot publish the address it
 * would derive is the caller's to act on but not the caller's to have caused,
 * and `unsupported_capability` alone says which of those two it is and nothing
 * about which knob to turn. The boot diagnostic and the Takoform Host lane both
 * name the remedies; so does this.
 */
test("a reservation refused by this deployment's own configuration says which knob to turn", async () => {
  const remedy =
    "no Worker endpoint can be published here: this deployment's address is plain HTTP, " +
    "and WorkerEndpoint@0.1.0 admits only https on the default port.";
  const { fetch } = fixture(
    new WorkerEndpointOriginReservationError("unsupported_capability", 422, remedy),
  );
  const response = await fetch(
    request({
      format: WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
      requestedSubdomain: "community-public",
      expiresInSeconds: 600,
    }),
  );
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    error: { code: "unsupported_capability", message: remedy, retryable: false },
  });
});
