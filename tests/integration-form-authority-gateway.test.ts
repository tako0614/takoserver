import { beforeAll, describe, expect, test } from "bun:test";
import {
  type FormAuthorityRpc,
  handleIntegrationFormAuthorityGateway,
  type IntegrationFormAuthorityGatewayEnv,
} from "../src/integration-form-authority-gateway.ts";
import { canonicalDigest, canonicalJson } from "../src/json.ts";

const OPERATOR_ORIGIN = "https://form-authority.integration.takoserver.com";
const HOST_ID = "https://api.integration.takoserver.com";
const PUBLIC_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const DRIFTED_VERSION_ID = "22222222-2222-4222-8222-222222222222";
const WORKER_ARTIFACT_DIGEST = `sha256:${"a".repeat(64)}`;
const OPERATOR_SCOPE = {
  tenantId: "tenant-yurucommu-integration",
  space: "space-yurucommu-integration",
} as const;
const NOW = new Date("2026-08-29T00:00:00Z");

let privateKey: CryptoKey;
let publicJwk: { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string };

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (exported.kty !== "OKP" || exported.crv !== "Ed25519" || !exported.x) {
    throw new Error("test Ed25519 public key is unavailable");
  }
  privateKey = pair.privateKey;
  publicJwk = { kty: "OKP", crv: "Ed25519", x: exported.x };
});

describe("integration Form authority operator gateway", () => {
  test("hard-refuses non-integration before key, identity, or authority reads", async () => {
    let privilegedRead = false;
    const env = {
      TAKOSERVER_ENVIRONMENT: "production",
      get TAKOSERVER_FORM_AUTHORITY_HOST_ID() {
        privilegedRead = true;
        throw new Error("must not read host identity");
      },
      get TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK() {
        privilegedRead = true;
        throw new Error("must not read operator key");
      },
      get PUBLIC_HOST_IDENTITY() {
        privilegedRead = true;
        throw new Error("must not read public service");
      },
      get FORM_AUTHORITY() {
        privilegedRead = true;
        throw new Error("must not read authority service");
      },
    } as unknown as IntegrationFormAuthorityGatewayEnv;

    const result = await handleIntegrationFormAuthorityGateway(
      new Request(`${OPERATOR_ORIGIN}/v1/plan`, { method: "POST" }),
      env,
      () => NOW,
    );
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: { code: "integration_only" } });
    expect(privilegedRead).toBe(false);
  });

  test("accepts only a short-lived exact method/path/body/public-identity proof", async () => {
    const calls: { action: string; body: unknown; assertion: string }[] = [];
    const body = {
      kind: "takoserver.form-authority-plan-request@v1",
      activation: { kind: "space", ...OPERATOR_SCOPE },
      actor: "operator",
    };
    const env = gatewayEnv({
      authority: authority(calls),
      publicVersionId: PUBLIC_VERSION_ID,
    });
    const assertion = await signGatewayAssertion("plan", "/v1/plan", body);
    const result = await handleIntegrationFormAuthorityGateway(
      request("/v1/plan", body, assertion),
      env,
      () => NOW,
    );

    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual({ action: "plan", accepted: true });
    expect(calls).toEqual([{ action: "plan", body, assertion }]);

    for (const invalid of [
      request("/v1/apply", body, assertion),
      request("/v1/plan", { ...body, actor: "other" }, assertion),
      new Request(`${OPERATOR_ORIGIN}/v1/plan`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${assertion}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      }),
    ]) {
      const refused = await handleIntegrationFormAuthorityGateway(invalid, env, () => NOW);
      expect([401, 404, 415]).toContain(refused.status);
    }
    expect(calls).toHaveLength(1);
  });

  test("rejects every action outside the exact target-owned tenant and Space", async () => {
    const calls: { action: string; body: unknown; assertion: string }[] = [];
    const env = gatewayEnv({
      authority: authority(calls),
      publicVersionId: PUBLIC_VERSION_ID,
    });
    for (const action of ["plan", "apply", "readback"] as const) {
      const requestBody = {
        kind: "takoserver.form-authority-plan-request@v1",
        activation: { kind: "space", tenantId: OPERATOR_SCOPE.tenantId, space: "other-space" },
      };
      const body =
        action === "apply"
          ? { kind: "takoserver.form-authority-plan@v1", request: requestBody }
          : requestBody;
      const path = `/v1/${action}` as const;
      const assertion = await signGatewayAssertion(action, path, body);
      const result = await handleIntegrationFormAuthorityGateway(
        request(path, body, assertion),
        env,
        () => NOW,
      );
      expect(result.status).toBe(403);
      expect(await result.json()).toEqual({ error: { code: "operator_scope_mismatch" } });
    }
    expect(calls).toEqual([]);
  });

  test("rejects public Worker drift before invoking the route-less authority", async () => {
    const calls: { action: string; body: unknown; assertion: string }[] = [];
    const body = {
      kind: "takoserver.form-authority-plan-request@v1",
      activation: { kind: "space", ...OPERATOR_SCOPE },
    };
    const assertion = await signGatewayAssertion("readback", "/v1/readback", body);
    const env = gatewayEnv({
      authority: authority(calls),
      publicVersionId: DRIFTED_VERSION_ID,
    });
    const result = await handleIntegrationFormAuthorityGateway(
      request("/v1/readback", body, assertion),
      env,
      () => NOW,
    );
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: { code: "public_host_drift" } });
    expect(calls).toEqual([]);
  });

  test("fails closed as unavailable when the sealed operator key is malformed", async () => {
    const calls: { action: string; body: unknown; assertion: string }[] = [];
    const body = { kind: "takoserver.form-authority-plan-request@v1" };
    const assertion = await signGatewayAssertion("plan", "/v1/plan", body);
    const env = {
      ...gatewayEnv({ authority: authority(calls), publicVersionId: PUBLIC_VERSION_ID }),
      TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: "malformed",
    };
    const result = await handleIntegrationFormAuthorityGateway(
      request("/v1/plan", body, assertion),
      env,
      () => NOW,
    );
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: { code: "identity_unavailable" } });
    expect(calls).toEqual([]);
  });

  test("refuses oversized requests before RPC", async () => {
    const calls: { action: string; body: unknown; assertion: string }[] = [];
    const env = gatewayEnv({
      authority: authority(calls),
      publicVersionId: PUBLIC_VERSION_ID,
    });
    const result = await handleIntegrationFormAuthorityGateway(
      new Request(`${OPERATOR_ORIGIN}/v1/plan`, {
        method: "POST",
        headers: {
          authorization: "Bearer invalid",
          "content-type": "application/json",
          "content-length": String(2 * 1_024 * 1_024 + 1),
        },
        body: "{}",
      }),
      env,
      () => NOW,
    );
    expect(result.status).toBe(413);
    expect(calls).toEqual([]);
  });
});

function gatewayEnv(input: {
  readonly authority: FormAuthorityRpc;
  readonly publicVersionId: string;
}): IntegrationFormAuthorityGatewayEnv {
  return {
    TAKOSERVER_ENVIRONMENT: "integration",
    TAKOSERVER_FORM_AUTHORITY_HOST_ID: HOST_ID,
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_ORIGIN: OPERATOR_ORIGIN,
    TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST: WORKER_ARTIFACT_DIGEST,
    TAKOSERVER_PUBLIC_WORKER_VERSION_ID: PUBLIC_VERSION_ID,
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: canonicalJson(publicJwk),
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID: OPERATOR_SCOPE.tenantId,
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE: OPERATOR_SCOPE.space,
    FORM_AUTHORITY: input.authority,
    PUBLIC_HOST_IDENTITY: {
      async identity() {
        return {
          kind: "takoserver.public-host-identity@v1",
          hostId: HOST_ID,
          workerVersionId: input.publicVersionId,
        };
      },
    },
  } as IntegrationFormAuthorityGatewayEnv;
}

function authority(
  calls: { action: string; body: unknown; assertion: string }[],
): FormAuthorityRpc {
  const accept = (
    action: "plan" | "apply" | "readback",
    invocation: Parameters<FormAuthorityRpc["plan"]>[0],
  ): { action: string; accepted: true } => {
    expect(invocation).toMatchObject({
      kind: "takoserver.signed-form-authority-rpc@v1",
      action,
      method: "POST",
      path: `/v1/${action}`,
      assertion: expect.any(String),
      body: expect.any(Object),
    });
    calls.push({ action, body: invocation.body, assertion: invocation.assertion });
    return { action, accepted: true };
  };
  return {
    async plan(invocation) {
      return accept("plan", invocation);
    },
    async apply(invocation) {
      return accept("apply", invocation);
    },
    async readback(invocation) {
      return accept("readback", invocation);
    },
  };
}

function request(path: string, body: unknown, assertion: string): Request {
  return new Request(`${OPERATOR_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${assertion}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function signGatewayAssertion(
  action: "plan" | "apply" | "readback",
  path: string,
  body: unknown,
): Promise<string> {
  const now = Math.floor(NOW.getTime() / 1_000);
  const claims = {
    purpose: "form-authority",
    action,
    method: "POST",
    path,
    bodyDigest: await canonicalDigest(body),
    environment: "integration",
    hostId: HOST_ID,
    workerArtifactDigest: WORKER_ARTIFACT_DIGEST,
    publicWorkerVersionId: PUBLIC_VERSION_ID,
    iat: now - 1,
    exp: now + 60,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(payload),
  );
  return `${payload}.${Buffer.from(signature).toString("base64url")}`;
}
