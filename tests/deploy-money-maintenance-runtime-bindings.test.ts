import { describe, expect, test } from "bun:test";
import { deploymentVariables } from "../scripts/deploy/realized-config.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { probeSchemaMaintenance } from "../scripts/deploy/worker.ts";
import worker from "../src/entry-worker.ts";

const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "integration-money-bindings-fixture",
  d1: {
    databaseName: `integration-ts-${"b".repeat(32)}`,
    databaseId: "00000000-0000-4000-8000-000000000001",
  },
  r2: { bucketName: `integration-ts-${"b".repeat(32)}` },
  publicOrigin: "https://integration-money-bindings-fixture.example.workers.dev",
  signing: { currentKeyId: "declared-unused-maintenance-key" },
  schemaMaintenanceMode: "pre-wallet-usd-micros-quiesced",
  moneyCutoverWriterPolicy: "transaction-fenced-usd-micros-v1",
  moneyCutoverWriterEpoch: `sha256:${"c".repeat(64)}`,
} satisfies DeployTarget;

function variables(selected: DeployTarget): Readonly<Record<string, string>> {
  return deploymentVariables(selected).vars as Readonly<Record<string, string>>;
}

function capturedEnv(overrides: Readonly<Record<string, unknown>> = {}) {
  let effects = 0;
  const env = {
    ...variables(target),
    get STATE_DB(): never {
      effects++;
      throw new Error("maintenance touched storage");
    },
    get STRIPE_SECRET_KEY(): never {
      effects++;
      throw new Error("maintenance touched payment credentials");
    },
    ...overrides,
  } as unknown as Parameters<typeof worker.fetch>[1];
  return { env, effects: () => effects };
}

describe("selected Money Writer environment binding", () => {
  test("the real emitted non-JIT maintenance bindings satisfy the actual entry and strict probe", async () => {
    expect(target).not.toHaveProperty("integrationE2eCredentialAuthority");
    const captured = capturedEnv();
    let requests = 0;
    const result = await probeSchemaMaintenance(
      target.publicOrigin,
      async (url, init) => {
        requests++;
        return await worker.fetch(new Request(url, init), captured.env);
      },
      target.schemaMaintenanceMode,
    );
    expect(result).toEqual({
      url: `${target.publicOrigin}/healthz`,
      status: 503,
      traffic: "maintenance",
    });
    expect(requests).toBe(1);
    expect(captured.env.TAKOSERVER_ENVIRONMENT).toBe("integration");
    expect(captured.env.TAKOSERVER_MONEY_CUTOVER_WRITER_POLICY).toBe(
      target.moneyCutoverWriterPolicy,
    );
    expect(captured.env.TAKOSERVER_MONEY_CUTOVER_WRITER_EPOCH).toBe(target.moneyCutoverWriterEpoch);
    await worker.scheduled({}, captured.env);
    expect(captured.effects()).toBe(0);
  });

  test("Money environment emission does not depend on maintenance or JIT and other profiles keep their bindings", () => {
    const { schemaMaintenanceMode: _mode, ...normal } = target;
    const normalVars = variables(normal);
    expect(normalVars.TAKOSERVER_ENVIRONMENT).toBe("integration");
    expect(normalVars.TAKOSERVER_SCHEMA_MAINTENANCE_MODE).toBeUndefined();
    expect(normalVars.TAKOSERVER_INTEGRATION_E2E_API_KEY_PUBLIC_JWK).toBeUndefined();
    expect(normalVars.TAKOSERVER_SOURCE_COMMIT).toBeUndefined();
    const { moneyCutoverWriterPolicy: _policy, moneyCutoverWriterEpoch: _epoch, ...plain } = normal;
    const plainVars = variables({ ...plain, environment: "production" });
    expect(plainVars.TAKOSERVER_ENVIRONMENT).toBeUndefined();
    expect(plainVars.TAKOSERVER_MONEY_CUTOVER_WRITER_POLICY).toBeUndefined();
    expect(plainVars.TAKOSERVER_MONEY_CUTOVER_WRITER_EPOCH).toBeUndefined();
  });

  test("the actual entry still refuses absent or crossed environment and invalid epoch before maintenance", async () => {
    const cases = [
      [{ TAKOSERVER_ENVIRONMENT: undefined }, "money cutover writer policy is invalid"],
      [{ TAKOSERVER_ENVIRONMENT: "production" }, "money cutover writer policy is invalid"],
      [
        { TAKOSERVER_MONEY_CUTOVER_WRITER_POLICY: "foreign" },
        "money cutover writer policy is invalid",
      ],
      [
        { TAKOSERVER_MONEY_CUTOVER_WRITER_EPOCH: undefined },
        "money cutover Writer epoch is invalid",
      ],
      [
        { TAKOSERVER_MONEY_CUTOVER_WRITER_EPOCH: "foreign" },
        "money cutover Writer epoch is invalid",
      ],
    ] as const;
    for (const [overrides, message] of cases) {
      const captured = capturedEnv(overrides);
      const response = await worker.fetch(
        new Request(`${target.publicOrigin}/healthz`),
        captured.env,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("retry-after")).toBeNull();
      expect(await response.clone().json()).toMatchObject({
        error: {
          code: "backend_unavailable",
          message,
          details: { reason: "runtime-configuration" },
        },
      });
      await expect(
        probeSchemaMaintenance(
          target.publicOrigin,
          async () => response.clone(),
          target.schemaMaintenanceMode,
        ),
      ).rejects.toMatchObject({
        phase: "verification",
        message: "schema maintenance Worker did not prove maintenance refusal",
      });
      expect(captured.effects()).toBe(0);
    }
  });
});
