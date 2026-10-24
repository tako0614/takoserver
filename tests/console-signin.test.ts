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

class SignInNode {
  readonly children: SignInNode[] = [];
  readonly style = {};
  readonly dataset = {};
  readonly attributes = new Map<string, string>();
  className = "";
  value = "";
  private readonly listeners = new Map<string, EventListener[]>();

  constructor(
    readonly tag = "text",
    private readonly content = "",
  ) {}

  get textContent(): string {
    return this.content + this.children.map((child) => child.textContent).join("");
  }

  append(...values: Array<SignInNode | string>): void {
    this.children.push(
      ...values.map((value) => (typeof value === "string" ? new SignInNode("text", value) : value)),
    );
  }

  replaceChildren(...values: Array<SignInNode | string>): void {
    this.children.length = 0;
    this.append(...values);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) listener({} as Event);
  }

  all(): SignInNode[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
}

function requireSignInNode(value: unknown): SignInNode {
  if (!(value instanceof SignInNode)) throw new Error("sign-in page did not render a test node");
  return value;
}

function installSignInDom(): void {
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
    Node: SignInNode,
    HTMLInputElement: SignInNode,
    localStorage: storage,
    sessionStorage: storage,
    document: {
      documentElement: new SignInNode("html"),
      createElement: (tag: string) => new SignInNode(tag),
      createElementNS: (_namespace: string, tag: string) => new SignInNode(tag),
      createTextNode: (value: string) => new SignInNode("text", value),
      createDocumentFragment: () => new SignInNode("fragment"),
      getElementById: () => null,
    },
    window: {
      addEventListener: () => undefined,
      location: new URL("https://console.example.test/"),
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
  test("endpoint Save keeps a completed logout's older availability reply from changing the new host", async () => {
    installSignInDom();
    const originalFetch = globalThis.fetch;
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { signInPage } = await import("../console/src/pages/signin.ts");
    consoleLocale.set("en");
    state.setApiOrigin("https://old.example.test");
    state.adoptSession("shared-auth");
    state.sharedAuthAvailable.set(true);
    const requests: Request[] = [];
    let answerLogoutProbe: (response: Response) => void = () => {
      throw new Error("logout availability probe did not start");
    };
    const logoutProbe = new Promise<Response>((resolve) => {
      answerLogoutProbe = resolve;
    });
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
        if (url.pathname === "/auth/oidc/logout") return new Response(null, { status: 204 });
        if (url.pathname === "/auth/oidc/session") {
          if (url.origin === "https://old.example.test") return logoutProbe;
          if (url.origin === "https://new.example.test")
            return Response.json({ error: { code: "not_found" } }, { status: 404 });
        }
        if (url.pathname === "/v1/identity/providers") return Response.json({ providers: [] });
        throw new Error(`unexpected Console request: ${request.url}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      const signingOut = state.signOut();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.session()).toBe(null);
      expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
        "/auth/oidc/logout",
        "/auth/oidc/session",
      ]);

      const page = requireSignInNode(signInPage());
      const input = page.all().find((node) => node.tag === "input" && node.className === "input");
      const save = page.all().find((node) => node.tag === "button" && node.textContent === "Save");
      expect(input).toBeDefined();
      expect(save).toBeDefined();
      if (!input || !save) throw new Error("missing endpoint controls");
      input.value = "https://new.example.test";
      save.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.sharedAuthAvailable()).toBe(false);
      expect(page.textContent).not.toContain("Continue with Takos account");

      answerLogoutProbe(Response.json({ authenticated: true }));
      await signingOut;
      expect(state.sharedAuthAvailable()).toBe(false);
      expect(page.textContent).not.toContain("Continue with Takos account");
      expect(
        requests
          .filter((request) => new URL(request.url).pathname === "/auth/oidc/session")
          .map((request) => new URL(request.url).origin),
      ).toEqual(["https://old.example.test", "https://new.example.test"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("saving another API endpoint re-probes shared auth and ignores stale or failed discovery", async () => {
    installSignInDom();
    const originalFetch = globalThis.fetch;
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { signInPage } = await import("../console/src/pages/signin.ts");
    consoleLocale.set("en");
    state.setApiOrigin("https://old.example.test");
    state.sharedAuthAvailable.set(true);
    const asked: string[] = [];
    let answerOldProbe: (response: Response) => void = () => {
      throw new Error("old probe did not start");
    };
    const oldProbe = new Promise<Response>((resolve) => {
      answerOldProbe = resolve;
    });
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        asked.push(`${url.origin}${url.pathname}`);
        if (url.pathname === "/v1/identity/providers") return Response.json({ providers: [] });
        if (url.pathname === "/auth/oidc/session") {
          if (url.origin === "https://old-probe.example.test") return oldProbe;
          if (url.origin === "https://new.example.test")
            return Response.json({ error: { code: "not_found" } }, { status: 404 });
          if (url.origin === "https://failed.example.test") throw new Error("unreachable");
          if (url.origin === "https://available.example.test")
            return Response.json({ authenticated: false }, { status: 401 });
        }
        throw new Error(`unexpected Console request: ${url.pathname}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      const page = requireSignInNode(signInPage());
      const input = page.all().find((node) => node.tag === "input" && node.className === "input");
      const save = page.all().find((node) => node.tag === "button" && node.textContent === "Save");
      expect(input).toBeDefined();
      expect(save).toBeDefined();
      if (!input || !save) throw new Error("missing endpoint controls");

      input.value = "https://old-probe.example.test";
      save.click();
      expect(state.sharedAuthAvailable()).toBe(null);
      input.value = "https://new.example.test";
      save.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.sharedAuthAvailable()).toBe(false);
      expect(page.textContent).not.toContain("Continue with Takos account");
      answerOldProbe(Response.json({ authenticated: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.sharedAuthAvailable()).toBe(false);

      state.sharedAuthAvailable.set(true);
      input.value = "https://failed.example.test";
      save.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.sharedAuthAvailable()).toBe(null);
      expect(page.textContent).not.toContain("Continue with Takos account");
      input.value = "https://available.example.test";
      save.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.sharedAuthAvailable()).toBe(true);
      expect(page.textContent).toContain("Continue with Takos account");
      expect(asked.filter((url) => url.endsWith("/auth/oidc/session"))).toEqual([
        "https://old-probe.example.test/auth/oidc/session",
        "https://new.example.test/auth/oidc/session",
        "https://failed.example.test/auth/oidc/session",
        "https://available.example.test/auth/oidc/session",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("shared-auth entry URL is fixed to the API origin and adds no redirect query", async () => {
    installConsoleGlobals();
    const { sharedSessionLoginUrl } = await import("../console/src/pages/signin.ts");

    expect(sharedSessionLoginUrl("https://api.example.test")).toBe(
      "https://api.example.test/auth/oidc/login",
    );
    expect(() => sharedSessionLoginUrl("https://api.example.test/path?returnTo=/billing")).toThrow(
      "invalid shared-auth API origin",
    );
  });

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
