import { expect, test } from "bun:test";
import { keyUsage } from "../console/src/key-scopes.ts";
import { createAccounts, type ExternalIdentityVerifier } from "../src/auth.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2AccountAccess } from "../src/takoform-v2/accounts.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { createTakoformV2Routes } from "../src/takoform-v2/routes.ts";
import { migrateSqliteDatabase } from "./helpers/migrated-database.ts";

const V2 = "https://host.example/apis/forms.takoform.com/v2";

const identity: ExternalIdentityVerifier = {
  async verify({ provider, assertion }) {
    return {
      providerSubject: `${provider}:${assertion}`,
      email: `${assertion}@example.com`,
      displayName: assertion,
    };
  },
};

/** Runs the request the console's snippet makes, as the shell would expand it. */
function snippetRequest(snippet: string, key: string): Request {
  const v2 = /^V2='([^']+)'$/mu.exec(snippet)?.[1];
  const org = /^ORG='([^']+)'$/mu.exec(snippet)?.[1];
  const path = /curl -sS -G "\$V2(\/[^"]*)" --data-urlencode "space=\$ORG"/u.exec(snippet)?.[1];
  if (!v2 || !org || !path) throw new Error(`unexpected snippet:\n${snippet}`);
  const url = new URL(`${v2}${path}`);
  url.searchParams.set("space", org);
  return new Request(url, { headers: { authorization: `Bearer ${key}` } });
}

test("the console's first request with a new key is one Host API v2 answers", async () => {
  const database = migrateSqliteDatabase();
  try {
    const sql = createSqliteSql(database);
    const accounts = createAccounts({ sql, identity });
    const access = createTakoformV2AccountAccess(accounts);
    const engine = createTakoformV2Engine({
      sql,
      replayWindowSeconds: 300,
      authorize: access.authorize,
      forms: {},
    });
    const router = createTakoformV2Routes(engine, {
      baseUrl: V2,
      documentation: "https://docs.example/takoform-v2",
      authenticationDocumentation: "https://docs.example/takoform-v2/authentication",
      authenticationSchemes: ["Bearer"],
      maxRequestBytes: 4_096,
      maxPageSize: 10,
      replayWindowSeconds: 300,
      cursorSigningKey: new Uint8Array(32).fill(0x5a),
      authenticate: access.authenticate,
    });
    const { sessionToken } = await accounts.signIn({ provider: "google", assertion: "owner" });
    const actor = await accounts.authenticate(`Bearer ${sessionToken}`);
    if (!actor) throw new Error("fixture owner session did not authenticate");
    const organization = await accounts.createOrganization({ actor, name: "Owner Org" });

    for (const scopes of [["resources:read"], ["resources:write"]] as const) {
      const { secret } = await accounts.createApiKey({
        actor,
        organizationId: organization.id,
        name: scopes[0],
        scopes,
        expiresInSeconds: 3_600,
      });
      const snippet = keyUsage(V2, organization.id, scopes);
      if (snippet === null) throw new Error(`no snippet for ${scopes[0]}`);
      const listing = await router.fetch(snippetRequest(snippet, secret));
      expect(listing?.status).toBe(200);
      expect(await listing?.json()).toMatchObject({ items: [] });
    }
  } finally {
    database.close();
  }
});
