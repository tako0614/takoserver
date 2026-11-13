import { afterEach, expect, test } from "bun:test";
import { createApi } from "../console/src/api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const principal = {
  id: "owner",
  provider: "local",
  email: "owner@example.test",
  displayName: "Owner",
};
const organization = (i: number) => ({
  id: `org-${i}`,
  name: `Organization ${i}`,
  ownerPrincipalId: "owner",
  createdAt: "2026-11-12T00:00:00Z",
});
function transport(reply: (request: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(request);
      return reply(request);
    },
    { preconnect: originalFetch.preconnect },
  );
  return seen;
}
function client(revision = () => 0) {
  return createApi({
    origin: "https://api.example.test",
    token: () => null,
    sessionRevision: revision,
    onSessionLost() {},
  });
}

test("Console reads one explicit bounded page without draining a continuation", async () => {
  const seen = transport(() =>
    Response.json({
      principal,
      organizations: Array.from({ length: 100 }, (_, i) => organization(i)),
      nextOrganizationCursor: "page-2",
    }),
  );
  const me = await client().me();
  expect(me.organizations).toHaveLength(100);
  expect(me.nextOrganizationCursor).toBe("page-2");
  expect(seen).toHaveLength(1);
  const sent = seen[0];
  if (!sent) throw new Error("page request missing");
  expect(new URL(sent.url).searchParams.get("organizationPageSize")).toBe("100");
  expect(sent.credentials).toBe("include");
  expect(sent.cache).toBe("no-store");
});

test("a continuation is read only when explicitly requested, and a failure is not an empty page", async () => {
  const seen = transport((request) =>
    new URL(request.url).searchParams.has("organizationCursor")
      ? Response.json({ error: { code: "unavailable" } }, { status: 503 })
      : Response.json({
          principal,
          organizations: [organization(0)],
          nextOrganizationCursor: "page-2",
        }),
  );
  const api = client();
  const first = await api.me();
  expect(seen).toHaveLength(1);
  if (first.nextOrganizationCursor === null) throw new Error("continuation missing");
  await expect(api.me(first.nextOrganizationCursor)).rejects.toMatchObject({ status: 503 });
  expect(seen).toHaveLength(2);
  expect(first.organizations).toEqual([organization(0)]);
});

test("a retired page response cannot supply identity to a newer local session", async () => {
  let revision = 0;
  const seen = transport(() => {
    revision++;
    return Response.json({
      principal,
      organizations: [organization(0)],
      nextOrganizationCursor: "page-2",
    });
  });
  await expect(client(() => revision).me()).rejects.toMatchObject({ code: "stale_identity" });
  expect(seen).toHaveLength(1);
});

test("missing page metadata, duplicate rows, empty progress and repeated cursor are refused", async () => {
  for (const payload of [
    { principal, organizations: [organization(0)] },
    { principal, organizations: [organization(0), organization(0)], nextOrganizationCursor: null },
    { principal, organizations: [], nextOrganizationCursor: "next" },
    { principal, organizations: [organization(0)], nextOrganizationCursor: "same" },
    {
      principal,
      organizations: Array.from({ length: 101 }, (_, i) => organization(i)),
      nextOrganizationCursor: null,
    },
  ]) {
    const seen = transport(() => Response.json(payload));
    await expect(client().me("same")).rejects.toMatchObject({ code: "invalid_response" });
    expect(seen).toHaveLength(1);
  }
});

test("an old server complete roster is accepted only when it fits the same page budgets", async () => {
  const seen = transport(() => Response.json({ principal, organizations: [organization(1)] }));
  expect((await client().me()).organizations).toEqual([organization(1)]);
  expect(seen).toHaveLength(1);
  transport(() =>
    Response.json({
      principal,
      organizations: Array.from({ length: 101 }, (_, i) => organization(i)),
    }),
  );
  await expect(client().me()).rejects.toMatchObject({ code: "invalid_response" });
});

test("a single page preserves server membership-index ordering", async () => {
  transport(() =>
    Response.json({
      principal,
      organizations: [organization(2), organization(1)],
      nextOrganizationCursor: null,
    }),
  );
  expect((await client().me()).organizations.map((org) => org.id)).toEqual(["org-2", "org-1"]);
});

test("page JSON and streamed response budgets reject oversized old-server output", async () => {
  transport(() =>
    Response.json({
      principal,
      organizations: [{ ...organization(1), name: "組".repeat(12000) }],
      nextOrganizationCursor: null,
    }),
  );
  await expect(client().me()).rejects.toMatchObject({ code: "invalid_response" });
  let cancelled = false;
  transport(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(0));
            controller.enqueue(new Uint8Array(65537));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await expect(client().me()).rejects.toMatchObject({ code: "invalid_response" });
  expect(cancelled).toBe(true);
});
