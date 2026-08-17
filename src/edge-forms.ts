import type { Offering } from "./catalog.ts";
import { canonicalDigest } from "./json.ts";
import type { JsonObject } from "./ports.ts";
import type { ProviderOffering } from "./provider-port.ts";
import type { InstalledTakoformForm } from "./takoform/types.ts";

/**
 * The Forms Takoserver sells today: an object bucket, a SQL database, and a
 * Worker. Together they are enough to run an application — which is the point,
 * since the platform exists so a customer can declare a whole deployment
 * rather than click through a console.
 *
 * A Form's `schemaDigest` is literally the digest of its desired schema, so
 * identity and definition cannot drift apart: change the schema and you have
 * declared a different Form, which is exactly what an exact-pin protocol
 * should mean. Because that digest is computed rather than typed, these are
 * built asynchronously at startup.
 *
 * One definition produces three views — the installed Form the Host serves,
 * the offering a provider can execute, and the offering the catalog prices —
 * so the three can never disagree about which Form they mean.
 */

const GROUP = "edge.forms.takoform.com/v1beta1";

export interface EdgeForm {
  readonly form: InstalledTakoformForm;
  readonly providerOffering: ProviderOffering;
  readonly offering: Offering;
}

export interface EdgeFormBundle {
  readonly objectBucket: EdgeForm;
  readonly sqlDatabase: EdgeForm;
  readonly workerScript: EdgeForm;
  readonly forms: readonly InstalledTakoformForm[];
  readonly providerOfferings: readonly ProviderOffering[];
  readonly offerings: readonly Offering[];
}

export interface EdgeFormPrices {
  readonly objectBucketMinor?: number;
  readonly sqlDatabaseMinor?: number;
  readonly workerScriptMinor?: number;
}

const OBJECT_BUCKET_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    location: { type: "string", pattern: "^[a-z]{3,8}$" },
  },
  additionalProperties: false,
};

const SQL_DATABASE_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    region: { type: "string", pattern: "^[a-z]{3,8}$" },
  },
  additionalProperties: false,
};

const WORKER_SCRIPT_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    // A committed WorkerBundle manifest the tenant holds. The bytes were
    // uploaded and verified before this Form ever names them.
    bundle: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    compatibilityDate: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
    compatibilityFlags: { type: "array", maxItems: 16, items: { type: "string", maxLength: 64 } },
    bindings: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["d1", "r2_bucket", "kv_namespace", "queue", "service", "plain_text"],
          },
          name: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" },
          databaseId: { type: "string", maxLength: 128 },
          bucketName: { type: "string", maxLength: 128 },
          namespaceId: { type: "string", maxLength: 128 },
          queueName: { type: "string", maxLength: 128 },
          service: { type: "string", maxLength: 128 },
          text: { type: "string", maxLength: 4096 },
        },
        required: ["type", "name"],
        additionalProperties: false,
      },
    },
    // Where the Worker should answer. Either a subdomain of a suffix the
    // platform offers, or a domain the operator has configured this tenant to
    // use. A Worker with no hostname is published but not served, which is a
    // legitimate thing to declare.
    hostnames: {
      type: "array",
      maxItems: 8,
      items: {
        type: "string",
        pattern: "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$",
        maxLength: 253,
      },
    },
  },
  required: ["bundle"],
  additionalProperties: false,
};

const OBSERVED_SCHEMA: JsonObject = { type: "object", additionalProperties: true };
const OUTPUT_SCHEMA: JsonObject = { type: "object", additionalProperties: true };

export async function buildEdgeForms(prices: EdgeFormPrices = {}): Promise<EdgeFormBundle> {
  const objectBucket = await define({
    kind: "ObjectBucket",
    offeringId: "storage.object.standard",
    providerKind: "object_bucket",
    displayName: "Object bucket",
    unit: "bucket-month",
    unitPriceMinor: prices.objectBucketMinor ?? 500,
    protocols: ["s3"],
    desiredSchema: OBJECT_BUCKET_SCHEMA,
  });
  const sqlDatabase = await define({
    kind: "SqlDatabase",
    offeringId: "database.sql.standard",
    providerKind: "sql_database",
    displayName: "SQL database",
    unit: "database-month",
    unitPriceMinor: prices.sqlDatabaseMinor ?? 1_000,
    protocols: [],
    desiredSchema: SQL_DATABASE_SCHEMA,
  });
  const workerScript = await define({
    kind: "WorkerScript",
    offeringId: "compute.worker.standard",
    providerKind: "worker_script",
    displayName: "Worker",
    unit: "worker-month",
    unitPriceMinor: prices.workerScriptMinor ?? 1_500,
    protocols: [],
    desiredSchema: WORKER_SCRIPT_SCHEMA,
    // The bundle must be a committed artifact before the Form may name it.
    artifactRequirement: { specField: "bundle", kind: "WorkerBundle" },
  });

  const all = [objectBucket, sqlDatabase, workerScript];
  return {
    objectBucket,
    sqlDatabase,
    workerScript,
    forms: all.map((entry) => entry.form),
    providerOfferings: all.map((entry) => entry.providerOffering),
    offerings: all.map((entry) => entry.offering),
  };
}

async function define(input: {
  readonly kind: string;
  readonly offeringId: string;
  readonly providerKind: string;
  readonly displayName: string;
  readonly unit: string;
  readonly unitPriceMinor: number;
  readonly protocols: readonly ("s3" | "openai")[];
  readonly desiredSchema: JsonObject;
  readonly artifactRequirement?: InstalledTakoformForm["artifactRequirement"];
}): Promise<EdgeForm> {
  const formRef = {
    apiVersion: GROUP,
    kind: input.kind,
    definitionVersion: "1.0.0",
    schemaDigest: await canonicalDigest(input.desiredSchema),
  } as const;

  const form: InstalledTakoformForm = {
    identity: { formRef },
    displayName: input.displayName,
    desiredSchema: input.desiredSchema,
    observedSchema: OBSERVED_SCHEMA,
    outputSchema: OUTPUT_SCHEMA,
    operations: ["create", "read", "update", "delete", "import", "observe"],
    ...(input.artifactRequirement ? { artifactRequirement: input.artifactRequirement } : {}),
  };

  return {
    form,
    providerOffering: {
      id: input.offeringId,
      kind: input.providerKind,
      displayName: input.displayName,
      form: formRef,
      unit: input.unit,
      unitPriceMinor: input.unitPriceMinor,
      protocols: input.protocols,
      capabilities: ["create", "update", "delete", "import", "observe"],
    },
    offering: {
      id: input.offeringId,
      providerId: "cloudflare",
      kind: input.providerKind,
      displayName: input.displayName,
      form: formRef,
      price: { currency: "USD", unit: input.unit, unitPriceMinor: input.unitPriceMinor },
      protocols: input.protocols,
      available: true,
    },
  };
}
