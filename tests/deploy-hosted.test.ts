import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import { type HostedDatabase, type HostedProcess, runHosted } from "../scripts/deploy/hosted.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import type { SigningPublicKeyRow } from "../scripts/deploy/signing.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import type { WorkerState } from "../scripts/deploy/worker-live.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";

const COMMIT = "a".repeat(40);
const BUNDLE = "export default {fetch(){return new Response('ok')}};\n";
const DIGEST = createHash("sha256").update(BUNDLE).digest("hex");
const TOKEN = "hosted-token-exact";

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
  publicOrigin: "https://api.integration.example.test",
  signing: { currentKeyId: "key-current" },
  hostedTopology: {
    service: "takosumi-platform",
    entrypoint: "TakosumiHostRuntimeMaterializerEntrypoint",
  },
} satisfies DeployTarget;

async function key() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicJwk = JSON.stringify({ kty: "OKP", crv: "Ed25519", x: jwk.x });
  return { pair, publicJwk };
}

function database(publicJwk: string): HostedDatabase & { readonly reads: number } {
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    async readSigningKey(): Promise<SigningPublicKeyRow> {
      reads += 1;
      return {
        keyId: "key-current",
        publicJwk,
        createdAtEpochSeconds: 1,
        revokedAtEpochSeconds: null,
      };
    },
    async proofTenant() {
      return "tenant-proof";
    },
  };
}

function processFixture() {
  const calls: { command: string[]; input?: string }[] = [];
  let uploadMessage: string | null = null;
  const run: HostedProcess = async (command, options): Promise<CommandResult> => {
    calls.push({
      command: [...command],
      ...(options?.input === undefined ? {} : { input: options.input }),
    });
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") return ok("feature/hosted\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
    if (key === "bun run check") return ok("green\n");
    if (command.includes("secret") && command.includes("put")) return ok("secret updated\n");
    if (command.includes("--dry-run")) {
      const out = command[command.indexOf("--outdir") + 1];
      if (!out) throw new Error("missing outdir");
      writeFileSync(join(out, "index.js"), BUNDLE);
      return ok("built\n");
    }
    if (command.includes("deploy") && command.includes("--no-bundle")) {
      uploadMessage = command[command.indexOf("--message") + 1] ?? null;
      return ok("uploaded\n");
    }
    throw new Error(`unexpected command: ${key}`);
  };
  return { run, calls, message: () => uploadMessage };
}

function state(input: {
  readonly beforeTopology: "desired" | "absent";
  readonly afterTopology: "desired" | "absent";
  readonly beforeHostedSecret: boolean;
  readonly afterHostedSecret: boolean;
  readonly afterMessage?: () => string | null;
}): WorkerState {
  let historyReads = 0;
  let secretReads = 0;
  return {
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: target.workerName }];
    },
    async workerDeployments() {
      historyReads += 1;
      return historyReads === 1
        ? [deployment("deployment-before", "version-before", "2026-08-28T01:00:00Z")]
        : [
            deployment("deployment-after", "version-after", "2026-08-28T02:00:00Z"),
            deployment("deployment-before", "version-before", "2026-08-28T01:00:00Z"),
          ];
    },
    async workerVersion(_worker, versionId) {
      const after = versionId === "version-after";
      return version(
        after ? input.afterTopology : input.beforeTopology,
        after
          ? input.afterHostedSecret
            ? hostedSecrets()
            : baseSecrets()
          : input.beforeHostedSecret
            ? hostedSecrets()
            : baseSecrets(),
        after
          ? (input.afterMessage?.() ?? `takoserver-worker:${COMMIT}:${DIGEST}`)
          : `takoserver-worker:${COMMIT}:${DIGEST}`,
      );
    },
    async workerSecrets() {
      secretReads += 1;
      const after = secretReads > 1;
      const present = after ? input.afterHostedSecret : input.beforeHostedSecret;
      return (present ? hostedSecrets() : baseSecrets()).map((name) => ({
        name,
        type: "secret_text",
      }));
    },
  };
}

describe("ordered Hosted token and topology cutovers", () => {
  test("token cutover changes only the secret, then proves the exact bearer and current signature", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-hosted-token-"));
    try {
      const signing = await key();
      const tokenPath = join(root, "hosted-token");
      writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
      const process = processFixture();
      const signingDatabase = database(signing.publicJwk);
      const requests: Request[] = [];
      const result = await runHosted(
        {
          surface: "takoserver-hosted-token-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database: signingDatabase,
          state: state({
            beforeTopology: "absent",
            afterTopology: "absent",
            beforeHostedSecret: false,
            afterHostedSecret: true,
          }),
          run: process.run,
          tokenPath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: sponsorshipFetcher(signing.pair.privateKey, requests),
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.hosted-token-cutover-apply@v2",
        topology: "absent",
        proof: { keyId: "key-current", tenantRef: "tenant-proof" },
      });
      const mutations = process.calls.filter(
        ({ command }) => command.includes("secret") && command.includes("put"),
      );
      expect(mutations).toHaveLength(1);
      expect(mutations[0]?.input).toBe(TOKEN);
      expect(mutations[0]?.command.join(" ")).not.toContain(TOKEN);
      expect(process.calls.some(({ command }) => command.includes("--no-bundle"))).toBe(false);
      expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(signingDatabase.reads).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("topology refuses to run before the Hosted token exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-hosted-order-"));
    try {
      const signing = await key();
      const tokenPath = join(root, "hosted-token");
      writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
      const process = processFixture();
      const failure = await runHosted(
        {
          surface: "takoserver-hosted-topology-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database: database(signing.publicJwk),
          state: state({
            beforeTopology: "absent",
            afterTopology: "desired",
            beforeHostedSecret: false,
            afterHostedSecret: false,
          }),
          run: process.run,
          tokenPath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: sponsorshipFetcher(signing.pair.privateKey, []),
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure.message).toContain("HOSTED_SPONSORSHIP_TOKEN");
      expect(process.calls.some(({ command }) => command.includes("--dry-run"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("topology proves the token first, then uploads identical code with only the service binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-hosted-topology-"));
    try {
      const signing = await key();
      const tokenPath = join(root, "hosted-token");
      writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
      const process = processFixture();
      const signingDatabase = database(signing.publicJwk);
      const requests: Request[] = [];
      const result = await runHosted(
        {
          surface: "takoserver-hosted-topology-cutover",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          database: signingDatabase,
          state: state({
            beforeTopology: "absent",
            afterTopology: "desired",
            beforeHostedSecret: true,
            afterHostedSecret: true,
            afterMessage: process.message,
          }),
          run: process.run,
          tokenPath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: sponsorshipFetcher(signing.pair.privateKey, requests),
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.hosted-topology-cutover-apply@v2",
        topology: "desired",
        service: target.hostedTopology.service,
        entrypoint: target.hostedTopology.entrypoint,
      });
      expect(requests).toHaveLength(2);
      expect(process.calls.filter(({ command }) => command.includes("--dry-run"))).toHaveLength(1);
      expect(process.calls.filter(({ command }) => command.includes("--no-bundle"))).toHaveLength(
        1,
      );
      expect(
        process.calls.some(({ command }) => command.includes("secret") && command.includes("put")),
      ).toBe(false);
      expect(process.calls.some(({ command }) => command.join(" ").includes(TOKEN))).toBe(false);
      expect(signingDatabase.reads).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function baseSecrets(): string[] {
  return ["TAKOSERVER_SIGNING_KEY"];
}

function hostedSecrets(): string[] {
  return ["TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN", "TAKOSERVER_SIGNING_KEY"];
}

function version(topology: "desired" | "absent", secrets: readonly string[], message: string) {
  const expected = expectedExactBindingClosure(target, {
    hostedTopology: topology,
    signingKeyId: "key-current",
    expectedSecrets: secrets,
  });
  return {
    annotations: { "workers/message": message },
    resources: {
      bindings: Object.entries(expected).flatMap(([name, requirement]) =>
        requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
    },
  };
}

function sponsorshipFetcher(privateKey: CryptoKey, requests: Request[]) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    requests.push(request.clone());
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const issuedAt = Math.floor(Date.now() / 1_000);
    const header = encode({ alg: "EdDSA", kid: "key-current", typ: "takoserver-token+jwt" });
    const payload = encode({
      aud: "takoform.run",
      exp: issuedAt + 60,
      iat: issuedAt,
      iss: target.publicOrigin,
      jti: "tok_hosted-proof",
      mode: "tenant-run",
      nbf: issuedAt,
      organizationId: "org-proof",
      runRef: "deploy-hosted-proof",
      spaceRef: "deploy-hosted-proof",
      tenantRef: "tenant-proof",
    });
    const signingInput = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      "Ed25519",
      privateKey,
      new TextEncoder().encode(signingInput),
    );
    return Response.json(
      {
        takoformRunCredential: {
          token: `${signingInput}.${Buffer.from(signature).toString("base64url")}`,
          expiresAt: new Date((issuedAt + 60) * 1_000).toISOString(),
        },
      },
      { status: 201 },
    );
  };
}

function deployment(id: string, versionId: string, created: string) {
  return { id, created_on: created, versions: [{ version_id: versionId, percentage: 100 }] };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}
