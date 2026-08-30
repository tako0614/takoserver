import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { targetCapabilityManifest } from "../scripts/deploy/form-authority.ts";
import {
  type FormAuthorityInvokeOptions,
  formAuthorityRequestTimeoutMs,
  runFormAuthorityInvoke,
} from "../scripts/deploy/form-authority-invoke.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { verifyFormAuthorityOperatorAssertion } from "../src/form-authority-operator-proof.ts";
import { canonicalJson } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { deriveFormAuthorityIdentity } from "../src/takoform/host-admission-endpoint.ts";
import { YURUCOMMU_IDENTITY_CAPABILITY_KINDS } from "../src/takoform/implementation-catalog.ts";
import { createIntegrationFormAuthorityComposition } from "../src/takoform/integration-operator-endpoint.ts";

const COMMIT = "a".repeat(40);
const NOW = new Date("2026-08-29T02:00:00Z");
const ARTIFACT = `sha256:${"b".repeat(64)}` as const;
const PUBLIC_VERSION = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://form-authority.integration.takoserver.com";
const HOST_ID = "https://api.integration.example.test";

let privateJwk: JsonWebKey;
let publicJwk: { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string };
const roots: string[] = [];

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicPart = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (publicPart.kty !== "OKP" || publicPart.crv !== "Ed25519" || !publicPart.x) {
    throw new Error("test Ed25519 key is unavailable");
  }
  publicJwk = { kty: "OKP", crv: "Ed25519", x: publicPart.x };
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("signed Form authority operator invocation", () => {
  test("bounds reads at 30 seconds and leaves apply inside its 60-second assertion", () => {
    expect(formAuthorityRequestTimeoutMs("plan")).toBe(30_000);
    expect(formAuthorityRequestTimeoutMs("readback")).toBe(30_000);
    expect(formAuthorityRequestTimeoutMs("apply")).toBe(55_000);
  });

  test("performs exact signed plan -> one apply -> signed readback without exposing credentials", async () => {
    const fixture = await invocationFixture();
    const result = await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
      },
      fixture.target,
      fixture.options,
    );

    expect(fixture.calls.map(({ action }) => action)).toEqual(["plan", "apply", "readback"]);
    expect(canonicalJson(fixture.calls[1]?.body)).toBe(canonicalJson(fixture.calls[0]?.result));
    expect((result.readback as { forms: unknown[] }).forms).toHaveLength(12);
    expect((result.apply as { receipts: unknown[] }).receipts).toHaveLength(38);
    expect(result).toMatchObject({
      kind: "takoserver.integration-form-authority-invocation@v1",
      action: "apply",
      environment: "integration",
      activation: {
        kind: "space",
        tenantId: "tenant-yurucommu-integration",
        space: "space-yurucommu-integration",
      },
      policyAuthority: "takoserver-host",
      verificationMode: "integration-fixture",
      productionEligible: false,
      credentialsRedacted: true,
      ready: true,
      plan: { planDigest: expect.stringMatching(/^sha256:/), commandCount: 38 },
      apply: {
        status: "converged",
        planDigest: expect.stringMatching(/^sha256:/),
        receipts: expect.any(Array),
        policyAuthority: "takoserver-host",
        verificationMode: "integration-fixture",
        productionEligible: false,
        replanRequired: false,
      },
      readback: { forms: expect.any(Array) },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(privateJwk.d as string);
    expect(serialized).not.toContain(fixture.assertions[0] ?? "missing-assertion");
  });

  test("status is one signed readback and reports the exact 12-form convergence", async () => {
    const fixture = await invocationFixture();
    await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
      },
      fixture.target,
      fixture.options,
    );
    fixture.calls.length = 0;
    fixture.assertions.length = 0;

    const status = await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      fixture.target,
      fixture.options,
    );
    expect(fixture.calls.map(({ action }) => action)).toEqual(["readback"]);
    expect(status).toMatchObject({ action: "status", ready: true, credentialsRedacted: true });
  });

  test("status accepts the valid nonconverged initial readback and reports not ready", async () => {
    const fixture = await invocationFixture();
    const status = await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      fixture.target,
      fixture.options,
    );

    expect(fixture.calls.map(({ action }) => action)).toEqual(["readback"]);
    expect(status).toMatchObject({ action: "status", ready: false, credentialsRedacted: true });
    expect((status.readback as { forms: unknown[] }).forms).toHaveLength(12);
  });

  test("classifies a malformed status readback as a preflight error", async () => {
    const fixture = await invocationFixture({ tamperReadback: "truthy" });
    const failure = await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority",
        action: "status",
        environment: "integration",
        commit: COMMIT,
      },
      fixture.target,
      fixture.options,
    ).catch((error) => error);

    expect(fixture.calls.map(({ action }) => action)).toEqual(["readback"]);
    expect(failure).toMatchObject({
      phase: "preflight",
      message: expect.stringContaining("readback is invalid"),
    });
  });

  test("rejects a tampered canonical plan digest before sending apply", async () => {
    const fixture = await invocationFixture({ tamperPlanDigest: true });
    await expect(
      runFormAuthorityInvoke(
        {
          surface: "takoserver-integration-form-authority",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        fixture.target,
        fixture.options,
      ),
    ).rejects.toThrow("plan digest");
    expect(fixture.calls.map(({ action }) => action)).toEqual(["plan"]);
  });

  test("never retries an indeterminate apply or hides it behind a readback", async () => {
    const fixture = await invocationFixture({ failApplyTransport: true });
    const failure = await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
      },
      fixture.target,
      fixture.options,
    ).catch((error) => error);
    expect(failure).toMatchObject({ phase: "mutation" });
    expect(fixture.calls.map(({ action }) => action)).toEqual(["plan", "apply"]);
  });

  test("an acknowledged partial apply exits nonzero with sanitized forward-repair diagnostics", async () => {
    const fixture = await invocationFixture({ partialApply: true });
    const failure = await runFormAuthorityInvoke(
      {
        surface: "takoserver-integration-form-authority",
        action: "apply",
        environment: "integration",
        commit: COMMIT,
      },
      fixture.target,
      fixture.options,
    ).catch((error) => error);
    expect(fixture.calls.map(({ action }) => action)).toEqual(["plan", "apply", "readback"]);
    expect(failure).toMatchObject({
      phase: "verification",
      message: expect.stringContaining("partial"),
    });
    const detail = String(failure.detail);
    expect(detail).toContain("nextPlanDigest");
    expect(detail).toContain("receipts");
    expect(detail).not.toContain(privateJwk.d as string);
    expect(fixture.assertions.every((assertion) => !detail.includes(assertion))).toBe(true);
  });

  test("readback rejects truthy, extra, and missing per-Form authority fields", async () => {
    for (const tamperReadback of ["truthy", "extra", "missing"] as const) {
      const fixture = await invocationFixture({ tamperReadback });
      const failure = await runFormAuthorityInvoke(
        {
          surface: "takoserver-integration-form-authority",
          action: "apply",
          environment: "integration",
          commit: COMMIT,
        },
        fixture.target,
        fixture.options,
      ).catch((error) => error);
      expect(fixture.calls.map(({ action }) => action)).toEqual(["plan", "apply", "readback"]);
      expect(failure).toMatchObject({
        phase: "verification",
        message: expect.stringContaining("readback is invalid"),
      });
    }
  });

  test("hard-refuses non-integration before gateway inspection or private-key reads", async () => {
    let inspected = false;
    const target = await integrationTarget();
    await expect(
      runFormAuthorityInvoke(
        {
          surface: "takoserver-integration-form-authority",
          action: "status",
          environment: "production",
          commit: COMMIT,
        },
        { ...target, environment: "production" },
        {
          inspectGateway: async () => {
            inspected = true;
            throw new Error("must not inspect");
          },
          privateJwkPath: "/must/not/read",
        },
      ),
    ).rejects.toThrow("integration-only");
    expect(inspected).toBe(false);
  });
});

async function invocationFixture(
  input: {
    readonly tamperPlanDigest?: boolean;
    readonly failApplyTransport?: boolean;
    readonly partialApply?: boolean;
    readonly tamperReadback?: "truthy" | "extra" | "missing";
  } = {},
) {
  const target = await integrationTarget();
  const capabilities = targetCapabilityManifest(target);
  const identity = await deriveFormAuthorityIdentity({
    environment: "integration",
    hostId: HOST_ID,
    workerArtifactDigest: ARTIFACT,
    publicWorkerVersionId: PUBLIC_VERSION,
    capabilities,
  });
  const composition = await createIntegrationFormAuthorityComposition({
    configuration: {
      environment: "integration",
      hostId: HOST_ID,
      workerArtifactDigest: ARTIFACT,
      publicWorkerVersionId: PUBLIC_VERSION,
      capabilities,
    },
    bindings: {
      sql: createEphemeralSql(),
      objects: createMemoryObjectStore(),
      publicHostIdentity: {
        async identity() {
          return {
            kind: "takoserver.public-host-identity@v1",
            hostId: HOST_ID,
            workerVersionId: PUBLIC_VERSION,
          };
        },
      },
    },
  });
  const calls: { action: string; body: unknown; result?: unknown }[] = [];
  const assertions: string[] = [];
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    const action = new URL(url).pathname.slice("/v1/".length) as "plan" | "apply" | "readback";
    const body = JSON.parse(String(init?.body)) as unknown;
    calls.push({ action, body });
    const authorization = new Headers(init?.headers).get("authorization");
    const assertion = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    assertions.push(assertion);
    await verifyFormAuthorityOperatorAssertion({
      assertion,
      action,
      path: `/v1/${action}`,
      body,
      identity: {
        environment: "integration",
        hostId: HOST_ID,
        workerArtifactDigest: ARTIFACT,
        publicWorkerVersionId: PUBLIC_VERSION,
      },
      publicJwk,
      clock: () => NOW,
    });
    if (action === "apply" && input.failApplyTransport) throw new Error("lost acknowledgement");
    const result =
      action === "plan"
        ? await composition.endpoint.plan(body as Parameters<typeof composition.endpoint.plan>[0])
        : action === "apply"
          ? await composition.endpoint.apply(
              body as Parameters<typeof composition.endpoint.apply>[0],
            )
          : await composition.endpoint.readback(
              body as Parameters<typeof composition.endpoint.readback>[0],
            );
    let returned: unknown =
      action === "plan" && input.tamperPlanDigest
        ? { ...result, planDigest: `sha256:${"f".repeat(64)}` }
        : result;
    if (action === "apply" && input.partialApply) {
      returned = {
        ...(result as unknown as Record<string, unknown>),
        status: "partial",
        replanRequired: true,
      };
    }
    if (action === "readback" && input.tamperReadback) {
      const readback = result as { forms: readonly Record<string, unknown>[] };
      const first = readback.forms[0] ?? {};
      const malformed =
        input.tamperReadback === "truthy"
          ? { ...first, installed: "true" }
          : input.tamperReadback === "extra"
            ? { ...first, unexpected: true }
            : (({ active: _active, ...missing }) => missing)(first);
      returned = {
        ...(result as unknown as Record<string, unknown>),
        forms: [malformed, ...readback.forms.slice(1)],
      };
    }
    const last = calls.at(-1);
    if (last) last.result = returned;
    return Response.json(returned);
  };
  return {
    target,
    calls,
    assertions,
    options: {
      inspectGateway: async () => ({
        kind: "takoserver.form-authority-worker-status@v1",
        surface: "takoserver-integration-form-authority-operator-worker",
        environment: "integration",
        workerName: target.formAuthority?.integrationOperatorWorkerName,
        hostId: HOST_ID,
        selectedCommit: COMMIT,
        deployedCommit: COMMIT,
        commitMatches: true,
        versionId: "22222222-2222-4222-8222-222222222222",
        authorityArtifactDigest: `sha256:${"c".repeat(64)}`,
        publicWorkerCommit: COMMIT,
        publicWorkerCommitMatches: true,
        authorityDeployedCommit: COMMIT,
        authorityCommitMatches: true,
        authorityVersionId: "33333333-3333-4333-8333-333333333333",
        operatorOrigin: ORIGIN,
        authorityWorkerName: target.formAuthority?.integrationWorkerName,
        workerArtifactDigest: ARTIFACT,
        publicWorkerVersionId: PUBLIC_VERSION,
        capabilityDigest: identity.capabilityDigest,
        implementationDigest: identity.implementationDigest,
        routeMode: "authenticated-integration-custom-domain",
        policyAuthority: "takoserver-host",
        verificationMode: "integration-fixture",
        verificationAvailable: true,
        productionEligible: false,
        ready: true,
      }),
      privateJwkPath: privateJwkFile(),
      fetcher,
      now: () => NOW,
      run: qualificationRun,
      review: "independent-reviewer",
    } satisfies FormAuthorityInvokeOptions,
  };
}

async function integrationTarget(): Promise<DeployTarget> {
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
    publicOrigin: HOST_ID,
    edgeSupplies: {
      offerings: YURUCOMMU_IDENTITY_CAPABILITY_KINDS.map((formKind) => ({ formKind })),
    } as unknown as NonNullable<DeployTarget["edgeSupplies"]>,
    workerEndpointSuffix: "integration.example.workers.dev",
    formAuthority: {
      workerName: "takoserver-form-authority-integration",
      integrationWorkerName: "takoserver-form-fixture-integration",
      integrationOperatorWorkerName: "takoserver-form-operator-integration",
      integrationOperatorOrigin: ORIGIN,
      integrationOperatorScope: {
        tenantId: "tenant-yurucommu-integration",
        space: "space-yurucommu-integration",
      },
      operatorPublicJwk: publicJwk,
      hostId: HOST_ID,
    },
    signing: { currentKeyId: "key-current" },
  };
}

function privateJwkFile(): string {
  const root = mkdtempSync(join(tmpdir(), "takoserver-form-authority-key-"));
  roots.push(root);
  const path = join(root, "operator.jwk.json");
  writeFileSync(path, `${JSON.stringify(privateJwk)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

async function qualificationRun(command: readonly string[]): Promise<CommandResult> {
  const key = command.join(" ");
  if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
  if (key === "git branch --show-current") return ok("feature/form-authority\n");
  if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok("");
  throw new Error(`unexpected command: ${key}`);
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}
