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
  /** The definition new resources are created under. */
  readonly form: InstalledTakoformForm;
  readonly providerOffering: ProviderOffering;
  readonly offering: Offering;
  /** Every definition, current and superseded, in order. */
  readonly forms: readonly InstalledTakoformForm[];
  readonly providerOfferings: readonly ProviderOffering[];
  readonly offerings: readonly Offering[];
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

const WORKER_SCRIPT_SCHEMA_V1_1: JsonObject = {
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

/**
 * The retired first definition of WorkerScript. It is kept verbatim, not
 * tidied, because its digest *is* its identity: a resource created under it
 * can only be read, updated, or deleted while this exact shape is installed.
 * Deleting it would strand every resource that named it.
 */
const WORKER_SCRIPT_SCHEMA_V1: JsonObject = {
  type: "object",
  properties: {
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
    workersDevSubdomain: { type: "string", maxLength: 63 },
  },
  required: ["bundle"],
  additionalProperties: false,
};

/**
 * The current definition. Durable Objects are declared alongside bindings
 * because a Worker that uses them cannot be published without also declaring
 * the migration that creates their classes — the two are one operation to
 * Cloudflare, and splitting them would let a caller publish a script whose
 * bindings point at classes that do not exist.
 */
const WORKER_SCRIPT_SCHEMA: JsonObject = {
  ...(WORKER_SCRIPT_SCHEMA_V1_1 as { readonly [key: string]: JsonObject }),
  properties: {
    ...(WORKER_SCRIPT_SCHEMA_V1_1 as { properties: { [key: string]: JsonObject } }).properties,
    durableObjects: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        properties: {
          name: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" },
          className: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" },
          // SQLite-backed classes are created by a different migration verb
          // than the original key-value ones, and the choice is permanent.
          storage: { type: "string", enum: ["sqlite", "key-value"] },
        },
        required: ["name", "className"],
        additionalProperties: false,
      },
    },
  },
};

const OBSERVED_SCHEMA: JsonObject = { type: "object", additionalProperties: true };
const OUTPUT_SCHEMA: JsonObject = { type: "object", additionalProperties: true };

export async function buildEdgeForms(prices: EdgeFormPrices = {}): Promise<EdgeFormBundle> {
  const objectBucket = await lineage({
    kind: "ObjectBucket",
    offeringId: "storage.object.standard",
    providerKind: "object_bucket",
    displayName: "Object bucket",
    unit: "bucket-month",
    unitPriceMinor: prices.objectBucketMinor ?? 500,
    protocols: ["s3"],
    versions: [{ definitionVersion: "1.0.0", desiredSchema: OBJECT_BUCKET_SCHEMA }],
  });
  const sqlDatabase = await lineage({
    kind: "SqlDatabase",
    offeringId: "database.sql.standard",
    providerKind: "sql_database",
    displayName: "SQL database",
    unit: "database-month",
    unitPriceMinor: prices.sqlDatabaseMinor ?? 1_000,
    protocols: [],
    versions: [{ definitionVersion: "1.0.0", desiredSchema: SQL_DATABASE_SCHEMA }],
  });
  const workerScript = await lineage({
    kind: "WorkerScript",
    offeringId: "compute.worker.standard",
    providerKind: "worker_script",
    displayName: "Worker",
    unit: "worker-month",
    unitPriceMinor: prices.workerScriptMinor ?? 1_500,
    protocols: [],
    // The bundle must be a committed artifact before the Form may name it.
    artifactRequirement: { specField: "bundle", kind: "WorkerBundle" },
    versions: [
      // Superseded, and deliberately still here. Resources created under it
      // stay readable, updatable, and deletable.
      { definitionVersion: "1.0.0", desiredSchema: WORKER_SCRIPT_SCHEMA_V1 },
      { definitionVersion: "1.1.0", desiredSchema: WORKER_SCRIPT_SCHEMA_V1_1 },
      { definitionVersion: "1.2.0", desiredSchema: WORKER_SCRIPT_SCHEMA },
    ],
  });

  const all = [objectBucket, sqlDatabase, workerScript];
  return {
    objectBucket,
    sqlDatabase,
    workerScript,
    forms: all.flatMap((entry) => entry.forms),
    providerOfferings: all.flatMap((entry) => entry.providerOfferings),
    offerings: all.flatMap((entry) => entry.offerings),
  };
}

interface FormVersion {
  readonly definitionVersion: string;
  readonly desiredSchema: JsonObject;
}

/**
 * Builds every definition of one Form, current and superseded alike.
 *
 * A Form's identity includes the digest of its schema, so improving a schema
 * mints a different Form. If only the newest were installed, every resource
 * created under an earlier one would become unreachable — not deleted, just
 * unaddressable, which is worse. Keeping the lineage installed is what lets a
 * declaration made last month still be managed today.
 */
async function lineage(input: {
  readonly kind: string;
  readonly offeringId: string;
  readonly providerKind: string;
  readonly displayName: string;
  readonly unit: string;
  readonly unitPriceMinor: number;
  readonly protocols: readonly ("s3" | "openai")[];
  readonly versions: readonly FormVersion[];
  readonly artifactRequirement?: InstalledTakoformForm["artifactRequirement"];
}): Promise<EdgeForm> {
  const built = await Promise.all(
    input.versions.map(async (version, index) => {
      const current = index === input.versions.length - 1;
      return await define({
        ...input,
        definitionVersion: version.definitionVersion,
        desiredSchema: version.desiredSchema,
        // The public offering id belongs to the current definition; a
        // superseded one keeps a version-qualified id so both can coexist.
        offeringId: current ? input.offeringId : `${input.offeringId}@${version.definitionVersion}`,
        retired: !current,
      });
    }),
  );
  const current = built.at(-1);
  if (!current) throw new TypeError(`${input.kind} declares no definitions`);
  return {
    form: current.form,
    providerOffering: current.providerOffering,
    offering: current.offering,
    forms: built.map((entry) => entry.form),
    providerOfferings: built.map((entry) => entry.providerOffering),
    offerings: built.map((entry) => entry.offering),
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
  readonly definitionVersion: string;
  readonly retired: boolean;
  readonly artifactRequirement?: InstalledTakoformForm["artifactRequirement"];
}): Promise<Definition> {
  const formRef = {
    apiVersion: GROUP,
    kind: input.kind,
    definitionVersion: input.definitionVersion,
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
      ...(input.retired ? { retired: true } : {}),
    },
  };
}

interface Definition {
  readonly form: InstalledTakoformForm;
  readonly providerOffering: ProviderOffering;
  readonly offering: Offering;
}
