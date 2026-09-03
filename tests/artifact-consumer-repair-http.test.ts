import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_CONSUMER_REPAIR_APPLY_FORMAT,
  ARTIFACT_CONSUMER_REPAIR_STATUS_FORMAT,
  ARTIFACT_CONSUMER_RESOLUTION_RECEIPT_FORMAT,
  type ArtifactConsumerRepair,
} from "../src/artifact-consumer-repair.ts";
import type { Accounts, ApiKeyScope } from "../src/auth.ts";
import { createControlRoutes } from "../src/control.ts";

const ORGANIZATION = "org_repair_http";
const DEPLOYMENT = "dep_repair_http";
const PLAN = `sha256:${"a".repeat(64)}` as const;

describe("artifact consumer repair HTTP boundary", () => {
  test("GET requires resources:read and POST requires resources:write", async () => {
    const { request, calls } = fixture();

    const read = await request("GET", "reader");
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      repair: {
        kind: ARTIFACT_CONSUMER_REPAIR_STATUS_FORMAT,
        deploymentId: DEPLOYMENT,
        state: "actionable",
      },
    });

    expect((await request("POST", "reader", validApply(), "repair:http:reader")).status).toBe(403);
    const applied = await request("POST", "writer", validApply(), "repair:http:writer");
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      receipt: {
        kind: ARTIFACT_CONSUMER_RESOLUTION_RECEIPT_FORMAT,
        resolution: "terminalized_absent",
      },
    });
    expect(calls).toEqual([
      {
        tenantId: ORGANIZATION,
        deploymentId: DEPLOYMENT,
        idempotencyKey: "repair:http:writer",
        planDigest: PLAN,
      },
    ]);
  });

  test("POST rejects a missing idempotency key and every caller-asserted repair claim", async () => {
    const { request, calls } = fixture();
    expect((await request("POST", "writer", validApply())).status).toBe(400);

    for (const claim of [
      { outcome: "absent" },
      { manifestDigest: `sha256:${"b".repeat(64)}` },
      { evidence: { provider: "asserted-by-caller" } },
      { targetDigest: `sha256:${"c".repeat(64)}` },
      { bypassTenantUncertainty: true },
    ]) {
      const response = await request(
        "POST",
        "writer",
        { ...validApply(), ...claim },
        `repair:http:claim:${Object.keys(claim)[0]}`,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_argument" } });
    }
    expect(calls).toEqual([]);
  });

  test("authentication runs before optional backend availability is disclosed", async () => {
    const { request } = fixture(false);
    expect((await request("GET", "missing")).status).toBe(401);
    expect((await request("GET", "reader")).status).toBe(503);
  });
});

function fixture(enabled = true) {
  const calls: Parameters<ArtifactConsumerRepair["apply"]>[0][] = [];
  const repair: ArtifactConsumerRepair = {
    async status(_tenantId, deploymentId) {
      return {
        kind: ARTIFACT_CONSUMER_REPAIR_STATUS_FORMAT,
        deploymentId,
        state: "actionable",
        planDigest: PLAN,
        uncertaintyFence: 1,
        candidateManifestCount: 1,
        path: "retained-historical",
        action: "verify-artifact-consumption",
      };
    },
    async apply(input) {
      calls.push(input);
      return {
        kind: ARTIFACT_CONSUMER_RESOLUTION_RECEIPT_FORMAT,
        receiptId: "acr_http_fixture",
        deploymentId: input.deploymentId,
        uncertaintyFence: 1,
        planDigest: input.planDigest,
        resolution: "terminalized_absent",
        createdAt: "2026-09-03T20:00:00.000Z",
      };
    },
  };
  const accounts = {
    async authenticate(authorization: string | null) {
      if (authorization === "Bearer missing") return null;
      const scopes: readonly ApiKeyScope[] =
        authorization === "Bearer writer" ? ["resources:write"] : ["resources:read"];
      return {
        hostPrincipalId: "host-principal-http",
        principalId: "principal-http",
        organizationId: ORGANIZATION,
        scopes,
        kind: "api_key",
      } as const;
    },
  } as Pick<Accounts, "authenticate"> as Accounts;
  const route = createControlRoutes({
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
    clock: () => new Date("2026-09-03T20:00:00.000Z"),
    ...(enabled ? { artifactConsumerRepair: repair } : {}),
  });
  return {
    calls,
    async request(
      method: "GET" | "POST",
      credential: "reader" | "writer" | "missing",
      body?: unknown,
      idempotencyKey?: string,
    ): Promise<Response> {
      const url = new URL(
        `https://api.takoserver.test/v1/organizations/${ORGANIZATION}/artifact-consumer-repairs/${DEPLOYMENT}`,
      );
      const response = await route(
        new Request(url, {
          method,
          headers: {
            authorization: `Bearer ${credential}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        url,
      );
      if (!response) throw new TypeError("artifact-consumer repair route was not handled");
      return response;
    },
  };
}

function validApply() {
  return { kind: ARTIFACT_CONSUMER_REPAIR_APPLY_FORMAT, planDigest: PLAN };
}
