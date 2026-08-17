import { describe, expect, test } from "bun:test";
import {
  type D1DatabasePort,
  D1GrantKeyStore,
  D1GrantReplayStore,
  D1ResourceRegistry,
  type D1StatementPort,
  DurableStateError,
} from "../src/state-store.ts";

interface RecordedStatement {
  readonly sql: string;
  values: unknown[];
}

function scriptedDatabase(options: {
  readonly rows?: readonly Record<string, unknown>[];
  readonly changes?: readonly number[];
}): { readonly database: D1DatabasePort; readonly statements: RecordedStatement[] } {
  const statements: RecordedStatement[] = [];
  const changes = [...(options.changes ?? [])];
  return {
    statements,
    database: {
      prepare(sql: string): D1StatementPort {
        const recorded: RecordedStatement = { sql, values: [] };
        statements.push(recorded);
        return {
          bind(...values: unknown[]): D1StatementPort {
            recorded.values = values;
            return this;
          },
          async all() {
            return { results: [...(options.rows ?? [])], meta: { changes: 0 } };
          },
          async run() {
            return { results: [], meta: { changes: changes.shift() ?? 0 } };
          },
        };
      },
    },
  };
}

describe("D1 durable runtime state", () => {
  test("consumes a replay identifier atomically with bounded D1 statements", async () => {
    const fake = scriptedDatabase({ changes: [2, 1, 0, 0] });
    const store = new D1GrantReplayStore(fake.database);
    const input = {
      grantId: "grant_durable_replay_001",
      expiresAtEpochSeconds: 1_800_000_060,
      nowEpochSeconds: 1_800_000_000,
    };

    await expect(store.consume(input)).resolves.toBe(true);
    await expect(store.consume(input)).resolves.toBe(false);

    expect(fake.statements.map((statement) => statement.sql)).toEqual([
      expect.stringContaining("DELETE FROM runtime_grant_replays"),
      expect.stringContaining("INSERT OR IGNORE INTO runtime_grant_replays"),
      expect.stringContaining("DELETE FROM runtime_grant_replays"),
      expect.stringContaining("INSERT OR IGNORE INTO runtime_grant_replays"),
    ]);
    expect(fake.statements.every((statement) => statement.values.length <= 100)).toBe(true);
    expect(fake.statements[1]?.values).toEqual([
      "grant_durable_replay_001",
      1_800_000_060,
      1_800_000_000,
    ]);
  });

  test("loads bounded Ed25519 verification keys without retaining private material", async () => {
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const fake = scriptedDatabase({
      rows: [
        {
          key_id: "runtime-key-2026-08",
          public_jwk: JSON.stringify(publicJwk),
        },
      ],
    });

    const loaded = await new D1GrantKeyStore(fake.database).loadActiveKeys();
    expect([...loaded.keys()]).toEqual(["runtime-key-2026-08"]);
    const loadedKey = loaded.get("runtime-key-2026-08");
    if (!loadedKey) throw new Error("expected loaded verification key");
    const signature = await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      new TextEncoder().encode("bounded-key-load"),
    );
    await expect(
      crypto.subtle.verify(
        "Ed25519",
        loadedKey,
        signature,
        new TextEncoder().encode("bounded-key-load"),
      ),
    ).resolves.toBe(true);
    expect(fake.statements).toHaveLength(1);
    expect(fake.statements[0]?.values).toEqual([33]);
    expect(fake.statements[0]?.values.length).toBeLessThanOrEqual(100);
  });

  test("fails closed when no active verification key exists", async () => {
    const fake = scriptedDatabase({ rows: [] });
    await expect(new D1GrantKeyStore(fake.database).loadActiveKeys()).rejects.toEqual(
      new DurableStateError("no_active_keys"),
    );
  });

  test("looks up a bounded durable resource registry record with exact allowances", async () => {
    const fake = scriptedDatabase({
      rows: [
        {
          organization_id: "org_durable_registry",
          security_domain_id: "domain_durable_registry",
          tenant_ref: "tenant_durable_registry",
          resource_ref: "resource_durable_registry",
          reservation_id: "reservation_durable_registry",
          offering_id: "storage.object.standard",
          offering_digest: `sha256:${"c".repeat(64)}`,
          backend_id: "cloudflare-r2-binding",
          native_id: "r2:durable-registry",
          allowances_json: JSON.stringify([
            { protocol: "s3", mode: "direct", authority: "resource_scoped_grant" },
          ]),
        },
      ],
    });

    await expect(
      new D1ResourceRegistry(fake.database).lookup({
        securityDomainId: "domain_durable_registry",
        tenantRef: "tenant_durable_registry",
        resourceRef: "resource_durable_registry",
      }),
    ).resolves.toEqual({
      organizationId: "org_durable_registry",
      securityDomainId: "domain_durable_registry",
      tenantRef: "tenant_durable_registry",
      resourceRef: "resource_durable_registry",
      reservationId: "reservation_durable_registry",
      offeringId: "storage.object.standard",
      offeringDigest: `sha256:${"c".repeat(64)}`,
      backendId: "cloudflare-r2-binding",
      nativeId: "r2:durable-registry",
      allowances: [{ protocol: "s3", mode: "direct", authority: "resource_scoped_grant" }],
    });
    expect(fake.statements).toHaveLength(1);
    expect(fake.statements[0]?.values).toEqual([
      "domain_durable_registry",
      "tenant_durable_registry",
      "resource_durable_registry",
    ]);
    expect(fake.statements[0]?.values.length).toBeLessThanOrEqual(100);
  });
});
