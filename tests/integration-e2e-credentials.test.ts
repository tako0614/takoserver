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
  FIXTURE_ORGANIZATION_NAME,
  IntegrationCredentialError,
  issueIntegrationCredentials,
  READER_KEY_NAME,
  revokeIntegrationCredentials,
  WRITER_KEY_NAME,
} from "../scripts/integration-e2e-credentials.ts";
import { buildApp, createEphemeralSql, createMemoryObjectStore } from "../src/index.ts";
import { createOperatorIdentity } from "../src/operator-credentials.ts";

const ORIGIN = "https://api.integration.example.test";

describe("integration E2E credential helper", () => {
  test("redacts assertions, sessions, and API-key secrets from surfaced errors", () => {
    const error = new IntegrationCredentialError(
      "sessionToken=session-secret-value secret=api-key-secret-value " +
        "assertion=operator-assertion-value Bearer bearer-session-value d=private-key-value",
    );
    expect(error.message).not.toContain("session-secret-value");
    expect(error.message).not.toContain("api-key-secret-value");
    expect(error.message).not.toContain("operator-assertion-value");
    expect(error.message).not.toContain("bearer-session-value");
    expect(error.message).not.toContain("private-key-value");
    expect(error.message).toContain("[REDACTED]");
  });

  test("issues exact scopes into 0600 files, revokes its session, and never returns secrets in metadata", async () => {
    const fixture = await testFixture();
    try {
      const requests: { method: string; path: string; status: number }[] = [];
      const result = await issueIntegrationCredentials({
        ...fixture.options,
        fetcher: async (input, init) => {
          const response = await fixture.fetcher(input, init);
          requests.push({
            method: init?.method ?? "GET",
            path: new URL(input).pathname,
            status: response.status,
          });
          return response;
        },
      });

      expect(result.organizationName).toBe(FIXTURE_ORGANIZATION_NAME);
      expect(result.keys.map((key) => [key.name, key.scopes])).toEqual([
        [WRITER_KEY_NAME, ["resources:write"]],
        [READER_KEY_NAME, ["resources:read"]],
      ]);
      expect(result.keys.every((key) => key.expiresAt && key.createdAt)).toBe(true);
      expect(result).not.toHaveProperty("secret");
      expect(result).not.toHaveProperty("assertion");
      for (const path of [fixture.paths.writer, fixture.paths.reader, fixture.paths.metadata]) {
        const stat = lstatSync(path);
        expect(stat.isSymbolicLink()).toBe(false);
        expect(stat.mode & 0o777).toBe(0o600);
      }
      const metadata = readFileSync(fixture.paths.metadata, "utf8");
      expect(metadata).not.toContain("writer-secret");
      expect(metadata).not.toContain("reader-secret");
      expect(requests.filter((request) => request.path === "/v1/session")).toEqual([
        { method: "DELETE", path: "/v1/session", status: 204 },
      ]);
      expect(requests.filter((request) => request.path === "/v1/me").at(-1)).toEqual({
        method: "GET",
        path: "/v1/me",
        status: 401,
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("compensates acknowledged keys and files when the second secret cannot be persisted", async () => {
    const fixture = await testFixture();
    const calls: { method: string; path: string }[] = [];
    let writes = 0;
    try {
      await expect(
        issueIntegrationCredentials({
          ...fixture.options,
          fetcher: async (input, init) => {
            calls.push({ method: init?.method ?? "GET", path: new URL(input).pathname });
            return fakeCredentialApi(input, init);
          },
          writeSecret: async (path, secret) => {
            writes += 1;
            if (writes === 1) writeFileSync(path, `${secret}\n`, { mode: 0o600 });
            else throw new Error("simulated disk failure");
          },
        }),
      ).rejects.toBeInstanceOf(IntegrationCredentialError);
      expect(writes).toBe(2);
      expect(existsSync(fixture.paths.writer)).toBe(false);
      expect(existsSync(fixture.paths.reader)).toBe(false);
      expect(existsSync(fixture.paths.metadata)).toBe(false);
      expect(calls.filter((call) => call.method === "DELETE")).toEqual([
        {
          method: "DELETE",
          path: "/v1/organizations/org_fixture/api-keys/key_reader",
        },
        {
          method: "DELETE",
          path: "/v1/organizations/org_fixture/api-keys/key_writer",
        },
        { method: "DELETE", path: "/v1/session" },
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  test("fails closed on duplicate metadata before signing in or touching the API", async () => {
    const fixture = await testFixture();
    const calls: string[] = [];
    try {
      writeFileSync(fixture.paths.metadata, "not metadata\n", { mode: 0o600 });
      await expect(
        issueIntegrationCredentials({
          ...fixture.options,
          fetcher: async (input, init) => {
            calls.push(`${init?.method ?? "GET"} ${new URL(input).pathname}`);
            return fixture.fetcher(input, init);
          },
        }),
      ).rejects.toThrow("credential destination already exists");
      expect(calls).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects unsafe private/output paths", async () => {
    const fixture = await testFixture();
    try {
      chmodSync(fixture.privatePath, 0o644);
      await expect(issueIntegrationCredentials(fixture.options)).rejects.toThrow("mode 0600");

      chmodSync(fixture.privatePath, 0o600);
      const linkedOutput = join(fixture.root, "linked-output");
      symlinkSync(fixture.outputDirectory, linkedOutput);
      await expect(
        issueIntegrationCredentials({ ...fixture.options, outputDirectory: linkedOutput }),
      ).rejects.toThrow("may not contain symlinks");

      await expect(
        issueIntegrationCredentials({ ...fixture.options, outputDirectory: process.cwd() }),
      ).rejects.toThrow("outside every Git repository");

      const linkedPrivate = join(fixture.root, "linked-private.jwk");
      symlinkSync(fixture.privatePath, linkedPrivate);
      await expect(
        issueIntegrationCredentials({ ...fixture.options, privateJwkPath: linkedPrivate }),
      ).rejects.toThrow("may not contain symlinks");
    } finally {
      fixture.cleanup();
    }
  });

  test("revokes exact API keys through HTTP, keeps the fixture organization, and removes only owned files", async () => {
    const fixture = await testFixture();
    try {
      const issued = await issueIntegrationCredentials(fixture.options);
      const revoked = await revokeIntegrationCredentials(fixture.options);
      expect(revoked.organizationId).toBe(issued.organizationId);
      expect(revoked.removed).toEqual([
        fixture.paths.writer,
        fixture.paths.reader,
        fixture.paths.metadata,
      ]);
      expect(existsSync(fixture.paths.writer)).toBe(false);
      expect(existsSync(fixture.paths.reader)).toBe(false);
      expect(existsSync(fixture.paths.metadata)).toBe(false);

      const session = await fixture.signIn();
      const me = await fixture.fetcher(`${ORIGIN}/v1/me`, {
        method: "GET",
        headers: { authorization: `Bearer ${session}` },
      });
      const body = (await me.json()) as {
        organizations: { id: string; name: string }[];
      };
      const organization = body.organizations.find((item) => item.id === issued.organizationId);
      expect(organization?.name).toBe(FIXTURE_ORGANIZATION_NAME);
      const keys = await fixture.fetcher(
        `${ORIGIN}/v1/organizations/${issued.organizationId}/api-keys`,
        { method: "GET", headers: { authorization: `Bearer ${session}` } },
      );
      expect(keys.status).toBe(200);
      expect(await keys.json()).toEqual({ apiKeys: [] });
      const signOut = await fixture.fetcher(`${ORIGIN}/v1/session`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${session}` },
      });
      expect(signOut.status).toBe(204);
    } finally {
      fixture.cleanup();
    }
  });

  test("retries a partial revoke and repairs the remaining fixture without recreating a key", async () => {
    const fixture = await testFixture();
    try {
      const issued = await issueIntegrationCredentials(fixture.options);
      let failReaderRevoke = true;
      const firstAttemptFetcher = async (input: string, init?: RequestInit): Promise<Response> => {
        const response = await fixture.fetcher(input, init);
        const path = new URL(input).pathname;
        if (
          failReaderRevoke &&
          init?.method === "DELETE" &&
          path.endsWith(`/api-keys/${issued.keys[1]?.keyId}`)
        ) {
          failReaderRevoke = false;
          return Response.json({ error: "acknowledgement lost" }, { status: 503 });
        }
        return response;
      };
      await expect(
        revokeIntegrationCredentials({ ...fixture.options, fetcher: firstAttemptFetcher }),
      ).rejects.toBeInstanceOf(IntegrationCredentialError);

      const retried = await revokeIntegrationCredentials(fixture.options);
      expect(retried.organizationId).toBe(issued.organizationId);
      expect(existsSync(fixture.paths.writer)).toBe(false);
      expect(existsSync(fixture.paths.reader)).toBe(false);
      expect(existsSync(fixture.paths.metadata)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("reconciles a key whose create response is malformed before compensating", async () => {
    const fixture = await testFixture();
    try {
      let loseFirstCreateResponse = true;
      const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
        const response = await fixture.fetcher(input, init);
        if (
          loseFirstCreateResponse &&
          init?.method === "POST" &&
          new URL(input).pathname.endsWith("/api-keys")
        ) {
          loseFirstCreateResponse = false;
          return new Response("not-json", { status: response.status });
        }
        return response;
      };
      await expect(
        issueIntegrationCredentials({ ...fixture.options, fetcher }),
      ).rejects.toBeInstanceOf(IntegrationCredentialError);

      const session = await fixture.signIn();
      const me = await fixture.fetcher(`${ORIGIN}/v1/me`, {
        method: "GET",
        headers: { authorization: `Bearer ${session}` },
      });
      const body = (await me.json()) as {
        organizations: { id: string; name: string }[];
      };
      const organization = body.organizations.find(
        (item) => item.name === FIXTURE_ORGANIZATION_NAME,
      );
      expect(organization).toBeDefined();
      const remaining = await fixture.fetcher(
        `${ORIGIN}/v1/organizations/${organization?.id}/api-keys`,
        { method: "GET", headers: { authorization: `Bearer ${session}` } },
      );
      expect(await remaining.json()).toEqual({ apiKeys: [] });
      const signOut = await fixture.fetcher(`${ORIGIN}/v1/session`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${session}` },
      });
      expect(signOut.status).toBe(204);
    } finally {
      fixture.cleanup();
    }
  });

  test("reports indeterminate compensation when an unknown create cannot be listed", async () => {
    const fixture = await testFixture();
    try {
      let created = false;
      let failedLists = 0;
      const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
        const path = new URL(input).pathname;
        if (created && init?.method === "GET" && path.endsWith("/api-keys") && failedLists < 3) {
          failedLists += 1;
          throw new Error("simulated list outage");
        }
        const response = await fixture.fetcher(input, init);
        if (init?.method === "POST" && path.endsWith("/api-keys")) {
          created = true;
          return new Response("not-json", { status: response.status });
        }
        return response;
      };

      await expect(issueIntegrationCredentials({ ...fixture.options, fetcher })).rejects.toThrow(
        "credential compensation is indeterminate",
      );
      expect(failedLists).toBe(3);

      const session = await fixture.signIn();
      const me = await fixture.fetcher(`${ORIGIN}/v1/me`, {
        method: "GET",
        headers: { authorization: `Bearer ${session}` },
      });
      const body = (await me.json()) as {
        organizations: { id: string; name: string }[];
      };
      const organization = body.organizations.find(
        (item) => item.name === FIXTURE_ORGANIZATION_NAME,
      );
      const remaining = await fixture.fetcher(
        `${ORIGIN}/v1/organizations/${organization?.id}/api-keys`,
        { method: "GET", headers: { authorization: `Bearer ${session}` } },
      );
      expect((await remaining.json()) as { apiKeys: unknown[] }).toMatchObject({
        apiKeys: [{ name: WRITER_KEY_NAME }],
      });
      const signOut = await fixture.fetcher(`${ORIGIN}/v1/session`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${session}` },
      });
      expect(signOut.status).toBe(204);
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects a destination replaced after the secret writer publishes it", async () => {
    const fixture = await testFixture();
    try {
      let writes = 0;
      await expect(
        issueIntegrationCredentials({
          ...fixture.options,
          writeSecret: async (path, secret) => {
            writes += 1;
            writeFileSync(path, `${secret}\n`, { mode: 0o600 });
            if (writes === 1) writeFileSync(path, "attacker replacement\n", { mode: 0o600 });
          },
        }),
      ).rejects.toBeInstanceOf(IntegrationCredentialError);
      expect(writes).toBe(1);

      const session = await fixture.signIn();
      const me = await fixture.fetcher(`${ORIGIN}/v1/me`, {
        method: "GET",
        headers: { authorization: `Bearer ${session}` },
      });
      const body = (await me.json()) as {
        organizations: { id: string; name: string }[];
      };
      const organization = body.organizations.find(
        (item) => item.name === FIXTURE_ORGANIZATION_NAME,
      );
      expect(organization).toBeDefined();
      const remaining = await fixture.fetcher(
        `${ORIGIN}/v1/organizations/${organization?.id}/api-keys`,
        { method: "GET", headers: { authorization: `Bearer ${session}` } },
      );
      expect(await remaining.json()).toEqual({ apiKeys: [] });
      const signOut = await fixture.fetcher(`${ORIGIN}/v1/session`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${session}` },
      });
      expect(signOut.status).toBe(204);
    } finally {
      fixture.cleanup();
    }
  });

  test("retains unrelated organization keys while revoking only the owned fixture pair", async () => {
    const fixture = await testFixture();
    try {
      const issued = await issueIntegrationCredentials(fixture.options);
      const session = await fixture.signIn();
      const create = await fixture.fetcher(
        `${ORIGIN}/v1/organizations/${issued.organizationId}/api-keys`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${session}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "unrelated integration key",
            scopes: ["catalog:read"],
            expiresInSeconds: 3600,
          }),
        },
      );
      expect(create.status).toBe(201);
      const signOut = await fixture.fetcher(`${ORIGIN}/v1/session`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${session}` },
      });
      expect(signOut.status).toBe(204);

      await revokeIntegrationCredentials(fixture.options);
      const remainingSession = await fixture.signIn();
      const remaining = await fixture.fetcher(
        `${ORIGIN}/v1/organizations/${issued.organizationId}/api-keys`,
        { method: "GET", headers: { authorization: `Bearer ${remainingSession}` } },
      );
      expect(await remaining.json()).toMatchObject({
        apiKeys: [{ name: "unrelated integration key", scopes: ["catalog:read"] }],
      });
      const finalSignOut = await fixture.fetcher(`${ORIGIN}/v1/session`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${remainingSession}` },
      });
      expect(finalSignOut.status).toBe(204);
    } finally {
      fixture.cleanup();
    }
  });
});

async function testFixture() {
  const root = mkdtempSync(join(tmpdir(), "takoserver-integration-e2e-"));
  const outputDirectory = join(root, "credentials");
  const privatePath = join(root, "operator.jwk");
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  mkdirSync(outputDirectory, { mode: 0o700 });
  writeFileSync(privatePath, `${JSON.stringify(privateJwk)}\n`, { mode: 0o600 });
  chmodSync(privatePath, 0o600);
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
    operatorIdentity: {
      publicJwk: { kty: "OKP", crv: "Ed25519", x: String(publicJwk.x) },
    },
  } satisfies DeployTarget;
  const identity = createOperatorIdentity({
    publicKeyJwk: target.operatorIdentity.publicJwk,
  });
  const app = buildApp({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    identity,
    settlement: { verify: () => Promise.reject(new Error("not configured")) },
    publicOrigin: ORIGIN,
    forms: [],
    hostForms: [],
    offerings: [],
  });
  const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    return app.fetch(new Request(input, init));
  };
  const paths = credentialPaths(outputDirectory);
  const signIn = async (): Promise<string> => {
    const now = Math.floor(Date.now() / 1_000);
    const assertion = await signAssertion(privateJwk, now);
    const response = await fetcher(`${ORIGIN}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "google", method: "operator-assertion", assertion }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessionToken: string };
    return body.sessionToken;
  };
  return {
    root,
    outputDirectory,
    privatePath,
    paths,
    options: { origin: ORIGIN, target, privateJwkPath: privatePath, outputDirectory, fetcher },
    fetcher,
    signIn,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function signAssertion(privateJwk: JsonWebKey, nowSeconds: number): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "Ed25519" }, false, [
    "sign",
  ]);
  const payload = base64Url(
    new TextEncoder().encode(
      JSON.stringify({
        purpose: "sign-in",
        provider: "google",
        subject: "task-0037-integration-operator",
        email: "task-0037-integration-operator@localhost",
        displayName: "TASK-0037 Integration Operator",
        iat: nowSeconds,
        exp: nowSeconds + 600,
      }),
    ),
  );
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(payload));
  return `${payload}.${base64Url(new Uint8Array(signature))}`;
}

async function fakeCredentialApi(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input);
  if (url.pathname === "/v1/sessions" && init?.method === "POST") {
    return Response.json({ sessionToken: "session-secret-value" }, { status: 200 });
  }
  if (url.pathname === "/v1/me") {
    return Response.json({
      principal: { id: "prn_fixture" },
      organizations: [{ id: "org_fixture", name: FIXTURE_ORGANIZATION_NAME }],
    });
  }
  if (url.pathname === "/v1/organizations/org_fixture/api-keys" && init?.method === "GET") {
    return Response.json({ apiKeys: [] });
  }
  if (url.pathname === "/v1/organizations/org_fixture/api-keys" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as { name: string; scopes: string[] };
    const id = body.name === WRITER_KEY_NAME ? "key_writer" : "key_reader";
    return Response.json(
      {
        apiKey: {
          id,
          organizationId: "org_fixture",
          name: body.name,
          scopes: body.scopes,
          createdAt: "2026-08-28T00:00:00.000Z",
          expiresAt: "2026-08-28T01:00:00.000Z",
        },
        secret: `${body.name}-secret-value`,
      },
      { status: 201 },
    );
  }
  if (
    url.pathname.endsWith("/api-keys/key_reader") ||
    url.pathname.endsWith("/api-keys/key_writer")
  ) {
    return Response.json({ apiKey: {} }, { status: 200 });
  }
  if (url.pathname === "/v1/session" && init?.method === "DELETE") {
    return new Response(null, { status: 204 });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
