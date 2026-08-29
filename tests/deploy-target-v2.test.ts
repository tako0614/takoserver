import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTarget, targetPath } from "../scripts/deploy/target.ts";

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    kind: "takoserver.deploy-target@v2",
    environment: "rehearsal",
    accountId: "a".repeat(32),
    workerName: "takoserver-api-rehearsal",
    d1: {
      databaseName: "takoserver-runtime-rehearsal",
      databaseId: "00000000-0000-4000-8000-000000000000",
    },
    r2: { bucketName: "takoserver-objects-rehearsal" },
    publicOrigin: "https://takoserver-api-rehearsal.example.workers.dev",
    consoleOrigin: "https://console-rehearsal.example.test",
    signing: { currentKeyId: "takoserver-rehearsal-2026-08" },
    hostedTopology: {
      service: "takosumi-hosted-rehearsal",
      entrypoint: "TakosumiHostRuntimeMaterializerEntrypoint",
    },
    ...overrides,
  };
}

function withTarget(value: unknown, run: (path: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "takoserver-target-v2-"));
  try {
    const path = join(root, "target.json");
    writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    run(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("environment-exact deploy target", () => {
  test("loads the selected environment and explicit signing/topology state", () => {
    withTarget(descriptor(), (path) => {
      expect(loadTarget(path, "rehearsal")).toMatchObject({
        environment: "rehearsal",
        signing: { currentKeyId: "takoserver-rehearsal-2026-08" },
        hostedTopology: {
          service: "takosumi-hosted-rehearsal",
          entrypoint: "TakosumiHostRuntimeMaterializerEntrypoint",
        },
      });
    });
  });

  test("refuses a descriptor for another environment", () => {
    withTarget(descriptor(), (path) => {
      expect(() => loadTarget(path, "production")).toThrow("environment");
    });
  });

  test("requires explicit current and next key ids for a rotation", () => {
    withTarget(
      descriptor({
        signing: {
          currentKeyId: "takoserver-rehearsal-current",
          nextKeyId: "takoserver-rehearsal-next",
        },
      }),
      (path) => {
        expect(loadTarget(path, "rehearsal").signing).toEqual({
          currentKeyId: "takoserver-rehearsal-current",
          nextKeyId: "takoserver-rehearsal-next",
        });
      },
    );
    withTarget(
      descriptor({
        signing: {
          currentKeyId: "takoserver-rehearsal-same",
          nextKeyId: "takoserver-rehearsal-same",
        },
      }),
      (path) => expect(() => loadTarget(path, "rehearsal")).toThrow("must differ"),
    );
  });

  test("does not accept the legacy mixed-controller key selector", () => {
    const legacy = descriptor({ signing: undefined, grantKeyId: "legacy-key" });
    withTarget(legacy, (path) => expect(() => loadTarget(path, "rehearsal")).toThrow());
  });

  test("derives a non-overridable target path from the selected environment", () => {
    expect(targetPath("integration")).toEndWith("/.deploy/targets/integration.json");
    expect(targetPath("rehearsal")).toEndWith("/.deploy/targets/rehearsal.json");
    expect(targetPath("production")).toEndWith("/.deploy/targets/production.json");
  });

  test("accepts only one exact public Ed25519 operator identity on integration", () => {
    const publicJwk = {
      kty: "OKP" as const,
      crv: "Ed25519" as const,
      x: "A".repeat(43),
    };
    withTarget(
      descriptor({
        environment: "integration",
        operatorIdentity: { publicJwk },
      }),
      (path) => {
        expect(loadTarget(path, "integration").operatorIdentity).toEqual({ publicJwk });
      },
    );

    for (const rejected of [
      { ...publicJwk, d: "private-material" },
      { ...publicJwk, kid: "unexpected" },
      { kty: "OKP", crv: "Ed25519", x: `${"A".repeat(42)}=` },
    ]) {
      withTarget(
        descriptor({
          environment: "integration",
          operatorIdentity: { publicJwk: rejected },
        }),
        (path) => expect(() => loadTarget(path, "integration")).toThrow("operatorIdentity"),
      );
    }
  });

  test("refuses operator identity in a non-integration target", () => {
    withTarget(
      descriptor({
        operatorIdentity: {
          publicJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
        },
      }),
      (path) => expect(() => loadTarget(path, "rehearsal")).toThrow("integration-only"),
    );
  });
});
