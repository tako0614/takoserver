import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalDigest } from "./json.ts";
import type { JsonObject } from "./ports.ts";
import {
  type InstalledTakoformBinding,
  type InstalledTakoformForm,
  TakoformHostError,
  type TakoformResourceDriver,
  type TakoformStandardServiceResolver,
} from "./takoform/types.ts";

const FAMILY_INDEX = "forms/candidates/current-family-index.json";
const SUITE_MANIFEST = "conformance/takoform-v1/manifest.json";
const EXPECTED_FAMILY_INDEX = "337a138c8d2561ade5b5ff44570c0d6a5543922f98d265c961874b06ef7ba703";
const EXPECTED_SUITE_MANIFEST = "7f3547d976592c8b8e71eea20a0b9ba80c5e9aa8e649bb4943a1a155510c83f8";
const verifiedCatalogs = new WeakSet<object>();

export interface StableLocalCatalog {
  readonly forms: readonly InstalledTakoformForm[];
  readonly bindings: readonly InstalledTakoformBinding[];
  readonly provenance: {
    readonly classification: "external-unpublished-test-input";
    readonly familyIndexSha256: `sha256:${string}`;
    readonly suiteManifestSha256: `sha256:${string}`;
    readonly familyCount: number;
    readonly formCount: number;
    readonly bindingCount: number;
    readonly currentObjectBucketInstalled: boolean;
    readonly currentEdgeObjectsInterfaceInstalled: boolean;
  };
}

interface StableArtifacts {
  resolveManifest(
    tenantId: string,
    digest: string,
  ): Promise<{
    readonly kind: string;
    readonly mainModule?: string;
    readonly modules?: readonly {
      readonly name: string;
      readonly mediaType: string;
      readonly size: number;
      readonly digest: string;
    }[];
  } | null>;
  resolveBlob(tenantId: string, digest: string): Promise<Uint8Array | null>;
}

export interface StableLocalWorkerComposition {
  readonly driver: TakoformResourceDriver;
  form(kind: string): InstalledTakoformForm;
  dispatch(hostname: string, request: Request): Promise<Response>;
  /** Dispatches the sole published worker used by the disposable network tracer. */
  dispatchPublished(request: Request): Promise<Response>;
  report(): {
    readonly classification: "test-only";
    readonly endpointAdmissionEvidence: false;
    readonly runtimeBackendEvidence: false;
    readonly materializedVersions: number;
    readonly publishedWorkers: number;
    readonly portableObjectBucketIdentities: 0;
    readonly currentEdgeObjectsReferences: 0;
    readonly nativeBindings: readonly {
      readonly name: string;
      readonly type: "r2_bucket";
      readonly service: {
        readonly apiVersion: string;
        readonly protocol: string;
      };
    }[];
  };
  dispose(): Promise<void>;
}

type StableFetchHandler = (
  request: Request,
  env: Readonly<Record<string, unknown>>,
  context: {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  },
) => Response | Promise<Response>;

/**
 * Load the provider-era 31/8 local fixture. This corpus is intentionally
 * test-only and is not the source for the generated production catalog.
 */
export async function loadProviderEraTestCatalog(
  repositoryRoot: string,
): Promise<StableLocalCatalog> {
  const root = resolve(repositoryRoot);
  const indexBytes = await requiredBytes(root, FAMILY_INDEX);
  const suiteBytes = await requiredBytes(root, SUITE_MANIFEST);
  const indexDigest = await sha256(indexBytes);
  const suiteDigest = await sha256(suiteBytes);
  if (indexDigest !== EXPECTED_FAMILY_INDEX || suiteDigest !== EXPECTED_SUITE_MANIFEST) {
    throw new Error("frozen_stable_input_mismatch");
  }
  const index = object(JSON.parse(new TextDecoder().decode(indexBytes)));
  const families = array(index.families);
  const forms: InstalledTakoformForm[] = [];
  for (const familyValue of families) {
    const family = object(familyValue);
    const group = string(family.group);
    const candidatePath = string(family.candidateSet);
    const candidateBytes = await requiredBytes(root, candidatePath);
    if ((await sha256(candidateBytes)) !== string(family.sha256)) {
      throw new Error("frozen_stable_input_mismatch");
    }
    const candidate = object(JSON.parse(new TextDecoder().decode(candidateBytes)));
    if (string(candidate.family) !== group) throw new Error("frozen_stable_input_mismatch");
    const entries = array(candidate.forms);
    if (entries.length !== number(family.formCount)) {
      throw new Error("frozen_stable_input_mismatch");
    }
    for (const entryValue of entries) {
      const entry = object(entryValue);
      const packageRoot = string(entry.path);
      const packageIndexBytes = await requiredBytes(root, `${packageRoot}/package-index.json`);
      const packageIndex = object(JSON.parse(new TextDecoder().decode(packageIndexBytes)));
      for (const fileValue of array(packageIndex.files)) {
        const file = object(fileValue);
        const bytes = await requiredBytes(root, `${packageRoot}/${string(file.path)}`);
        if (
          bytes.byteLength !== number(file.size) ||
          `sha256:${await sha256(bytes)}` !== file.digest
        ) {
          throw new Error("frozen_stable_input_mismatch");
        }
      }
      const definition = object(
        JSON.parse(
          new TextDecoder().decode(
            await requiredBytes(root, `${packageRoot}/${string(packageIndex.definitionPath)}`),
          ),
        ),
      );
      const ref = object(entry.formRef);
      if (
        definition.apiVersion !== ref.apiVersion ||
        definition.kind !== ref.kind ||
        definition.definitionVersion !== ref.definitionVersion
      ) {
        throw new Error("frozen_stable_input_mismatch");
      }
      forms.push(installedForm(definition, ref, string(entry.packageDigest)));
    }
  }
  const bindingRef = object(index.bindingCandidateSet);
  const bindingBytes = await requiredBytes(root, string(bindingRef.path));
  if ((await sha256(bindingBytes)) !== string(bindingRef.sha256)) {
    throw new Error("frozen_stable_input_mismatch");
  }
  const bindingSet = object(JSON.parse(new TextDecoder().decode(bindingBytes)));
  const bindingEntries = array(bindingSet.bindings);
  const acceptedBindings = forms.flatMap((form) => form.acceptedBindings ?? []);
  const bindings: InstalledTakoformBinding[] = [];
  for (const entryValue of bindingEntries) {
    const entry = object(entryValue);
    const name = string(entry.name);
    const version = string(entry.version);
    const expectedDigest = string(entry.schemaDigest);
    const definition = object(
      JSON.parse(
        new TextDecoder().decode(
          await requiredBytes(root, `bindings/candidates/v1alpha2/${name}/definition.json`),
        ),
      ),
    );
    const ref = acceptedBindings.find(
      (candidate) =>
        candidate.name === name &&
        candidate.version === version &&
        candidate.schemaDigest === expectedDigest,
    );
    if (
      definition.apiVersion !== "bindings.takoform.com/v1alpha2" ||
      definition.kind !== "BindingDefinition" ||
      definition.name !== name ||
      definition.version !== version ||
      !ref ||
      (await canonicalDigest(definition)) !== expectedDigest ||
      !["identity", "revision", "deployment", "attachment", "policy"].includes(
        string(definition.sourceRole),
      ) ||
      typeof definition.targetInterface !== "object" ||
      definition.targetInterface === null ||
      Array.isArray(definition.targetInterface) ||
      !Array.isArray(definition.allowedTargetForms)
    ) {
      throw new Error("frozen_stable_input_mismatch");
    }
    bindings.push({
      bindingRef: structuredClone(ref),
      sourceRole: definition.sourceRole as InstalledTakoformBinding["sourceRole"],
      targetInterface: structuredClone(
        definition.targetInterface,
      ) as InstalledTakoformBinding["targetInterface"],
      allowedTargetForms: structuredClone(
        definition.allowedTargetForms,
      ) as InstalledTakoformBinding["allowedTargetForms"],
    });
  }
  const interfaceRef = object(index.interfaceCandidateSet);
  const interfaceBytes = await requiredBytes(root, string(interfaceRef.path));
  if ((await sha256(interfaceBytes)) !== string(interfaceRef.sha256)) {
    throw new Error("frozen_stable_input_mismatch");
  }
  const interfaces = array(object(JSON.parse(new TextDecoder().decode(interfaceBytes))).interfaces);
  if (
    forms.length !== 31 ||
    families.length !== 8 ||
    bindings.length !== 6 ||
    bindings.length !== acceptedBindings.length
  ) {
    throw new Error("frozen_stable_input_mismatch");
  }
  const catalog: StableLocalCatalog = {
    forms,
    bindings,
    provenance: {
      classification: "external-unpublished-test-input",
      familyIndexSha256: `sha256:${indexDigest}`,
      suiteManifestSha256: `sha256:${suiteDigest}`,
      familyCount: families.length,
      formCount: forms.length,
      bindingCount: bindings.length,
      currentObjectBucketInstalled: forms.some(
        (form) => form.identity.formRef.kind === "ObjectBucket",
      ),
      currentEdgeObjectsInterfaceInstalled: interfaces.some(
        (value) => object(value).name === "edge.objects",
      ),
    },
  };
  if (
    catalog.provenance.currentObjectBucketInstalled ||
    catalog.provenance.currentEdgeObjectsInterfaceInstalled
  ) {
    throw new Error("frozen_stable_input_mismatch");
  }
  verifiedCatalogs.add(catalog);
  return catalog;
}

export function createStableLocalS3Resolver(): TakoformStandardServiceResolver {
  return {
    async satisfiable(input) {
      return (
        input.serviceRef.apiVersion === "standards.takoform.com/v1" &&
        input.serviceRef.protocol === "com.amazonaws.s3"
      );
    },
    async resolve(input) {
      if (
        input.slot.service.apiVersion !== "standards.takoform.com/v1" ||
        input.slot.service.protocol !== "com.amazonaws.s3"
      ) {
        return null;
      }
      const bucket = `stable-local-${(
        await sha256(
          new TextEncoder().encode(`${input.tenantId}\0${input.space}\0${input.slot.name}`),
        )
      ).slice(0, 24)}`;
      return {
        endpoint: { implementation: "test-only-memory-r2", bucket },
        credential: { authority: "sealed-local-test-material" },
      };
    },
  };
}

export function createStableLocalWorkerComposition(input: {
  readonly catalog: StableLocalCatalog;
  readonly artifacts: StableArtifacts;
  readonly dataRoot?: string;
}): StableLocalWorkerComposition {
  if (!verifiedCatalogs.has(input.catalog) || input.catalog.forms.length !== 31) {
    throw new Error("stable_local_catalog_unverified");
  }
  const root = resolve(
    input.dataRoot ?? join(tmpdir(), `takoserver-stable-local-${crypto.randomUUID()}`),
  );
  const workers = new Map<string, string>();
  const versions = new Map<
    string,
    {
      readonly module: { readonly default?: { fetch?: StableFetchHandler } };
      readonly tenantId: string;
      readonly space: string;
      readonly vars: Readonly<Record<string, unknown>>;
      readonly services: readonly {
        readonly name: string;
        readonly service: {
          readonly apiVersion: string;
          readonly protocol: string;
        };
      }[];
    }
  >();
  const activeVersions = new Map<string, string>();
  const endpoints = new Map<string, string>();
  const buckets = new Map<string, MemoryR2Bucket>();
  const nativeBindings: {
    name: string;
    type: "r2_bucket";
    service: { apiVersion: string; protocol: string };
  }[] = [];

  const form = (kind: string): InstalledTakoformForm => {
    const matches = input.catalog.forms.filter(
      (candidate) =>
        candidate.identity.formRef.apiVersion === "edge.forms.takoform.com" &&
        candidate.identity.formRef.kind === kind,
    );
    if (matches.length !== 1 || !matches[0]) throw new Error("stable_local_form_missing");
    return matches[0];
  };

  const driver: TakoformResourceDriver = {
    async apply(value) {
      switch (value.form.identity.formRef.kind) {
        case "ModuleWorker":
          workers.set(value.resourceUid, value.resourceUid);
          return { observed: {} };
        case "WorkerBundle":
          return { observed: structuredClone(value.spec) };
        case "WorkerVersion": {
          const declared = Array.isArray(value.spec.externalServices)
            ? value.spec.externalServices
            : [];
          const supplied = value.standardServices ?? [];
          for (const slotValue of declared) {
            const slot = object(slotValue);
            const service = object(slot.service);
            const required = slot.required !== false;
            if (
              required &&
              !supplied.some(
                (candidate) =>
                  candidate.name === slot.name &&
                  candidate.service.apiVersion === service.apiVersion &&
                  candidate.service.protocol === service.protocol,
              )
            ) {
              throw new TakoformHostError("unsupported_capability", 422);
            }
          }
          const bundle = value.relations.find((relation) => relation.pointer === "/bundle");
          const manifestDigest = bundle?.resource.spec.manifestDigest;
          if (typeof manifestDigest !== "string") {
            throw new TakoformHostError("artifact_invalid", 400);
          }
          const manifest = await input.artifacts.resolveManifest(value.tenantId, manifestDigest);
          const main = manifest?.modules?.find((module) => module.name === manifest.mainModule);
          const bytes = main
            ? await input.artifacts.resolveBlob(value.tenantId, main.digest)
            : null;
          if (!manifest || !main || !bytes || bytes.byteLength !== main.size) {
            throw new TakoformHostError("artifact_missing", 404);
          }
          const modulePath = join(root, "modules", `${safe(value.resourceUid)}.mjs`);
          await mkdir(dirname(modulePath), { recursive: true });
          await writeFile(modulePath, bytes);
          const module = (await import(
            `${pathToFileURL(modulePath).href}?operation=${encodeURIComponent(value.operationId)}`
          )) as { readonly default?: { fetch?: StableFetchHandler } };
          const services = supplied.map((candidate) => ({
            name: candidate.name,
            service: structuredClone(candidate.service),
          }));
          versions.set(value.resourceUid, {
            module,
            tenantId: value.tenantId,
            space: value.space,
            vars:
              typeof value.spec.vars === "object" &&
              value.spec.vars !== null &&
              !Array.isArray(value.spec.vars)
                ? structuredClone(value.spec.vars as Record<string, unknown>)
                : {},
            services,
          });
          for (const candidate of services) {
            if (
              candidate.service.apiVersion === "standards.takoform.com/v1" &&
              candidate.service.protocol === "com.amazonaws.s3"
            ) {
              const key = `${value.tenantId}\0${value.space}\0${candidate.name}`;
              if (!buckets.has(key)) buckets.set(key, new MemoryR2Bucket());
              if (!nativeBindings.some((binding) => binding.name === candidate.name)) {
                nativeBindings.push({
                  name: candidate.name,
                  type: "r2_bucket",
                  service: structuredClone(candidate.service),
                });
              }
            }
          }
          return { observed: {}, outputs: {} };
        }
        case "WorkerDeployment": {
          const worker = value.relations.find((relation) => relation.pointer === "/worker");
          const version = value.relations.find(
            (relation) => relation.pointer === "/versions/0/workerVersion",
          );
          if (!worker || !version || !versions.has(version.targetUid)) {
            throw new TakoformHostError("invalid_argument", 400);
          }
          activeVersions.set(worker.targetUid, version.targetUid);
          return { observed: {}, outputs: {} };
        }
        case "WorkerEndpoint": {
          const worker = value.relations.find((relation) => relation.pointer === "/worker");
          if (!worker || !activeVersions.has(worker.targetUid)) {
            throw new TakoformHostError("invalid_argument", 400);
          }
          const hostname = `worker-${(
            await sha256(new TextEncoder().encode(worker.targetUid))
          ).slice(0, 24)}.stable-local.invalid`;
          endpoints.set(hostname, worker.targetUid);
          return {
            observed: {},
            outputs: { hostname, url: `https://${hostname}/` },
          };
        }
        default:
          throw new TakoformHostError("unsupported_capability", 422);
      }
    },
    async observe(value) {
      return {
        ...(value.resource.status.observed
          ? { observed: structuredClone(value.resource.status.observed) }
          : {}),
        ...(value.resource.status.outputs
          ? { outputs: structuredClone(value.resource.status.outputs) }
          : {}),
      };
    },
    async delete(value) {
      workers.delete(value.resourceUid);
      versions.delete(value.resourceUid);
      activeVersions.delete(value.resourceUid);
    },
  };

  return {
    driver,
    form,
    async dispatch(hostname, request) {
      const workerUid = endpoints.get(hostname);
      const versionUid = workerUid ? activeVersions.get(workerUid) : undefined;
      const version = versionUid ? versions.get(versionUid) : undefined;
      const handler = version?.module.default?.fetch;
      if (!workerUid || !versionUid || !version || typeof handler !== "function") {
        return new Response("stable local worker not found\n", { status: 404 });
      }
      const env: Record<string, unknown> = structuredClone(version.vars);
      for (const slot of version.services) {
        if (
          slot.service.apiVersion === "standards.takoform.com/v1" &&
          slot.service.protocol === "com.amazonaws.s3"
        ) {
          const key = `${version.tenantId}\0${version.space}\0${slot.name}`;
          env[slot.name] = buckets.get(key) ?? new MemoryR2Bucket();
        }
      }
      const response = await handler.call(version.module.default, request, env, {
        waitUntil() {},
        passThroughOnException() {},
      });
      return response instanceof Response
        ? response
        : new Response("stable local worker returned no Response\n", {
            status: 500,
          });
    },
    async dispatchPublished(request) {
      if (endpoints.size !== 1) {
        return new Response("stable local tracer requires exactly one published worker\n", {
          status: 409,
        });
      }
      const hostname = endpoints.keys().next().value;
      return typeof hostname === "string"
        ? await this.dispatch(hostname, request)
        : new Response("stable local worker not found\n", { status: 404 });
    },
    report() {
      return {
        classification: "test-only",
        endpointAdmissionEvidence: false,
        runtimeBackendEvidence: false,
        materializedVersions: versions.size,
        publishedWorkers: endpoints.size,
        portableObjectBucketIdentities: 0,
        currentEdgeObjectsReferences: 0,
        nativeBindings: structuredClone(nativeBindings),
      };
    },
    async dispose() {
      workers.clear();
      versions.clear();
      activeVersions.clear();
      endpoints.clear();
      buckets.clear();
      await rm(root, { recursive: true, force: true });
    },
  };
}

class MemoryR2Bucket {
  readonly #objects = new Map<
    string,
    {
      readonly bytes: Uint8Array;
      readonly etag: string;
      readonly httpMetadata?: Record<string, string>;
      readonly customMetadata?: Record<string, string>;
    }
  >();

  async put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    options: {
      readonly httpMetadata?: Record<string, string>;
      readonly customMetadata?: Record<string, string>;
    } = {},
  ) {
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : new Uint8Array(value);
    const etag = await sha256(bytes);
    this.#objects.set(key, {
      bytes: new Uint8Array(bytes),
      etag,
      ...(options.httpMetadata ? { httpMetadata: structuredClone(options.httpMetadata) } : {}),
      ...(options.customMetadata
        ? { customMetadata: structuredClone(options.customMetadata) }
        : {}),
    });
    return this.#head(key);
  }

  async head(key: string) {
    return this.#head(key);
  }

  async get(key: string) {
    const value = this.#objects.get(key);
    if (!value) return null;
    return {
      ...this.#head(key),
      text: async () => new TextDecoder().decode(value.bytes),
      arrayBuffer: async () => value.bytes.buffer.slice(0),
    };
  }

  async list(options: { readonly prefix?: string; readonly limit?: number } = {}) {
    const prefix = options.prefix ?? "";
    const limit = options.limit ?? 1_000;
    const objects = [...this.#objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(0, limit)
      .map((key) => this.#head(key));
    return { objects, truncated: objects.length < this.#objects.size };
  }

  async delete(keys: string | readonly string[]) {
    for (const key of typeof keys === "string" ? [keys] : keys) this.#objects.delete(key);
  }

  #head(key: string) {
    const value = this.#objects.get(key);
    if (!value) return null;
    return {
      key,
      size: value.bytes.byteLength,
      etag: value.etag,
      ...(value.httpMetadata ? { httpMetadata: structuredClone(value.httpMetadata) } : {}),
      ...(value.customMetadata ? { customMetadata: structuredClone(value.customMetadata) } : {}),
    };
  }
}

function installedForm(
  definition: Record<string, unknown>,
  ref: Record<string, unknown>,
  packageDigest: string,
): InstalledTakoformForm {
  return {
    identity: {
      formRef: {
        apiVersion: string(ref.apiVersion),
        kind: string(ref.kind),
        definitionVersion: string(ref.definitionVersion),
        schemaDigest: digest(ref.schemaDigest),
      },
      packageDigest: digest(packageDigest),
    },
    ...(typeof definition.title === "string" ? { displayName: definition.title } : {}),
    ...(typeof definition.description === "string" ? { description: definition.description } : {}),
    ...(typeof definition.requiresHostApi === "string"
      ? { requiresHostApi: definition.requiresHostApi }
      : {}),
    ...(typeof definition.role === "string"
      ? { role: definition.role as NonNullable<InstalledTakoformForm["role"]> }
      : {}),
    ...(Array.isArray(definition.providedInterfaces)
      ? {
          providedInterfaces: structuredClone(definition.providedInterfaces) as never,
        }
      : {}),
    ...(Array.isArray(definition.acceptedBindings)
      ? {
          acceptedBindings: structuredClone(definition.acceptedBindings) as never,
        }
      : {}),
    desiredSchema: object(definition.desiredSchema) as JsonObject,
    ...(definition.observedSchema
      ? { observedSchema: object(definition.observedSchema) as JsonObject }
      : {}),
    ...(definition.outputSchema
      ? { outputSchema: object(definition.outputSchema) as JsonObject }
      : {}),
    operations: array(definition.lifecycleCapabilities).map(string) as never,
  };
}

async function requiredBytes(root: string, relative: string): Promise<Uint8Array> {
  const path = resolve(root, relative);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error("frozen_stable_input_missing");
  }
  try {
    if (!(await stat(path)).isFile()) throw new Error("not a file");
    return new Uint8Array(await readFile(path));
  } catch {
    throw new Error("frozen_stable_input_missing");
  }
}

async function sha256(value: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function digest(value: unknown): `sha256:${string}` {
  const parsed = string(value);
  if (!/^sha256:[0-9a-f]{64}$/u.test(parsed)) throw new Error("frozen_stable_input_mismatch");
  return parsed as `sha256:${string}`;
}

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 96);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("frozen_stable_input_mismatch");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("frozen_stable_input_mismatch");
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("frozen_stable_input_mismatch");
  return value;
}

function number(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new Error("frozen_stable_input_mismatch");
  return value as number;
}
