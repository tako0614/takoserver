import { describe, expect, test } from "bun:test";
import { createOperatorIdentity } from "../src/operator-credentials.ts";
import {
  ensureOperatorKey,
  parseOperatorPublicKey,
  signOperatorAssertion,
} from "../src/operator-key.ts";

/**
 * A machine standing on its own has to let its operator in.
 *
 * Without a generated key, a deployment with no identity provider advertises no
 * way in and refuses every sign-in — a server nobody can enter. These say the
 * key is minted once, reused after a restart, and never invented where a real
 * identity provider is configured.
 */

function memoryFiles(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    files,
    readFile: async (path: string) => files.get(path) ?? null,
    writeFile: async (path: string, contents: string) => {
      files.set(path, contents);
    },
  };
}

describe("ensureOperatorKey", () => {
  test("mints a key when nothing else can say who the operator is", async () => {
    const store = memoryFiles();
    const key = await ensureOperatorKey({
      hasIdentityProvider: false,
      path: "/data/operator-key.jwk",
      readFile: store.readFile,
      writeFile: store.writeFile,
    });

    expect(key).toBeDefined();
    expect(key?.crv).toBe("Ed25519");
    expect(store.files.has("/data/operator-key.jwk")).toBe(true);
    // The private half is what was written; only the public half is returned.
    const written = JSON.parse(store.files.get("/data/operator-key.jwk") ?? "{}") as {
      d?: string;
      x?: string;
    };
    expect(typeof written.d).toBe("string");
    expect(key?.x).toBe(written.x);
    expect((key as { d?: string }).d).toBeUndefined();
  });

  test("keeps the key it already made, so a restart is not a new identity", async () => {
    const store = memoryFiles();
    const first = await ensureOperatorKey({
      hasIdentityProvider: false,
      path: "/data/operator-key.jwk",
      readFile: store.readFile,
      writeFile: store.writeFile,
    });
    const second = await ensureOperatorKey({
      hasIdentityProvider: false,
      path: "/data/operator-key.jwk",
      readFile: store.readFile,
      writeFile: store.writeFile,
    });

    expect(second?.x).toBe(first?.x);
    expect(store.files.size).toBe(1);
  });

  test("invents nothing when a real identity provider answers who someone is", async () => {
    const store = memoryFiles();
    const key = await ensureOperatorKey({
      hasIdentityProvider: true,
      path: "/data/operator-key.jwk",
      readFile: store.readFile,
      writeFile: store.writeFile,
    });

    expect(key).toBeUndefined();
    expect(store.files.size).toBe(0);
  });

  test("still honours a key on disk once a provider is configured", async () => {
    // How the operator gets in when the identity provider is what broke.
    const store = memoryFiles();
    const minted = await ensureOperatorKey({
      hasIdentityProvider: false,
      path: "/data/operator-key.jwk",
      readFile: store.readFile,
      writeFile: store.writeFile,
    });
    const afterGoogle = await ensureOperatorKey({
      hasIdentityProvider: true,
      path: "/data/operator-key.jwk",
      readFile: store.readFile,
      writeFile: store.writeFile,
    });

    expect(afterGoogle?.x).toBe(minted?.x);
  });

  test("a configured public half is used verbatim and generates nothing", async () => {
    const store = memoryFiles();
    const configured = { kty: "OKP", crv: "Ed25519", x: "Zm9vYmFy" };
    const key = await ensureOperatorKey({
      configured: JSON.stringify(configured),
      hasIdentityProvider: false,
      path: "/data/operator-key.jwk",
      readFile: store.readFile,
      writeFile: store.writeFile,
    });

    expect(key).toEqual(configured);
    expect(store.files.size).toBe(0);
  });

  test("says which variable is wrong rather than failing as bad JSON", async () => {
    const store = memoryFiles();
    await expect(
      ensureOperatorKey({
        configured: "not json",
        hasIdentityProvider: false,
        path: "/data/operator-key.jwk",
        readFile: store.readFile,
        writeFile: store.writeFile,
      }),
    ).rejects.toThrow(/TAKOSERVER_OPERATOR_PUBLIC_JWK/);
  });

  test("names the additive identity-only variable in configuration failures", () => {
    expect(() =>
      parseOperatorPublicKey("not json", "TAKOSERVER_OPERATOR_IDENTITY_PUBLIC_JWK"),
    ).toThrow(/TAKOSERVER_OPERATOR_IDENTITY_PUBLIC_JWK/);
  });
});

describe("the assertion a first run prints", () => {
  test("verifies against the key that was just generated", async () => {
    const store = memoryFiles();
    const publicKeyJwk = await ensureOperatorKey({
      hasIdentityProvider: false,
      path: "/data/operator-key.jwk",
      readFile: store.readFile,
      writeFile: store.writeFile,
    });
    if (!publicKeyJwk) throw new Error("expected a generated key");

    const now = 1_700_000_000;
    const assertion = await signOperatorAssertion({
      privateJwk: store.files.get("/data/operator-key.jwk") ?? "",
      claims: {
        purpose: "sign-in",
        provider: "google",
        subject: "operator",
        email: "operator@localhost",
        displayName: "Operator",
      },
      nowSeconds: now,
      lifetimeSeconds: 600,
    });

    const identity = createOperatorIdentity({
      publicKeyJwk,
      clock: () => new Date(now * 1_000),
    });
    const verified = await identity.verify({ provider: "google", assertion });

    expect(verified.providerSubject).toBe("operator");
    expect(verified.email).toBe("operator@localhost");
    expect(verified.displayName).toBe("Operator");
  });

  test("expires, so a banner left in scrollback is not a standing key", async () => {
    const store = memoryFiles();
    const publicKeyJwk = await ensureOperatorKey({
      hasIdentityProvider: false,
      path: "/data/operator-key.jwk",
      readFile: store.readFile,
      writeFile: store.writeFile,
    });
    if (!publicKeyJwk) throw new Error("expected a generated key");

    const issued = 1_700_000_000;
    const assertion = await signOperatorAssertion({
      privateJwk: store.files.get("/data/operator-key.jwk") ?? "",
      claims: {
        purpose: "sign-in",
        provider: "google",
        subject: "operator",
        email: "operator@localhost",
        displayName: "Operator",
      },
      nowSeconds: issued,
      lifetimeSeconds: 600,
    });

    const identity = createOperatorIdentity({
      publicKeyJwk,
      clock: () => new Date((issued + 601) * 1_000),
    });
    await expect(identity.verify({ provider: "google", assertion })).rejects.toThrow();
  });
});
