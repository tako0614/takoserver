import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type Accounts, createAccounts, type ExternalIdentityVerifier } from "../src/auth.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2AccountAccess } from "../src/takoform-v2/accounts.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { createTakoformV2Routes } from "../src/takoform-v2/routes.ts";
import type { V2Backend, V2Form } from "../src/takoform-v2/types.ts";

const FORM = "https://forms.example/fixture-only/key-value/1.0.0";
const BASE_URL = "https://host.example/takoform-v2";
const ROOT = "/takoform-v2";
const CURSOR_KEY = new Uint8Array(32).fill(0x5a);

const identity: ExternalIdentityVerifier = {
  async verify({ provider, assertion }) {
    return {
      providerSubject: `${provider}:${assertion}`,
      email: `${assertion}@example.com`,
      displayName: assertion,
    };
  },
};

function setup() {
  const database = new Database(":memory:");
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  const accounts = createAccounts({ sql, identity });
  const backend: V2Backend = {
    id: "fixture-only-backend",
    targetKey: "fixture-only-target",
    async execute() {
      return { kind: "complete", observed: { fixtureOnly: true }, output: {} };
    },
    async reconcile() {
      return { kind: "complete", observed: { fixtureOnly: true }, output: {} };
    },
  };
  const form: V2Form = {
    validateCreate(spec) {
      if (typeof spec.value !== "string") throw new Error("fixture spec requires a string value");
    },
    validateUpdate(_previous, spec) {
      if (typeof spec.value !== "string") throw new Error("fixture spec requires a string value");
    },
    backend,
  };
  const access = createTakoformV2AccountAccess(accounts);
  const engine = createTakoformV2Engine({
    sql,
    replayWindowSeconds: 300,
    authorize: access.authorize,
    forms: { [FORM]: form },
  });
  const router = createTakoformV2Routes(engine, {
    baseUrl: BASE_URL,
    documentation: "https://docs.example/takoform-v2",
    authenticationDocumentation: "https://docs.example/takoform-v2/authentication",
    authenticationSchemes: ["Bearer"],
    maxRequestBytes: 4_096,
    maxPageSize: 10,
    replayWindowSeconds: 300,
    cursorSigningKey: CURSOR_KEY,
    authenticate: access.authenticate,
  });
  return {
    database,
    accounts,
    access,
    engine,
    router,
  };
}

async function ownerWithOrganization(accounts: Accounts, assertion: string) {
  const { principal, sessionToken } = await accounts.signIn({ provider: "google", assertion });
  const actor = await accounts.authenticate(`Bearer ${sessionToken}`);
  if (!actor) throw new Error("fixture owner session did not authenticate");
  const organization = await accounts.createOrganization({ actor, name: `${assertion} Org` });
  return { principal, sessionToken, actor, organization };
}

async function issueKey(
  accounts: Accounts,
  actor: Awaited<ReturnType<Accounts["authenticate"]>> & {},
  organizationId: string,
  scopes: readonly ("resources:read" | "resources:write")[],
  name: string,
) {
  return await accounts.createApiKey({
    actor,
    organizationId,
    name,
    scopes,
    expiresInSeconds: 3_600,
  });
}

function request(
  path: string,
  token: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Request {
  return new Request(`https://host.example${ROOT}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
}

async function response(router: ReturnType<typeof createTakoformV2Routes>, req: Request) {
  const result = await router.fetch(req);
  if (!result) throw new Error("expected the v2 router to handle request");
  return result;
}

function createBody(space: string, name: string, value: string) {
  return JSON.stringify({ form: FORM, space, name, spec: { value } });
}

test("organization API keys and owner session share the exact stable v2 identity and replay key", async () => {
  const fixture = setup();
  const owner = await ownerWithOrganization(fixture.accounts, "owner");
  const first = await issueKey(
    fixture.accounts,
    owner.actor,
    owner.organization.id,
    ["resources:write"],
    "writer one",
  );
  const second = await issueKey(
    fixture.accounts,
    owner.actor,
    owner.organization.id,
    ["resources:write"],
    "writer two",
  );
  try {
    const writerPrincipal = await fixture.access.authenticate(request("/resources", first.secret));
    const secondPrincipal = await fixture.access.authenticate(request("/resources", second.secret));
    const sessionPrincipal = await fixture.access.authenticate(
      request("/resources", owner.sessionToken, {
        headers: { "takoform-organization": owner.organization.id },
      }),
    );
    expect(writerPrincipal).toEqual({ principal: `org:${owner.organization.id}`, access: "write" });
    expect(secondPrincipal).toEqual(writerPrincipal);
    expect(sessionPrincipal).toEqual(writerPrincipal);
    expect(
      await fixture.access.authorize(
        `org:${owner.organization.id}`,
        owner.organization.id,
        "write",
      ),
    ).toBe(true);
    expect(
      await fixture.access.authorize(`org:${owner.organization.id}`, "other-space", "read"),
    ).toBe(false);

    const key = "shared-replay-key-0001";
    const body = createBody(owner.organization.id, "shared", "one");
    const created = await response(
      fixture.router,
      request("/resources", first.secret, {
        method: "POST",
        headers: { "idempotency-key": key },
        body,
      }),
    );
    const replay = await response(
      fixture.router,
      request("/resources", second.secret, {
        method: "POST",
        headers: { "idempotency-key": key },
        body,
      }),
    );
    const sessionReplay = await response(
      fixture.router,
      request("/resources", owner.sessionToken, {
        method: "POST",
        headers: { "idempotency-key": key, "takoform-organization": owner.organization.id },
        body,
      }),
    );
    expect(created.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(sessionReplay.status).toBe(202);
    const [createdOperation, replayOperation, sessionOperation] = (await Promise.all([
      created.json(),
      replay.json(),
      sessionReplay.json(),
    ])) as { id: string; resourceUid: string }[];
    expect(replayOperation?.id).toBe(createdOperation?.id);
    expect(sessionOperation?.id).toBe(createdOperation?.id);
    const resource = await response(
      fixture.router,
      request(`/resources/${createdOperation?.resourceUid}`, owner.sessionToken, {
        headers: { "takoform-organization": owner.organization.id },
      }),
    );
    expect(resource.status).toBe(200);
    expect(await resource.json()).toMatchObject({ space: owner.organization.id, name: "shared" });
  } finally {
    fixture.database.close();
  }
});

test("read-only keys can read but cannot create, update, delete, or replay mutations", async () => {
  const fixture = setup();
  const owner = await ownerWithOrganization(fixture.accounts, "reader-owner");
  const writer = await issueKey(
    fixture.accounts,
    owner.actor,
    owner.organization.id,
    ["resources:write"],
    "writer",
  );
  const reader = await issueKey(
    fixture.accounts,
    owner.actor,
    owner.organization.id,
    ["resources:read"],
    "reader",
  );
  try {
    const created = await response(
      fixture.router,
      request("/resources", writer.secret, {
        method: "POST",
        headers: { "idempotency-key": "reader-target-create-001" },
        body: createBody(owner.organization.id, "target", "one"),
      }),
    );
    const accepted = (await created.json()) as { id: string; resourceUid: string };
    expect(created.status).toBe(202);
    expect(
      (await response(fixture.router, request(`/resources/${accepted.resourceUid}`, reader.secret)))
        .status,
    ).toBe(200);

    const denied = await Promise.all([
      response(
        fixture.router,
        request("/resources", reader.secret, {
          method: "POST",
          headers: { "idempotency-key": "reader-create-denied-001" },
          body: createBody(owner.organization.id, "denied", "two"),
        }),
      ),
      response(
        fixture.router,
        request(`/resources/${accepted.resourceUid}`, reader.secret, {
          method: "PUT",
          headers: {
            "idempotency-key": "reader-update-denied-001",
            "takoform-expected-generation": "1",
          },
          body: JSON.stringify({ spec: { value: "two" } }),
        }),
      ),
      response(
        fixture.router,
        request(`/resources/${accepted.resourceUid}`, reader.secret, {
          method: "DELETE",
          headers: {
            "idempotency-key": "reader-delete-denied-001",
            "takoform-expected-generation": "1",
          },
        }),
      ),
      response(
        fixture.router,
        request("/resources", reader.secret, {
          method: "POST",
          headers: { "idempotency-key": "reader-target-create-001" },
          body: createBody(owner.organization.id, "target", "one"),
        }),
      ),
    ]);
    expect(denied.map((item) => item.status)).toEqual([403, 403, 403, 403]);
    expect(
      await (
        await response(fixture.router, request(`/resources/${accepted.resourceUid}`, reader.secret))
      ).json(),
    ).toMatchObject({ generation: 1, spec: { value: "one" } });
  } finally {
    fixture.database.close();
  }
});

test("replacing or revoking a key changes only that credential, not organization v2 identity", async () => {
  const fixture = setup();
  const owner = await ownerWithOrganization(fixture.accounts, "replace-owner");
  const first = await issueKey(
    fixture.accounts,
    owner.actor,
    owner.organization.id,
    ["resources:write"],
    "first",
  );
  const successor = await issueKey(
    fixture.accounts,
    owner.actor,
    owner.organization.id,
    ["resources:write"],
    "successor",
  );
  try {
    const created = await response(
      fixture.router,
      request("/resources", first.secret, {
        method: "POST",
        headers: { "idempotency-key": "key-replacement-replay-001" },
        body: createBody(owner.organization.id, "survives", "one"),
      }),
    );
    const accepted = (await created.json()) as { id: string; resourceUid: string };
    await fixture.accounts.revokeApiKey({
      actor: owner.actor,
      organizationId: owner.organization.id,
      apiKeyId: first.apiKey.id,
    });
    expect(await fixture.access.authenticate(request("/resources", first.secret))).toBeNull();
    const successorReplay = await response(
      fixture.router,
      request("/resources", successor.secret, {
        method: "POST",
        headers: { "idempotency-key": "key-replacement-replay-001" },
        body: createBody(owner.organization.id, "survives", "one"),
      }),
    );
    expect(successorReplay.status).toBe(202);
    expect((await successorReplay.json()).id).toBe(accepted.id);
    const ownerRead = await response(
      fixture.router,
      request(`/resources/${accepted.resourceUid}`, owner.sessionToken, {
        headers: { "takoform-organization": owner.organization.id },
      }),
    );
    expect(ownerRead.status).toBe(200);
  } finally {
    fixture.database.close();
  }
});

test("API keys cannot select another organization, and owner sessions require explicit exact ownership", async () => {
  const fixture = setup();
  const owner = await ownerWithOrganization(fixture.accounts, "isolation-owner");
  const otherOwner = await ownerWithOrganization(fixture.accounts, "isolation-other");
  const key = await issueKey(
    fixture.accounts,
    owner.actor,
    owner.organization.id,
    ["resources:write"],
    "bound",
  );
  try {
    expect(await fixture.access.authenticate(request("/resources", owner.sessionToken))).toBeNull();
    expect(
      await fixture.access.authenticate(
        request("/resources", owner.sessionToken, {
          headers: { "takoform-organization": otherOwner.organization.id },
        }),
      ),
    ).toBeNull();
    expect(
      await fixture.access.authenticate(
        request("/resources", owner.sessionToken, {
          headers: { "takoform-organization": owner.organization.id.replace("org_", "ORG_") },
        }),
      ),
    ).toBeNull();

    const own = await response(
      fixture.router,
      request("/resources", key.secret, {
        method: "POST",
        headers: {
          "idempotency-key": "organization-isolation-own-001",
          "takoform-organization": otherOwner.organization.id,
        },
        body: createBody(owner.organization.id, "own", "one"),
      }),
    );
    expect(own.status).toBe(202);
    const foreign = await response(
      fixture.router,
      request("/resources", key.secret, {
        method: "POST",
        headers: {
          "idempotency-key": "organization-isolation-other-001",
          "takoform-organization": otherOwner.organization.id,
        },
        body: createBody(otherOwner.organization.id, "foreign", "two"),
      }),
    );
    expect(foreign.status).toBe(403);
  } finally {
    fixture.database.close();
  }
});

test("concurrent credentials retain their own authority without cross-request leakage", async () => {
  const fixture = setup();
  const owner = await ownerWithOrganization(fixture.accounts, "concurrent-owner");
  const writer = await issueKey(
    fixture.accounts,
    owner.actor,
    owner.organization.id,
    ["resources:write"],
    "writer",
  );
  const reader = await issueKey(
    fixture.accounts,
    owner.actor,
    owner.organization.id,
    ["resources:read"],
    "reader",
  );
  try {
    const results = await Promise.all([
      response(
        fixture.router,
        request("/resources", writer.secret, {
          method: "POST",
          headers: { "idempotency-key": "concurrent-writer-create-001" },
          body: createBody(owner.organization.id, "writer", "one"),
        }),
      ),
      response(
        fixture.router,
        request("/resources", reader.secret, {
          method: "POST",
          headers: { "idempotency-key": "concurrent-reader-create-001" },
          body: createBody(owner.organization.id, "reader", "two"),
        }),
      ),
    ]);
    expect(results.map((item) => item.status)).toEqual([202, 403]);
    const listing = await response(
      fixture.router,
      request(`/resources?space=${encodeURIComponent(owner.organization.id)}`, reader.secret),
    );
    expect(listing.status).toBe(200);
    expect(((await listing.json()) as { items: unknown[] }).items).toHaveLength(1);
  } finally {
    fixture.database.close();
  }
});
