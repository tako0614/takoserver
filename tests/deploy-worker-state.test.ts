import { describe, expect, test } from "bun:test";
import { DeployError } from "../scripts/deploy/errors.ts";
import {
  assertVersionBindingClosure,
  expectedBindingClosureForTarget,
  versionBindingDeclared,
} from "../scripts/deploy/worker-state.ts";

const VERSION = {
  id: "version-1",
  resources: {
    bindings: [
      { type: "d1", name: "STATE_DB", database_id: "database-id" },
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
  STATE_DB: { type: "d1", fields: { database_id: "database-id" } },
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
        hostRuntimeMaterializerService: {
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

  test("detects first-enable secret binding from the immutable Version only", () => {
    const withSecret = {
      ...VERSION,
      resources: {
        bindings: [
          ...VERSION.resources.bindings,
          { type: "secret_text", name: "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN" },
        ],
      },
    };
    expect(
      versionBindingDeclared(
        "preflight",
        "version-1",
        withSecret,
        "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN",
      ),
    ).toBeTrue();
    expect(
      versionBindingDeclared(
        "preflight",
        "version-1",
        VERSION,
        "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN",
      ),
    ).toBeFalse();
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
