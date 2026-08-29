import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createEphemeralSql } from "../src/compat.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import type { TakoformResourceDriver } from "../src/takoform/types.ts";
import { createStaticStableEphemeralTakoformHost } from "./helpers/historical-takoform-host.ts";

const formRef = {
  apiVersion: "edge.forms.takoform.com",
  kind: "WorkerVersion",
  definitionVersion: "0.2.0",
  schemaDigest: `sha256:${"a".repeat(64)}` as const,
};

const workerVersionForm = {
  identity: { formRef },
  role: "revision" as const,
  desiredSchema: {
    type: "object",
    properties: {
      requiredSensitiveVars: {
        type: "array",
        items: { type: "string" },
        uniqueItems: true,
      },
    },
    required: ["requiredSensitiveVars"],
    additionalProperties: false,
  },
  operations: ["create", "read", "delete", "observe"] as const,
};

describe("independent Takoserver Host boundary", () => {
  test("advertises zero sensitive vars and refuses them before provider mutation while accepting empty declarations", async () => {
    const memory = new InMemoryTakoformResourceDriver();
    let providerApplyCalls = 0;
    const driver: TakoformResourceDriver = {
      async apply(input) {
        providerApplyCalls += 1;
        return await memory.apply(input);
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
      import: (input) => memory.import(input),
    };
    const host = createStaticStableEphemeralTakoformHost({
      sql: createEphemeralSql(),
      objects: createMemoryObjectStore(),
      authenticate: async () => ({ tenantId: "tenant-a", principalId: "principal-a" }),
      forms: [workerVersionForm],
      driver,
    });
    const headers = { authorization: "Bearer independent-host" };
    const support = await host.handle(
      new Request(
        `https://host.invalid/apis/forms.takoform.com/v1/support/forms/${formRef.apiVersion}/${formRef.kind}/${formRef.definitionVersion}`,
        { headers },
      ),
    );
    expect(support?.status).toBe(200);
    expect(await support?.json()).toMatchObject({
      limits: {
        "/requiredSensitiveVars": 0,
      },
    });

    const refused = await applyWorkerVersion(host, "with-secret", ["ENCRYPTION_KEY"], headers);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      error: { code: "unsupported_capability" },
    });
    expect(providerApplyCalls).toBe(0);

    const accepted = await applyWorkerVersion(host, "without-secret", [], headers);
    expect(accepted.status).toBe(201);
    expect(providerApplyCalls).toBe(1);
  });

  test("production source contains no retired hosted materialization seam", () => {
    const repository = resolve(import.meta.dir, "..");
    const retiredNames = [
      ["HOST", "RUNTIME", "MATERIALIZER"].join("_"),
      ["hosted", "Topology"].join(""),
      ["runtime", "Materialization"].join(""),
      ["Runtime", "Materializer"].join(""),
      ["runtime", "materialization"].join("-"),
      ["Takosumi", "RuntimeBindingMaterializerEntrypoint"].join(""),
      ["Takosumi", "HostRuntimeMaterializerEntrypoint"].join(""),
    ];
    const retained: string[] = [];
    for (const root of [join(repository, "src"), join(repository, "scripts")]) {
      for (const path of sourceFiles(root)) {
        const source = readFileSync(path, "utf8");
        for (const name of retiredNames) {
          if (source.includes(name)) retained.push(`${relative(repository, path)}: ${name}`);
        }
      }
    }
    expect(retained).toEqual([]);
  }, 15_000);
});

function sourceFiles(root: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...sourceFiles(path));
    else if (entry.isFile() && /\.(?:[cm]?ts|jsonc?)$/u.test(entry.name)) paths.push(path);
  }
  return paths;
}

async function applyWorkerVersion(
  host: { handle(request: Request): Promise<Response | null> },
  name: string,
  requiredSensitiveVars: readonly string[],
  headers: Readonly<Record<string, string>>,
): Promise<Response> {
  const resource = {
    apiVersion: formRef.apiVersion,
    kind: formRef.kind,
    form: { formRef },
    metadata: { name, space: "main" },
    spec: { requiredSensitiveVars },
  };
  const prepared = await host.handle(
    new Request("https://host.invalid/apis/forms.takoform.com/v1/resources/prepare", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(resource),
    }),
  );
  expect(prepared?.status).toBe(200);
  const preparedBody = (await prepared?.json()) as { review: { prepareDigest: string } };
  const response = await host.handle(
    new Request(
      `https://host.invalid/apis/forms.takoform.com/v1/resources/${formRef.apiVersion}/${formRef.kind}/${name}`,
      {
        method: "PUT",
        headers: {
          ...headers,
          "content-type": "application/json",
          "idempotency-key": `apply-${name}`,
          "if-none-match": "*",
        },
        body: JSON.stringify({ ...resource, review: preparedBody.review }),
      },
    ),
  );
  if (!response) throw new TypeError("stable Host did not handle WorkerVersion Apply");
  return response;
}
