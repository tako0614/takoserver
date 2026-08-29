import { describe, expect, test } from "bun:test";
import { buildApp, createEphemeralSql, createMemoryObjectStore } from "../src/index.ts";

function app(consoleOrigin?: string) {
  return buildApp({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    identity: {
      async verify({ assertion }) {
        return {
          providerSubject: assertion,
          email: `${assertion}@example.test`,
          displayName: assertion,
        };
      },
    },
    settlement: {
      verify: () => {
        throw new Error("not configured");
      },
    },
    publicOrigin: "https://api.example.test",
    ...(consoleOrigin === undefined ? {} : { consoleOrigin }),
    forms: [],
    hostForms: [],
    offerings: [],
  });
}

async function signIn(
  fetch: (request: Request) => Promise<Response>,
  assertion: string,
  origin?: string,
): Promise<{ token: string; cookie: string | null }> {
  const response = await fetch(
    new Request("https://api.example.test/v1/sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(origin === undefined ? {} : { origin }),
      },
      body: JSON.stringify({ provider: "google", assertion }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { sessionToken?: string };
  return {
    token: body.sessionToken ?? "",
    cookie: response.headers.get("set-cookie"),
  };
}

function cookieValue(setCookie: string): string {
  return setCookie.split(";", 1)[0] ?? "";
}

describe("session revocation", () => {
  test("durably revokes a bearer before clearing the cookie and rejects replay", async () => {
    const { fetch } = app();
    const { token } = await signIn(fetch, "bearer-user");

    const signedOut = await fetch(
      new Request("https://api.example.test/v1/session", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(signedOut.status).toBe(204);
    expect(signedOut.headers.get("set-cookie")).toContain("Max-Age=0");

    const replay = await fetch(
      new Request("https://api.example.test/v1/me", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(replay.status).toBe(401);
  });

  test("does not let an API key use session logout or revoke itself", async () => {
    const { fetch } = app();
    const { token } = await signIn(fetch, "api-key-owner");
    const owner = { authorization: `Bearer ${token}` };
    const organizationResponse = await fetch(
      new Request("https://api.example.test/v1/organizations", {
        method: "POST",
        headers: { ...owner, "content-type": "application/json" },
        body: JSON.stringify({ name: "Acme" }),
      }),
    );
    const organization = (await organizationResponse.json()) as {
      organization: { id: string };
    };
    const keyResponse = await fetch(
      new Request(
        `https://api.example.test/v1/organizations/${organization.organization.id}/api-keys`,
        {
          method: "POST",
          headers: { ...owner, "content-type": "application/json" },
          body: JSON.stringify({
            name: "wallet-reader",
            scopes: ["wallet:read"],
            expiresInSeconds: 3_600,
          }),
        },
      ),
    );
    const key = (await keyResponse.json()) as { secret: string };

    const signedOut = await fetch(
      new Request("https://api.example.test/v1/session", {
        method: "DELETE",
        headers: { authorization: `Bearer ${key.secret}` },
      }),
    );
    expect(signedOut.status).toBe(401);

    const stillUsable = await fetch(
      new Request(
        `https://api.example.test/v1/organizations/${organization.organization.id}/wallet`,
        { headers: { authorization: `Bearer ${key.secret}` } },
      ),
    );
    expect(stillUsable.status).toBe(200);
  });

  test("accepts a cookie only from the configured console origin", async () => {
    const { fetch } = app("https://console.example.test");
    const signedIn = await signIn(fetch, "cookie-user", "https://console.example.test");
    expect(signedIn.token).toBe("");
    expect(signedIn.cookie).not.toBeNull();
    const cookie = cookieValue(signedIn.cookie ?? "");

    const absent = await fetch(
      new Request("https://api.example.test/v1/session", { method: "DELETE" }),
    );
    expect(absent.status).toBe(401);

    const wrongOrigin = await fetch(
      new Request("https://api.example.test/v1/session", {
        method: "DELETE",
        headers: { origin: "https://evil.example.test", cookie },
      }),
    );
    expect(wrongOrigin.status).toBe(401);

    const stillLive = await fetch(
      new Request("https://api.example.test/v1/me", {
        headers: { origin: "https://console.example.test", cookie },
      }),
    );
    expect(stillLive.status).toBe(200);

    const signedOut = await fetch(
      new Request("https://api.example.test/v1/session", {
        method: "DELETE",
        headers: { origin: "https://console.example.test", cookie },
      }),
    );
    expect(signedOut.status).toBe(204);
    expect(signedOut.headers.get("set-cookie")).toContain("Max-Age=0");

    const replay = await fetch(
      new Request("https://api.example.test/v1/me", {
        headers: { origin: "https://console.example.test", cookie },
      }),
    );
    expect(replay.status).toBe(401);
  });
});
