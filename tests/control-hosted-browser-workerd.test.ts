import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { assertOrgTopUpSchema } from "../src/org-top-up.ts";
import { createD1Sql, type D1DatabaseLike } from "../src/sql-d1.ts";
import { miniflareServiceBinding } from "./helpers/miniflare-service-binding.ts";
import { SHARED_AUTH_TEST_ONLY_DDL } from "./helpers/shared-auth-session-fixture.ts";
import {
  createSharedSessionTestIssuer,
  SESSION_TEST_ACCOUNT,
  SESSION_TEST_CONFIG,
  SESSION_TEST_CONSOLE,
  SESSION_TEST_PERSONAL,
} from "./helpers/shared-auth-session-issuer.ts";

const NOW = 1_800_000_000_000;
const PRINCIPAL = "native-consumer-principal";
const ORGANIZATION = "native-consumer-organization";
const WORKSPACE_REF = "native-consumer-workspace-ref";
const REFERENCE = `takosumi:topup:${"a".repeat(64)}`;

test("native prepare awaits the actual current selection and records the exact TopUp original receipt", async () => {
  const f = await fixture();
  try {
    const before = await f.metadata("0");
    expect(before.status).toBe(200);
    const metadata = (await before.json()) as {
      continuation: {
        continuationRef: string;
        kind: string;
        workspaceId: string;
        workspaceRef: string;
        organizationId: string;
      };
    };
    expect(metadata.continuation).toMatchObject({
      continuationRef: "0".repeat(64),
      kind: "view",
      workspaceId: SESSION_TEST_PERSONAL.id,
      workspaceRef: WORKSPACE_REF,
      organizationId: ORGANIZATION,
    });
    const choice = {
      kind: "topup",
      amountMinor: 125,
      checkoutConsent: "interactive-checkout",
    } as const;
    const prepared = await f.prepare("0", choice);
    expect(prepared.status).toBe(200);
    const afterPrepare = (await prepared.json()) as {
      continuation: {
        kind: string;
        workspaceId: string;
        workspaceRef: string;
        organizationId: string;
        operation: { path: string; body: unknown };
      };
    };
    expect(afterPrepare.continuation).toMatchObject({
      kind: "payment",
      workspaceId: metadata.continuation.workspaceId,
      workspaceRef: metadata.continuation.workspaceRef,
      organizationId: metadata.continuation.organizationId,
    });
    const metadataReadback = await f.metadata("0");
    expect(metadataReadback.status).toBe(200);
    const readbackMetadata = (await metadataReadback.json()) as {
      continuation: {
        continuationRef: string;
        kind: string;
        workspaceId: string;
        workspaceRef: string;
        organizationId: string;
      };
    };
    expect(readbackMetadata.continuation).toMatchObject({
      continuationRef: metadata.continuation.continuationRef,
      kind: "payment",
      workspaceId: metadata.continuation.workspaceId,
      workspaceRef: metadata.continuation.workspaceRef,
      organizationId: metadata.continuation.organizationId,
    });
    const hostedState = await f.hostedState();
    expect(hostedState.callback).toMatchObject({
      continuationRef: "0".repeat(64),
      scope: {
        continuationRef: metadata.continuation.continuationRef,
        workspaceId: metadata.continuation.workspaceId,
        workspaceRef: metadata.continuation.workspaceRef,
        organizationId: metadata.continuation.organizationId,
      },
      choice,
    });
    const preparedOriginal = hostedState.preparedOriginal as Record<string, unknown>;
    expect(preparedOriginal.scope).toEqual(hostedState.callback?.scope);
    expect(preparedOriginal.scope).toMatchObject({
      continuationRef: metadata.continuation.continuationRef,
      canonicalAccountId: SESSION_TEST_ACCOUNT,
      workspaceId: metadata.continuation.workspaceId,
      workspaceRef: metadata.continuation.workspaceRef,
      organizationId: metadata.continuation.organizationId,
    });
    expect(preparedOriginal.action).toMatchObject({
      family: "topup",
      request: {
        amountMinor: 125,
        checkoutConsent: "interactive-checkout",
      },
      claim: { amountMinor: 125 },
    });
    expect(await f.commands()).toMatchObject({ results: [] });
    expect(await f.processor()).toEqual({ create: 0, read: 0, recover: 0 });
    expect(f.records).toEqual([]);

    const operation = afterPrepare.continuation.operation;
    const checkout = await f.selected(operation.path, "POST", "0", operation.body);
    expect(checkout.status).toBe(201);
    expect(((await checkout.json()) as { checkout: unknown }).checkout).toEqual({
      url: "https://checkout.stripe.com/c/pay/cs_native_fixture",
    });
    const rows = await f.commands();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      org_id: ORGANIZATION,
      reference: REFERENCE,
      state: "ready",
    });
    expect(JSON.parse(rows.results[0]?.command_json ?? "null")).toMatchObject({
      organizationId: ORGANIZATION,
      reference: REFERENCE,
      amountMinor: 125,
      financialRealm: "local-fixture-only",
    });
    expect(await f.processor()).toEqual({ create: 1, read: 1, recover: 0 });
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toEqual({
      selector: "0".repeat(64),
      original: preparedOriginal,
      outcome: {
        kind: "topup",
        receipt: {
          reference: REFERENCE,
          state: "ready",
          checkout: { url: "https://checkout.stripe.com/c/pay/cs_native_fixture" },
        },
      },
    });
    const recorded = f.records[0];
    if (!recorded?.original) throw new Error("native original receipt was not recorded");
    expect(
      (
        recorded.original as {
          action: { request: { amountMinor: number }; claim: { amountMinor: number } };
        }
      ).action,
    ).toMatchObject({
      request: { amountMinor: 125 },
      claim: { amountMinor: 125 },
    });
    expect((await f.hostedState()).readCallback).toEqual({
      callbackCount: 0,
      callbackRejected: false,
      scope: null,
    });
  } finally {
    await f.runtime.dispose();
  }
}, 30_000);

test("only continuation-selected financial GETs use the request-bound Owner read callback", async () => {
  const f = await fixture();
  try {
    expect((await f.metadata("0")).status).toBe(200);
    expect((await f.hostedState()).readCallback).toMatchObject({ callbackCount: 0 });

    const checkoutReceipt = `/v1/organizations/${ORGANIZATION}/wallet/checkout/${REFERENCE}`;
    const selectedGet = await f.selectedGet(checkoutReceipt, "a");
    // No local receipt was created; reaching its ordinary 404 proves that the
    // native current-owner callback completed before the local read route.
    expect(selectedGet.status).toBe(404);
    expect((await f.hostedState()).readCallback).toMatchObject({
      callbackCount: 1,
      callbackRejected: false,
      scope: {
        continuationRef: "a".repeat(64),
        canonicalAccountId: SESSION_TEST_ACCOUNT,
        organizationId: ORGANIZATION,
      },
    });

    const mismatched = await f.selectedGet(checkoutReceipt, "1");
    expect(mismatched.status).toBe(503);
    expect((await f.hostedState()).readCallback).toMatchObject({
      callbackCount: 2,
      callbackRejected: true,
      scope: { organizationId: "different-native-organization" },
    });

    // Existing metadata POST preparation remains on the one-argument read.
    const prepare = await f.prepare("0", {
      kind: "topup",
      amountMinor: 125,
      checkoutConsent: "interactive-checkout",
    });
    expect(prepare.status).toBe(200);
    expect((await f.hostedState()).readCallback).toMatchObject({ callbackCount: 2 });
  } finally {
    await f.runtime.dispose();
  }
}, 30_000);

test("native prepare receiver cannot substitute a different live selection scope", async () => {
  const f = await fixture();
  try {
    const response = await f.prepare("1", {
      kind: "topup",
      amountMinor: 125,
      checkoutConsent: "interactive-checkout",
    });
    expect(response.status).toBe(503);
    expect(await f.hostedState()).toMatchObject({
      callback: {
        continuationRef: "1".repeat(64),
        scope: { organizationId: "different-native-organization" },
        choice: null,
      },
      callbackAttempted: true,
      callbackRejected: true,
    });
    const readback = await f.metadata("1");
    expect(readback.status).toBe(200);
    const readbackBody = (await readback.json()) as {
      continuation: {
        continuationRef: string;
        kind: string;
        workspaceId: string;
        workspaceRef: string;
        organizationId: string;
      };
    };
    expect(readbackBody.continuation).toMatchObject({
      continuationRef: "1".repeat(64),
      kind: "view",
      workspaceId: SESSION_TEST_PERSONAL.id,
      workspaceRef: WORKSPACE_REF,
      organizationId: ORGANIZATION,
    });
    expect(await f.commands()).toMatchObject({ results: [] });
    expect(await f.processor()).toEqual({ create: 0, read: 0, recover: 0 });
    expect(f.records).toEqual([]);
  } finally {
    await f.runtime.dispose();
  }
}, 30_000);

function cookie(response: { headers: { getSetCookie(): string[] } }, name: string): string {
  const value = response.headers
    .getSetCookie()
    .map((item) => item.split(";")[0] ?? "")
    .find((item) => item.startsWith(`${name}=`));
  if (!value || value === `${name}=`) throw new Error(`missing ${name}`);
  return value;
}

async function fixture() {
  const issuer = await createSharedSessionTestIssuer(() => NOW);
  issuer.control.personalBillingOrganization = {
    workspaceId: SESSION_TEST_PERSONAL.id,
    workspaceRef: WORKSPACE_REF,
    organizationId: ORGANIZATION,
  };
  const built = await Bun.build({
    entrypoints: [new URL("./fixtures/control-hosted-browser-worker.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    minify: false,
    external: ["cloudflare:workers"],
  });
  const output = built.outputs[0];
  if (!built.success || built.outputs.length !== 1 || !output)
    throw new Error(`native HTTP consumer build failed: ${built.logs.join("\n")}`);
  const contents = await output.text();
  let databaseForRevocation: Awaited<ReturnType<Miniflare["getD1Database"]>> | undefined;
  let revocations = 0;
  const records: { selector: string; original?: unknown; outcome: unknown }[] = [];
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "native-consumer-caller",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents } },
          },
          env: {
            AUTH_DB: { type: "d1", id: "native-consumer-d1" },
            ISSUER: { type: "fetcher", handler: issuer.send },
            HOSTED: miniflareServiceBinding("worker", "native-consumer-hosted", "Hosted"),
          },
          triggers: [],
        },
      },
      {
        config: {
          name: "native-consumer-hosted",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents } },
          },
          env: {
            REVOKER: {
              type: "fetcher",
              handler: async () => {
                if (!databaseForRevocation) throw new Error("local D1 is not ready");
                await databaseForRevocation
                  .prepare(
                    "UPDATE org_memberships SET role = 'member' WHERE org_id = ? AND principal_id = ?",
                  )
                  .bind(ORGANIZATION, PRINCIPAL)
                  .run();
                revocations++;
                return new Response(null, { status: 204 });
              },
            },
            EVENTS: {
              type: "fetcher",
              handler: async (request: Request) => {
                records.push((await request.json()) as (typeof records)[number]);
                return new Response(null, { status: 204 });
              },
            },
          },
          triggers: [],
        },
      },
    ],
  });
  try {
    databaseForRevocation = await runtime.getD1Database("AUTH_DB", "native-consumer-caller");
    const database = databaseForRevocation.withSession("first-primary");
    for (const ddl of SHARED_AUTH_TEST_ONLY_DDL) await database.prepare(ddl).run();
    await database
      .prepare(`CREATE TABLE principals (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_subject TEXT NOT NULL,
      email TEXT NOT NULL, display_name TEXT NOT NULL, created_at TEXT NOT NULL
    )`)
      .run();
    await database
      .prepare(`CREATE TABLE orgs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_principal_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`)
      .run();
    await database
      .prepare(`CREATE TABLE org_memberships (
      org_id TEXT NOT NULL, principal_id TEXT NOT NULL, role TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY (org_id, principal_id)
    )`)
      .run();
    await database
      .prepare("INSERT INTO principals VALUES (?,'shared-account',?,'','',?)")
      .bind(PRINCIPAL, `${PRINCIPAL}-binding`, new Date(NOW).toISOString())
      .run();
    await database
      .prepare("INSERT INTO orgs VALUES (?,'Owned',?,?)")
      .bind(ORGANIZATION, PRINCIPAL, new Date(NOW).toISOString())
      .run();
    await database
      .prepare("INSERT INTO org_memberships VALUES (?,?,'owner',?)")
      .bind(ORGANIZATION, PRINCIPAL, new Date(NOW).toISOString())
      .run();
    // Use the exact owning 0099 SQL, including command immutability guards.
    const migration = MIGRATIONS.find((item) => item.name === "0099_hosted_billing_extensions.sql");
    if (!migration) throw new Error("missing owning top-up migration");
    for (const pattern of [
      /CREATE TABLE stripe_top_up_commands\s*\([\s\S]*?\n\);/u,
      /CREATE UNIQUE INDEX stripe_top_up_pending_org\b[\s\S]*?;/u,
      /CREATE TRIGGER stripe_top_up_command_immutable\b[\s\S]*?\bEND\s*;/u,
      /CREATE TRIGGER stripe_top_up_commands_no_delete\b[\s\S]*?\bEND\s*;/u,
    ]) {
      const ddl = migration.sql.match(pattern)?.[0];
      if (!ddl) throw new Error("missing owning top-up DDL");
      await database.prepare(ddl).run();
    }
    await assertOrgTopUpSchema(
      createD1Sql(database as unknown as D1DatabaseLike, {
        acknowledgement: "explicit-d1-result",
      }),
    );
    const worker = await runtime.getWorker("native-consumer-caller");
    const send = (
      path: string,
      init: { method?: string; headers?: Record<string, string>; body?: string } = {},
    ) =>
      worker.fetch(`${SESSION_TEST_CONFIG.publicOrigin}${path}`, { redirect: "manual", ...init });
    const login = await send("/auth/oidc/login");
    if (login.status !== 303) throw new Error(`native login failed: ${login.status}`);
    const callback = new URL(issuer.authorize(login.headers.get("location") ?? ""));
    const signed = await send(callback.pathname + callback.search, {
      headers: { cookie: cookie(login, "__Host-takoserver_oidc_attempt") },
    });
    if (signed.status !== 303) throw new Error(`native callback failed: ${signed.status}`);
    const browserCookie = cookie(signed, "__Host-takoserver_shared_session");
    return {
      runtime,
      database,
      records,
      revocations: () => revocations,
      metadata(selector: "0" | "1") {
        return send(`/v1/billing/hosted-continuations/${selector.repeat(64)}`, {
          method: "GET",
          headers: { cookie: browserCookie, "x-test-origin": SESSION_TEST_CONSOLE },
        });
      },
      prepare(selector: "0" | "1", body: unknown) {
        return send(`/v1/billing/hosted-continuations/${selector.repeat(64)}`, {
          method: "POST",
          headers: {
            cookie: browserCookie,
            "x-test-origin": SESSION_TEST_CONSOLE,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      },
      selected(path: string, method: string, selector: "0" | "1", body: unknown) {
        return send(path, {
          method,
          headers: {
            cookie: browserCookie,
            "x-test-origin": SESSION_TEST_CONSOLE,
            "Takoserver-Billing-Continuation": `hosted-browser-v1.${selector.repeat(64)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      },
      selectedGet(path: string, selector: "a" | "1") {
        return send(path, {
          method: "GET",
          headers: {
            cookie: browserCookie,
            "x-test-origin": SESSION_TEST_CONSOLE,
            "Takoserver-Billing-Continuation": `hosted-browser-v1.${selector.repeat(64)}`,
          },
        });
      },
      async hostedState() {
        const response = await send("/test/hosted");
        return (await response.json()) as {
          callback: {
            continuationRef: string;
            scope: Record<string, unknown>;
            choice: unknown;
          } | null;
          callbackAttempted: boolean;
          callbackRejected: boolean;
          readCallback: {
            callbackCount: number;
            callbackRejected: boolean;
            scope: Record<string, unknown> | null;
          };
          preparedOriginal: Record<string, unknown> | null;
        };
      },
      claim(kind: "a" | "b" | "c" | "d" | "e" | "f") {
        return send(`/v1/organizations/${ORGANIZATION}/wallet/checkout`, {
          method: "POST",
          headers: {
            cookie: browserCookie,
            "x-test-origin": SESSION_TEST_CONSOLE,
            "Takoserver-Billing-Continuation": `hosted-browser-v1.${kind.repeat(64)}`,
            "content-type": "application/json",
            ...(kind === "f" ? { "x-test-unknown-ack": "yes" } : {}),
          },
          body: JSON.stringify({ reference: REFERENCE, amountMinor: 50 }),
        });
      },
      async processor() {
        const response = await send("/test/processor");
        return (await response.json()) as { create: number; read: number; recover: number };
      },
      async commands() {
        const response = await send("/test/topup-command-readback", { method: "POST" });
        if (!response.ok) throw new Error(`native command readback failed: ${response.status}`);
        return (await response.json()) as {
          results: {
            org_id: string;
            reference: string;
            state: string;
            command_json: string;
            dispatched_at: string | null;
          }[];
        };
      },
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

test("native selected Console request reaches real TopUp command and same-original receipt", async () => {
  const f = await fixture();
  try {
    const response = await f.claim("a");
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      checkout: { url: "https://checkout.stripe.com/c/pay/cs_native_fixture" },
    });
    const rows = await f.commands();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      org_id: ORGANIZATION,
      reference: REFERENCE,
      state: "ready",
    });
    expect(JSON.parse(rows.results[0]?.command_json ?? "null")).toMatchObject({
      organizationId: ORGANIZATION,
      reference: REFERENCE,
      amountMinor: 50,
      financialRealm: "local-fixture-only",
    });
    expect(await f.processor()).toMatchObject({ create: 1, read: 1 });
    expect(f.records).toEqual([
      {
        selector: "a".repeat(64),
        outcome: {
          kind: "topup",
          receipt: {
            reference: REFERENCE,
            state: "ready",
            checkout: { url: "https://checkout.stripe.com/c/pay/cs_native_fixture" },
          },
        },
      },
    ]);
    expect((await f.hostedState()).readCallback).toEqual({
      callbackCount: 0,
      callbackRejected: false,
      scope: null,
    });
  } finally {
    await f.runtime.dispose();
  }
}, 30_000);

test("accepted history, unknown claim, and view deny before local command or processor effect", async () => {
  for (const [kind, status] of [
    ["b", 409],
    ["c", 503],
    ["d", 400],
  ] as const) {
    const f = await fixture();
    try {
      const response = await f.claim(kind);
      expect(response.status).toBe(status);
      expect(response.headers.get("x-fixture-command-count")).toBe("0");
      expect(response.headers.get("x-fixture-processor-create")).toBe("0");
      expect(response.headers.get("x-fixture-processor-read")).toBe("0");
      expect(response.headers.get("x-fixture-processor-recover")).toBe("0");
      expect(f.records).toEqual([]);
    } finally {
      await f.runtime.dispose();
    }
  }
}, 30_000);

test("Owner revoked after claim but before effect cannot begin a TopUp", async () => {
  const f = await fixture();
  try {
    expect((await f.claim("e")).status).toBe(503);
    expect(f.revocations()).toBe(1);
    expect((await f.commands()).results).toEqual([]);
    expect(await f.processor()).toEqual({ create: 0, read: 0, recover: 0 });
    expect(f.records).toEqual([]);
    const owner = await f.database
      .prepare("SELECT role FROM org_memberships WHERE org_id = ?")
      .bind(ORGANIZATION)
      .first<{ role: string }>();
    expect(owner?.role).toBe("member");
  } finally {
    await f.runtime.dispose();
  }
}, 30_000);

test("unknown processor ACK retains the exact dispatched command with no automatic second effect", async () => {
  const f = await fixture();
  try {
    const first = await f.claim("f");
    expect(first.status).toBe(503);
    expect(first.headers.get("x-fixture-command-count")).toBe("1");
    const firstRowBytes = first.headers.get("x-fixture-original-row");
    expect(firstRowBytes).not.toBeNull();
    const firstRow = JSON.parse(firstRowBytes ?? "null") as Record<string, unknown>;
    expect(firstRow).toMatchObject({
      org_id: ORGANIZATION,
      reference: REFERENCE,
      state: "pending",
    });
    expect(firstRow.dispatched_at).not.toBeNull();
    expect(typeof firstRow.fingerprint).toBe("string");
    expect(typeof firstRow.stripe_key).toBe("string");
    expect(JSON.parse(String(firstRow.command_json))).toMatchObject({
      organizationId: ORGANIZATION,
      reference: REFERENCE,
      amountMinor: 50,
    });
    const second = await f.claim("f");
    expect(second.status).toBe(409);
    expect(second.headers.get("x-fixture-command-count")).toBe("1");
    expect(second.headers.get("x-fixture-original-row")).toBe(firstRowBytes);
    for (const response of [first, second]) {
      expect(response.headers.get("x-fixture-processor-create")).toBe("1");
      expect(response.headers.get("x-fixture-processor-read")).toBe("0");
      expect(response.headers.get("x-fixture-processor-recover")).toBe("0");
    }
    expect(f.records).toEqual([{ selector: "f".repeat(64), outcome: { kind: "unknown" } }]);
  } finally {
    await f.runtime.dispose();
  }
}, 30_000);
