import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExistingSpaceOperator } from "../scripts/deploy/existing-space-operator.ts";
import { type DeployTarget, parseDeployTarget } from "../scripts/deploy/target.ts";
import { handleExistingSpaceOperator } from "../src/existing-space-operator.ts";
import {
  existingSpaceOperatorFixture,
  OPERATOR_COMMIT,
  OPERATOR_NOW,
  OPERATOR_VERSION,
} from "./helpers/existing-space-operator-fixture.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const invocation = {
  surface: "takoserver-existing-space-reconciliation",
  action: "apply",
  environment: "integration",
  commit: OPERATOR_COMMIT,
} as const;
async function fixture() {
  const f = await existingSpaceOperatorFixture();
  const root = mkdtempSync(join(tmpdir(), "existing-space-operator-test-"));
  roots.push(root);
  const requestPath = join(root, "request.json");
  const privateJwkPath = join(root, "key.json");
  writeFileSync(requestPath, JSON.stringify(f.request), { mode: 0o600 });
  writeFileSync(privateJwkPath, JSON.stringify(f.privateJwk), { mode: 0o600 });
  const target = {
    kind: "takoserver.deploy-target@v2",
    environment: "integration",
    accountId: "a".repeat(32),
    workerName: "public-host",
    d1: { databaseName: "test-database", databaseId: OPERATOR_VERSION },
    r2: { bucketName: "test-bucket" },
    publicOrigin: f.identity.hostId,
    signing: { currentKeyId: "current-key" },
    formAuthority: {
      workerName: "released-authority",
      hostId: f.identity.hostId,
      identityProbeWorkerName: "identity-probe",
      identityProbeOrigin: "https://identity-probe.example.workers.dev",
      managedSpaceAdmissionPolicy: f.policy,
      existingSpaceOperator: {
        workerName: "existing-operator",
        origin: f.identity.origin,
        publicJwk: f.publicJwk,
      },
    },
  } satisfies DeployTarget;
  const status = {
    kind: "takoserver.form-authority-worker-status@v1",
    surface: "takoserver-existing-space-operator-worker",
    workerName: "existing-operator",
    operatorOrigin: f.identity.origin,
    selectedCommit: OPERATOR_COMMIT,
    deployedCommit: OPERATOR_COMMIT,
    commitMatches: true,
    publicWorkerCommit: OPERATOR_COMMIT,
    publicWorkerCommitMatches: true,
    authorityWorkerName: "released-authority",
    authorityDeployedCommit: OPERATOR_COMMIT,
    authorityCommitMatches: true,
    publicIdentityRpcReady: true,
    coreVerifierRpcReady: true,
    verificationMode: "released-core",
    scopeBindingProfile: "exact-target",
    authorityScopeBindingProfile: "exact-target",
    publicWorkerBindingProfile: "dynamic-public-rpc",
    authorityPublicWorkerBindingProfile: "dynamic-public-rpc",
    ready: true,
    ...f.formIdentity,
    authorityVersionId: OPERATOR_VERSION,
  };
  const http: string[] = [];
  const options = {
    requestPath,
    privateJwkPath,
    inspect: async () => status,
    review: "independent-reviewer",
    now: () => OPERATOR_NOW,
    run: async (command: readonly string[]) => ({
      exitCode: 0,
      stdout: command.includes("rev-parse") ? `${OPERATOR_COMMIT}\n` : "",
      stderr: "",
    }),
    fetcher: async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      http.push(new URL(request.url).pathname);
      return handleExistingSpaceOperator(request, f.env, () => OPERATOR_NOW);
    },
  };
  return { ...f, target, status, http, options };
}

describe("owning existing-Space invocation", () => {
  test("status rejects incomplete or malformed readback without reconciliation", async () => {
    const f = await fixture();
    for (const malformed of [[], [{ activationHead: { present: true, active: true } }]]) {
      await expect(
        runExistingSpaceOperator({ ...invocation, action: "status" }, f.target, {
          ...f.options,
          fetcher: async (input, init) => {
            const response = await f.options.fetcher(input, init);
            const value = (await response.json()) as Record<string, unknown>;
            return Response.json({ ...value, forms: malformed });
          },
        }),
      ).rejects.toMatchObject({ phase: "preflight" });
    }
    expect(f.calls).toEqual(["readback", "readback"]);
  });
  test("one signed mutation followed by exact per-Space readback", async () => {
    const f = await fixture();
    const result = await runExistingSpaceOperator(invocation, f.target, f.options);
    expect(f.calls).toEqual(["reconcile", "readback", "readback"]);
    expect(result.readbacks).toHaveLength(2);
    expect(result).not.toHaveProperty("ready");
  });
  test("status never qualifies mutation, reads review, or reconciles", async () => {
    const f = await fixture();
    const result = await runExistingSpaceOperator({ ...invocation, action: "status" }, f.target, {
      ...f.options,
      run: async () => {
        throw new Error("status must not qualify source");
      },
      get review(): string {
        throw new Error("status must not read reviewer");
      },
    });
    expect(f.calls).toEqual(["readback", "readback"]);
    expect(result.action).toBe("status");
  });
  test("unknown transport outcome sends one mutation and never retries or auto-reconciles", async () => {
    const f = await fixture();
    let sent = 0;
    await expect(
      runExistingSpaceOperator(invocation, f.target, {
        ...f.options,
        fetcher: async () => {
          sent++;
          throw new Error("transport ack lost");
        },
      }),
    ).rejects.toMatchObject({ phase: "mutation" });
    expect(sent).toBe(1);
    expect(f.calls).toEqual([]);
  });
  test("HTTP rejection after mutation remains indeterminate", async () => {
    const f = await fixture();
    let sent = 0;
    await expect(
      runExistingSpaceOperator(invocation, f.target, {
        ...f.options,
        fetcher: async () => {
          sent++;
          return new Response(null, { status: 502 });
        },
      }),
    ).rejects.toMatchObject({ phase: "mutation" });
    expect(sent).toBe(1);
  });
  test("policy, authority, Host drift fail before sending any request", async () => {
    const f = await fixture();
    for (const drift of [
      { authorityDeployedCommit: "b".repeat(40) },
      { publicWorkerCommit: "b".repeat(40) },
      { ready: false },
      { verificationMode: "integration-fixture" },
    ]) {
      await expect(
        runExistingSpaceOperator(invocation, f.target, {
          ...f.options,
          inspect: async () => ({ ...f.status, ...drift }),
        }),
      ).rejects.toMatchObject({ phase: "preflight" });
    }
    writeFileSync(
      f.options.requestPath,
      JSON.stringify({ ...f.request, policyDigest: `sha256:${"c".repeat(64)}` }),
    );
    await expect(runExistingSpaceOperator(invocation, f.target, f.options)).rejects.toMatchObject({
      phase: "preflight",
    });
    expect(f.http).toEqual([]);
  });
  test("Host drift during qualification cannot send mutation", async () => {
    const f = await fixture();
    let inspections = 0;
    await expect(
      runExistingSpaceOperator(invocation, f.target, {
        ...f.options,
        inspect: async () => ({
          ...f.status,
          publicWorkerVersionId:
            ++inspections === 1 ? OPERATOR_VERSION : "22222222-2222-4222-8222-222222222222",
        }),
      }),
    ).rejects.toMatchObject({ phase: "preflight" });
    expect(f.http).toEqual([]);
  });
  test("acknowledged mutation with failed readback never retries", async () => {
    const f = await fixture();
    let sent = 0;
    await expect(
      runExistingSpaceOperator(invocation, f.target, {
        ...f.options,
        fetcher: async (input, init) => {
          sent++;
          if (sent > 1) throw new Error("readback unavailable");
          return f.options.fetcher(input, init);
        },
      }),
    ).rejects.toMatchObject({ phase: "verification" });
    expect(sent).toBe(2);
    expect(f.calls).toEqual(["reconcile"]);
  });
  test("private target requires dedicated ingress/key/policy and unique Worker name", async () => {
    const f = await fixture();
    expect(
      parseDeployTarget(f.target, "<test>", "integration").formAuthority?.existingSpaceOperator,
    ).toEqual(f.target.formAuthority.existingSpaceOperator);
    for (const operator of [
      { ...f.target.formAuthority.existingSpaceOperator, origin: f.target.publicOrigin },
      {
        ...f.target.formAuthority.existingSpaceOperator,
        origin: "https://operator.example.workers.dev",
      },
      { ...f.target.formAuthority.existingSpaceOperator, workerName: f.target.workerName },
    ]) {
      expect(() =>
        parseDeployTarget(
          {
            ...f.target,
            formAuthority: { ...f.target.formAuthority, existingSpaceOperator: operator },
          },
          "<test>",
          "integration",
        ),
      ).toThrow();
    }
    expect(() =>
      parseDeployTarget(
        { ...f.target, operatorIdentity: { publicJwk: f.publicJwk } },
        "<test>",
        "integration",
      ),
    ).toThrow("dedicated");
    expect(() =>
      parseDeployTarget(
        {
          ...f.target,
          formAuthority: { ...f.target.formAuthority, managedSpaceAdmissionPolicy: undefined },
        },
        "<test>",
        "integration",
      ),
    ).toThrow();
  });
});
