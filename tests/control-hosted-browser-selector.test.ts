import { expect, test } from "bun:test";
import { createAccounts } from "../src/auth.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { createControlRoutes } from "../src/control.ts";
import { HOSTED_BROWSER_CONTINUATION_HEADER } from "../src/financial-hosted-browser-selector.ts";

const ORIGIN = "https://server.example.test";
const SELECTOR = "a".repeat(64);
const VALUE = `hosted-browser-v1.${SELECTOR}`;

async function fixture() {
  const sql = createEphemeralSql();
  const accounts = createAccounts({
    sql,
    identity: {
      async verify({ assertion }) {
        return {
          providerSubject: assertion,
          email: `${assertion}@local.example.test`,
          displayName: assertion,
        };
      },
    },
  });
  const signed = await accounts.signIn({ provider: "google", assertion: "local-owner" });
  const actor = await accounts.authenticate(`Bearer ${signed.sessionToken}`);
  if (!actor) throw new Error("missing actual Accounts session");
  const organization = await accounts.createOrganization({ actor, name: "Owned" });
  const checkoutCalls: string[] = [];
  const control = createControlRoutes({
    publicOrigin: ORIGIN,
    accounts,
    inventory: {} as never,
    deployments: {} as never,
    attachments: {} as never,
    migrations: {} as never,
    forms: [],
    identityProviders: [],
    ledger: {} as never,
    catalog: {} as never,
    reseller: {} as never,
    tokens: {} as never,
    settlement: {} as never,
    clock: () => new Date(1_800_000_000_000),
    checkout: {
      referenceRequired: true,
      bounds: { minimumMinor: 1, maximumMinor: 1000 },
      async begin(input) {
        checkoutCalls.push(input.reference ?? "missing-reference");
        return { url: "https://checkout.example.test/session" };
      },
    },
  });
  async function send(
    path: string,
    method: string,
    headers: Headers = new Headers(),
    body?: unknown,
  ): Promise<Response> {
    if (body !== undefined && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    const request = new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const response = await control(request, new URL(request.url));
    if (!response) throw new Error("unhandled control route");
    return response;
  }
  const bearer = () => new Headers({ authorization: `Bearer ${signed.sessionToken}` });
  const selected = () => new Headers({ [HOSTED_BROWSER_CONTINUATION_HEADER]: VALUE });
  return { organization, checkoutCalls, send, bearer, selected };
}

test("absent header preserves ordinary Accounts Owner and checkout routes", async () => {
  const f = await fixture();
  expect((await f.send("/v1/me", "GET", f.bearer())).status).toBe(200);
  const response = await f.send(
    `/v1/organizations/${f.organization.id}/wallet/checkout`,
    "POST",
    f.bearer(),
    { reference: "ordinary-a", amountMinor: 50 },
  );
  expect(response.status).toBe(201);
  expect(f.checkoutCalls).toEqual(["ordinary-a"]);
});

test("valid selected existing payment/read routes fail closed before auth and effects", async () => {
  const f = await fixture();
  const base = `/v1/organizations/${f.organization.id}`;
  const routes: readonly [string, string][] = [
    ["POST", `${base}/wallet/checkout`],
    ["GET", `${base}/wallet/checkout/topup-a`],
    ["GET", `${base}/payments/subscription`],
    ["POST", `${base}/payments/subscription`],
    ["PATCH", `${base}/payments/subscription`],
    ["GET", `${base}/payments/subscription/commands/start/subscription-a`],
  ];
  for (const [method, path] of routes) {
    const response = await f.send(path, method, f.selected());
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("backend_unavailable");
  }
  expect(f.checkoutCalls).toEqual([]);
});

test("malformed, duplicated and unknown-version headers never fall back", async () => {
  const f = await fixture();
  const path = `/v1/organizations/${f.organization.id}/wallet/checkout`;
  const values = [
    "",
    `hosted-browser-v2.${SELECTOR}`,
    `hosted-browser-v1.${"A".repeat(64)}`,
    `hosted-browser-v1.${"a".repeat(63)}`,
    `${VALUE}, ${VALUE}`,
    `${VALUE}.extra`,
  ];
  for (const value of values) {
    const headers = f.bearer();
    headers.set(HOSTED_BROWSER_CONTINUATION_HEADER, value);
    const response = await f.send(path, "POST", headers, {
      reference: "blocked-a",
      amountMinor: 50,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_argument");
  }
  const duplicate = f.bearer();
  duplicate.append(HOSTED_BROWSER_CONTINUATION_HEADER, VALUE);
  duplicate.append(HOSTED_BROWSER_CONTINUATION_HEADER, VALUE);
  expect((await f.send(path, "POST", duplicate)).status).toBe(400);
  expect(f.checkoutCalls).toEqual([]);
});

test("selector on unsupported routes or methods is 400 with no ordinary effect", async () => {
  const f = await fixture();
  const base = `/v1/organizations/${f.organization.id}`;
  for (const [method, path] of [
    ["GET", "/v1/me"],
    ["GET", "/health"],
    ["POST", `${base}/wallet/funding`],
    ["GET", `${base}/wallet/checkout`],
    ["DELETE", `${base}/payments/subscription`],
    ["POST", `${base}/payments/subscription/commands/start/ref-a`],
  ] as const) {
    const response = await f.send(path, method, f.selected());
    expect(response.status).toBe(400);
  }
  expect(f.checkoutCalls).toEqual([]);
});

test("dedicated metadata GET and POST are unavailable; malformed selector and other methods are 400", async () => {
  const f = await fixture();
  const base = "/v1/billing/hosted-continuations";
  const valid = await f.send(`${base}/${SELECTOR}`, "GET");
  expect(valid.status).toBe(503);
  expect((await valid.json()).error.code).toBe("backend_unavailable");
  expect((await f.send(`${base}/${SELECTOR}`, "POST")).status).toBe(503);
  for (const [method, path] of [
    ["GET", `${base}/${"A".repeat(64)}`],
    ["GET", `${base}/short`],
    ["GET", `${base}/${SELECTOR}/extra`],
    ["PATCH", `${base}/${SELECTOR}`],
  ] as const) {
    expect((await f.send(path, method)).status).toBe(400);
  }
  expect((await f.send(`${base}/${SELECTOR}`, "GET", f.selected())).status).toBe(400);
  expect(f.checkoutCalls).toEqual([]);
});
