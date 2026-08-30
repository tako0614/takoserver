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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeployTarget } from "../scripts/deploy/target.ts";
import {
  credentialPaths,
  EVIDENCE_KEY_NAME,
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
  test("issues one exact-org writer/evidence pair into three owner-only 0600 files", async () => {
    const fixture = await testFixture();
    const requests: { readonly method: string; readonly path: string; readonly url: string }[] = [];
    let sawDurableCoordinatesBeforeIssue = false;
    try {
      const metadata = await issueIntegrationCredentials({
        ...fixture.options,
        fetcher: async (input, init) => {
          expect(existsSync(fixture.paths.metadata)).toBe(true);
          expect(existsSync(fixture.paths.writerSecret)).toBe(false);
          expect(existsSync(fixture.paths.evidenceSecret)).toBe(false);
          const metadataStat = lstatSync(fixture.paths.metadata);
          expect(metadataStat.mode & 0o777).toBe(0o600);
          expect(metadataStat.nlink).toBe(1);
          sawDurableCoordinatesBeforeIssue = true;
          requests.push({
            method: init?.method ?? "GET",
            path: new URL(input).pathname,
            url: input,
          });
          return await fixture.fetcher(input, init);
        },
      });

      expect(metadata.organizationId).toBe(fixture.organizationId);
      expect(metadata.ttlSeconds).toBe(KEY_TTL_SECONDS);
      expect(metadata.roles).toMatchObject({
        writer: { name: WRITER_KEY_NAME, scopes: ["resources:write"] },
        evidence: { name: EVIDENCE_KEY_NAME, scopes: ["resources:read"] },
      });
      expect(metadata).not.toHaveProperty("secret");
      expect(metadata).not.toHaveProperty("assertion");
      const writerSecret = readFileSync(fixture.paths.writerSecret, "utf8").trim();
      const evidenceSecret = readFileSync(fixture.paths.evidenceSecret, "utf8").trim();
      expect(writerSecret.length).toBeGreaterThan(16);
      expect(evidenceSecret.length).toBeGreaterThan(16);
      expect(writerSecret).not.toBe(evidenceSecret);
      const metadataBytes = readFileSync(fixture.paths.metadata, "utf8");
      expect(metadataBytes).not.toContain(writerSecret);
      expect(metadataBytes).not.toContain(evidenceSecret);
      for (const path of [
        fixture.paths.writerSecret,
        fixture.paths.evidenceSecret,
        fixture.paths.metadata,
      ]) {
        const stat = lstatSync(path);
        expect(stat.isSymbolicLink()).toBe(false);
        expect(stat.nlink).toBe(1);
        expect(stat.mode & 0o777).toBe(0o600);
      }
      expect(requests.map((request) => request.path)).toEqual([credentialAuthorityPath("issue")]);
      expect(sawDurableCoordinatesBeforeIssue).toBe(true);
      expect(requests.every((request) => !request.url.includes("assertion"))).toBe(true);
      expect(requests.every((request) => !request.url.includes("secret"))).toBe(true);
      expect(await fixture.liveKeyCount()).toBe(2);
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
      expect(existsSync(fixture.paths.writerSecret)).toBe(false);
      expect(existsSync(fixture.paths.evidenceSecret)).toBe(false);
      expect(existsSync(fixture.paths.metadata)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("compensates an evidence-secret publication failure and proves both ids absent", async () => {
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
            if (path === fixture.paths.evidenceSecret) {
              throw new Error("disk acknowledgement lost for secret=api-key-secret-value");
            }
          },
        }),
      ).rejects.toBeInstanceOf(IntegrationCredentialError);

      expect(actions).toEqual(["issue", "revoke", "status"]);
      expect(await fixture.liveKeyCount()).toBe(0);
      expect(existsSync(fixture.paths.writerSecret)).toBe(false);
      expect(existsSync(fixture.paths.evidenceSecret)).toBe(false);
      expect(existsSync(fixture.paths.metadata)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("preserves every recovery path when secret publication compensation lacks signed absence", async () => {
    const fixture = await testFixture();
    const actions: IntegrationE2eCredentialAuthorityAction[] = [];
    const diagnosticSecret = "api-key-secret-value-must-not-escape";
    try {
      const failure = await issueIntegrationCredentials({
        ...fixture.options,
        fetcher: async (input, init) => {
          const action = actionFromPath(new URL(input).pathname);
          if (action) actions.push(action);
          if (action === "status") throw new Error(`status lost secret=${diagnosticSecret}`);
          return await fixture.fetcher(input, init);
        },
        writeSecret: async (path, secret) => {
          writeFileSync(path, `${secret}\n`, { mode: 0o600 });
          if (path === fixture.paths.evidenceSecret) {
            throw new Error(`disk acknowledgement lost secret=${diagnosticSecret}`);
          }
        },
      }).catch((error) => error);

      expect(failure).toBeInstanceOf(IntegrationCredentialError);
      expect(failure.message).toContain("compensation is indeterminate");
      expect(failure.message).not.toContain(diagnosticSecret);
      expect(actions).toEqual(["issue", "revoke", "status"]);
      for (const path of [
        fixture.paths.writerSecret,
        fixture.paths.evidenceSecret,
        fixture.paths.metadata,
      ]) {
        expect(pathEntryExists(path)).toBe(true);
      }
      expect(readFileSync(fixture.paths.metadata, "utf8")).not.toContain(diagnosticSecret);
    } finally {
      fixture.cleanup();
    }
  });

  test("resumes an exact revoking operation after signed status without replaying issue", async () => {
    const fixture = await testFixture();
    const actions: IntegrationE2eCredentialAuthorityAction[] = [];
    let loseFirstRevoke = true;
    try {
      const metadata = await issueIntegrationCredentials(fixture.options);
      const revoked = await revokeIntegrationCredentials({
        ...fixture.options,
        fetcher: async (input, init) => {
          const action = actionFromPath(new URL(input).pathname);
          if (action) actions.push(action);
          if (action === "revoke" && loseFirstRevoke) {
            loseFirstRevoke = false;
            const claimed = await fixture.sql.run(
              `UPDATE integration_e2e_credential_pair_operations
               SET state = 'revoking', fence = fence + 1, updated_at = ?
               WHERE operation_id = ? AND state = 'active'`,
              [NOW, metadata.operationId],
            );
            expect(claimed.changes).toBe(1);
            throw new Error("revoke acknowledgement lost secret=must-not-escape");
          }
          return await fixture.fetcher(input, init);
        },
      });

      expect(revoked).toMatchObject({ operationId: metadata.operationId, absent: true });
      expect(actions).toEqual(["revoke", "status", "revoke", "status"]);
      expect(await fixture.liveKeyCount()).toBe(0);
      expect(pathEntryExists(fixture.paths.metadata)).toBe(false);
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
        state: "active",
        completeness: "complete",
        roles: {
          writer: { keyId: metadata.roles.writer.keyId, present: true, usable: true },
          evidence: { keyId: metadata.roles.evidence.keyId, present: true, usable: true },
        },
      });
      expect(status.files).toMatchObject({
        writerSecret: { exists: true },
        evidenceSecret: { exists: true },
        metadata: { exists: true },
      });

      const revoked = await revokeIntegrationCredentials({
        ...fixture.options,
        fetcher: async (input, init) => {
          const action = actionFromPath(new URL(input).pathname);
          if (action) actions.push(action);
          return await fixture.fetcher(input, init);
        },
      });
      expect(revoked).toMatchObject({
        operationId: metadata.operationId,
        keyIds: {
          writer: metadata.roles.writer.keyId,
          evidence: metadata.roles.evidence.keyId,
        },
        absent: true,
      });
      expect(actions).toEqual(["status", "revoke", "status"]);
      expect(await fixture.liveKeyCount()).toBe(0);
      expect(existsSync(fixture.paths.writerSecret)).toBe(false);
      expect(existsSync(fixture.paths.evidenceSecret)).toBe(false);
      expect(existsSync(fixture.paths.metadata)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("recovers and revokes an older live pair through the current dedicated authority", async () => {
    const fixture = await testFixture();
    try {
      const metadata = await issueIntegrationCredentials(fixture.options);
      const nextPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      const nextPrivate = (await crypto.subtle.exportKey("jwk", nextPair.privateKey)) as JsonWebKey;
      const nextPublic = (await crypto.subtle.exportKey("jwk", nextPair.publicKey)) as JsonWebKey;
      const nextPrivatePath = join(fixture.root, "integration-e2e-api-key-next.jwk");
      writeFileSync(nextPrivatePath, `${JSON.stringify(nextPrivate)}\n`, { mode: 0o600 });
      chmodSync(nextPrivatePath, 0o600);
      const nextAuthority = {
        environment: "integration",
        organizationId: fixture.organizationId,
        publicJwk: { kty: "OKP", crv: "Ed25519", x: string(nextPublic.x) },
        sourceCommit: "c".repeat(40),
        artifactDigest: `sha256:${"d".repeat(64)}` as const,
        publicWorkerVersionId: "00000000-0000-4000-8000-000000000002",
      } as const;
      const currentApp = buildApp({
        sql: fixture.sql,
        objects: createMemoryObjectStore(),
        identity: { verify: () => Promise.reject(new Error("not configured")) },
        settlement: { verify: () => Promise.reject(new Error("not configured")) },
        publicOrigin: ORIGIN,
        forms: [],
        hostForms: [],
        offerings: [],
        clock: () => new Date(NOW),
        publicWorkerVersionId: nextAuthority.publicWorkerVersionId,
        integrationE2eCredentialAuthority: nextAuthority,
      });
      const currentOptions = {
        ...fixture.options,
        authority: nextAuthority,
        privateJwkPath: nextPrivatePath,
        fetcher: async (input: string, init?: RequestInit) =>
          await currentApp.fetch(new Request(input, init)),
      };

      expect(await statusIntegrationCredentials(currentOptions)).toMatchObject({
        remote: {
          state: "active",
          provenance: metadata.requestedAuthority,
        },
      });
      expect(await revokeIntegrationCredentials(currentOptions)).toMatchObject({
        operationId: metadata.operationId,
        absent: true,
      });
      expect(await fixture.liveKeyCount()).toBe(0);
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
      expect(await fixture.liveKeyCount()).toBe(2);
    } finally {
      fixture.cleanup();
    }
  });

  test("fails closed when a dangling metadata path entry would otherwise look absent", async () => {
    const fixture = await testFixture();
    try {
      symlinkSync(join(fixture.root, "missing-metadata-target"), fixture.paths.metadata);
      await expect(statusIntegrationCredentials(fixture.options)).rejects.toThrow("symlink");
      expect(pathEntryExists(fixture.paths.metadata)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("unlinks a dangling secret path only after signed terminal absence", async () => {
    const fixture = await testFixture();
    try {
      const metadata = await issueIntegrationCredentials(fixture.options);
      unlinkSync(fixture.paths.evidenceSecret);
      symlinkSync(join(fixture.root, "missing-evidence-target"), fixture.paths.evidenceSecret);

      expect(await revokeIntegrationCredentials(fixture.options)).toMatchObject({
        operationId: metadata.operationId,
        absent: true,
      });
      for (const path of [
        fixture.paths.writerSecret,
        fixture.paths.evidenceSecret,
        fixture.paths.metadata,
      ]) {
        expect(pathEntryExists(path)).toBe(false);
      }
    } finally {
      fixture.cleanup();
    }
  });

  test("rechecks all three path entries after terminal cleanup before claiming absence", async () => {
    const fixture = await testFixture();
    try {
      await issueIntegrationCredentials(fixture.options);
      const failure = await revokeIntegrationCredentials({
        ...fixture.options,
        removeFile: async (path) => {
          unlinkSync(path);
          if (path === fixture.paths.metadata) {
            writeFileSync(fixture.paths.writerSecret, "recreated-path-entry\n", { mode: 0o600 });
          }
        },
      }).catch((error) => error);

      expect(failure).toBeInstanceOf(IntegrationCredentialError);
      expect(failure.message).toContain("local file cleanup failed");
      expect(pathEntryExists(fixture.paths.writerSecret)).toBe(true);
      expect(await fixture.liveKeyCount()).toBe(0);
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
      ).rejects.toThrow("exactly 3600 seconds");
      for (const target of [
        {
          ...fixture.options.target,
          operatorIdentity: { publicJwk: fixture.options.authority.publicJwk },
        },
        {
          ...fixture.options.target,
          formAuthority: {
            workerName: "takoserver-form-authority-integration",
            identityProbeWorkerName: "takoserver-form-identity-integration",
            identityProbeOrigin:
              "https://takoserver-form-identity-integration.integration.example.workers.dev",
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
      expect(await fixture.liveKeyCount()).toBe(2);
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
      const roles = record(metadata.roles);
      const writer = record(roles.writer);
      writer.keyId = "key_ie2e_w_0000000000000000000000000000000000000000";
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
      expect(await fixture.liveKeyCount()).toBe(2);
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
    sql,
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

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
