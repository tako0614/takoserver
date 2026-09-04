import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { Accounts } from "../src/auth.ts";
import { createControlRoutes } from "../src/control.ts";
import {
  exactArtifactRecoveryWorkerEnv,
  routeLessExactArtifactRecoveryFetch,
} from "../src/exact-artifact-recovery-worker.ts";
import {
  handleIntegrationFormAuthorityGateway,
  type IntegrationFormAuthorityGatewayEnv,
  integrationFormAuthorityGatewayEnv,
} from "../src/integration-form-authority-gateway.ts";

test("the normal customer Worker has no artifact recovery route", async () => {
  const route = createControlRoutes({
    accounts: {} as Accounts,
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
    clock: () => new Date("2026-09-04T00:00:00.000Z"),
  });
  for (const action of ["status", "apply", "purge"]) {
    const url = new URL(
      `https://api.takoserver.test/v1/organizations/org_takosumi_hosted_staging/exact-artifact-recovery/${action}`,
    );
    const response = await route(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      url,
    );
    expect(response?.status).toBe(404);
  }
});

test("removing the temporary gateway binding retires recovery ingress as a 404", async () => {
  let identityReads = 0;
  const env = {
    TAKOSERVER_ENVIRONMENT: "integration",
    TAKOSERVER_FORM_AUTHORITY_HOST_ID: "operator.example.test",
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_ORIGIN: "https://operator.example.test",
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: "unconfigured",
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID: "unconfigured",
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE: "unconfigured",
    FORM_AUTHORITY: {} as never,
    PUBLIC_HOST_IDENTITY: {
      async identity() {
        identityReads += 1;
        throw new Error("must not be read after binding retirement");
      },
    },
  } satisfies IntegrationFormAuthorityGatewayEnv;
  const response = await handleIntegrationFormAuthorityGateway(
    new Request("https://operator.example.test/v1/exact-artifact-recovery/status", {
      method: "POST",
      headers: { authorization: "Bearer not-used", "content-type": "application/json" },
      body: "{}",
    }),
    env,
  );
  expect(response.status).toBe(404);
  expect(identityReads).toBe(0);
});

test("the recovery Worker is route-less and no generic public gateway config exists", async () => {
  const direct = routeLessExactArtifactRecoveryFetch();
  expect(direct.status).toBe(404);

  const normal = config("wrangler.integration-form-authority-operator.jsonc");
  const worker = config("wrangler.exact-artifact-recovery.jsonc");
  expect(normal.services.some((service) => service.binding === "EXACT_ARTIFACT_RECOVERY")).toBe(
    false,
  );
  expect(
    existsSync(new URL("../wrangler.exact-artifact-recovery-gateway.jsonc", import.meta.url)),
  ).toBe(false);
  expect(readFileSync(new URL("../package.json", import.meta.url), "utf8")).not.toContain(
    "build:exact-artifact-recovery-gateway",
  );
  expect(worker.workers_dev).toBe(false);
  expect(worker.preview_urls).toBe(false);
  expect("routes" in worker).toBe(false);
});

test("generated Worker environments are validated before privileged bindings escape", () => {
  const shared = {
    TAKOSERVER_ENVIRONMENT: "integration",
    TAKOSERVER_FORM_AUTHORITY_HOST_ID: "https://api.integration.takoserver.test",
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: "{}",
  };
  expect(() =>
    exactArtifactRecoveryWorkerEnv({
      ...shared,
      TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_DIGEST: `sha256:${"a".repeat(64)}`,
      TAKOSERVER_EXACT_ARTIFACT_RECOVERY_R2_IDENTITY_DIGEST: `sha256:${"b".repeat(64)}`,
      TAKOSERVER_EXACT_ARTIFACT_RECOVERY_SOURCE_COMMIT: "a4075a4",
      TAKOSERVER_EXACT_ARTIFACT_RECOVERY_SOURCE_VERSION: "1.0.0",
      WORKER_VERSION: { id: "11111111-1111-4111-8111-111111111111" },
      PUBLIC_HOST_IDENTITY: { identity() {} },
      STATE_DB: { prepare() {}, batch() {} },
      OBJECTS: { put() {}, get() {}, head() {}, list() {} },
    }),
  ).toThrow("exact artifact recovery Worker environment is invalid");

  const ordinaryGateway = {
    ...shared,
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_ORIGIN: "https://operator.integration.takoserver.test",
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID: "tenant",
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE: "space",
    FORM_AUTHORITY: { plan() {}, apply() {}, readback() {} },
    PUBLIC_HOST_IDENTITY: { identity() {} },
  };
  expect(() => integrationFormAuthorityGatewayEnv(ordinaryGateway)).not.toThrow();
  expect(() =>
    integrationFormAuthorityGatewayEnv({
      ...ordinaryGateway,
      EXACT_ARTIFACT_RECOVERY: { identity() {}, status() {}, apply() {}, purge() {} },
      TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_DIGEST: `sha256:${"a".repeat(64)}`,
    }),
  ).toThrow("integration Form authority gateway Env is invalid");
});

function config(path: string): {
  readonly workers_dev?: boolean;
  readonly preview_urls?: boolean;
  readonly routes?: unknown;
  readonly services: readonly { readonly binding?: string; readonly entrypoint?: string }[];
} {
  return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}
