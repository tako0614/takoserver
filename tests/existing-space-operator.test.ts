import { describe, expect, test } from "bun:test";
import { handleExistingSpaceOperator } from "../src/existing-space-operator.ts";
import { existingSpaceOperatorPath } from "../src/existing-space-operator-proof.ts";
import { canonicalJson } from "../src/json.ts";
import { createExistingSpaceAdmissionAuthority } from "../src/takoform/existing-space-admission.ts";
import {
  existingSpaceOperatorFixture,
  OPERATOR_NOW,
} from "./helpers/existing-space-operator-fixture.ts";

describe("dedicated existing-Space operator bridge", () => {
  test("Host rotation between signed bridge observation and RPC composition reaches no authority work", async () => {
    const f = await existingSpaceOperatorFixture();
    let reads = 0;
    let plans = 0;
    let writes = 0;
    const authority = createExistingSpaceAdmissionAuthority({
      policy: f.policy,
      compose: async () => ({
        identity: { ...f.formIdentity, implementationDigest: `sha256:${"c".repeat(64)}` },
        evidence: f.readRequest.evidence,
        endpoint: {
          readback: async () => {
            reads++;
            throw new Error("stale signature reached readback");
          },
          plan: async () => {
            plans++;
            throw new Error("stale signature reached plan");
          },
          apply: async () => {
            writes++;
            throw new Error("stale signature reached mutation");
          },
        },
      }),
    });
    const env = {
      ...f.env,
      FORM_AUTHORITY: {
        ...f.env.FORM_AUTHORITY,
        reconcileExistingSpaces: (
          body: unknown,
          expected: import("../src/existing-space-operator.ts").ExistingSpaceOperatorFence,
        ) => authority.reconcileExistingSpaces(body, expected.identity),
      },
    };
    const response = await handleExistingSpaceOperator(
      signedRequest(
        f.identity.origin,
        "reconcile",
        f.request,
        await f.sign("reconcile", f.request),
      ),
      env,
      () => OPERATOR_NOW,
    );
    expect(response.status).toBe(502);
    expect({ reads, plans, writes }).toEqual({ reads: 0, plans: 0, writes: 0 });
  });
  test("expiry during slow identity observation cannot dispatch reconciliation", async () => {
    const f = await existingSpaceOperatorFixture();
    let now = OPERATOR_NOW;
    const env = {
      ...f.env,
      FORM_AUTHORITY: {
        ...f.env.FORM_AUTHORITY,
        verifierIdentity: async () => {
          now = new Date(OPERATOR_NOW.getTime() + 60000);
          return f.env.FORM_AUTHORITY.verifierIdentity();
        },
      },
    };
    expect(
      (
        await handleExistingSpaceOperator(
          signedRequest(
            f.identity.origin,
            "reconcile",
            f.request,
            await f.sign("reconcile", f.request),
          ),
          env,
          () => now,
        )
      ).status,
    ).toBe(401);
    expect(f.calls).toEqual([]);
  });
  test("rejects unauthenticated, wrong-purpose and expired requests before any RPC", async () => {
    const f = await existingSpaceOperatorFixture();
    let rpcs = 0;
    const env = {
      ...f.env,
      PUBLIC_HOST_IDENTITY: {
        identity: async () => {
          rpcs++;
          throw new Error("no unauthenticated identity");
        },
      },
      FORM_AUTHORITY: {
        ...f.env.FORM_AUTHORITY,
        verifierIdentity: async () => {
          rpcs++;
          throw new Error("no unauthenticated container wake");
        },
      },
    };
    for (const assertion of [
      "x",
      await f.sign("reconcile", f.request, { purpose: "form-authority" }),
    ]) {
      expect(
        (
          await handleExistingSpaceOperator(
            signedRequest(f.identity.origin, "reconcile", f.request, assertion),
            env,
            () => OPERATOR_NOW,
          )
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await handleExistingSpaceOperator(
          signedRequest(
            f.identity.origin,
            "reconcile",
            f.request,
            await f.sign("reconcile", f.request),
          ),
          env,
          () => new Date(OPERATOR_NOW.getTime() + 60000),
        )
      ).status,
    ).toBe(401);
    expect(rpcs).toBe(0);
  });
  test("dispatches only exact reconcile and readback; status never mutates", async () => {
    const f = await existingSpaceOperatorFixture();
    for (const [action, body] of [
      ["reconcile", f.request],
      ["readback", f.readRequest],
    ] as const) {
      const response = await handleExistingSpaceOperator(
        signedRequest(f.identity.origin, action, body, await f.sign(action, body)),
        f.env,
        () => OPERATOR_NOW,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(f.calls).toEqual(["reconcile", "readback"]);
    for (const path of [
      "/v1/plan",
      "/v1/apply",
      "/v1/readback",
      "/v1/existing-spaces/reconcile?scope=all",
    ]) {
      expect(
        (
          await handleExistingSpaceOperator(
            new Request(f.identity.origin + path, { method: "POST" }),
            f.env,
          )
        ).status,
      ).toBe(404);
    }
    expect(
      (
        await handleExistingSpaceOperator(
          new Request(f.identity.origin + existingSpaceOperatorPath("reconcile")),
          f.env,
        )
      ).status,
    ).toBe(404);
    expect(f.calls).toEqual(["reconcile", "readback"]);
  });
  test("rejects cross-purpose/action/Host/policy/environment/origin/body/authority replay", async () => {
    const f = await existingSpaceOperatorFixture();
    for (const overrides of [
      { purpose: "form-authority" },
      { purpose: "funding" },
      { action: "readback" },
      { method: "GET" },
      { path: "/v1/apply" },
      { environment: "production" },
      { hostId: "https://other.test" },
      { origin: "https://other.test" },
      { policyDigest: `sha256:${"c".repeat(64)}` },
      { bodyDigest: `sha256:${"c".repeat(64)}` },
      { capabilityDigest: `sha256:${"c".repeat(64)}` },
      { authorityWorkerVersionId: "22222222-2222-4222-8222-222222222222" },
      { extra: true },
    ]) {
      expect(
        (
          await handleExistingSpaceOperator(
            signedRequest(
              f.identity.origin,
              "reconcile",
              f.request,
              await f.sign("reconcile", f.request, overrides),
            ),
            f.env,
            () => OPERATOR_NOW,
          )
        ).status,
      ).toBe(401);
    }
    expect(f.calls).toEqual([]);
  });
  test("rejects expired replay and live Host/authority/policy drift before mutation", async () => {
    const f = await existingSpaceOperatorFixture();
    const assertion = await f.sign("reconcile", f.request);
    const invoke = (env = f.env, time = OPERATOR_NOW) =>
      handleExistingSpaceOperator(
        signedRequest(f.identity.origin, "reconcile", f.request, assertion),
        env,
        () => time,
      );
    expect((await invoke(f.env, new Date(OPERATOR_NOW.getTime() + 60000))).status).toBe(401);
    const live = await f.env.PUBLIC_HOST_IDENTITY.identity();
    expect(
      (
        await invoke({
          ...f.env,
          PUBLIC_HOST_IDENTITY: {
            identity: async () => ({ ...live, hostId: "https://drift.test" }),
          },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await invoke({
          ...f.env,
          PUBLIC_HOST_IDENTITY: {
            identity: async () => ({ ...live, implementationDigest: `sha256:${"c".repeat(64)}` }),
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await invoke({
          ...f.env,
          TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY: canonicalJson({
            ...f.policy,
            organizationId: "org_other",
          }),
        })
      ).status,
    ).toBe(401);
    expect(f.calls).toEqual([]);
  });
  test("rejects scope expansion and customer-controlled readback tenant", async () => {
    const f = await existingSpaceOperatorFixture();
    for (const body of [
      { ...f.request, spaces: [] },
      { ...f.request, spaces: ["one", "one"] },
      { ...f.request, forms: [] },
      { ...f.request, spaces: Array.from({ length: 101 }, (_, i) => `space-${i}`) },
    ]) {
      expect(
        (
          await handleExistingSpaceOperator(
            signedRequest(f.identity.origin, "reconcile", body, await f.sign("reconcile", body)),
            f.env,
            () => OPERATOR_NOW,
          )
        ).status,
      ).toBe(400);
    }
    const body = {
      ...f.readRequest,
      activation: { ...f.readRequest.activation, tenantId: "org_other" },
    };
    expect(
      (
        await handleExistingSpaceOperator(
          signedRequest(f.identity.origin, "readback", body, await f.sign("readback", body)),
          f.env,
          () => OPERATOR_NOW,
        )
      ).status,
    ).toBe(400);
    expect(f.calls).toEqual([]);
  });
  test("unknown RPC outcome stays indeterminate and is never retried", async () => {
    const f = await existingSpaceOperatorFixture();
    let mutations = 0;
    const env = {
      ...f.env,
      FORM_AUTHORITY: {
        ...f.env.FORM_AUTHORITY,
        reconcileExistingSpaces: async () => {
          mutations++;
          throw new Error("lost ack");
        },
      },
    };
    const response = await handleExistingSpaceOperator(
      signedRequest(
        f.identity.origin,
        "reconcile",
        f.request,
        await f.sign("reconcile", f.request),
      ),
      env,
      () => OPERATOR_NOW,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: "reconciliation_indeterminate" } });
    expect(mutations).toBe(1);
  });
});
function signedRequest(
  origin: string,
  action: "reconcile" | "readback",
  body: unknown,
  assertion: string,
) {
  return new Request(origin + existingSpaceOperatorPath(action), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${assertion}` },
    body: canonicalJson(body),
  });
}
