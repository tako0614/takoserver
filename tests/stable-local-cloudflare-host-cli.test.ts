import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";

import {
  parseStableLocalCloudflareHostEnvironment,
  stableLocalCloudflareHostReadyRecord,
} from "../scripts/stable-local-cloudflare-host.ts";
import { startStableLocalCloudflareHost } from "../src/entry-stable-local-cloudflare-host.ts";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const TAKOFORM_ROOT = resolve(import.meta.dir, "fixtures/takoform-v1");
const TOKEN = "generic-stable-local-token";
const RUNTIME_NAME = "GENERIC_LOCAL_VALUE";
const RUNTIME_VALUE = "generic-local-secret-value";
type LauncherChild = ChildProcessByStdio<null, Readable, Readable>;

const children = new Set<LauncherChild>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await childExit(child);
  }
  children.clear();
});

describe("the stable local Cloudflare Host launcher", () => {
  test("requires a complete, nonempty generic runtime-value map", () => {
    const base = {
      TAKOFORM_STABLE_CATALOG_ROOT: TAKOFORM_ROOT,
      TAKOSERVER_STABLE_LOCAL_TOKEN: TOKEN,
    };

    for (const runtimeValues of [undefined, "", "null", "[]", "{}", "{broken"] as const) {
      expect(() =>
        parseStableLocalCloudflareHostEnvironment({
          ...base,
          TAKOSERVER_STABLE_LOCAL_RUNTIME_VALUES: runtimeValues,
        }),
      ).toThrow("TAKOSERVER_STABLE_LOCAL_RUNTIME_VALUES");
    }

    expect(
      parseStableLocalCloudflareHostEnvironment({
        ...base,
        TAKOSERVER_STABLE_LOCAL_RUNTIME_VALUES: JSON.stringify({
          [RUNTIME_NAME]: RUNTIME_VALUE,
        }),
      }),
    ).toEqual({
      takoformRepositoryRoot: TAKOFORM_ROOT,
      token: TOKEN,
      runtimeValues: { [RUNTIME_NAME]: RUNTIME_VALUE },
      space: "default",
      port: 0,
    });
  });

  test("renders one sanitized test-only readiness record", () => {
    const record = stableLocalCloudflareHostReadyRecord({
      endpoint: "http://127.0.0.1:43210",
      diagnosticRuntimeEndpoint: "http://127.0.0.1:43210",
      space: "local-space",
      classification: "test-only-local-cloudflare-adapter",
      report: () => ({
        classification: "test-only-local-cloudflare-adapter",
        installedFormKindCount: 13,
        resourceGraphCount: 13,
        currentObjectBucketIdentities: 0,
        currentEdgeObjectsReferences: 0,
        resources: {},
      }),
    });
    const rendered = JSON.stringify(record);

    expect(record).toEqual({
      kind: "takoserver.stable-local-cloudflare-host@v1",
      status: "ready",
      classification: "test-only-local-cloudflare-adapter",
      endpoint: "http://127.0.0.1:43210",
      diagnosticRuntimeEndpoint: "http://127.0.0.1:43210",
      space: "local-space",
      report: {
        installedFormKindCount: 13,
        resourceGraphCount: 13,
        currentObjectBucketIdentities: 0,
        currentEdgeObjectsReferences: 0,
      },
    });
    for (const forbidden of [TOKEN, RUNTIME_NAME, RUNTIME_VALUE, "Takosumi", "materializer"]) {
      expect(rendered.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  test("starts on loopback, exposes literal v1 discovery, rejects bad auth, and closes on SIGTERM", async () => {
    const child = spawn("bun", ["run", "debug:stable-local-cloudflare-host"], {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        TAKOFORM_STABLE_CATALOG_ROOT: TAKOFORM_ROOT,
        TAKOSERVER_STABLE_LOCAL_TOKEN: TOKEN,
        TAKOSERVER_STABLE_LOCAL_RUNTIME_VALUES: JSON.stringify({
          [RUNTIME_NAME]: RUNTIME_VALUE,
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    const line = await readLine(child.stdout);
    const ready = JSON.parse(line) as {
      endpoint: string;
      diagnosticRuntimeEndpoint: string;
      classification: string;
    };

    expect(new URL(ready.endpoint).hostname).toBe("127.0.0.1");
    expect(ready.diagnosticRuntimeEndpoint).toBe(ready.endpoint);
    expect(ready.classification).toBe("test-only-local-cloudflare-adapter");
    for (const forbidden of [TOKEN, RUNTIME_NAME, RUNTIME_VALUE, "Takosumi", "materializer"]) {
      expect(line.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }

    const discovery = await fetch(`${ready.endpoint}/.well-known/takoform/v1`).then((response) =>
      response.json(),
    );
    expect(discovery).toMatchObject({
      api_versions: ["forms.takoform.com/v1"],
    });
    for (const authorization of [undefined, "Bearer wrong-local-token"]) {
      const response = await fetch(`${ready.endpoint}/apis/forms.takoform.com/v1/forms`, {
        headers: authorization ? { authorization } : {},
      });
      expect(response.status).toBe(401);
    }

    const authorization = `Bearer ${TOKEN}`;
    const forms = (await fetch(`${ready.endpoint}/apis/forms.takoform.com/v1/forms?space=default`, {
      headers: { authorization },
    }).then((response) => response.json())) as {
      forms: Array<{
        identity: {
          formRef: {
            apiVersion: string;
            kind: string;
            definitionVersion: string;
            schemaDigest: string;
          };
        };
      }>;
    };
    const formRef = forms.forms.find((form) => form.identity.formRef.kind === "EdgeKVNamespace")
      ?.identity.formRef;
    if (!formRef) throw new Error("stable EdgeKVNamespace was not installed");
    const desired = {
      apiVersion: formRef.apiVersion,
      kind: formRef.kind,
      form: { formRef },
      metadata: { name: "generic-kv", space: "default" },
      spec: {},
    };
    const prepared = await fetch(`${ready.endpoint}/apis/forms.takoform.com/v1/resources/prepare`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(desired),
    });
    expect(prepared.status).toBe(200);
    const review = ((await prepared.json()) as { review: Record<string, string> }).review;
    const applied = await fetch(
      `${ready.endpoint}/apis/forms.takoform.com/v1/resources/${formRef.apiVersion}/${formRef.kind}/generic-kv`,
      {
        method: "PUT",
        headers: {
          authorization,
          "content-type": "application/json",
          "idempotency-key": "stable-local-cli-kv-create-0001",
          "if-none-match": "*",
        },
        body: JSON.stringify({ ...desired, review }),
      },
    );
    expect(applied.status).toBe(201);

    child.kill("SIGTERM");
    expect(await childExit(child)).toBe(0);
    children.delete(child);
    await expect(fetch(`${ready.endpoint}/.well-known/takoform/v1`)).rejects.toThrow();
  }, 30_000);

  test("refuses a drifted frozen catalog before binding a listener", async () => {
    const root = await mkdtemp(join(tmpdir(), "takoserver-stable-catalog-drift-"));
    try {
      await cp(TAKOFORM_ROOT, root, { recursive: true });
      await writeFile(join(root, "forms/candidates/current-family-index.json"), "{}\n");
      await expect(
        startStableLocalCloudflareHost({
          takoformRepositoryRoot: root,
          token: TOKEN,
          runtimeValues: { [RUNTIME_NAME]: RUNTIME_VALUE },
        }),
      ).rejects.toThrow("frozen_stable_input_mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function readLine(stream: Readable): Promise<string> {
  return await new Promise<string>((resolveLine, rejectLine) => {
    let rendered = "";
    const finish = (): void => {
      clearTimeout(timeout);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const onData = (chunk: Buffer | string): void => {
      rendered += chunk.toString();
      const [line] = rendered.split("\n", 1);
      if (!line || !rendered.includes("\n")) return;
      finish();
      resolveLine(line);
    };
    const onEnd = (): void => {
      finish();
      rejectLine(new Error("stable local launcher did not publish readiness"));
    };
    const onError = (error: Error): void => {
      finish();
      rejectLine(error);
    };
    const timeout = setTimeout(() => {
      finish();
      rejectLine(new Error("stable local launcher did not publish readiness"));
    }, 15_000);
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

async function childExit(child: LauncherChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
}
