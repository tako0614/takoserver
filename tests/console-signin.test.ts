import { describe, expect, test } from "bun:test";
import type { IdentityProvider } from "../console/src/api.ts";

function installConsoleGlobals(): void {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
    removeItem: (key: string): void => {
      values.delete(key);
    },
  };
  Object.assign(globalThis, {
    localStorage: storage,
    document: { documentElement: { dataset: {} as Record<string, string> } },
    window: {
      addEventListener: (): void => undefined,
      location: {
        protocol: "https:",
        hostname: "console.example.test",
        port: "",
        origin: "https://console.example.test",
        href: "https://console.example.test/",
      },
    },
  });
}

function assertionFor(provider: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      purpose: "sign-in",
      provider,
      subject: "operator-1",
      email: "owner@example.com",
      displayName: "Owner",
      iat: 1,
      exp: 301,
    }),
  ).toString("base64url");
  return `${payload}.signature`;
}

describe("Takoserver Console operator sign-in", () => {
  test("routes a GitHub assertion to GitHub when both descriptors are advertised", async () => {
    installConsoleGlobals();
    const { signInWithOperatorAssertion } = await import("../console/src/pages/signin.ts");
    const providers: readonly IdentityProvider[] = [
      { id: "google", displayName: "Operator assertion", method: "operator-assertion" },
      { id: "github", displayName: "Operator assertion", method: "operator-assertion" },
    ];
    const assertion = assertionFor("github");
    const calls: Array<[string, string, "operator-assertion"]> = [];
    const client = {
      signIn: async (
        provider: string,
        value: string,
        method: "operator-assertion",
      ): Promise<unknown> => {
        calls.push([provider, value, method]);
        return undefined;
      },
    };

    await signInWithOperatorAssertion(client, providers, assertion);

    expect(calls).toEqual([["github", assertion, "operator-assertion"]]);
  });
});
