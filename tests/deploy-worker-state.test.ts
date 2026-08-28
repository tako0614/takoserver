import { describe, expect, test } from "bun:test";
import { DeployError } from "../scripts/deploy/errors.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import {
  assertExactSecretInventory,
  assertExactVersionBindingClosure,
  assertVersionBindingClosure,
  expectedBindingClosureForTarget,
  expectedExactBindingClosure,
  parseWorkerDeploymentHistory,
} from "../scripts/deploy/worker-state.ts";

const VERSION = {
  id: "version-1",
  resources: {
    bindings: [
      { type: "d1", name: "STATE_DB", id: "database-id" },
      { type: "r2_bucket", name: "OBJECTS", bucket_name: "objects" },
      {
        type: "service",
        name: "HOST_RUNTIME_MATERIALIZER",
        service: "takosumi-platform",
        entrypoint: "TakosumiHostRuntimeMaterializerEntrypoint",
      },
    ],
  },
};

const EXPECTED = {
  STATE_DB: { type: "d1", fields: { id: "database-id" } },
  OBJECTS: { type: "r2_bucket", fields: { bucket_name: "objects" } },
  HOST_RUNTIME_MATERIALIZER: {
    type: "service",
    fields: {
      service: "takosumi-platform",
      entrypoint: "TakosumiHostRuntimeMaterializerEntrypoint",
    },
  },
} as const;

describe("immutable Worker Version binding closure", () => {
  test("derives the exact status closure from the realized target", () => {
    expect(
      expectedBindingClosureForTarget({
        d1: { databaseId: "database-id" },
        r2: { bucketName: "objects" },
        hostedTopology: {
          service: "takosumi-platform",
          entrypoint: "TakosumiHostRuntimeMaterializerEntrypoint",
        },
      }),
    ).toEqual(EXPECTED);
  });

  test("requires materializer absence when the target declares none", () => {
    expect(
      expectedBindingClosureForTarget({
        d1: { databaseId: "database-id" },
        r2: { bucketName: "objects" },
      }).HOST_RUNTIME_MATERIALIZER,
    ).toBeNull();
  });

  test("accepts the exact named service and entrypoint", () => {
    expect(() =>
      assertVersionBindingClosure("verification", "version-1", VERSION, EXPECTED),
    ).not.toThrow();
  });

  test("rejects a service or entrypoint that differs from the private target", () => {
    for (const binding of [
      { ...VERSION.resources.bindings[2], service: "somewhere-else" },
      { ...VERSION.resources.bindings[2], entrypoint: "default" },
    ]) {
      const version = {
        ...VERSION,
        resources: { bindings: [...VERSION.resources.bindings.slice(0, 2), binding] },
      };
      expect(() =>
        assertVersionBindingClosure("verification", "version-1", version, EXPECTED),
      ).toThrow("HOST_RUNTIME_MATERIALIZER");
    }
  });

  test("rejects a stale authority binding when the target declares none", () => {
    expect(() =>
      assertVersionBindingClosure("verification", "version-1", VERSION, {
        HOST_RUNTIME_MATERIALIZER: null,
      }),
    ).toThrow("unexpectedly declares the HOST_RUNTIME_MATERIALIZER binding");
  });

  test("rejects duplicate named bindings instead of accepting the first one", () => {
    const version = {
      ...VERSION,
      resources: {
        bindings: [...VERSION.resources.bindings, VERSION.resources.bindings[2]],
      },
    };
    expect(() =>
      assertVersionBindingClosure("verification", "version-1", version, EXPECTED),
    ).toThrow("declares the HOST_RUNTIME_MATERIALIZER binding more than once");
  });

  test("reads only the canonical binding inventory", () => {
    const nestedImpostor = {
      ...VERSION,
      resources: {
        bindings: VERSION.resources.bindings.slice(0, 2),
        annotations: {
          name: "HOST_RUNTIME_MATERIALIZER",
          type: "service",
          service: "takosumi-platform",
          entrypoint: "TakosumiHostRuntimeMaterializerEntrypoint",
        },
      },
    };
    expect(() =>
      assertVersionBindingClosure("verification", "version-1", nestedImpostor, EXPECTED),
    ).toThrow("does not declare the HOST_RUNTIME_MATERIALIZER binding");
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
        expectedExactBindingClosure(target, { hostedTopology: "desired" }),
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
        expectedExactBindingClosure(target, { hostedTopology: "desired" }),
      ),
    ).toThrow("exact selected target closure");
  });

  test("missing-binding diagnostics never disclose unrelated binding values", () => {
    const version = {
      ...VERSION,
      resources: {
        bindings: [
          ...VERSION.resources.bindings.slice(0, 2),
          { name: "PRIVATE_COMMERCIAL_CONFIG", type: "plain_text", text: "do-not-log-me" },
        ],
      },
    };
    let failure: unknown;
    try {
      assertVersionBindingClosure("preflight", "version-1", version, EXPECTED);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DeployError);
    expect((failure as DeployError).detail).toContain("PRIVATE_COMMERCIAL_CONFIG");
    expect((failure as DeployError).detail).toContain("plain_text");
    expect((failure as DeployError).detail).not.toContain("do-not-log-me");
  });

  test("a malformed Version cannot prove an authority binding is absent", () => {
    expect(() =>
      assertVersionBindingClosure(
        "verification",
        "version-1",
        { resources: {} },
        { HOST_RUNTIME_MATERIALIZER: null },
      ),
    ).toThrow("has no canonical binding inventory");
  });
});

function expectedExactVersion(target: DeployTarget) {
  return {
    resources: {
      bindings: [
        { type: "ai", name: "AI" },
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

describe("authoritative Worker history and secret closure", () => {
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
