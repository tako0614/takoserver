import { expect, test } from "bun:test";
import { createActorNamespace } from "../src/actor-namespace-facade.ts";
import { renderActorNamespaceFacadeModuleSource } from "../src/actor-namespace-facade-source.ts";

test("Actor namespace facade mints synchronously and dispatches ordinary and opaque outcomes", async () => {
  const calls: Array<{ id: string; url: string; method: string }> = [];
  const outcome = Object.freeze(Object.create(null)) as object;
  const namespace = createActorNamespace({
    addressing: Object.freeze({
      idFromName(name: string) {
        return `opaque:${name}`;
      },
      newUniqueId() {
        return "opaque:unique";
      },
      isValidActorId(value: unknown) {
        return typeof value === "string" && value.startsWith("opaque:");
      },
    }),
    async invoke(id, request) {
      calls.push({ id, url: request.url, method: request.method });
      return request.url.endsWith("/socket") ? outcome : new Response("ordinary");
    },
  });
  expect(Object.isFrozen(namespace)).toBe(true);
  expect(namespace.idFromName("room")).toBe("opaque:room");
  expect(namespace.newUniqueId()).toBe("opaque:unique");
  const stub = namespace.get("opaque:room");
  expect(Object.isFrozen(stub)).toBe(true);
  const ordinary = await stub.fetch("http://actor.invalid/ordinary");
  expect(ordinary).toBeInstanceOf(Response);
  expect(await (ordinary as Response).text()).toBe("ordinary");
  expect(await stub.fetch(new Request("http://actor.invalid/socket"))).toBe(outcome);
  expect(calls).toEqual([
    { id: "opaque:room", url: "http://actor.invalid/ordinary", method: "GET" },
    { id: "opaque:room", url: "http://actor.invalid/socket", method: "GET" },
  ]);
  expect(() => namespace.get("different-domain")).toThrow();
});

test("generated Host-only namespace module is a closed ESM projection", () => {
  const source = renderActorNamespaceFacadeModuleSource();
  expect(source).not.toContain("import ");
  expect(source).toContain("export {");
  expect(source).toContain("createActorNamespace");
});
