import { describe, expect, test } from "bun:test";
import { handleFormAuthorityIdentityProbe } from "../src/form-authority-identity-probe.ts";

const IDENTITY = {
  kind: "takoserver.public-host-identity@v2" as const,
  hostId: "https://api.example.test",
  workerVersionId: "11111111-1111-4111-8111-111111111111",
  workerArtifactDigest: `sha256:${"a".repeat(64)}` as const,
  implementationPayloadDigest: `sha256:${"b".repeat(64)}` as const,
  capabilityDigest: `sha256:${"c".repeat(64)}` as const,
  implementationDigest: `sha256:${"d".repeat(64)}` as const,
};

describe("Form authority identity probe", () => {
  test("returns only the identity read from the named public RPC", async () => {
    let calls = 0;
    const response = await handleFormAuthorityIdentityProbe(
      new Request("https://probe.example.test/v1/public-host-identity"),
      {
        TAKOSERVER_FORM_AUTHORITY_HOST_ID: IDENTITY.hostId,
        PUBLIC_HOST_IDENTITY: {
          async identity() {
            calls += 1;
            return IDENTITY;
          },
        },
        FORM_AUTHORITY: unavailableVerifierRpc(),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(IDENTITY);
    expect(calls).toBe(1);
  });

  test("maps thrown RPC failure to an unavailable response", async () => {
    const response = await handleFormAuthorityIdentityProbe(
      new Request("https://probe.example.test/v1/public-host-identity"),
      {
        TAKOSERVER_FORM_AUTHORITY_HOST_ID: IDENTITY.hostId,
        PUBLIC_HOST_IDENTITY: {
          async identity(): Promise<never> {
            throw new Error("unavailable");
          },
        },
        FORM_AUTHORITY: unavailableVerifierRpc(),
      },
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "identity_unavailable" } });
  });

  test("keeps the public identity route live when Core authority is not configured", async () => {
    const request = new Request("https://probe.example.test/v1/core-verifier-identity");
    const response = await handleFormAuthorityIdentityProbe(request, {
      TAKOSERVER_FORM_AUTHORITY_HOST_ID: IDENTITY.hostId,
      PUBLIC_HOST_IDENTITY: {
        async identity() {
          return IDENTITY;
        },
      },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "verifier_unavailable" } });

    const publicResponse = await handleFormAuthorityIdentityProbe(
      new Request("https://probe.example.test/v1/public-host-identity"),
      {
        TAKOSERVER_FORM_AUTHORITY_HOST_ID: IDENTITY.hostId,
        PUBLIC_HOST_IDENTITY: {
          async identity() {
            return IDENTITY;
          },
        },
      },
    );
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.json()).toEqual(IDENTITY);
  });

  test("does not expose another path or method", async () => {
    let called = false;
    const env = {
      TAKOSERVER_FORM_AUTHORITY_HOST_ID: IDENTITY.hostId,
      PUBLIC_HOST_IDENTITY: {
        async identity() {
          called = true;
          return IDENTITY;
        },
      },
      FORM_AUTHORITY: unavailableVerifierRpc(),
    };
    for (const request of [
      new Request("https://probe.example.test/"),
      new Request("https://probe.example.test/v1/public-host-identity", { method: "POST" }),
      new Request("https://probe.example.test/v1/public-host-identity?x=1"),
    ]) {
      expect((await handleFormAuthorityIdentityProbe(request, env)).status).toBe(404);
    }
    expect(called).toBe(false);
  });
});

function unavailableVerifierRpc() {
  return {
    async verifierIdentity(): Promise<never> {
      throw new Error("unexpected verifier identity call");
    },
  };
}
