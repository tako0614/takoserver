import { describe, expect, test } from "bun:test";
import { DeployError } from "../scripts/deploy/errors.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import {
  assertExactSecretInventory,
  assertExactVersionBindingClosure,
  assertVersionBindingClosure,
  expectedBindingClosureForTarget,
  expectedExactBindingClosure,
  expectedLegacyPreVersionMetadataBindingClosure,
  parseWorkerDeploymentChain,
  parseWorkerDeploymentHistory,
  workerVersionMetadataBindingProfile,
} from "../scripts/deploy/worker-state.ts";
import { cloudflareProviderExecutorTarget } from "./helpers/hosted-supply-fixtures.ts";

const VERSION = {
  id: "version-1",
  resources: {
    bindings: [
      { type: "d1", name: "STATE_DB", id: "database-id" },
      { type: "r2_bucket", name: "OBJECTS", bucket_name: "objects" },
    ],
  },
};

const EXPECTED = {
  STATE_DB: { type: "d1", fields: { id: "database-id" } },
  OBJECTS: { type: "r2_bucket", fields: { bucket_name: "objects" } },
} as const;

describe("immutable Worker Version binding closure", () => {
  test("derives the independent data-binding closure from the realized target", () => {
    expect(
      expectedBindingClosureForTarget({
        d1: { databaseId: "database-id" },
        r2: { bucketName: "objects" },
      }),
    ).toEqual(EXPECTED);
  });

  test("accepts the exact independent binding closure", () => {
    expect(() =>
      assertVersionBindingClosure("verification", "version-1", VERSION, EXPECTED),
    ).not.toThrow();
  });

  test("exact closure rejects a retained runtime service binding", () => {
    const version = {
      ...VERSION,
      resources: {
        bindings: [
          ...VERSION.resources.bindings,
          {
            type: "service",
            name: ["HOST", "RUNTIME", "MATERIALIZER"].join("_"),
            service: "retired-runtime-service",
            entrypoint: "RetiredRuntimeEntrypoint",
          },
        ],
      },
    };
    expect(() =>
      assertExactVersionBindingClosure("verification", "version-1", version, EXPECTED),
    ).toThrow("exact selected target closure");
  });

  test("rejects duplicate named bindings instead of accepting the first one", () => {
    const duplicated = {
      ...VERSION,
      resources: {
        bindings: [...VERSION.resources.bindings, VERSION.resources.bindings[0]],
      },
    };
    expect(() =>
      assertVersionBindingClosure("verification", "version-1", duplicated, EXPECTED),
    ).toThrow("declares the STATE_DB binding more than once");
  });

  test("exact closure refuses a stale extra variable or secret binding", () => {
    const target = {
      kind: "takoserver.deploy-target@v2",
      environment: "integration",
      accountId: "a".repeat(32),
      workerName: "takoserver-api-integration",
      d1: { databaseName: "runtime-db", databaseId: "database-id" },
      r2: { bucketName: "objects" },
      publicOrigin: "https://api.integration.example.test",
      signing: { currentKeyId: "key-current" },
    } satisfies DeployTarget;
    const exact = expectedExactVersion(target);
    expect(() =>
      assertExactVersionBindingClosure(
        "preflight",
        "version-1",
        exact,
        expectedExactBindingClosure(target),
      ),
    ).not.toThrow();
    const drifted = {
      ...exact,
      resources: {
        bindings: [
          ...exact.resources.bindings,
          { type: "plain_text", name: "STALE_CONFIGURATION", text: "1" },
        ],
      },
    };
    expect(() =>
      assertExactVersionBindingClosure(
        "preflight",
        "version-1",
        drifted,
        expectedExactBindingClosure(target),
      ),
    ).toThrow("exact selected target closure");
  });

  test("binds the public Version to the exact private provider executor service", () => {
    const cloudflareProviderExecutor = cloudflareProviderExecutorTarget();
    const target = {
      kind: "takoserver.deploy-target@v2",
      environment: "integration",
      accountId: "a".repeat(32),
      workerName: "takoserver-api-integration",
      d1: { databaseName: "runtime-db", databaseId: "database-id" },
      r2: { bucketName: "objects" },
      publicOrigin: "https://api.integration.example.test",
      signing: { currentKeyId: "key-current" },
      cloudflareProviderExecutor,
    } satisfies DeployTarget;
    expect(expectedExactBindingClosure(target).CLOUDFLARE_PROVIDER_EXECUTOR).toEqual({
      type: "service",
      fields: {
        service: cloudflareProviderExecutor.workerName,
        entrypoint: "CloudflareProviderExecutor",
      },
    });
  });

  test("JIT authority closures require an exact five-binding provenance profile", () => {
    const target = {
      kind: "takoserver.deploy-target@v2",
      environment: "integration",
      accountId: "a".repeat(32),
      workerName: "takoserver-api-integration",
      d1: { databaseName: "runtime-db", databaseId: "database-id" },
      r2: { bucketName: "objects" },
      publicOrigin: "https://api.integration.example.test",
      signing: { currentKeyId: "key-current" },
      integrationE2eCredentialAuthority: {
        organizationId: "org_takosumi_hosted_staging",
        publicJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
      },
    } satisfies DeployTarget;
    const profile = {
      kind: "provenance-bound-jit" as const,
      provenance: {
        sourceCommit: "a".repeat(40),
        artifactDigest: `sha256:${"b".repeat(64)}` as const,
      },
    };
    const exact = expectedExactVersionFromClosure(
      expectedExactBindingClosure(target, { authorityProfile: profile }),
    );
    expect(() =>
      assertExactVersionBindingClosure(
        "preflight",
        "version-1",
        exact,
        expectedExactBindingClosure(target, { authorityProfile: profile }),
      ),
    ).not.toThrow();

    const historical = expectedExactVersionFromClosure(
      expectedExactBindingClosure(target, { authorityProfile: { kind: "historical-pre-jit" } }),
    );
    expect(() =>
      assertExactVersionBindingClosure(
        "preflight",
        "version-1",
        historical,
        expectedExactBindingClosure(target, { authorityProfile: profile }),
      ),
    ).toThrow("does not declare the TAKOSERVER_ENVIRONMENT binding");

    const wrongProvenance = {
      kind: "provenance-bound-jit" as const,
      provenance: {
        sourceCommit: "c".repeat(40),
        artifactDigest: `sha256:${"d".repeat(64)}` as const,
      },
    };
    expect(() =>
      assertExactVersionBindingClosure(
        "preflight",
        "version-1",
        exact,
        expectedExactBindingClosure(target, { authorityProfile: wrongProvenance }),
      ),
    ).toThrow("binds TAKOSERVER_SOURCE_COMMIT with unexpected text");
  });

  test("legacy predecessor closure requires exactly the pre-version-metadata shape", () => {
    const target = {
      kind: "takoserver.deploy-target@v2",
      environment: "integration",
      accountId: "a".repeat(32),
      workerName: "takoserver-api-integration",
      d1: { databaseName: "runtime-db", databaseId: "database-id" },
      r2: { bucketName: "objects" },
      publicOrigin: "https://api.integration.example.test",
      signing: { currentKeyId: "key-current" },
    } satisfies DeployTarget;
    const current = expectedExactVersion(target);
    const legacy = {
      ...current,
      resources: {
        bindings: current.resources.bindings.filter(({ name }) => name !== "WORKER_VERSION"),
      },
    };
    const closure = expectedLegacyPreVersionMetadataBindingClosure(target);
    expect(() =>
      assertExactVersionBindingClosure("preflight", "version-1", legacy, closure),
    ).not.toThrow();
    expect(() =>
      assertExactVersionBindingClosure("preflight", "version-1", current, closure),
    ).toThrow("unexpectedly declares the WORKER_VERSION binding");
    expect(() =>
      assertExactVersionBindingClosure(
        "preflight",
        "version-1",
        {
          ...legacy,
          resources: {
            bindings: legacy.resources.bindings.filter(({ name }) => name !== "STATE_DB"),
          },
        },
        closure,
      ),
    ).toThrow("does not declare the STATE_DB binding");
  });

  test("classifies the version-metadata binding profile structurally", () => {
    const current = {
      ...VERSION,
      resources: {
        bindings: [
          ...VERSION.resources.bindings,
          { type: "version_metadata", name: "WORKER_VERSION" },
        ],
      },
    };
    expect(workerVersionMetadataBindingProfile("preflight", "version-1", VERSION)).toBe(
      "pre-version-metadata",
    );
    expect(workerVersionMetadataBindingProfile("preflight", "version-1", current)).toBe("current");
    expect(() =>
      workerVersionMetadataBindingProfile("preflight", "version-1", {
        ...current,
        resources: {
          bindings: [
            ...current.resources.bindings,
            { type: "version_metadata", binding: "WORKER_VERSION" },
          ],
        },
      }),
    ).toThrow("WORKER_VERSION binding more than once");
    expect(() =>
      workerVersionMetadataBindingProfile("preflight", "version-1", {
        id: "version-1",
        resources: { bindings: [null] },
      }),
    ).toThrow("invalid binding inventory");
  });

  test("missing-binding diagnostics never disclose unrelated binding values", () => {
    const version = {
      ...VERSION,
      resources: {
        bindings: [
          ...VERSION.resources.bindings,
          { name: "PRIVATE_COMMERCIAL_CONFIG", type: "plain_text", text: "do-not-log-me" },
        ],
      },
    };
    let failure: unknown;
    try {
      assertVersionBindingClosure("preflight", "version-1", version, {
        ...EXPECTED,
        REQUIRED_BINDING: { type: "plain_text", fields: { text: "expected" } },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DeployError);
    expect((failure as DeployError).detail).toContain("PRIVATE_COMMERCIAL_CONFIG");
    expect((failure as DeployError).detail).toContain("plain_text");
    expect((failure as DeployError).detail).not.toContain("do-not-log-me");
  });

  test("a malformed Version cannot prove the independent closure", () => {
    expect(() =>
      assertVersionBindingClosure("verification", "version-1", { resources: {} }, EXPECTED),
    ).toThrow("has no canonical binding inventory");
  });
});

function expectedExactVersion(target: DeployTarget) {
  return {
    resources: {
      bindings: [
        { type: "ai", name: "AI" },
        { type: "version_metadata", name: "WORKER_VERSION" },
        { type: "d1", name: "STATE_DB", id: target.d1.databaseId },
        { type: "r2_bucket", name: "OBJECTS", bucket_name: target.r2.bucketName },
        { type: "plain_text", name: "PUBLIC_ORIGIN", text: target.publicOrigin },
        {
          type: "plain_text",
          name: "TAKOSERVER_SIGNING_KEY_ID",
          text: target.signing.currentKeyId,
        },
        { type: "secret_text", name: "TAKOSERVER_SIGNING_KEY" },
      ],
    },
  };
}

function expectedExactVersionFromClosure(closure: ReturnType<typeof expectedExactBindingClosure>) {
  return {
    resources: {
      bindings: Object.entries(closure).flatMap(([name, requirement]) =>
        requirement === null ? [] : [{ name, type: requirement.type, ...requirement.fields }],
      ),
    },
  };
}

describe("authoritative Worker history and secret closure", () => {
  test("strict transition history rejects invalid Version IDs, duplicate deployments, and partial shapes", () => {
    const validA = "11111111-1111-4111-8111-111111111111";
    const validB = "22222222-2222-4222-8222-222222222222";
    const strict = { requireUuidVersionIds: true } as const;
    const cases = [
      [
        "invalid Version ID",
        [deploymentHistory("deployment-a", "version-a", "2026-08-28T02:00:00Z")],
      ],
      [
        "duplicate deployment IDs",
        [
          deploymentHistory("deployment-a", validA, "2026-08-28T02:00:00Z"),
          deploymentHistory("deployment-a", validB, "2026-08-28T01:00:00Z"),
        ],
      ],
      [
        "one 100 percent Version",
        [
          {
            id: "deployment-a",
            created_on: "2026-08-28T02:00:00Z",
            versions: [
              { version_id: validA, percentage: 50 },
              { version_id: validB, percentage: 50 },
            ],
          },
        ],
      ],
    ] as const;

    for (const [message, history] of cases) {
      expect(() => parseWorkerDeploymentChain(history, "preflight", strict), message).toThrow(
        message,
      );
    }
  });

  test("strict history preserves valid older rollback reuse of an immutable Version", () => {
    const validA = "11111111-1111-4111-8111-111111111111";
    const validB = "22222222-2222-4222-8222-222222222222";
    expect(
      parseWorkerDeploymentChain(
        [
          deploymentHistory("deployment-current", validA, "2026-08-28T03:00:00Z"),
          deploymentHistory("deployment-previous", validB, "2026-08-28T02:00:00Z"),
          deploymentHistory("deployment-rollback", validA, "2026-08-28T01:00:00Z"),
        ],
        "preflight",
        { requireUuidVersionIds: true },
      ).map(({ deploymentId, versionId }) => ({ deploymentId, versionId })),
    ).toEqual([
      { deploymentId: "deployment-current", versionId: validA },
      { deploymentId: "deployment-previous", versionId: validB },
      { deploymentId: "deployment-rollback", versionId: validA },
    ]);
  });

  test("requires one 100 percent version and preserves the previous rollback id", () => {
    expect(
      parseWorkerDeploymentHistory([
        {
          id: "deployment-current",
          created_on: "2026-08-28T02:00:00Z",
          versions: [{ version_id: "version-current", percentage: 100 }],
        },
        {
          id: "deployment-previous",
          created_on: "2026-08-28T01:00:00Z",
          versions: [{ version_id: "version-previous", percentage: 100 }],
        },
      ]),
    ).toEqual({
      deploymentId: "deployment-current",
      versionId: "version-current",
      previousVersionId: "version-previous",
    });
  });

  test("refuses a gradual or malformed active deployment", () => {
    expect(() =>
      parseWorkerDeploymentHistory([
        {
          id: "deployment-current",
          created_on: "2026-08-28T02:00:00Z",
          versions: [
            { version_id: "one", percentage: 50 },
            { version_id: "two", percentage: 50 },
          ],
        },
      ]),
    ).toThrow("exactly one");
  });

  test("compares the exhaustive secret-name set without reading values", () => {
    expect(() =>
      assertExactSecretInventory(
        [
          { name: "TAKOSERVER_SIGNING_KEY", type: "secret_text" },
          { name: "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN", type: "secret_text" },
        ],
        ["TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN", "TAKOSERVER_SIGNING_KEY"],
      ),
    ).not.toThrow();
    expect(() =>
      assertExactSecretInventory(
        [
          { name: "TAKOSERVER_SIGNING_KEY", type: "secret_text" },
          { name: "RETIRED_SECRET", type: "secret_text" },
        ],
        ["TAKOSERVER_SIGNING_KEY"],
      ),
    ).toThrow("secret inventory drift");
  });
});

function deploymentHistory(id: string, versionId: string, createdOn: string) {
  return { id, created_on: createdOn, versions: [{ version_id: versionId, percentage: 100 }] };
}
