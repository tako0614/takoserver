import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type IntegrationOrganizationBootstrapOptions,
  runIntegrationOrganizationBootstrap,
} from "../scripts/deploy/integration-organization-bootstrap.ts";
import { expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import type { WorkerState } from "../scripts/deploy/worker-live.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";
import { normalizeGeneratedEd25519PrivateJwk } from "../src/ed25519-private-jwk.ts";
import { createEphemeralSql } from "../src/index.ts";
import {
  createIntegrationOrganizationBootstrap,
  INTEGRATION_ORGANIZATION_ID,
} from "../src/integration-organization-bootstrap.ts";

const COMMIT = "a".repeat(40);
const BUNDLE = "b".repeat(64);
const VERSION = "00000000-0000-4000-8000-000000000001";
const ORIGIN = "https://api.integration.example.test";
const NOW = new Date("2026-09-12T12:00:00.000Z");
const OWNER = {
  provider: "google" as const,
  subject: "owner-subject",
  email: "owner@example.test",
  displayName: "Operator",
};

describe("fixed integration organization owning deploy surface", () => {
  test("creates once through the actual signed route and thereafter performs only status", async () => {
    await fixture(async (f) => {
      const first = await f.run("apply");
      expect(first).toMatchObject({
        ready: true,
        mutationApplied: true,
        mutationAcknowledged: true,
      });
      expect(f.actions).toEqual(["status", "apply", "status"]);
      expect(await f.orgCount()).toBe(1);
      expect(
        await f.sql.query("SELECT role FROM org_memberships WHERE org_id = ?", [
          INTEGRATION_ORGANIZATION_ID,
        ]),
      ).toEqual([{ role: "owner" }]);
      const second = await f.run("apply");
      expect(second).toMatchObject({
        ready: true,
        mutationApplied: false,
        mutationAcknowledged: false,
      });
      expect(f.actions).toEqual(["status", "apply", "status", "status"]);
      const serialized = JSON.stringify(first);
      expect(serialized).not.toContain(OWNER.email);
      expect(serialized).not.toContain(OWNER.subject);
      expect(serialized).not.toContain(f.privateJwkPath);
      expect(serialized).not.toContain("Bearer ");
    });
  });

  test("status on an eligible tuple creates no organization", async () => {
    await fixture(async (f) => {
      expect(await f.run("status")).toMatchObject({
        ready: false,
        mutationApplied: false,
        result: { state: "eligible" },
      });
      expect(f.actions).toEqual(["status"]);
      expect(await f.orgCount()).toBe(0);
    });
  });

  test("refuses production/rehearsal before source, native, private input or HTTP access", async () => {
    await fixture(async (f) => {
      for (const environment of ["production", "rehearsal"] as const) {
        await expect(
          runIntegrationOrganizationBootstrap({ ...invocation("apply"), environment }, f.target, {
            run: async () => {
              throw new Error("must not run");
            },
            privateJwkPath: "/absent-private-input",
            fetcher: async () => {
              throw new Error("must not fetch");
            },
          }),
        ).rejects.toMatchObject({ phase: "preflight" });
      }
      expect(f.actions).toEqual([]);
    });
  });

  test("refuses a changed native Version at the last pre-apply fence", async () => {
    await fixture(async (f) => {
      const state: WorkerState = {
        ...f.state,
        async workerDeployments(name) {
          const rows = await f.state.workerDeployments(name);
          // Native inspection itself reads deployment history more than once.
          // Drift only after the signed status, at the final pre-apply fence.
          return !f.actions.includes("status")
            ? rows
            : [
                {
                  id: "deployment-raced",
                  created_on: NOW.toISOString(),
                  versions: [
                    { version_id: "00000000-0000-4000-8000-000000000002", percentage: 100 },
                  ],
                },
              ];
        },
      };
      await expect(f.run("apply", { state })).rejects.toMatchObject({ phase: "preflight" });
      expect(f.actions).toEqual(["status"]);
      expect(await f.orgCount()).toBe(0);
    });
  });

  test("retains accepted mutation classification after malformed or wrongly typed response", async () => {
    for (const mediaType of ["application/json", "application/json-evil"]) {
      await fixture(async (f) => {
        const fetcher = async (url: string, init?: RequestInit) => {
          const response = await f.fetcher(url, init);
          return url.endsWith("/apply")
            ? new Response(mediaType === "application/json" ? "{" : await response.text(), {
                status: 201,
                headers: { "content-type": mediaType },
              })
            : response;
        };
        await expect(f.run("apply", { fetcher })).rejects.toMatchObject({ phase: "verification" });
        expect(f.actions).toEqual(["status", "apply"]);
        expect(await f.orgCount()).toBe(1);
        expect(await f.run("status")).toMatchObject({ ready: true, mutationApplied: false });
      });
    }
  });

  test("a lost apply acknowledgement is not retried and is settled by separate status", async () => {
    await fixture(async (f) => {
      await expect(
        f.run("apply", {
          fetcher: async (url, init) => {
            const response = await f.fetcher(url, init);
            if (url.endsWith("/apply")) throw new Error("transport disconnected");
            return response;
          },
        }),
      ).rejects.toMatchObject({ phase: "mutation" });
      expect(f.actions).toEqual(["status", "apply"]);
      expect(await f.run("status")).toMatchObject({ ready: true, mutationApplied: false });
      expect(f.actions.filter((action) => action === "apply")).toHaveLength(1);
    });
  });

  test("a post-commit unavailable response remains indeterminate until separate status", async () => {
    await fixture(async (f) => {
      await expect(
        f.run("apply", {
          fetcher: async (url, init) => {
            const response = await f.fetcher(url, init);
            if (!url.endsWith("/apply")) return response;
            expect(response.status).toBe(201);
            return new Response(null, { status: 503 });
          },
        }),
      ).rejects.toMatchObject({ phase: "mutation" });
      expect(f.actions).toEqual(["status", "apply"]);
      expect(await f.orgCount()).toBe(1);
      expect(await f.run("status")).toMatchObject({ ready: true, mutationApplied: false });
      expect(f.actions.filter((action) => action === "apply")).toHaveLength(1);
    });
  });

  test("refused apply is preflight and never exposes the provider response body", async () => {
    await fixture(async (f) => {
      const error = await f
        .run("apply", {
          fetcher: async (url, init) =>
            url.endsWith("/apply")
              ? new Response("private response diagnostic", { status: 403 })
              : f.fetcher(url, init),
        })
        .catch((value: unknown) => value);
      expect(error).toMatchObject({ phase: "preflight" });
      expect(String(error)).not.toContain("private response diagnostic");
      expect(await f.orgCount()).toBe(0);
    });
  });
});

function invocation(action: "status" | "apply") {
  return {
    surface: "takoserver-integration-organization-bootstrap" as const,
    action,
    environment: "integration" as const,
    commit: COMMIT,
  };
}

async function fixture(
  use: (input: {
    readonly target: DeployTarget;
    readonly state: WorkerState;
    readonly sql: ReturnType<typeof createEphemeralSql>;
    readonly privateJwkPath: string;
    readonly actions: string[];
    fetcher(url: string, init?: RequestInit): Promise<Response>;
    orgCount(): Promise<number>;
    run(
      action: "status" | "apply",
      options?: IntegrationOrganizationBootstrapOptions,
    ): Promise<Record<string, unknown>>;
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "takoserver-org-bootstrap-deploy-"));
  try {
    const keys = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const privateJwk = normalizeGeneratedEd25519PrivateJwk(
      await crypto.subtle.exportKey("jwk", keys.privateKey),
    );
    const publicJwk = { kty: "OKP" as const, crv: "Ed25519" as const, x: privateJwk.x };
    const target: DeployTarget = {
      kind: "takoserver.deploy-target@v2",
      environment: "integration",
      accountId: "a".repeat(32),
      workerName: "takoserver-api-integration",
      publicOrigin: ORIGIN,
      d1: {
        databaseName: "takoserver-integration",
        databaseId: "00000000-0000-4000-8000-000000000000",
      },
      r2: { bucketName: "takoserver-integration" },
      signing: { currentKeyId: "key-current" },
      operatorIdentity: { publicJwk },
      integrationE2eCredentialAuthority: {
        organizationId: INTEGRATION_ORGANIZATION_ID,
        publicJwk: { ...publicJwk, x: "A".repeat(43) },
      },
    };
    const privateJwkPath = join(root, "operator.json");
    const operatorIdentityPath = join(root, "identity.json");
    writeFileSync(privateJwkPath, JSON.stringify(privateJwk), { mode: 0o600 });
    writeFileSync(
      operatorIdentityPath,
      JSON.stringify({ kind: "takoserver.operator-sign-in-identity@v1", ...OWNER }),
      { mode: 0o600 },
    );
    const sql = createEphemeralSql();
    await sql.run(
      "INSERT INTO principals (id, provider, provider_subject, email, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "prn_operator",
        OWNER.provider,
        OWNER.subject,
        OWNER.email,
        OWNER.displayName,
        NOW.toISOString(),
      ],
    );
    const route = createIntegrationOrganizationBootstrap({
      sql,
      clock: () => NOW,
      configuration: {
        environment: "integration",
        hostId: ORIGIN,
        publicJwk,
        sourceCommit: COMMIT,
        artifactDigest: `sha256:${BUNDLE}`,
        publicWorkerVersionId: VERSION,
      },
    });
    const closure = expectedExactBindingClosure(target, {
      authorityProfile: {
        kind: "provenance-bound-jit",
        provenance: {
          sourceCommit: COMMIT,
          artifactDigest: `sha256:${BUNDLE}`,
        },
      },
    });
    const state: WorkerState = {
      async workerDeployments() {
        return [
          {
            id: "deployment-current",
            created_on: NOW.toISOString(),
            versions: [{ version_id: VERSION, percentage: 100 }],
          },
        ];
      },
      async workerVersion() {
        return {
          annotations: {
            "workers/message": `takoserver-worker:${COMMIT}:${BUNDLE}`,
            "workers/triggered_by": "version_upload",
          },
          resources: {
            bindings: Object.entries(closure).flatMap(([name, value]) =>
              value === null ? [] : [{ name, type: value.type, ...value.fields }],
            ),
          },
        };
      },
      async workerSecrets() {
        return expectedWorkerSecrets(target).map((name) => ({ name, type: "secret_text" }));
      },
      async workerDomains() {
        return [{ hostname: new URL(ORIGIN).hostname, service: target.workerName }];
      },
    };
    const actions: string[] = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new URL(url).origin).toBe(ORIGIN);
      actions.push(url.endsWith("/apply") ? "apply" : "status");
      const response = await route(new Request(url, init));
      if (!response) throw new Error("unexpected route");
      return response;
    };
    const options: IntegrationOrganizationBootstrapOptions = {
      state,
      privateJwkPath,
      operatorIdentityPath,
      fetcher,
      review: "reviewer@example.test",
      now: () => NOW,
      run: async (command) => {
        const key = command.join(" ");
        if (key === "git rev-parse HEAD") return { exitCode: 0, stdout: COMMIT, stderr: "" };
        if (
          key === "git branch --show-current" ||
          key === "git status --porcelain=v1 -z --untracked-files=all"
        ) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected source command: ${key}`);
      },
    };
    await use({
      target,
      state,
      sql,
      privateJwkPath,
      actions,
      fetcher,
      orgCount: async () =>
        Number(
          (
            await sql.query("SELECT count(*) AS count FROM orgs WHERE id = ?", [
              INTEGRATION_ORGANIZATION_ID,
            ])
          )[0]?.count,
        ),
      run: async (action, override = {}) =>
        runIntegrationOrganizationBootstrap(invocation(action), target, {
          ...options,
          ...override,
        }),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
