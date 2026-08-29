import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOperatorIdentity } from "../scripts/deploy/identity.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { runWorker } from "../scripts/deploy/worker.ts";
import type { WorkerState } from "../scripts/deploy/worker-live.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";

const COMMIT = "a".repeat(40);
const BUNDLE = "export default {fetch(){return new Response('ok')}};\n";
const BUNDLE_DIGEST = createHash("sha256").update(BUNDLE).digest("hex");
const PUBLIC_JWK = { kty: "OKP" as const, crv: "Ed25519" as const, x: "A".repeat(43) };
const PUBLIC_JWK_DIGEST = `sha256:${createHash("sha256")
  .update(JSON.stringify(PUBLIC_JWK))
  .digest("hex")}`;

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
  operatorIdentity: { publicJwk: PUBLIC_JWK },
} satisfies DeployTarget;

describe("integration operator identity deploy surface", () => {
  test("status is mutation-free and reports the desired public digest and readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-identity-status-"));
    try {
      const state = staticState(version("absent"));
      const result = await runOperatorIdentity(
        {
          surface: "takoserver-integration-operator-identity",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        { state, outputDirectory: root },
      );
      expect(result).toEqual({
        kind: "takoserver.integration-operator-identity-status@v2",
        surface: "takoserver-integration-operator-identity",
        environment: "integration",
        selectedCommit: COMMIT,
        deployedCommit: COMMIT,
        versionId: "version-before",
        desiredPublicJwkDigest: PUBLIC_JWK_DIGEST,
        configuredPublicJwkDigest: null,
        configured: false,
        ready: true,
      });
      expect(state.reads()).toEqual({ deployments: 1, versions: 1, secrets: 1, domains: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("routine Worker publication cannot bridge an absent operator identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-identity-routine-"));
    try {
      const process = processFixture();
      const failure = await runWorker(
        {
          surface: "takoserver-worker",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        target,
        {
          state: staticState(version("absent")),
          migrations: {
            async read() {
              return { local: [], applied: [] };
            },
          },
          run: process.run,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);

      expect(failure).toMatchObject({ phase: "preflight" });
      expect(failure.message).toContain(
        "does not declare the OPERATOR_IDENTITY_PUBLIC_JWK binding",
      );
      expect(process.calls.some((command) => command.includes("check"))).toBe(false);
      expect(process.calls.some((command) => command.includes("deploy"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("apply refuses an unsafe or mismatched private JWK before gate or upload", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-identity-private-"));
    try {
      const selected = await keyPair();
      const other = await keyPair();
      const selectedTarget = targetWithPublicX(selected.publicJwk.x);
      const privatePath = join(root, "operator-private.jwk");
      writeFileSync(privatePath, `${JSON.stringify(selected.privateJwk)}\n`, { mode: 0o644 });
      const process = processFixture();
      const invocation = {
        surface: "takoserver-integration-operator-identity" as const,
        action: "apply" as const,
        environment: "integration" as const,
        commit: COMMIT,
      };
      const options = {
        state: staticState(versionForTarget(selectedTarget, "absent")),
        run: process.run,
        privateJwkPath: privatePath,
        review: "reviewer@example.test",
        outputDirectory: join(root, "unsafe-work"),
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      };

      const unsafe = await runOperatorIdentity(invocation, selectedTarget, options).catch(
        (error) => error,
      );
      expect(unsafe).toBeInstanceOf(Error);
      expect(unsafe.message).toContain("owned 0600");

      writeFileSync(privatePath, `${JSON.stringify(other.privateJwk)}\n`);
      chmodSync(privatePath, 0o600);
      const mismatch = await runOperatorIdentity(invocation, selectedTarget, {
        ...options,
        state: staticState(versionForTarget(selectedTarget, "absent")),
        outputDirectory: join(root, "mismatch-work"),
      }).catch((error) => error);
      expect(mismatch).toBeInstanceOf(Error);
      expect(mismatch.message).toContain("does not match");
      expect(process.calls.some((command) => command.includes("check"))).toBe(false);
      expect(process.calls.some((command) => command.includes("deploy"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uploads one identical-code Version, adds only the public var, and proves a redacted session", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-identity-apply-"));
    try {
      const selected = await keyPair();
      const selectedTarget = targetWithPublicX(selected.publicJwk.x);
      const privateRaw = `${JSON.stringify(selected.privateJwk)}\n`;
      const privatePath = join(root, "operator-private.jwk");
      writeFileSync(privatePath, privateRaw, { mode: 0o600 });
      const process = processFixture({ build: true, upload: true });
      const state = transitionState(selectedTarget);
      const requests: Request[] = [];
      const captured: { assertion?: string } = {};
      const result = await runOperatorIdentity(
        {
          surface: "takoserver-integration-operator-identity",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        selectedTarget,
        {
          state,
          run: process.run,
          privateJwkPath: privatePath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: sessionFetcher(selected.pair.publicKey, requests, captured),
          now: () => new Date("2026-08-28T12:00:00Z"),
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.integration-operator-identity-apply@v2",
        surface: "takoserver-integration-operator-identity",
        environment: "integration",
        commit: COMMIT,
        reviewer: "reviewer@example.test",
        previousVersionId: "version-before",
        versionId: "version-after",
        publicJwkDigest: sha256(JSON.stringify(selectedTarget.operatorIdentity?.publicJwk)),
        exactConfigDiff: {
          added: [
            {
              name: "OPERATOR_IDENTITY_PUBLIC_JWK",
              valueDigest: expect.stringMatching(/^sha256:/),
            },
          ],
          changed: [],
          removed: [],
        },
        proof: {
          sessionStatus: 200,
          meStatus: 200,
          revokeStatus: 204,
          replayStatus: 401,
          sessionRevoked: true,
          assertionRedacted: true,
          sessionRedacted: true,
        },
      });
      const uploads = process.calls.filter(
        (command) => command.includes("--no-bundle") && !command.includes("--dry-run"),
      );
      expect(uploads).toHaveLength(1);
      expect(process.calls.filter((command) => command.join(" ") === "bun run check")).toHaveLength(
        1,
      );
      expect(process.calls.some((command) => command.includes("d1"))).toBe(false);
      expect(
        requests.map((request) => `${request.method} ${new URL(request.url).pathname}`),
      ).toEqual(["POST /v1/sessions", "GET /v1/me", "DELETE /v1/session", "GET /v1/me"]);
      const rendered = JSON.stringify(result);
      expect(rendered).not.toContain(String(selected.privateJwk.d));
      expect(rendered).not.toContain("session-secret-do-not-print");
      expect(captured.assertion).toEqual(expect.any(String));
      expect(rendered).not.toContain(captured.assertion as string);
      expect(process.calls.some((command) => command.join(" ").includes(privateRaw.trim()))).toBe(
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses unrelated live configuration drift before any mutation", async () => {
    const drifted = structuredClone(version("absent")) as {
      resources: { bindings: Record<string, unknown>[] };
    };
    drifted.resources.bindings.push({
      name: "UNRELATED_CONFIGURATION",
      type: "plain_text",
      text: "must-not-survive",
    });
    const failure = await runOperatorIdentity(
      {
        surface: "takoserver-integration-operator-identity",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      target,
      { state: staticState(drifted) },
    ).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("exact selected target closure");
  });

  test("classifies unrelated post-upload configuration drift as verification failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-identity-after-drift-"));
    try {
      const selected = await keyPair();
      const selectedTarget = targetWithPublicX(selected.publicJwk.x);
      const privatePath = join(root, "operator-private.jwk");
      writeFileSync(privatePath, `${JSON.stringify(selected.privateJwk)}\n`, { mode: 0o600 });
      const process = processFixture({ build: true, upload: true });
      const requests: Request[] = [];
      const failure = await runOperatorIdentity(
        {
          surface: "takoserver-integration-operator-identity",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        selectedTarget,
        {
          state: transitionStateWithDrift(selectedTarget),
          run: process.run,
          privateJwkPath: privatePath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: async (input, init) => {
            requests.push(new Request(input, init));
            return Response.json({ error: "unexpected proof" }, { status: 500 });
          },
        },
      ).catch((error) => error);

      expect(failure).toMatchObject({ phase: "verification" });
      expect(failure.message).toContain("exact selected target closure");
      expect(
        process.calls.filter(
          (command) => command.includes("--no-bundle") && !command.includes("--dry-run"),
        ),
      ).toHaveLength(1);
      expect(requests).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires revoked-session replay refusal without exposing proof credentials", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-identity-replay-"));
    try {
      const selected = await keyPair();
      const selectedTarget = targetWithPublicX(selected.publicJwk.x);
      const privatePath = join(root, "operator-private.jwk");
      writeFileSync(privatePath, `${JSON.stringify(selected.privateJwk)}\n`, { mode: 0o600 });
      const process = processFixture({ build: true, upload: true });
      const requests: Request[] = [];
      const captured: { assertion?: string } = {};
      const failure = await runOperatorIdentity(
        {
          surface: "takoserver-integration-operator-identity",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        selectedTarget,
        {
          state: transitionState(selectedTarget),
          run: process.run,
          privateJwkPath: privatePath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: sessionFetcher(selected.pair.publicKey, requests, captured, {
            allowRevokedReplay: true,
          }),
          now: () => new Date("2026-08-28T12:00:00Z"),
        },
      ).catch((error) => error);

      expect(failure).toMatchObject({ phase: "verification" });
      expect(failure.message).toContain("remains usable after revocation");
      expect(
        requests.map((request) => `${request.method} ${new URL(request.url).pathname}`),
      ).toEqual(["POST /v1/sessions", "GET /v1/me", "DELETE /v1/session", "GET /v1/me"]);
      const renderedFailure = `${failure.message}\n${String(failure.detail)}\n${JSON.stringify(failure)}`;
      expect(renderedFailure).not.toContain("session-secret-do-not-print");
      expect(renderedFailure).not.toContain(String(selected.privateJwk.d));
      expect(captured.assertion).toEqual(expect.any(String));
      expect(renderedFailure).not.toContain(captured.assertion as string);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("closes the qualification race and performs no upload after a Version advance", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-identity-race-"));
    try {
      const selected = await keyPair();
      const selectedTarget = targetWithPublicX(selected.publicJwk.x);
      const privatePath = join(root, "operator-private.jwk");
      writeFileSync(privatePath, `${JSON.stringify(selected.privateJwk)}\n`, { mode: 0o600 });
      const process = processFixture({ build: true, upload: true });
      const failure = await runOperatorIdentity(
        {
          surface: "takoserver-integration-operator-identity",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        selectedTarget,
        {
          state: racingState(selectedTarget),
          run: process.run,
          privateJwkPath: privatePath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain("changed during operator identity qualification");
      expect(
        process.calls.filter(
          (command) => command.includes("--no-bundle") && !command.includes("--dry-run"),
        ),
      ).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("treats a lost upload acknowledgement as indeterminate and reconciles by status", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-identity-ack-"));
    try {
      const selected = await keyPair();
      const selectedTarget = targetWithPublicX(selected.publicJwk.x);
      const privatePath = join(root, "operator-private.jwk");
      writeFileSync(privatePath, `${JSON.stringify(selected.privateJwk)}\n`, { mode: 0o600 });
      const process = processFixture({
        build: true,
        upload: true,
        uploadExitCode: 1,
        uploadStderr: "acknowledgement lost while token was in provider diagnostic",
      });
      const failure = await runOperatorIdentity(
        {
          surface: "takoserver-integration-operator-identity",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        selectedTarget,
        {
          state: transitionState(selectedTarget),
          run: process.run,
          privateJwkPath: privatePath,
          review: "reviewer@example.test",
          outputDirectory: join(root, "work"),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        },
      ).catch((error) => error);
      expect(failure).toMatchObject({ phase: "mutation" });
      expect(failure.message).toContain("indeterminate");
      expect(String(failure.detail)).not.toContain("token");
      expect(String(failure.detail)).toContain("[redacted]");
      expect(
        process.calls.filter(
          (command) => command.includes("--no-bundle") && !command.includes("--dry-run"),
        ),
      ).toHaveLength(1);

      const status = await runOperatorIdentity(
        {
          surface: "takoserver-integration-operator-identity",
          action: "status",
          environment: "integration",
          commit: COMMIT,
        },
        selectedTarget,
        { state: staticState(versionForTarget(selectedTarget, "desired")) },
      );
      expect(status).toMatchObject({
        configured: true,
        configuredPublicJwkDigest: sha256(
          JSON.stringify(selectedTarget.operatorIdentity?.publicJwk),
        ),
        ready: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function version(identity: "desired" | "absent") {
  return versionForTarget(target, identity);
}

function versionForTarget(selected: DeployTarget, identity: "desired" | "absent") {
  const selectedTarget = identity === "desired" ? selected : withoutOperatorIdentity(selected);
  const expected = expectedExactBindingClosure(selectedTarget, {
    hostedTopology: "desired",
    signingKeyId: selected.signing.currentKeyId,
  });
  return {
    annotations: { "workers/message": `takoserver-worker:${COMMIT}:${BUNDLE_DIGEST}` },
    resources: {
      bindings: Object.entries(expected).flatMap(([name, requirement]) =>
        requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
    },
  };
}

async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey & {
    x: string;
    d: string;
  };
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & {
    x: string;
  };
  return { pair, privateJwk, publicJwk };
}

function targetWithPublicX(x: string): DeployTarget {
  return {
    ...target,
    operatorIdentity: { publicJwk: { kty: "OKP", crv: "Ed25519", x } },
  };
}

function processFixture(
  options: {
    readonly build?: boolean;
    readonly upload?: boolean;
    readonly uploadExitCode?: number;
    readonly uploadStderr?: string;
  } = {},
) {
  const calls: string[][] = [];
  return {
    calls,
    run: async (command: readonly string[]): Promise<CommandResult> => {
      calls.push([...command]);
      const key = command.join(" ");
      if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
      if (key === "git branch --show-current") return ok("feature/operator-identity\n");
      if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
      if (key === "bun run check") return ok("checked\n");
      if (options.build && command.includes("--dry-run")) {
        const out = command[command.indexOf("--outdir") + 1];
        if (!out) throw new Error("missing build outdir");
        writeFileSync(join(out, "index.js"), BUNDLE);
        return ok("built\n");
      }
      if (options.upload && command.includes("--no-bundle")) {
        return options.uploadExitCode
          ? {
              exitCode: options.uploadExitCode,
              stdout: "",
              stderr: options.uploadStderr ?? "acknowledgement lost",
            }
          : ok("uploaded\n");
      }
      throw new Error(`unexpected command: ${key}`);
    },
  };
}

function racingState(selectedTarget: DeployTarget): WorkerState {
  let deploymentReads = 0;
  return {
    async workerDeployments() {
      deploymentReads += 1;
      return deploymentReads === 1
        ? [deployment("deployment-before", "version-before", "2026-08-28T01:00:00Z")]
        : [
            deployment("deployment-raced", "version-raced", "2026-08-28T01:30:00Z"),
            deployment("deployment-before", "version-before", "2026-08-28T01:00:00Z"),
          ];
    },
    async workerVersion() {
      return versionForTarget(selectedTarget, "absent");
    },
    async workerSecrets() {
      return [{ name: "TAKOSERVER_SIGNING_KEY", type: "secret_text" }];
    },
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: selectedTarget.workerName }];
    },
  };
}

function transitionState(selectedTarget: DeployTarget): WorkerState {
  let deploymentReads = 0;
  return {
    async workerDeployments() {
      deploymentReads += 1;
      return deploymentReads <= 2
        ? [deployment("deployment-before", "version-before", "2026-08-28T01:00:00Z")]
        : [
            deployment("deployment-after", "version-after", "2026-08-28T02:00:00Z"),
            deployment("deployment-before", "version-before", "2026-08-28T01:00:00Z"),
          ];
    },
    async workerVersion(_worker, versionId) {
      return versionForTarget(selectedTarget, versionId === "version-after" ? "desired" : "absent");
    },
    async workerSecrets() {
      return [{ name: "TAKOSERVER_SIGNING_KEY", type: "secret_text" }];
    },
    async workerDomains() {
      return [{ hostname: "api.integration.example.test", service: selectedTarget.workerName }];
    },
  };
}

function transitionStateWithDrift(selectedTarget: DeployTarget): WorkerState {
  const state = transitionState(selectedTarget);
  return {
    ...state,
    async workerVersion(workerName, versionId) {
      const value = await state.workerVersion(workerName, versionId);
      if (versionId !== "version-after") return value;
      const drifted = structuredClone(value) as {
        resources: { bindings: Record<string, unknown>[] };
      };
      drifted.resources.bindings.push({
        name: "UNRELATED_CONFIGURATION",
        type: "plain_text",
        text: "must-not-survive",
      });
      return drifted;
    },
  };
}

function sessionFetcher(
  publicKey: CryptoKey,
  requests: Request[],
  captured: { assertion?: string },
  options: { readonly allowRevokedReplay?: boolean } = {},
) {
  let revoked = false;
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    requests.push(request.clone());
    if (request.method === "POST" && new URL(request.url).pathname === "/v1/sessions") {
      const body = (await request.json()) as Record<string, unknown>;
      const assertion = String(body.assertion ?? "");
      captured.assertion = assertion;
      const [payloadPart, signaturePart] = assertion.split(".");
      if (!payloadPart || !signaturePart)
        return Response.json({ error: "bad proof" }, { status: 401 });
      const valid = await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        Buffer.from(signaturePart, "base64url"),
        new TextEncoder().encode(payloadPart),
      );
      const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<
        string,
        unknown
      >;
      if (
        !valid ||
        body.provider !== "google" ||
        body.method !== "operator-assertion" ||
        claims.purpose !== "sign-in" ||
        claims.provider !== "google" ||
        claims.subject !== "task-0037-integration-operator" ||
        claims.email !== "task-0037-integration-operator@localhost" ||
        claims.displayName !== "TASK-0037 Integration Operator" ||
        Number(claims.exp) - Number(claims.iat) !== 60
      ) {
        return Response.json({ error: "bad proof" }, { status: 401 });
      }
      return Response.json({
        principal: proofPrincipal(),
        sessionToken: "session-secret-do-not-print",
      });
    }
    if (request.method === "GET" && new URL(request.url).pathname === "/v1/me") {
      if (request.headers.get("authorization") !== "Bearer session-secret-do-not-print") {
        return Response.json({ error: "unauthenticated" }, { status: 401 });
      }
      if (revoked && options.allowRevokedReplay !== true) {
        return Response.json({ error: "unauthenticated" }, { status: 401 });
      }
      return Response.json({ principal: proofPrincipal(), organizations: [] });
    }
    if (request.method === "DELETE" && new URL(request.url).pathname === "/v1/session") {
      if (request.headers.get("authorization") !== "Bearer session-secret-do-not-print") {
        return Response.json({ error: "unauthenticated" }, { status: 401 });
      }
      revoked = true;
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
}

function proofPrincipal() {
  return {
    id: "principal-proof",
    provider: "google",
    providerSubject: "task-0037-integration-operator",
    email: "task-0037-integration-operator@localhost",
    displayName: "TASK-0037 Integration Operator",
  };
}

function staticState(workerVersion: unknown): WorkerState & {
  reads(): { deployments: number; versions: number; secrets: number; domains: number };
} {
  const reads = { deployments: 0, versions: 0, secrets: 0, domains: 0 };
  return {
    reads: () => ({ ...reads }),
    async workerDeployments() {
      reads.deployments += 1;
      return [deployment("deployment-before", "version-before", "2026-08-28T01:00:00Z")];
    },
    async workerVersion() {
      reads.versions += 1;
      return workerVersion;
    },
    async workerSecrets() {
      reads.secrets += 1;
      return [{ name: "TAKOSERVER_SIGNING_KEY", type: "secret_text" }];
    },
    async workerDomains() {
      reads.domains += 1;
      return [{ hostname: "api.integration.example.test", service: target.workerName }];
    },
  };
}

function withoutOperatorIdentity(value: DeployTarget): DeployTarget {
  const { operatorIdentity: _operatorIdentity, ...withoutIdentity } = value;
  return withoutIdentity;
}

function deployment(id: string, versionId: string, created: string) {
  return { id, created_on: created, versions: [{ version_id: versionId, percentage: 100 }] };
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
