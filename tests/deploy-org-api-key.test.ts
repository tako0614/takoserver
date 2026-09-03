import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import {
  MAX_ORG_API_KEY_EXPIRY_DAYS,
  type OrgApiKeyOptions,
  type OrgApiKeyProcess,
  runOrgApiKey,
} from "../scripts/deploy/org-api-key.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { YURUCOMMU_IDENTITY_CAPABILITY_KINDS } from "../src/takoform/implementation-catalog.ts";

const COMMIT = "a".repeat(40);
const ORGANIZATION = "org_takosumi_hosted_staging";
const ORIGIN = "https://api.integration.example.test";
const KEY_ID = "key_1111111111111111111111111111111111111111";
const SESSION = "ses_operator_proof_token_value_0000000000";
const SECRET = "f".repeat(64);

const IDENTITY = {
  kind: "takoserver.operator-sign-in-identity@v1",
  provider: "google",
  subject: "takoserver-operator",
  email: "operator@localhost",
  displayName: "Takoserver Operator",
} as const;

/** Everything the surface writes or reads that must stay outside the repository. */
interface Owned {
  readonly root: string;
  readonly privateJwkPath: string;
  readonly operatorIdentityPath: string;
  readonly outputDirectory: string;
  readonly publicJwk: { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string };
}

async function owned(identity?: Record<string, unknown>): Promise<Owned> {
  const root = mkdtempSync(join(tmpdir(), "takoserver-org-api-key-"));
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as Record<
    string,
    unknown
  >;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<
    string,
    unknown
  >;
  const privateJwkPath = join(root, "operator.jwk");
  writeFileSync(
    privateJwkPath,
    JSON.stringify({
      crv: "Ed25519",
      d: privateJwk.d,
      ext: true,
      key_ops: ["sign"],
      kty: "OKP",
      x: privateJwk.x,
    }),
    { mode: 0o600 },
  );
  chmodSync(privateJwkPath, 0o600);
  const operatorIdentityPath = join(root, "operator-identity.json");
  writeFileSync(operatorIdentityPath, `${JSON.stringify(identity ?? IDENTITY, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(operatorIdentityPath, 0o600);
  const outputDirectory = join(root, "secrets");
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  chmodSync(outputDirectory, 0o700);
  return {
    root,
    privateJwkPath,
    operatorIdentityPath,
    outputDirectory,
    publicJwk: { kty: "OKP", crv: "Ed25519", x: String(publicJwk.x) },
  };
}

function targetFor(input: Owned): DeployTarget {
  return {
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
    edgeSupplies: {
      offerings: YURUCOMMU_IDENTITY_CAPABILITY_KINDS.map((formKind) => ({ formKind })),
    } as unknown as NonNullable<DeployTarget["edgeSupplies"]>,
    operatorIdentity: { publicJwk: input.publicJwk },
    signing: { currentKeyId: "key-current" },
  } satisfies DeployTarget;
}

interface Host {
  readonly fetcher: (input: string, init?: RequestInit) => Promise<Response>;
  readonly calls: string[];
  readonly keys: Map<string, Record<string, unknown>>;
  readonly issuedSecrets: string[];
  sessionRevoked: boolean;
}

function host(
  input: {
    readonly existing?: Record<string, unknown>;
    /** Providers this Host registers an operator-assertion verifier for. */
    readonly assertionProviders?: readonly string[];
    /** The signed-in principal owns nothing, exactly as the owner gate answers. */
    readonly ownerGateRefuses?: boolean;
  } = {},
): Host {
  const state: Host = {
    calls: [],
    keys: new Map(),
    issuedSecrets: [],
    sessionRevoked: false,
    fetcher: async (url, init) => {
      const method = init?.method ?? "GET";
      const path = new URL(url).pathname;
      state.calls.push(`${method} ${path}`);
      if (path === "/.well-known/takoserver") {
        return Response.json({
          product: "takoserver",
          apiVersion: "v1",
          endpoints: { api: ORIGIN, openapi: `${ORIGIN}/openapi.json` },
        });
      }
      if (path === "/openapi.json") return Response.json({ servers: [{ url: ORIGIN }] });
      if (method === "POST" && path === "/v1/sessions") {
        const posted = JSON.parse(String(init?.body)) as { provider: string };
        // Exactly the Host's own answer: a provider it registers nothing for
        // is the caller's error, and the assertion is never even read.
        if (!(input.assertionProviders ?? ["google", "github"]).includes(posted.provider)) {
          return Response.json({ error: { code: "invalid" } }, { status: 400 });
        }
        return Response.json({
          principal: { id: "prn_operator" },
          sessionToken: SESSION,
        });
      }
      const authorized = init?.headers
        ? (init.headers as Record<string, string>).authorization === `Bearer ${SESSION}`
        : false;
      if (method === "DELETE" && path === "/v1/session") {
        state.sessionRevoked = true;
        return new Response(null, { status: 204 });
      }
      if (path === "/v1/me") {
        return state.sessionRevoked || !authorized
          ? Response.json({ error: { code: "unauthenticated" } }, { status: 401 })
          : Response.json({ principal: { id: "prn_operator" }, organizations: [] });
      }
      if (!authorized || state.sessionRevoked) {
        return Response.json({ error: { code: "unauthenticated" } }, { status: 401 });
      }
      const collection = `/v1/organizations/${ORGANIZATION}/api-keys`;
      if (input.ownerGateRefuses && path === collection) {
        return Response.json({ error: { code: "permission_denied" } }, { status: 403 });
      }
      if (method === "GET" && path === collection) {
        return Response.json({ apiKeys: [...state.keys.values()] });
      }
      if (method === "POST" && path === collection) {
        const body = JSON.parse(String(init?.body)) as {
          name: string;
          scopes: string[];
          expiresInSeconds: number;
        };
        const apiKey = {
          id: KEY_ID,
          organizationId: ORGANIZATION,
          name: body.name,
          scopes: body.scopes,
          createdAt: "2026-09-02T00:00:00.000Z",
          expiresAt: new Date(
            Date.parse("2026-09-02T00:00:00.000Z") + body.expiresInSeconds * 1_000,
          ).toISOString(),
        };
        state.keys.set(apiKey.id, apiKey);
        state.issuedSecrets.push(SECRET);
        return Response.json({ apiKey, secret: SECRET }, { status: 201 });
      }
      if (method === "DELETE" && path.startsWith(`${collection}/`)) {
        const id = path.slice(`${collection}/`.length);
        const apiKey = state.keys.get(id);
        if (!apiKey) return Response.json({ error: { code: "not_found" } }, { status: 404 });
        state.keys.delete(id);
        return Response.json({ apiKey });
      }
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    },
  };
  if (input.existing) state.keys.set(String(input.existing.id), input.existing);
  return state;
}

const run: OrgApiKeyProcess = async (command): Promise<CommandResult> => {
  const key = command.join(" ");
  if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
  if (key === "git branch --show-current") return ok("fix/org-api-key\n");
  if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
  throw new Error(`unexpected command: ${key}`);
};

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function optionsFor(input: Owned, live: Host, review?: string): OrgApiKeyOptions {
  return {
    run,
    fetcher: live.fetcher,
    privateJwkPath: input.privateJwkPath,
    operatorIdentityPath: input.operatorIdentityPath,
    outputDirectory: input.outputDirectory,
    ...(review === undefined ? {} : { review }),
  };
}

describe("durable organization API key surface", () => {
  test("mints a bounded key, keeps its secret off every output, and names its own reversal", async () => {
    const input = await owned();
    try {
      const live = host();
      const result = await runOrgApiKey(
        {
          surface: "takoserver-org-api-key",
          action: "mint",
          environment: "integration",
          commit: COMMIT,
          organizationId: ORGANIZATION,
          keyName: "takosumi-hosted-reservation",
          scopes: ["resources:write"],
          expiresInDays: 90,
        },
        targetFor(input),
        optionsFor(input, live, "independent-reviewer"),
      );
      expect(result).toMatchObject({
        kind: "takoserver.org-api-key-mint@v1",
        organizationId: ORGANIZATION,
        apiKeyId: KEY_ID,
        keyName: "takosumi-hosted-reservation",
        expiresInDays: 90,
        reviewer: "independent-reviewer",
        secretsRedacted: true,
        mutationApplied: true,
      });
      expect(result.scopes).toEqual(["resources:write"]);
      expect(result.reversal).toContain("--revoke");
      expect(result.reversal).toContain(`--key-id=${KEY_ID}`);

      // The secret exists exactly once, at 0600, and nowhere in the output.
      const secretPath = join(
        input.outputDirectory,
        `${ORGANIZATION}.takosumi-hosted-reservation.secret`,
      );
      expect(result.secretPath).toBe(secretPath);
      expect(readFileSync(secretPath, "utf8")).toBe(SECRET);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(JSON.stringify(result)).not.toContain(SESSION);

      // The key is recorded where every organization API key is recorded, and
      // the proof session is dead before the surface returns.
      expect([...live.keys.values()]).toHaveLength(1);
      expect(live.sessionRevoked).toBe(true);
      expect(live.calls).toContain("DELETE /v1/session");
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  });

  test("lists live keys without review and without mutating", async () => {
    const input = await owned();
    try {
      const live = host({
        existing: {
          id: KEY_ID,
          organizationId: ORGANIZATION,
          name: "takosumi-hosted-reservation",
          scopes: ["resources:write"],
          createdAt: "2026-09-02T00:00:00.000Z",
          expiresAt: "2026-12-01T00:00:00.000Z",
        },
      });
      const status = await runOrgApiKey(
        {
          surface: "takoserver-org-api-key",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          organizationId: ORGANIZATION,
        },
        targetFor(input),
        optionsFor(input, live),
      );
      expect(status).toMatchObject({
        kind: "takoserver.org-api-key-status@v1",
        organizationId: ORGANIZATION,
        mutationApplied: false,
        ready: true,
      });
      expect(status.apiKeys).toEqual([
        {
          id: KEY_ID,
          organizationId: ORGANIZATION,
          name: "takosumi-hosted-reservation",
          scopes: ["resources:write"],
          createdAt: "2026-09-02T00:00:00.000Z",
          expiresAt: "2026-12-01T00:00:00.000Z",
        },
      ]);
      expect(status).not.toHaveProperty("reviewer");
      expect(live.calls.some((call) => call.startsWith("POST /v1/organizations"))).toBe(false);
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  });

  test("revokes the exact key id and proves its absence", async () => {
    const input = await owned();
    try {
      const live = host({
        existing: {
          id: KEY_ID,
          organizationId: ORGANIZATION,
          name: "takosumi-hosted-reservation",
          scopes: ["resources:write"],
          createdAt: "2026-09-02T00:00:00.000Z",
          expiresAt: "2026-12-01T00:00:00.000Z",
        },
      });
      const result = await runOrgApiKey(
        {
          surface: "takoserver-org-api-key",
          action: "revoke",
          environment: "integration",
          commit: COMMIT,
          organizationId: ORGANIZATION,
          apiKeyId: KEY_ID,
        },
        targetFor(input),
        optionsFor(input, live, "independent-reviewer"),
      );
      expect(result).toMatchObject({
        kind: "takoserver.org-api-key-revoke@v1",
        apiKeyId: KEY_ID,
        revokedKeyName: "takosumi-hosted-reservation",
        mutationApplied: true,
      });
      expect(result.apiKeys).toEqual([]);
      expect(live.keys.size).toBe(0);
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  });

  test("refuses to mint without an independent reviewer, before any credential moves", async () => {
    const input = await owned();
    const previous = process.env.TAKOSERVER_INDEPENDENT_REVIEW;
    delete process.env.TAKOSERVER_INDEPENDENT_REVIEW;
    try {
      const live = host();
      const refusal = await runOrgApiKey(
        {
          surface: "takoserver-org-api-key",
          action: "mint",
          environment: "integration",
          commit: COMMIT,
          organizationId: ORGANIZATION,
          keyName: "takosumi-hosted-reservation",
          scopes: ["resources:write"],
          expiresInDays: 90,
        },
        targetFor(input),
        {
          run,
          fetcher: live.fetcher,
          privateJwkPath: input.privateJwkPath,
          operatorIdentityPath: input.operatorIdentityPath,
          outputDirectory: input.outputDirectory,
        },
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(DeployError);
      expect((refusal as DeployError).phase).toBe("preflight");
      expect((refusal as DeployError).message).toContain("TAKOSERVER_INDEPENDENT_REVIEW");
      // Nothing was signed, no session was opened, nothing was written.
      expect(live.calls).toEqual([]);
      expect(
        existsSync(
          join(input.outputDirectory, `${ORGANIZATION}.takosumi-hosted-reservation.secret`),
        ),
      ).toBe(false);
    } finally {
      if (previous !== undefined) process.env.TAKOSERVER_INDEPENDENT_REVIEW = previous;
      rmSync(input.root, { recursive: true, force: true });
    }
  });

  test("refuses an unbounded expiry and a duplicate live key name", async () => {
    const input = await owned();
    try {
      const unbounded = await runOrgApiKey(
        {
          surface: "takoserver-org-api-key",
          action: "mint",
          environment: "integration",
          commit: COMMIT,
          organizationId: ORGANIZATION,
          keyName: "takosumi-hosted-reservation",
          scopes: ["resources:write"],
          expiresInDays: MAX_ORG_API_KEY_EXPIRY_DAYS + 1,
        },
        targetFor(input),
        optionsFor(input, host(), "independent-reviewer"),
      ).catch((error: unknown) => error);
      expect(unbounded).toBeInstanceOf(DeployError);
      expect((unbounded as DeployError).message).toContain("never issued unbounded");

      const live = host({
        existing: {
          id: KEY_ID,
          organizationId: ORGANIZATION,
          name: "takosumi-hosted-reservation",
          scopes: ["resources:write"],
          createdAt: "2026-09-02T00:00:00.000Z",
          expiresAt: "2026-12-01T00:00:00.000Z",
        },
      });
      const duplicate = await runOrgApiKey(
        {
          surface: "takoserver-org-api-key",
          action: "mint",
          environment: "integration",
          commit: COMMIT,
          organizationId: ORGANIZATION,
          keyName: "takosumi-hosted-reservation",
          scopes: ["resources:write"],
          expiresInDays: 90,
        },
        targetFor(input),
        optionsFor(input, live, "independent-reviewer"),
      ).catch((error: unknown) => error);
      expect(duplicate).toBeInstanceOf(DeployError);
      expect((duplicate as DeployError).phase).toBe("preflight");
      expect((duplicate as DeployError).message).toContain(
        "already has an unrevoked API key named",
      );
      expect(live.keys.size).toBe(1);
      expect(live.sessionRevoked).toBe(true);
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  });

  test("refuses a target that declares no operator authority", async () => {
    const input = await owned();
    try {
      const { operatorIdentity: _absent, ...withoutIdentity } = targetFor(input);
      const refusal = await runOrgApiKey(
        {
          surface: "takoserver-org-api-key",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          organizationId: ORGANIZATION,
        },
        withoutIdentity as DeployTarget,
        optionsFor(input, host()),
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(DeployError);
      expect((refusal as DeployError).message).toContain("operatorIdentity");
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  });

  /**
   * The organization's owner decides which provider must sign in.
   *
   * `org_takosumi_hosted_staging`'s only owner is a `github` principal, and the
   * surface refused with "operator sign-in did not return a usable redacted
   * session, status=500" — a sentence about nothing anyone could act on. The
   * provider is now named on both sides: before a request leaves, when the
   * identity file names a provider no assertion can vouch for, and on the wire,
   * when the Host verifies none for the provider it does name.
   */
  test("mints for a GitHub-owned organization", async () => {
    const input = await owned({ ...IDENTITY, provider: "github", subject: "staging-operator" });
    try {
      const live = host();
      const result = await runOrgApiKey(
        {
          surface: "takoserver-org-api-key",
          action: "mint",
          environment: "integration",
          commit: COMMIT,
          organizationId: ORGANIZATION,
          keyName: "takosumi-hosted-reservation",
          scopes: ["resources:write"],
          expiresInDays: 90,
        },
        targetFor(input),
        optionsFor(input, live, "independent-reviewer"),
      );
      expect(result).toMatchObject({ kind: "takoserver.org-api-key-mint@v1", apiKeyId: KEY_ID });
      expect(live.keys.size).toBe(1);
      expect(live.sessionRevoked).toBe(true);
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  });

  test("refuses an identity naming a provider no operator assertion can vouch for", async () => {
    const input = await owned({ ...IDENTITY, provider: "takos-id" });
    try {
      const live = host();
      const refusal = await runOrgApiKey(
        {
          surface: "takoserver-org-api-key",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          organizationId: ORGANIZATION,
        },
        targetFor(input),
        optionsFor(input, live),
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(DeployError);
      expect((refusal as DeployError).phase).toBe("preflight");
      expect((refusal as DeployError).message).toContain("takos-id");
      expect((refusal as DeployError).message).toContain("google, github");
      // Nothing left for the Host: the mismatch is decided from the file.
      expect(live.calls).toEqual([]);
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  });

  test("names the provider when the Host verifies no assertion for it", async () => {
    const input = await owned({ ...IDENTITY, provider: "github", subject: "staging-operator" });
    try {
      const live = host({ assertionProviders: ["google"] });
      const refusal = await runOrgApiKey(
        {
          surface: "takoserver-org-api-key",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          organizationId: ORGANIZATION,
        },
        targetFor(input),
        optionsFor(input, live),
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(DeployError);
      expect((refusal as DeployError).phase).toBe("preflight");
      expect((refusal as DeployError).message).toContain("github");
      expect((refusal as DeployError).message).toContain("no operator assertion");
      expect(live.keys.size).toBe(0);
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  });

  test("names an assertion-capable identity that is not the organization's owner", async () => {
    const input = await owned();
    try {
      const live = host({ ownerGateRefuses: true });
      const refusal = await runOrgApiKey(
        {
          surface: "takoserver-org-api-key",
          action: "status",
          environment: "integration",
          commit: COMMIT,
          organizationId: ORGANIZATION,
        },
        targetFor(input),
        optionsFor(input, live),
      ).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(DeployError);
      expect((refusal as DeployError).message).toContain("does not own");
      expect((refusal as DeployError).message).toContain(ORGANIZATION);
      expect(live.sessionRevoked).toBe(true);
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  });
});
