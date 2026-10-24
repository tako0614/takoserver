import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIssuedOrganizationBillingReadSupplier } from "../scripts/issued-org-billing-read.ts";
import { createAccounts } from "../src/auth.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { type CreateControlRoutesOptions, createControlRoutes } from "../src/control.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(scopes: string[] = ["wallet:read"]) {
  const root = mkdtempSync(join(tmpdir(), "issued-billing-"));
  roots.push(root);
  const sql = createEphemeralSql();
  let now = Date.parse("2026-10-23T12:00:00.000Z");
  const accounts = createAccounts({
    sql,
    clock: () => new Date(now),
    identity: {
      async verify() {
        return { providerSubject: "owner", email: "owner@example.test", displayName: "Owner" };
      },
    },
  });
  const session = await accounts.signIn({ provider: "google", assertion: "local-owner" });
  const owner = await accounts.authenticate(`Bearer ${session.sessionToken}`);
  if (!owner) throw new Error("owner fixture unavailable");
  const organization = await accounts.createOrganization({ actor: owner, name: "Billing" });
  const org = organization.id;
  const usage = { organizationId: org, currency: "USD", usedMicros: 17, availableMicros: 83 };
  const route = createControlRoutes({
    publicOrigin: "https://api.test",
    accounts,
    inventory: {} as never,
    deployments: {} as never,
    attachments: {} as never,
    migrations: {} as never,
    forms: [],
    identityProviders: [],
    ledger: {} as never,
    billing: {
      async usageSummary() {
        return usage;
      },
    } as never,
    catalog: {} as never,
    reseller: {} as never,
    tokens: {} as never,
    settlement: {} as never,
    subscriptionCustody: {
      planTable: { plans: [] },
      async read() {
        return { organizationId: org, state: "active" };
      },
    } as never,
    clock: () => new Date(now),
  } satisfies CreateControlRoutesOptions);
  const hits: {
    method: string;
    path: string;
    authorization: string | null;
    cookie: string | null;
    redirect: RequestRedirect;
  }[] = [];
  const fetcher = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    hits.push({
      method: init.method ?? "",
      path: url.pathname,
      authorization: new Headers(init.headers).get("authorization"),
      cookie: new Headers(init.headers).get("cookie"),
      redirect: init.redirect ?? "follow",
    });
    const response = await route(new Request(input, init), url);
    if (!response) throw new Error("local route unavailable");
    return response;
  };
  const issue = await route(
    new Request(`https://api.test/v1/organizations/${org}/api-keys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "hosted-read", scopes, expiresInSeconds: 3600 }),
    }),
    new URL(`https://api.test/v1/organizations/${org}/api-keys`),
  );
  expect(issue?.status).toBe(201);
  const issued = (await issue?.json()) as {
    apiKey: { id: string; createdAt: string; expiresAt: string };
    secret: string;
  };
  const secretPath = join(root, `${org}.hosted-read.secret`);
  writeFileSync(secretPath, issued.secret, { mode: 0o600 });
  const receiptPath = join(root, "mint.json");
  const receipt = {
    kind: "takoserver.org-api-key-mint@v1",
    surface: "takoserver-org-api-key",
    action: "mint",
    environment: "integration",
    commit: "a".repeat(40),
    organizationId: org,
    apiKeyId: issued.apiKey.id,
    keyName: "hosted-read",
    scopes,
    createdAt: issued.apiKey.createdAt,
    expiresAt: issued.apiKey.expiresAt,
    secretPath,
    probe: {
      url: "https://api.test/.well-known/takoserver",
      status: 200,
      openapi: { url: "https://api.test/openapi.json", status: 200 },
    },
    secretsRedacted: true,
    mutationApplied: true,
  };
  writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  const selection = {
    serverOrigin: "https://api.test",
    environment: "integration" as const,
    organizationId: org,
    keyName: "hosted-read",
    sourceCommit: "a".repeat(40),
    mintReceiptPath: receiptPath,
    secretDirectory: root,
  };
  return {
    root,
    org,
    owner,
    accounts,
    route,
    hits,
    fetcher,
    issued,
    secretPath,
    receiptPath,
    receipt,
    selection,
    now: (value: string) => {
      now = Date.parse(value);
    },
    supplier: () =>
      createIssuedOrganizationBillingReadSupplier(selection, { fetcher, now: () => new Date(now) }),
  };
}

test("real owner-issued wallet key reads only the two scoped GET routes", async () => {
  const f = await fixture();
  const result = await f.supplier().readFacts();
  expect(result.usageSummary).toMatchObject({ usageSummary: { organizationId: f.org } });
  expect(result.subscription).toMatchObject({ subscription: { organizationId: f.org } });
  expect(f.hits.map(({ path }) => path)).toEqual([
    `/v1/organizations/${f.org}/wallet/usage-summary`,
    `/v1/organizations/${f.org}/payments/subscription`,
  ]);
  expect(
    f.hits.every(
      (hit) =>
        hit.method === "GET" &&
        hit.redirect === "manual" &&
        hit.cookie === null &&
        hit.authorization === `Bearer ${f.issued.secret}`,
    ),
  ).toBe(true);
  expect(await f.supplier().apiKeyFor(f.org)).toBe(f.issued.secret);
  await expect(f.supplier().apiKeyFor("org_foreign")).rejects.toThrow(
    "issued organization billing read unavailable",
  );
  expect(f.hits).toHaveLength(2);
});

test("live revocation and missing scope refuse without retry or secret disclosure", async () => {
  const f = await fixture();
  const supplier = f.supplier();
  const revoke = await f.route(
    new Request(`https://api.test/v1/organizations/${f.org}/api-keys/${f.issued.apiKey.id}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${(await f.accounts.signIn({ provider: "google", assertion: "local-owner" })).sessionToken}`,
      },
    }),
    new URL(`https://api.test/v1/organizations/${f.org}/api-keys/${f.issued.apiKey.id}`),
  );
  expect(revoke?.status).toBe(200);
  await expect(supplier.readFacts()).rejects.toThrow(
    "issued organization billing read unavailable",
  );
  expect(f.hits).toHaveLength(1);
  expect(f.hits[0]?.method).toBe("GET");
  const absent = await fixture(["catalog:read"]);
  expect(() => absent.supplier()).toThrow("issued organization billing read unavailable");
  expect(absent.hits).toHaveLength(0);
  writeFileSync(absent.receiptPath, JSON.stringify({ ...absent.receipt, scopes: ["wallet:read"] }));
  await expect(absent.supplier().readFacts()).rejects.toThrow(
    "issued organization billing read unavailable",
  );
  expect(absent.hits).toHaveLength(1);
});

test("expiry, malformed receipt, permissions, links, BOM, and replacement fail closed", async () => {
  const f = await fixture();
  const supplier = f.supplier();
  f.now("2026-10-23T13:00:01.000Z");
  await expect(supplier.apiKeyFor(f.org)).rejects.toThrow(
    "issued organization billing read unavailable",
  );
  f.now("2026-10-23T12:00:00.000Z");
  const replacement = join(f.root, "replacement.secret");
  writeFileSync(replacement, readFileSync(f.secretPath), { mode: 0o600 });
  renameSync(replacement, f.secretPath);
  await expect(supplier.apiKeyFor(f.org)).rejects.toThrow(
    "issued organization billing read unavailable",
  );
  chmodSync(f.secretPath, 0o644);
  expect(() => f.supplier()).toThrow("issued organization billing read unavailable");
  chmodSync(f.secretPath, 0o600);
  const hardlink = join(f.root, "hardlink.secret");
  linkSync(f.secretPath, hardlink);
  expect(() => f.supplier()).toThrow("issued organization billing read unavailable");
  rmSync(hardlink);
  rmSync(f.secretPath);
  symlinkSync(f.receiptPath, f.secretPath);
  expect(() => f.supplier()).toThrow("issued organization billing read unavailable");
  rmSync(f.secretPath);
  writeFileSync(
    f.secretPath,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(f.issued.secret)]),
    { mode: 0o600 },
  );
  expect(() => f.supplier()).toThrow("issued organization billing read unavailable");
  writeFileSync(f.secretPath, f.issued.secret, { mode: 0o600 });
  writeFileSync(
    f.receiptPath,
    JSON.stringify({ ...f.receipt, apiKeyId: "key_wrong", secretPath: "/tmp/other" }),
  );
  expect(() => f.supplier()).toThrow("issued organization billing read unavailable");
  expect(f.hits).toHaveLength(0);
});

test("foreign response and transport errors are generic and no retry occurs", async () => {
  const f = await fixture();
  const supplier = createIssuedOrganizationBillingReadSupplier(f.selection, {
    now: () => new Date("2026-10-23T12:00:00.000Z"),
    fetcher: async () =>
      Response.json({ usageSummary: { organizationId: "org_foreign", secret: f.issued.secret } }),
  });
  await expect(supplier.readFacts()).rejects.toThrow(
    "issued organization billing read unavailable",
  );
  const bad = createIssuedOrganizationBillingReadSupplier(f.selection, {
    now: () => new Date("2026-10-23T12:00:00.000Z"),
    fetcher: async () => {
      throw new Error(f.issued.secret);
    },
  });
  try {
    await bad.readFacts();
  } catch (error) {
    expect(String(error)).not.toContain(f.issued.secret);
    expect(String(error)).not.toContain(f.secretPath);
  }
});

test("protected custody below a public read-only ancestor remains usable", async () => {
  const f = await fixture();
  const shared = join(f.root, "shared");
  const privateDirectory = join(shared, "private");
  mkdirSync(shared, { mode: 0o755 });
  mkdirSync(privateDirectory, { mode: 0o700 });
  const secretPath = join(privateDirectory, `${f.org}.hosted-read.secret`);
  const receiptPath = join(privateDirectory, "mint.json");
  writeFileSync(secretPath, f.issued.secret, { mode: 0o600 });
  writeFileSync(receiptPath, JSON.stringify({ ...f.receipt, secretPath }), { mode: 0o600 });
  const supplier = createIssuedOrganizationBillingReadSupplier(
    {
      ...f.selection,
      secretDirectory: privateDirectory,
      mintReceiptPath: receiptPath,
    },
    { now: () => new Date("2026-10-23T12:00:00.000Z") },
  );
  expect(await supplier.apiKeyFor(f.org)).toBe(f.issued.secret);
});

test("midflight custody drift and stalled response refuse", async () => {
  const f = await fixture();
  const changed = createIssuedOrganizationBillingReadSupplier(f.selection, {
    now: () => new Date("2026-10-23T12:00:00.000Z"),
    fetcher: async () => {
      const replacement = join(f.root, "midflight.secret");
      writeFileSync(replacement, f.issued.secret, { mode: 0o600 });
      renameSync(replacement, f.secretPath);
      return Response.json({ usageSummary: { organizationId: f.org } });
    },
  });
  await expect(changed.readFacts()).rejects.toThrow("issued organization billing read unavailable");
  writeFileSync(f.secretPath, f.issued.secret, { mode: 0o600 });
  const stalled = createIssuedOrganizationBillingReadSupplier(f.selection, {
    now: () => new Date("2026-10-23T12:00:00.000Z"),
    timeoutMs: 20,
    fetcher: async () => new Promise<Response>(() => {}),
  });
  await expect(stalled.readFacts()).rejects.toThrow("issued organization billing read unavailable");
});

test("a receipt for another Server origin cannot send its key to a retargeted origin", async () => {
  const f = await fixture();
  let sends = 0;
  expect(() =>
    createIssuedOrganizationBillingReadSupplier(
      {
        ...f.selection,
        serverOrigin: "https://attacker.example",
      },
      {
        now: () => new Date("2026-10-23T12:00:00.000Z"),
        fetcher: async () => {
          sends++;
          return Response.json({});
        },
      },
    ),
  ).toThrow("issued organization billing read unavailable");
  expect(sends).toBe(0);
});
