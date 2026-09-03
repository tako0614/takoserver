import { expect, test } from "bun:test";
import type { Accounts } from "../src/auth.ts";
import { createControlRoutes, type ResourceInventory } from "../src/control.ts";

const ORGANIZATION_ID = "org_01";

function fixture() {
  const spaces: (string | undefined)[] = [];
  const inventory: ResourceInventory = {
    async listResources(_tenantId, options) {
      spaces.push(options.space);
      return { resources: [], cursor: null };
    },
    async resourceByUid() {
      return null;
    },
    async listOperations() {
      return [];
    },
  };
  const route = createControlRoutes({
    accounts: {
      async authenticate() {
        return {
          hostPrincipalId: "host-principal-01",
          principalId: "principal_01",
          organizationId: ORGANIZATION_ID,
          scopes: ["resources:read"],
          kind: "api_key",
        } as const;
      },
    } as Pick<Accounts, "authenticate"> as Accounts,
    inventory,
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
    clock: () => new Date("2026-09-03T00:00:00Z"),
  });
  const list = async (space: string): Promise<Response> => {
    const url = new URL(
      `https://api.takoserver.test/v1/organizations/${ORGANIZATION_ID}/resources`,
    );
    url.searchParams.set("space", space);
    const response = await route(
      new Request(url, { headers: { authorization: "Bearer reader" } }),
      url,
    );
    if (!response) throw new TypeError("resource-list route was not handled");
    return response;
  };
  return { list, spaces };
}

test("resource inventory accepts the complete stable Space grammar", async () => {
  const { list, spaces } = fixture();
  const values = [
    "tenant:tsh_2IS0Th3vfHv-B1kAAJfyNKHM79GJ0SxuZdRM147QfvI",
    `tenant:${"界".repeat(248)}`,
    "😀".repeat(255),
  ];
  for (const value of values) expect((await list(value)).status).toBe(200);
  expect(spaces).toEqual(values);
});

test("resource inventory refuses a non-Host Space before querying storage", async () => {
  const { list, spaces } = fixture();
  for (const value of [
    "",
    "x".repeat(256),
    "😀".repeat(256),
    "tenant/child",
    "tenant:\u0000child",
    "tenant:\u0085child",
    " leading",
    "trailing ",
  ]) {
    const response = await list(value);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_argument" } });
  }
  expect(spaces).toEqual([]);
});
