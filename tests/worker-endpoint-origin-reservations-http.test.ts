import { expect, test } from "bun:test";
import type { Accounts } from "../src/auth.ts";
import { createControlRoutes } from "../src/control.ts";
import { createRouter } from "../src/router.ts";
import {
  WORKER_ENDPOINT_ORIGIN_RESERVATION_ACTIVATION_FORMAT,
  WORKER_ENDPOINT_ORIGIN_RESERVATION_FORMAT,
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

function fixture() {
  const prepareCalls: unknown[] = [];
  const activationCalls: unknown[] = [];
  const originReservations: WorkerEndpointOriginReservations = {
    async prepare(input) {
      prepareCalls.push(input);
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
