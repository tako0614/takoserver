import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createDataObjectRoutes } from "../src/data-objects.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createTokenService } from "../src/token.ts";

/**
 * A bucket a customer cannot reach is a line in a list and a charge on a
 * wallet. This is the door, so what it refuses matters as much as what it
 * serves: a token names one bucket, and a key must stay inside it.
 */

async function signingKey(sql: ReturnType<typeof createEphemeralSql>) {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  await sql.run(
    "INSERT INTO runtime_grant_keys (key_id, public_jwk, created_at_epoch_seconds) VALUES (?, ?, ?)",
    ["data-test", JSON.stringify({ kty: "OKP", crv: "Ed25519", x: jwk.x }), 0],
  );
  return { keyId: "data-test", privateKey: pair.privateKey };
}

async function bucket() {
  const sql = createEphemeralSql();
  const objects = createMemoryObjectStore();
  const tokens = createTokenService({
    sql,
    issuer: "https://api.example.test",
    signingKey: await signingKey(sql),
  });
  const routes = createDataObjectRoutes({ objects, tokens });

  const mint = async (resourceUid: string) =>
    (
      await tokens.issueDataToken({
        organizationId: "org_1",
        resourceUid,
        protocols: ["s3"],
        ttlSeconds: 600,
      })
    ).token;

  const call = (method: string, path: string, token: string | null, init: RequestInit = {}) => {
    const url = new URL(`https://api.example.test/data/v1/objects/${path}`);
    const { headers, ...rest } = init;
    return routes(
      new Request(url, {
        ...rest,
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...((headers as Record<string, string>) ?? {}),
        },
      }),
      url,
    );
  };

  return { mint, call, objects };
}

describe("object data plane", () => {
  test("round-trips an object the customer wrote", async () => {
    const { mint, call } = await bucket();
    const token = await mint("uid_media");

    const written = await call("PUT", "uid_media/photos/one.txt", token, {
      body: "hello",
      headers: { "content-type": "text/plain" },
    });
    expect(written?.status).toBe(201);

    const read = await call("GET", "uid_media/photos/one.txt", token);
    expect(read?.status).toBe(200);
    expect(await read?.text()).toBe("hello");
    expect(read?.headers.get("content-type")).toBe("text/plain");

    const probe = await call("HEAD", "uid_media/photos/one.txt", token);
    expect(probe?.status).toBe(200);
    expect(probe?.headers.get("content-length")).toBe("5");

    const listed = await call("GET", "uid_media/?prefix=photos/", token);
    expect(await listed?.json()).toMatchObject({ objects: [{ key: "photos/one.txt", size: 5 }] });

    expect((await call("DELETE", "uid_media/photos/one.txt", token))?.status).toBe(204);
    expect((await call("GET", "uid_media/photos/one.txt", token))?.status).toBe(404);
  });

  test("a delete that finds nothing still succeeds", async () => {
    const { mint, call } = await bucket();
    const token = await mint("uid_media");
    // Otherwise retrying after a dropped connection reports an error for
    // having already worked.
    expect((await call("DELETE", "uid_media/never-existed", token))?.status).toBe(204);
  });

  test("refuses a token minted for another bucket", async () => {
    const { mint, call } = await bucket();
    const other = await mint("uid_somebody_else");
    const response = await call("PUT", "uid_media/theirs.txt", other, { body: "x" });
    expect(response?.status).toBe(401);
  });

  test("refuses a caller with no token at all", async () => {
    const { call } = await bucket();
    expect((await call("GET", "uid_media/anything", null))?.status).toBe(401);
  });

  test("refuses a key that would climb out of the bucket", async () => {
    const { mint, call, objects } = await bucket();
    const token = await mint("uid_media");

    // Percent-encoded traversal survives URL normalisation and arrives here as
    // a key, which is exactly the case a store that joins strings gets wrong.
    for (const key of [
      "%2e%2e%2fescape",
      "a%2f%2e%2e%2f%2e%2e%2fb",
      "%2fleading",
      "double%2f%2fslash",
    ]) {
      const response = await call("PUT", `uid_media/${key}`, token, { body: "x" });
      expect(response?.status).toBe(400);
    }

    // Plain traversal is resolved by the URL before it is read, which moves it
    // to another bucket's name — where this token does not open anything.
    expect((await call("PUT", "uid_media/../uid_other/escape", token, { body: "x" }))?.status).toBe(
      401,
    );

    // Nothing was written anywhere, under any name.
    expect((await objects.list({ prefix: "", limit: 100 })).objects).toEqual([]);
  });

  test("keeps two buckets apart even though they share a store", async () => {
    const { mint, call } = await bucket();
    const mine = await mint("uid_mine");
    const yours = await mint("uid_yours");
    await call("PUT", "uid_mine/secret", mine, { body: "mine" });
    await call("PUT", "uid_yours/secret", yours, { body: "yours" });

    expect(await (await call("GET", "uid_mine/secret", mine))?.text()).toBe("mine");
    // Same key, different bucket, different object — and neither token opens
    // the other.
    expect(await (await call("GET", "uid_yours/secret", yours))?.text()).toBe("yours");
    expect((await call("GET", "uid_yours/secret", mine))?.status).toBe(401);
  });

  test("reports what moved, so it can be billed", async () => {
    const sql = createEphemeralSql();
    const objects = createMemoryObjectStore();
    const tokens = createTokenService({
      sql,
      issuer: "https://api.example.test",
      signingKey: await signingKey(sql),
    });
    const seen: { operation: string; bytes: number }[] = [];
    const routes = createDataObjectRoutes({
      objects,
      tokens,
      async record(usage) {
        seen.push({ operation: usage.operation, bytes: usage.bytes });
      },
    });
    const { token } = await tokens.issueDataToken({
      organizationId: "org_1",
      resourceUid: "uid_media",
      protocols: ["s3"],
      ttlSeconds: 600,
    });
    const url = new URL("https://api.example.test/data/v1/objects/uid_media/a.bin");
    await routes(
      new Request(url, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}` },
        body: "1234",
      }),
      url,
    );
    await routes(new Request(url, { headers: { authorization: `Bearer ${token}` } }), url);
    expect(seen).toEqual([
      { operation: "put", bytes: 4 },
      { operation: "get", bytes: 4 },
    ]);
  });
});
