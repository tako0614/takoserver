import { describe, expect, test } from "bun:test";
import type { Provider, ProviderOffering } from "../src/provider-port.ts";
import { failed, succeeded } from "../src/provider-port.ts";
import { createRemoteProvider, PROVISIONER_PATH } from "../src/providers/remote.ts";
import { createProvisionerEndpoint } from "../src/provisioner-endpoint.ts";

/**
 * The public API runs where no cloud credential may go, so provisioning happens
 * on the other half of the deployment. These two pieces are that road, and the
 * thing worth testing is that nothing about it leaks into the product: what
 * crosses is the classified ticket the port already speaks, and a broken road
 * fails in a way an operation can be retried through.
 */

const OFFERING: ProviderOffering = {
  id: "storage.object.standard",
  kind: "object_bucket",
  displayName: "Object bucket",
  form: {
    apiVersion: "edge.forms.takoform.com/v1beta1",
    kind: "ObjectBucket",
    definitionVersion: "0.1.0",
    schemaDigest: "sha256:3383a60c12bdc5a853868bd7ccab3670e1aff7b3eca889583b86d11ac0f90494",
  },
  providedInterfaces: [],
  bindingRefs: [],
  capabilities: ["create", "update", "delete", "import", "observe"],
};

const IDENTITY = { tenantRef: "org_1", space: "default", name: "media" };

function backend(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "cloudflare",
    offerings: [OFFERING],
    async apply(input) {
      return succeeded({
        nativeId: `r2:${input.identity.name}`,
        observed: { name: input.identity.name },
        outputs: { protocol: "s3", bucketName: input.identity.name },
      });
    },
    async observe() {
      return succeeded({ nativeId: "r2:media", observed: {}, outputs: {} });
    },
    async delete() {
      return succeeded({ nativeId: "r2:media", observed: { deleted: true }, outputs: {} });
    },
    ...overrides,
  };
}

function road(provider: Provider, credential = "shared-secret") {
  const endpoint = createProvisionerEndpoint({ providers: [provider], credential });
  const remote = createRemoteProvider({
    origin: "https://provisioner.test",
    offerings: [OFFERING],
    authorize: () => `Bearer ${credential}`,
    async fetch(request) {
      const answered = await endpoint(request);
      return answered ?? new Response("not found", { status: 404 });
    },
  });
  return { remote, endpoint };
}

describe("provisioning across the road", () => {
  test("carries a result back unchanged", async () => {
    const { remote } = road(backend());
    const ticket = await remote.apply({
      operationId: "op_1",
      offering: OFFERING,
      identity: IDENTITY,
      spec: {},
    });
    expect(ticket).toEqual({
      phase: "succeeded",
      result: {
        nativeId: "r2:media",
        observed: { name: "media" },
        outputs: { protocol: "s3", bucketName: "media" },
      },
    });
  });

  test("carries a classified failure back as a failure", async () => {
    const { remote } = road(
      backend({
        async apply() {
          return failed("invalid_spec", "no");
        },
      }),
    );
    const ticket = await remote.apply({
      operationId: "op_2",
      offering: OFFERING,
      identity: IDENTITY,
      spec: {},
    });
    expect(ticket).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
  });

  test("turns a thrown provider into a retryable failure, not an exception", async () => {
    const { remote } = road(
      backend({
        async apply() {
          throw new Error("the account token is invalid");
        },
      }),
    );
    const ticket = await remote.apply({
      operationId: "op_3",
      offering: OFFERING,
      identity: IDENTITY,
      spec: {},
    });
    expect(ticket).toMatchObject({ phase: "failed", failure: { retryable: true } });
    // What went wrong is for an operator of the far half, not for the caller.
    expect(JSON.stringify(ticket)).not.toContain("account token");
  });

  test("refuses a caller without the credential", async () => {
    const endpoint = createProvisionerEndpoint({
      providers: [backend()],
      credential: "shared-secret",
    });
    const answered = await endpoint(
      new Request(`https://provisioner.test${PROVISIONER_PATH}`, {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
        body: JSON.stringify({ operation: "apply", input: {} }),
      }),
    );
    expect(answered?.status).toBe(401);
  });

  test("does not serve the path at all when no credential is configured", async () => {
    const endpoint = createProvisionerEndpoint({ providers: [backend()] });
    const answered = await endpoint(
      new Request(`https://provisioner.test${PROVISIONER_PATH}`, { method: "POST" }),
    );
    // Not "forbidden": a scanner should not learn there is a provisioner here.
    expect(answered?.status).toBe(404);
  });

  test("can drain a retired offering without retaining remote apply authority", async () => {
    let applies = 0;
    let observes = 0;
    let deletes = 0;
    const provider = backend({
      async apply(input) {
        applies += 1;
        return succeeded({ nativeId: input.operationId, observed: {}, outputs: {} });
      },
      async observe(input) {
        observes += 1;
        return succeeded({ nativeId: input.nativeId, observed: {}, outputs: {} });
      },
      async delete(input) {
        deletes += 1;
        return succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} });
      },
    });
    const endpoint = createProvisionerEndpoint({
      providers: [provider],
      credential: "shared-secret",
      applyOfferingIds: [],
    });
    const invoke = async (operation: string, input: Record<string, unknown>) => {
      const response = await endpoint(
        new Request(`https://provisioner.test${PROVISIONER_PATH}`, {
          method: "POST",
          headers: {
            authorization: "Bearer shared-secret",
            "content-type": "application/json",
          },
          body: JSON.stringify({ operation, input: { offering: OFFERING, ...input } }),
        }),
      );
      return (await response?.json()) as { readonly ticket: { readonly phase: string } };
    };

    expect((await invoke("apply", { operationId: "retired-create" })).ticket.phase).toBe("failed");
    expect(
      (await invoke("observe", { nativeId: "r2:media", identity: IDENTITY, spec: {} })).ticket
        .phase,
    ).toBe("succeeded");
    expect(
      (
        await invoke("delete", {
          operationId: "retired-delete",
          nativeId: "r2:media",
          identity: IDENTITY,
          spec: {},
        })
      ).ticket.phase,
    ).toBe("succeeded");
    expect({ applies, observes, deletes }).toEqual({ applies: 0, observes: 1, deletes: 1 });
  });

  test("refuses to read a half-written answer as success", async () => {
    const remote = createRemoteProvider({
      origin: "https://provisioner.test",
      offerings: [OFFERING],
      authorize: () => "Bearer shared-secret",
      async fetch() {
        return Response.json({ ticket: { phase: "succeeded", result: {} } });
      },
    });
    const ticket = await remote.apply({
      operationId: "op_4",
      offering: OFFERING,
      identity: IDENTITY,
      spec: {},
    });
    // Recording a resource nobody created is worse than failing.
    expect(ticket).toMatchObject({ phase: "failed", failure: { retryable: true } });
  });

  test("reports an unreachable provisioner as retryable", async () => {
    const remote = createRemoteProvider({
      origin: "https://provisioner.test",
      offerings: [OFFERING],
      authorize: () => "Bearer shared-secret",
      fetch() {
        throw new TypeError("connection refused");
      },
    });
    const ticket = await remote.observe({
      offering: OFFERING,
      nativeId: "r2:media",
      identity: IDENTITY,
      spec: {},
    });
    expect(ticket).toMatchObject({ phase: "failed", failure: { retryable: true } });
  });
});

/**
 * A provider refuses a credential — ours. What the customer must not be told is
 * that *they* lack permission: they would check their key, their scopes, and
 * their account, and find nothing wrong, because nothing is.
 */
describe("failures as the caller sees them", () => {
  test("never blames the caller for a credential of ours", async () => {
    const { failureToWire } = await import("../src/provider-driver.ts");
    expect(failureToWire("denied")).toEqual(["backend_unavailable", 503]);
  });

  test("still blames the caller for what the caller wrote", async () => {
    const { failureToWire } = await import("../src/provider-driver.ts");
    expect(failureToWire("invalid_spec")).toEqual(["invalid_argument", 400]);
    expect(failureToWire("conflict")).toEqual(["resource_busy", 409]);
    expect(failureToWire("not_found")).toEqual(["resource_not_found", 404]);
  });
});
