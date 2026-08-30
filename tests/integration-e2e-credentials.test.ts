import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeployTarget } from "../scripts/deploy/target.ts";
import {
  credentialPaths,
  IntegrationCredentialError,
  issueIntegrationCredentials,
  KEY_TTL_SECONDS,
  revokeIntegrationCredentials,
  statusIntegrationCredentials,
  WRITER_KEY_NAME,
} from "../scripts/integration-e2e-credentials.ts";
import { buildApp, createEphemeralSql, createMemoryObjectStore } from "../src/index.ts";
import {
  credentialAuthorityPath,
  INTEGRATION_E2E_ORGANIZATION_ID,
  type IntegrationE2eCredentialAuthorityAction,
} from "../src/integration-e2e-credential-authority.ts";

const ORIGIN = "https://api.integration.example.test";
const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);

describe("integration E2E credential helper", () => {
  test("issues one exact-org writer into separate owner-only 0600 secret and metadata files", async () => {
    const fixture = await testFixture();
    const requests: { readonly method: string; readonly path: string; readonly url: string }[] = [];
    try {
      const metadata = await issueIntegrationCredentials({
        ...fixture.options,
        fetcher: async (input, init) => {
          requests.push({
            method: init?.method ?? "GET",
            path: new URL(input).pathname,
            url: input,
          });
          return await fixture.fetcher(input, init);
        },
      });

      expect(metadata.organizationId).toBe(fixture.organizationId);
      expect(metadata.key).toMatchObject({
        name: WRITER_KEY_NAME,
        scopes: ["resources:write"],
        ttlSeconds: KEY_TTL_SECONDS,
      });
      expect(metadata).not.toHaveProperty("secret");
      expect(metadata).not.toHaveProperty("assertion");
      expect(readFileSync(fixture.paths.secret, "utf8").trim().length).toBeGreaterThan(16);
      const metadataBytes = readFileSync(fixture.paths.metadata, "utf8");
      expect(metadataBytes).not.toContain(readFileSync(fixture.paths.secret, "utf8").trim());
      for (const path of [fixture.paths.secret, fixture.paths.metadata]) {
        const stat = lstatSync(path);
        expect(stat.isSymbolicLink()).toBe(false);
        expect(stat.nlink).toBe(1);
        expect(stat.mode & 0o777).toBe(0o600);
      }
      expect(requests.map((request) => request.path)).toEqual([credentialAuthorityPath("issue")]);
      expect(requests.every((request) => !request.url.includes("assertion"))).toBe(true);
      expect(requests.every((request) => !request.url.includes("secret"))).toBe(true);
      expect(await fixture.liveKeyCount()).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });

  test("reconciles a lost issue acknowledgement by signed status, revoke, and proven absence without retrying issue", async () => {
    const fixture = await testFixture();
    const actions: IntegrationE2eCredentialAuthorityAction[] = [];
    let loseIssueResponse = true;
    try {
      await expect(
        issueIntegrationCredentials({
          ...fixture.options,
          fetcher: async (input, init) => {
            const path = new URL(input).pathname;
            const action = actionFromPath(path);
            if (action) actions.push(action);
            const response = await fixture.fetcher(input, init);
            if (action === "issue" && loseIssueResponse) {
              loseIssueResponse = false;
              throw new Error("simulated lost response containing api-key-secret-value");
            }
            return response;
          },
        }),
      ).rejects.toThrow("secret acknowledgement was lost");

      expect(actions).toEqual(["issue", "status", "revoke", "status"]);
      expect(actions.filter((action) => action === "issue")).toHaveLength(1);
      expect(await fixture.liveKeyCount()).toBe(0);
      expect(existsSync(fixture.paths.secret)).toBe(false);
      expect(existsSync(fixture.paths.metadata)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("compensates a secret publication failure and proves the exact id absent", async () => {
    const fixture = await testFixture();
    const actions: IntegrationE2eCredentialAuthorityAction[] = [];
    try {
      await expect(
        issueIntegrationCredentials({
          ...fixture.options,
          fetcher: async (input, init) => {
            const action = actionFromPath(new URL(input).pathname);
            if (action) actions.push(action);
            return await fixture.fetcher(input, init);
          },
          writeSecret: async (path, secret) => {
            writeFileSync(path, `${secret}\n`, { mode: 0o600 });
            throw new Error("disk acknowledgement lost for secret=api-key-secret-value");
          },
        }),
      ).rejects.toBeInstanceOf(IntegrationCredentialError);

      expect(actions).toEqual(["issue", "revoke", "status"]);
      expect(await fixture.liveKeyCount()).toBe(0);
      expect(existsSync(fixture.paths.secret)).toBe(false);
      expect(existsSync(fixture.paths.metadata)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("uses signed remote status and removes files only after revoke status proves absence", async () => {
    const fixture = await testFixture();
    const actions: IntegrationE2eCredentialAuthorityAction[] = [];
    try {
      const metadata = await issueIntegrationCredentials(fixture.options);
      const status = await statusIntegrationCredentials({
        ...fixture.options,
        fetcher: async (input, init) => {
          const action = actionFromPath(new URL(input).pathname);
          if (action) actions.push(action);
          return await fixture.fetcher(input, init);
        },
      });
      expect(status.remote).toMatchObject({
        keyId: metadata.key.keyId,
        present: true,
        usable: true,
      });
      expect(status.files).toMatchObject({ secret: { exists: true }, metadata: { exists: true } });

      const revoked = await revokeIntegrationCredentials({
        ...fixture.options,
        fetcher: async (input, init) => {
          const action = actionFromPath(new URL(input).pathname);
          if (action) actions.push(action);
          return await fixture.fetcher(input, init);
        },
      });
      expect(revoked).toMatchObject({ keyId: metadata.key.keyId, absent: true });
      expect(actions).toEqual(["status", "revoke", "status"]);
      expect(await fixture.liveKeyCount()).toBe(0);
      expect(existsSync(fixture.paths.secret)).toBe(false);
      expect(existsSync(fixture.paths.metadata)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("does not claim compensation when signed absence cannot be established", async () => {
    const fixture = await testFixture();
    try {
      let issued = false;
      await expect(
        issueIntegrationCredentials({
          ...fixture.options,
          fetcher: async (input, init) => {
            const action = actionFromPath(new URL(input).pathname);
            const response = await fixture.fetcher(input, init);
            if (action === "issue") issued = true;
            if (issued && action === "status") throw new Error("status unavailable");
            if (action === "issue") throw new Error("issue response lost");
            return response;
          },
        }),
      ).rejects.toThrow("compensation is indeterminate");
      expect(await fixture.liveKeyCount()).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });

  test("redacts assertions, bearer values, API-key secrets, and private JWK members", () => {
    const error = new IntegrationCredentialError(
      "assertion=operator-assertion-value Bearer bearer-value " +
        "secret=api-key-secret-value token=session-token-value d=private-key-value",
    );
    for (const value of [
      "operator-assertion-value",
      "bearer-value",
      "api-key-secret-value",
      "session-token-value",
      "private-key-value",
    ]) {
      expect(error.message).not.toContain(value);
    }
    expect(error.message).toContain("[REDACTED]");
  });

  test("fails before network on unsafe paths, non-integration routing, or an excessive TTL", async () => {
    const fixture = await testFixture();
    const calls: string[] = [];
    const fetcher = async (input: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(input).pathname}`);
      return await fixture.fetcher(input, init);
    };
    try {
      chmodSync(fixture.privatePath, 0o644);
      await expect(issueIntegrationCredentials({ ...fixture.options, fetcher })).rejects.toThrow(
        "mode 0600",
      );
      chmodSync(fixture.privatePath, 0o600);

      const linkedOutput = join(fixture.root, "linked-output");
      symlinkSync(fixture.outputDirectory, linkedOutput);
      await expect(
        issueIntegrationCredentials({ ...fixture.options, outputDirectory: linkedOutput, fetcher }),
      ).rejects.toThrow("symlink");

      await expect(
        issueIntegrationCredentials({
          ...fixture.options,
          target: { ...fixture.options.target, environment: "production" },
          fetcher,
        }),
      ).rejects.toThrow("integration target");
      await expect(
        issueIntegrationCredentials({ ...fixture.options, keyLifetimeSeconds: 3_601, fetcher }),
      ).rejects.toThrow("outside its bounded range");
      for (const target of [
        {
          ...fixture.options.target,
          operatorIdentity: { publicJwk: fixture.options.authority.publicJwk },
        },
        {
          ...fixture.options.target,
          formAuthority: {
            workerName: "takoserver-form-authority-integration",
            hostId: "host.integration.example.test",
            operatorPublicJwk: fixture.options.authority.publicJwk,
          },
        },
      ]) {
        await expect(
          issueIntegrationCredentials({ ...fixture.options, target, fetcher }),
        ).rejects.toThrow("dedicated Ed25519 key");
      }
      expect(calls).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test("refuses tampered metadata before a signed revoke", async () => {
    const fixture = await testFixture();
    const calls: string[] = [];
    try {
      await issueIntegrationCredentials(fixture.options);
      const metadata = JSON.parse(readFileSync(fixture.paths.metadata, "utf8")) as Record<
        string,
        unknown
      >;
      metadata.organizationId = "org_other";
      writeFileSync(fixture.paths.metadata, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
      await expect(
        revokeIntegrationCredentials({
          ...fixture.options,
          fetcher: async (input, init) => {
            calls.push(`${init?.method ?? "GET"} ${new URL(input).pathname}`);
            return await fixture.fetcher(input, init);
          },
        }),
      ).rejects.toThrow();
      expect(calls).toEqual([]);
      expect(await fixture.liveKeyCount()).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });

  test("refuses an operation/key mismatch in owner-only metadata before network", async () => {
    const fixture = await testFixture();
    const calls: string[] = [];
    try {
      await issueIntegrationCredentials(fixture.options);
      const metadata = JSON.parse(readFileSync(fixture.paths.metadata, "utf8")) as Record<
        string,
        unknown
      >;
      const key = record(metadata.key);
      key.keyId = "key_ie2e_0000000000000000000000000000000000000000";
      writeFileSync(fixture.paths.metadata, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
      await expect(
        statusIntegrationCredentials({
          ...fixture.options,
          fetcher: async (input, init) => {
            calls.push(`${init?.method ?? "GET"} ${new URL(input).pathname}`);
            return await fixture.fetcher(input, init);
          },
        }),
      ).rejects.toThrow("exact live routing");
      expect(calls).toEqual([]);
      expect(await fixture.liveKeyCount()).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });
});

async function testFixture() {
  const root = mkdtempSync(join(tmpdir(), "takoserver-integration-e2e-"));
  const outputDirectory = join(root, "credentials");
  const privatePath = join(root, "integration-e2e-api-key.jwk");
  mkdirSync(outputDirectory, { mode: 0o700 });

  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  writeFileSync(privatePath, `${JSON.stringify(privateJwk)}\n`, { mode: 0o600 });
  chmodSync(privatePath, 0o600);

  const sql = createEphemeralSql();
  const bootstrap = buildApp({
    sql,
    objects: createMemoryObjectStore(),
    identity: {
      async verify() {
        return {
          providerSubject: "owner",
          email: "owner@example.test",
          displayName: "Owner",
          organizations: [
            {
              id: INTEGRATION_E2E_ORGANIZATION_ID,
              name: "Takosumi Hosted staging",
              role: "owner" as const,
            },
          ],
        };
      },
    },
    settlement: { verify: () => Promise.reject(new Error("not configured")) },
    publicOrigin: ORIGIN,
    forms: [],
    hostForms: [],
    offerings: [],
    clock: () => new Date(NOW),
  });
  const sessionResponse = await bootstrap.fetch(
    new Request(`${ORIGIN}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "takos-id", assertion: "bootstrap" }),
    }),
  );
  expect(sessionResponse.status).toBe(200);
  const organizationId = INTEGRATION_E2E_ORGANIZATION_ID;
  const authority = {
    environment: "integration",
    organizationId,
    publicJwk: { kty: "OKP", crv: "Ed25519", x: string(publicJwk.x) },
    sourceCommit: "a".repeat(40),
    artifactDigest: `sha256:${"b".repeat(64)}` as const,
    publicWorkerVersionId: "00000000-0000-4000-8000-000000000001",
  } as const;
  const app = buildApp({
    sql,
    objects: createMemoryObjectStore(),
    identity: { verify: () => Promise.reject(new Error("not configured")) },
    settlement: { verify: () => Promise.reject(new Error("not configured")) },
    publicOrigin: ORIGIN,
    forms: [],
    hostForms: [],
    offerings: [],
    clock: () => new Date(NOW),
    publicWorkerVersionId: authority.publicWorkerVersionId,
    integrationE2eCredentialAuthority: authority,
  });
  const target = {
    kind: "takoserver.deploy-target@v2",
    environment: "integration",
    accountId: "a".repeat(32),
    workerName: "takoserver-api-integration",
    d1: {
      databaseName: "takoserver-runtime-integration",
      databaseId: "00000000-0000-4000-8000-000000000000",
    },
    r2: { bucketName: "takoserver-objects-integration" },
    publicOrigin: ORIGIN,
    signing: { currentKeyId: "takoserver-integration-202608" },
  } satisfies DeployTarget;
  const fetcher = async (input: string, init?: RequestInit) =>
    await app.fetch(new Request(input, init));
  const paths = credentialPaths(outputDirectory);
  return {
    root,
    outputDirectory,
    privatePath,
    paths,
    organizationId,
    options: {
      origin: ORIGIN,
      target,
      authority,
      privateJwkPath: privatePath,
      outputDirectory,
      fetcher,
      now: () => new Date(NOW),
    },
    fetcher,
    liveKeyCount: async () =>
      Number(
        (
          await sql.query(
            "SELECT COUNT(*) AS count FROM auth_tokens WHERE kind = 'api_key' AND revoked_at IS NULL",
          )
        )[0]?.count ?? -1,
      ),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function actionFromPath(path: string): IntegrationE2eCredentialAuthorityAction | null {
  for (const action of ["issue", "status", "revoke"] as const) {
    if (path === credentialAuthorityPath(action)) return action;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("record");
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("string");
  return value;
}
