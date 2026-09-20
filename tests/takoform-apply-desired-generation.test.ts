import { expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { createTakoformStore } from "../src/takoform/store.ts";
import type {
  InstalledTakoformForm,
  TakoformResourceDriver,
  TakoformStoredResource,
} from "../src/takoform/types.ts";
import { createStaticStableTestTakoformHost } from "./helpers/historical-takoform-host.ts";

const lane = "/apis/forms.takoform.com/v1";
const form: InstalledTakoformForm = {
  identity: {
    formRef: {
      apiVersion: "example.forms.invalid",
      kind: "MutableService",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"a".repeat(64)}`,
    },
  },
  role: "deployment",
  operations: ["create", "read", "update", "delete"],
  desiredSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
};

function fixture() {
  const sql = createEphemeralSql();
  const store = createTakoformStore(sql, () => new Date());
  const calls: Parameters<TakoformResourceDriver["apply"]>[0][] = [];
  const driver = new InMemoryTakoformResourceDriver();
  const host = createStaticStableTestTakoformHost({
    sql,
    objects: createMemoryObjectStore(),
    authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
    forms: [form],
    driver: {
      selectApply: (input) => driver.selectApply(input),
      async apply(input) {
        calls.push(structuredClone(input));
        return driver.apply(input);
      },
      observe: (input) => driver.observe(input),
      delete: (input) => driver.delete(input),
    },
  });
  async function send(path: string, init: RequestInit) {
    const response = await host.handle(
      new Request(`https://host.test${lane}${path}`, {
        ...init,
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
          ...init.headers,
        },
      }),
    );
    if (!response) throw new Error("Host did not handle request");
    if (response.status >= 400) throw new Error(await response.text());
    return response;
  }
  async function prepare(value: string, key: string, current?: TakoformStoredResource) {
    const desired = {
      apiVersion: form.identity.formRef.apiVersion,
      kind: form.identity.formRef.kind,
      form: form.identity,
      metadata: { name: "service", space: "main" },
      spec: { value },
    };
    const fence: Record<string, string> = current
      ? { "takoform-expected-generation": current.metadata.generation }
      : {};
    const prepared = await send("/resources/prepare", {
      method: "POST",
      headers: fence,
      body: JSON.stringify(desired),
    });
    expect(prepared.status).toBe(200);
    const { review } = (await prepared.json()) as { review: unknown };
    const init = {
      method: "PUT",
      headers: {
        ...fence,
        "idempotency-key": `generation-${key}`,
        ...(current ? { "if-match": `"${current.metadata.revision}"` } : { "if-none-match": "*" }),
      },
      body: JSON.stringify({ ...desired, review }),
    };
    return () => send(`/resources/${desired.apiVersion}/${desired.kind}/service`, init);
  }
  const address = {
    tenantId: "tenant-a",
    space: "main",
    apiVersion: form.identity.formRef.apiVersion,
    kind: form.identity.formRef.kind,
    name: "service",
  };
  async function current() {
    const resource = await store.readResource(address);
    if (!resource) throw new Error("Resource not stored");
    return resource;
  }
  return { calls, prepare, current, store, address };
}

test("engine selects incoming generation while preserving previous state and idempotent replay", async () => {
  const f = fixture();
  const create = await f.prepare("first", "create");
  expect((await create()).status).toBe(201);
  expect(f.calls[0]?.desiredGeneration).toBe("1");
  expect(f.calls[0]?.previous).toBeUndefined();
  const first = await f.current();
  const update = await f.prepare("second", "update", first);
  expect((await update()).status).toBe(200);
  expect(f.calls[1]?.desiredGeneration).toBe("2");
  expect(f.calls[1]?.previous).toEqual(first);
  const second = await f.current();
  expect(second.metadata.generation).toBe("2");
  expect((await update()).status).toBe(200);
  expect(f.calls).toHaveLength(2);
  expect(await f.current()).toEqual(second);
  const same = await f.prepare("second", "same", second);
  expect((await same()).status).toBe(200);
  expect(f.calls).toHaveLength(2);
  const settled = await f.current();
  expect(settled.metadata.generation).toBe("2");
  expect((await same()).status).toBe(200);
  expect(f.calls).toHaveLength(2);
  expect(await f.current()).toEqual(settled);
  expect(f.calls[1]?.previous).toEqual(first);
});

test("incoming generation preserves decimal precision beyond Number safe integers", async () => {
  const f = fixture();
  expect((await (await f.prepare("first", "create"))()).status).toBe(201);
  const first = await f.current();
  const large: TakoformStoredResource = {
    ...first,
    metadata: { ...first.metadata, generation: "9007199254740992" },
    status: { ...first.status, observedGeneration: "9007199254740992" },
  };
  expect(
    await f.store.writeResource({
      address: f.address,
      resource: large,
      relations: [],
      expectedRevision: first.metadata.revision,
    }),
  ).toBe(true);
  const update = await f.prepare("second", "large-update", large);
  expect((await update()).status).toBe(200);
  expect(f.calls[1]?.desiredGeneration).toBe("9007199254740993");
  expect(f.calls[1]?.previous?.metadata.generation).toBe("9007199254740992");
  expect((await f.current()).metadata.generation).toBe("9007199254740993");
});
