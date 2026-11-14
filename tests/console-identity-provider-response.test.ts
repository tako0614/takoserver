import { afterEach, expect, test } from "bun:test";
import { createApi } from "../console/src/api.ts";
import { resource } from "../console/src/reactive.ts";
import { resolveIdentity } from "../src/identity-setup.ts";

const origin = "https://api.identity-response.test";
const path = "/v1/identity/providers";
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function client() {
  return createApi({ origin, token: () => null, onSessionLost() {} });
}

function respond(reply: () => Response | Promise<Response>) {
  const requests: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return await reply();
    },
    { preconnect: originalFetch.preconnect },
  );
  return requests;
}

test("identity discovery rejects incompatible successful metadata instead of no-provider ready state", async () => {
  for (const payload of [
    { providers: [{ id: "google", displayName: "Operator assertion" }] },
    { providers: [{ id: "google", displayName: "Operator assertion", method: "operator" }] },
    { providers: [{ id: "unknown", displayName: "Unknown", method: "operator-assertion" }] },
    { providers: [{ id: "google", displayName: "Google", method: "oidc" }] },
    {
      providers: [{ id: "takos-id", displayName: "Takos ID", method: "oidc", clientId: "client" }],
    },
    { providers: [{ id: "github", displayName: "", method: "operator-assertion" }] },
    { providers: null },
    {},
    null,
  ]) {
    const requests = respond(() => Response.json(payload));
    const discovery = resource(() => client().identityProviders());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = discovery.get();
    expect(state.state).toBe("error");
    if (state.state !== "error") throw new Error("incompatible identity metadata became ready");
    expect(state.error).toMatchObject({ code: "invalid_response", status: 200, path });
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", `${origin}${path}`],
    ]);
  }
});

test("identity discovery preserves genuine empty and configured identity descriptors", async () => {
  const setups = [
    resolveIdentity({}),
    resolveIdentity({
      operatorPublicKeyJwk: {
        kty: "OKP",
        crv: "Ed25519",
        x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
      operatorAudience: origin,
    }),
    resolveIdentity({ googleClientId: "local.apps.googleusercontent.com" }),
    resolveIdentity({ takosId: { issuer: "https://identity.example.test", clientId: "local" } }),
  ];
  for (const { providers } of setups) {
    const requests = respond(() => Response.json({ providers }));
    expect(await client().identityProviders()).toEqual({ providers });
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", `${origin}${path}`],
    ]);
  }
  // These are actual discovery descriptors, not a verified identity or session.
  expect(setups[0]?.providers).toEqual([]);
  expect(setups[1]?.providers.map(({ id, method }) => [id, method])).toEqual([
    ["google", "operator-assertion"],
    ["github", "operator-assertion"],
  ]);
});

test("identity discovery keeps HTTP and transport failures separate from empty configuration", async () => {
  const refused = respond(() => new Response("refused", { status: 403 }));
  await expect(client().identityProviders()).rejects.toMatchObject({
    code: "http_403",
    status: 403,
    path,
  });
  expect(refused).toHaveLength(1);

  const unreachable = respond(() => {
    throw new Error("local transport refusal");
  });
  await expect(client().identityProviders()).rejects.toMatchObject({
    code: "unreachable",
    status: 0,
    path,
  });
  expect(unreachable).toHaveLength(1);
});
