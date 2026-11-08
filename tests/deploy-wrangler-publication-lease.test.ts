import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import {
  acquireWranglerVersionPublicationLease,
  deployExistingWranglerVersion,
  deployWranglerLifecycleChange,
  publishWranglerVersion,
} from "../scripts/deploy/wrangler-state.ts";

const accountId = "a".repeat(32);
const workerName = "local-publication-lease";
const versionId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "22222222-2222-4222-8222-222222222222";
type Operation = "staged" | "lifecycle" | "existing";
type Loss = "released" | "clone" | "proof" | "upload" | "none";

async function fixture(operation: Operation, loss: Loss) {
  const root = mkdtempSync(join(userInfo().homedir, ".core-publication-lease-test-"));
  const acquired = await acquireWranglerVersionPublicationLease({
    accountId,
    workerName,
    root: join(root, "lease"),
  });
  let effects = 0;
  const proof = async () => {
    if (loss === "proof") await acquired.release();
  };
  if (loss === "released") await acquired.release();
  const input = {
    root: join(root, "output"),
    bundlePath: join(root, "worker.js"),
    configPath: join(root, "wrangler.jsonc"),
    accountId,
    workerName,
    versionId,
    message: "local fixture",
    lease: loss === "clone" ? { ...acquired } : acquired,
    assertPredecessorStillCurrent: proof,
    assertCurrentStillExpected: proof,
    run: async (argv: readonly string[]) => {
      effects++;
      const upload = argv.includes("upload");
      if (upload && loss === "upload") await acquired.release();
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          type: upload ? "version-upload" : operation === "lifecycle" ? "deploy" : "version-deploy",
          version: 1,
          worker_name: workerName,
          worker_tag: null,
          ...(upload
            ? { version_id: versionId, worker_name_overridden: false }
            : operation === "lifecycle"
              ? { version_id: versionId, targets: [], worker_name_overridden: false }
              : { deployment_id: deploymentId, version_traffic: { [versionId]: 100 } }),
        }),
      };
    },
  };
  return {
    invoke: () =>
      operation === "staged"
        ? publishWranglerVersion(input)
        : operation === "lifecycle"
          ? deployWranglerLifecycleChange(input)
          : deployExistingWranglerVersion(input),
    get effects() {
      return effects;
    },
    dispose: async () => {
      try {
        await acquired.release();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

for (const operation of ["staged", "lifecycle", "existing"] as const) {
  test.each(["released", "clone", "proof"] as const)(
    `Core ${operation} final send refuses lost acquired-lease authority (%s)`,
    async (loss) => {
      const f = await fixture(operation, loss);
      try {
        const value = await f.invoke().catch((error: unknown) => error);
        expect(f.effects).toBe(operation === "staged" && loss === "proof" ? 1 : 0);
        expect(value).toBeInstanceOf(DeployError);
        if (!(value instanceof DeployError)) throw new Error("expected lease refusal");
        expect(value.phase).toBe(
          operation === "staged" && loss !== "proof" ? "preflight" : "mutation",
        );
        if (operation === "staged" && loss === "proof") {
          expect(value.message).toContain("did not start a traffic deployment");
          expect(value.message).toContain("run --status");
        }
      } finally {
        await f.dispose();
      }
    },
  );
  test(`Core ${operation} final send accepts its actual acquired lease`, async () => {
    const f = await fixture(operation, "none");
    try {
      expect(await f.invoke()).toMatchObject({ versionId });
      expect(f.effects).toBe(operation === "staged" ? 2 : 1);
    } finally {
      await f.dispose();
    }
  });
}

test("Core staged final send retains unknown classification after upload loses the lease", async () => {
  const f = await fixture("staged", "upload");
  try {
    const value = await f.invoke().catch((error: unknown) => error);
    expect(f.effects).toBe(1);
    expect(value).toBeInstanceOf(DeployError);
    if (!(value instanceof DeployError)) throw new Error("expected post-upload refusal");
    expect(value.phase).toBe("mutation");
    expect(value.message).toContain("did not start a traffic deployment");
    expect(value.message).toContain("run --status");
  } finally {
    await f.dispose();
  }
});
