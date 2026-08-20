import { describe, expect, test } from "bun:test";
import {
  buildApp,
  createEphemeralSql,
  createMemoryObjectStore,
  type ExternalIdentityVerifier,
  type FundingSettlementVerifier,
  InMemoryTakoformResourceDriver,
  type S3CredentialIssue,
  type S3CredentialIssuer,
  TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_INSTALLED_FORM,
} from "../src/index.ts";

const identity: ExternalIdentityVerifier = {
  async verify() {
    return { providerSubject: "subject", email: "owner@example.com", displayName: "Owner" };
  },
};

const settlement: FundingSettlementVerifier = {
  async verify(): Promise<never> {
    throw new Error("not used");
  },
};

async function fixture() {
  const sql = createEphemeralSql();
  const issues: S3CredentialIssue[] = [];
  const s3: S3CredentialIssuer = {
    limits() {
      return { minimumSeconds: 60, maximumSeconds: 3_600, defaultSeconds: 900 };
    },
    async issue(input) {
      issues.push(input);
      return {
        endpoint: "https://account.r2.cloudflarestorage.com",
        region: "auto",
        bucket: "ts-private-bucket",
        accessKeyId: "temporary-access-key",
        secretAccessKey: "temporary-secret-key",
        sessionToken: "temporary-session-token",
        expiresAt: "2026-08-18T12:15:00.000Z",
      };
    },
  };
  const app = buildApp({
    sql,
    objects: createMemoryObjectStore(),
    identity,
    settlement,
    publicOrigin: "https://api.takoserver.com",
    forms: [TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_INSTALLED_FORM],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
    s3,
    clock: () => new Date("2026-08-18T12:00:00.000Z"),
  });

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    authorization?: string,
  ): Promise<Response> =>
    await app.fetch(
      new Request(`https://api.takoserver.com${path}`, {
        method,
        headers: {
          ...(authorization ? { authorization } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  const session = await call("POST", "/v1/sessions", {
    provider: "google",
    assertion: "verified",
  });
  const sessionToken = String(((await session.json()) as { sessionToken: string }).sessionToken);
  const owner = `Bearer ${sessionToken}`;
  const organization = await call("POST", "/v1/organizations", { name: "Acme" }, owner);
  const organizationId = String(
    ((await organization.json()) as { organization: { id: string } }).organization.id,
  );

  const apiKey = async (scopes: readonly string[]): Promise<string> => {
    const response = await call(
      "POST",
      `/v1/organizations/${organizationId}/api-keys`,
      { name: scopes.join("-"), scopes, expiresInSeconds: 3_600 },
      owner,
    );
    return `Bearer ${String(((await response.json()) as { secret: string }).secret)}`;
  };

  const install = async (input: {
    readonly uid: string;
    readonly schemaDigest?: string;
    readonly nativeId?: string;
  }): Promise<void> => {
    const released = structuredClone(TAKOFORM_PROVIDER_V211_OBJECT_BUCKET_INSTALLED_FORM.identity);
    const form = input.schemaDigest
      ? {
          ...released,
          formRef: {
            ...released.formRef,
            schemaDigest: input.schemaDigest as `sha256:${string}`,
          },
        }
      : released;
    const resource = {
      apiVersion: "forms.takoform.com/v1alpha3",
      kind: "Resource",
      form,
      metadata: {
        name: input.uid,
        space: "default",
        uid: input.uid,
        generation: "1",
        revision: "1",
      },
      spec: {},
      status: {
        observedGeneration: "1",
        conditions: [
          {
            type: "Ready",
            status: "True",
            reason: "Available",
            lastTransitionTime: "2026-08-18T12:00:00.000Z",
          },
        ],
      },
    };
    await sql.run(
      `INSERT INTO tf_resources
       (tenant_id, space, api_version, kind, name, uid, generation, revision,
        resource_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        organizationId,
        "default",
        form.formRef.apiVersion,
        form.formRef.kind,
        input.uid,
        input.uid,
        "1",
        "1",
        JSON.stringify(resource),
        Date.parse("2026-08-18T12:00:00.000Z"),
      ],
    );
    await sql.run(
      `INSERT INTO tf_resource_deployments
       (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
        provider_installation_ref, native_id, state, observed_json, outputs_json,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', '{}', '{}', ?, ?)`,
      [
        organizationId,
        `dep_${input.uid}`,
        input.uid,
        "storage.object.standard",
        "cloudflare",
        "cloudflare.primary",
        input.nativeId ?? "r2:ts-private-bucket",
        Date.parse("2026-08-18T12:00:00.000Z"),
        Date.parse("2026-08-18T12:00:00.000Z"),
      ],
    );
  };

  return { call, organizationId, apiKey, install, issues };
}

describe("standard S3 connection credentials", () => {
  test("reads one exact organization resource so a reseller can enforce its tenant space", async () => {
    const { call, organizationId, apiKey, install } = await fixture();
    await install({ uid: "uid_bucket" });
    const reader = await apiKey(["resources:read"]);

    const response = await call(
      "GET",
      `/v1/organizations/${organizationId}/resources/uid_bucket`,
      undefined,
      reader,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: {
        metadata: { uid: "uid_bucket", space: "default" },
      },
    });
    expect(
      (await call("GET", `/v1/organizations/org_not_owner/resources/uid_bucket`, undefined, reader))
        .status,
    ).toBe(403);
  });

  test("issues short-lived standard credentials for one exact ObjectBucket", async () => {
    const { call, organizationId, apiKey, install, issues } = await fixture();
    await install({ uid: "uid_bucket" });
    const reader = await apiKey(["resources:read"]);

    const response = await call(
      "POST",
      `/v1/organizations/${organizationId}/resources/uid_bucket/s3-credentials`,
      { access: "read-only", expiresInSeconds: 900 },
      reader,
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      kind: "takoserver.s3-connection@v1",
      endpoint: "https://account.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "ts-private-bucket",
      credentials: {
        accessKeyId: "temporary-access-key",
        secretAccessKey: "temporary-secret-key",
        sessionToken: "temporary-session-token",
        expiresAt: "2026-08-18T12:15:00.000Z",
      },
    });
    expect(issues).toEqual([
      {
        organizationId,
        resourceUid: "uid_bucket",
        deploymentId: "dep_uid_bucket",
        offeringId: "storage.object.standard",
        providerPackRef: "cloudflare",
        providerInstallationRef: "cloudflare.primary",
        nativeId: "r2:ts-private-bucket",
        access: "read-only",
        ttlSeconds: 900,
      },
    ]);
  });

  test("requires write authority for read-write credentials", async () => {
    const { call, organizationId, apiKey, install, issues } = await fixture();
    await install({ uid: "uid_bucket" });
    const reader = await apiKey(["resources:read"]);
    const writer = await apiKey(["resources:write"]);
    const path = `/v1/organizations/${organizationId}/resources/uid_bucket/s3-credentials`;

    expect((await call("POST", path, { access: "read-write" }, reader)).status).toBe(403);
    expect((await call("POST", path, { access: "read-write" }, writer)).status).toBe(201);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.access).toBe("read-write");
  });

  test("will not turn an unknown or locally invented Form into an S3 resource", async () => {
    const { call, organizationId, apiKey, install, issues } = await fixture();
    await install({ uid: "uid_spoof", schemaDigest: `sha256:${"f".repeat(64)}` });
    const writer = await apiKey(["resources:write"]);
    const response = await call(
      "POST",
      `/v1/organizations/${organizationId}/resources/uid_spoof/s3-credentials`,
      { access: "read-write" },
      writer,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "unsupported_capability" } });
    expect(issues).toEqual([]);
  });
});
