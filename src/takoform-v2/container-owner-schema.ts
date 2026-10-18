import { CONTAINER_CONTRACT as C } from "../container-contract.ts";
import type { Sql, SqlStatement } from "../ports.ts";
import { parseStrictJson } from "../strict-json.ts";
import {
  prepareV2HostAcceptance,
  type V2HostAcceptance,
  type V2HostAcceptanceContext,
  type V2HostDeleteAcceptanceContext,
} from "./host-acceptance.ts";

export const V2_CONTAINER_F2_FORM = "https://edge.forms.takoform.com/forms/Container/0.2.0/";
const F2_FORM = V2_CONTAINER_F2_FORM;
export function validateV2ContainerF2SensitiveNames(
  value: unknown,
  environmentNames: readonly string[] = [],
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    Object.keys(value).length !== value.length ||
    !Array.from({ length: value.length }, (_, index) =>
      Object.getOwnPropertyDescriptor(value, String(index)),
    ).every(
      (descriptor) => !!descriptor && descriptor.enumerable && Object.hasOwn(descriptor, "value"),
    )
  )
    throw new TypeError("invalid Container F2 sensitive names");
  const names = new Set<string>();
  for (const name of value) {
    if (
      typeof name !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,63}$/u.test(name) ||
      /^(?:CLOUDFLARE_|TAKOFORM_)/u.test(name) ||
      names.has(name) ||
      environmentNames.includes(name)
    )
      throw new TypeError("invalid Container F2 sensitive names");
    names.add(name);
  }
  return Object.freeze([...names].sort());
}
export function serializeV2ContainerConfiguredPrivateInputs(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).length !== 3 ||
    !["keyId", "nonce", "ciphertext"].every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        !!descriptor &&
        descriptor.enumerable &&
        Object.hasOwn(descriptor, "value") &&
        typeof descriptor.value === "string" &&
        descriptor.value.length > 0 &&
        descriptor.value.length <= 1048576
      );
    })
  )
    throw new TypeError("invalid Container configured private inputs");
  const sealed = value as {
    readonly keyId: string;
    readonly nonce: string;
    readonly ciphertext: string;
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(sealed.keyId))
    throw new TypeError("invalid Container configured key identifier");
  return JSON.stringify({
    keyId: sealed.keyId,
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
  });
}
function f2Names(record: Record<string, unknown>): readonly string[] {
  const environment = record[C.fields.environment];
  if (
    environment !== undefined &&
    (!environment || typeof environment !== "object" || Array.isArray(environment))
  )
    throw new TypeError("invalid Container F2 environment");
  const outbound = record[C.fields.outboundInternet];
  if (outbound !== undefined && typeof outbound !== "boolean")
    throw new TypeError("invalid Container F2 egress policy");
  return validateV2ContainerF2SensitiveNames(
    record[C.fields.requiredSensitiveVars] === undefined
      ? []
      : record[C.fields.requiredSensitiveVars],
    environment === undefined ? [] : Object.keys(environment),
  );
}

/** Unregistered Host-owned storage, not migration 0101 or a native authority grant.
 * History has no replay TTL and no cascading dependency on Core replay rows.
 * Only an actual backend-held broker may interpret native observations/transitions.
 */
const MAX = 9_007_199_254_740_991;
const PREFIX = "tf_v2_container_";
const I = `${PREFIX}instances`;
const A = `${PREFIX}acceptances`;
const R = `${PREFIX}revisions`;
const Q = `${PREFIX}create_claims`;
const S = `${PREFIX}start_attempts`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const integer = (name: string, minimum: number) =>
  `typeof(${name}) = 'integer' AND ${name} BETWEEN ${minimum} AND ${MAX}`;
const hex = (name: string) =>
  `typeof(${name}) = 'text' AND length(${name}) = 64 AND ${name} NOT GLOB '*[^0-9a-f]*'`;
const text = (name: string) => `typeof(${name}) = 'text' AND length(${name}) BETWEEN 1 AND 2048`;

interface OwnerObject {
  readonly type: "table" | "index" | "trigger";
  readonly name: string;
  readonly table: string;
  readonly sql: string;
}
const object = (type: OwnerObject["type"], name: string, table: string, sql: string): OwnerObject =>
  Object.freeze({ type, name, table, sql });
const tables = [
  object(
    "table",
    I,
    I,
    `CREATE TABLE ${I} (
  resource_uid TEXT NOT NULL PRIMARY KEY CHECK (${text("resource_uid")}),
  installation_id TEXT NOT NULL CHECK (${text("installation_id")}),
  principal TEXT NOT NULL CHECK (${text("principal")}),
  space TEXT NOT NULL CHECK (${text("space")}),
  name TEXT NOT NULL CHECK (${text("name")}),
  form_url TEXT NOT NULL CHECK(form_url IN (${literal(C.formUrl)},${literal(F2_FORM)})),
  backend_id TEXT NOT NULL CHECK (${text("backend_id")}),
  target_key TEXT NOT NULL CHECK (${text("target_key")}),
  incarnation_id TEXT NOT NULL UNIQUE CHECK (${hex("incarnation_id")}),
  create_operation_id TEXT NOT NULL UNIQUE CHECK (${text("create_operation_id")}),
  desired_generation INTEGER NOT NULL CHECK (${integer("desired_generation", 1)}),
  management_epoch INTEGER NOT NULL CHECK (${integer("management_epoch", 1)}),
  serving_generation INTEGER CHECK (serving_generation IS NULL OR ${integer("serving_generation", 1)}),
  runtime_epoch INTEGER NOT NULL CHECK (${integer("runtime_epoch", 0)}),
  retire_operation_id TEXT CHECK (retire_operation_id IS NULL OR ${text("retire_operation_id")}),
  retired_at_ms INTEGER CHECK (retired_at_ms IS NULL OR ${integer("retired_at_ms", 0)}),
  created_at TEXT NOT NULL CHECK (${text("created_at")}),
  CHECK ((retire_operation_id IS NULL) = (retired_at_ms IS NULL)),
  CHECK (retired_at_ms IS NULL OR serving_generation IS NULL)
)`,
  ),
  // Repeated scope is deliberate: the single fixed terminal needs the complete
  // original context in NEW before its CREATE trigger can establish the birth.
  object(
    "table",
    A,
    A,
    `CREATE TABLE ${A} (
  operation_id TEXT NOT NULL PRIMARY KEY CHECK (${text("operation_id")}),
  resource_uid TEXT NOT NULL REFERENCES ${I}(resource_uid),
  installation_id TEXT NOT NULL CHECK (${text("installation_id")}),
  incarnation_id TEXT NOT NULL CHECK (${hex("incarnation_id")}),
  principal TEXT NOT NULL CHECK (${text("principal")}),
  space TEXT NOT NULL CHECK (${text("space")}),
  name TEXT NOT NULL CHECK (${text("name")}),
  form_url TEXT NOT NULL CHECK(form_url IN (${literal(C.formUrl)},${literal(F2_FORM)})),
  backend_id TEXT NOT NULL CHECK (${text("backend_id")}),
  target_key TEXT NOT NULL CHECK (${text("target_key")}),
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  generation INTEGER NOT NULL CHECK (${integer("generation", 1)}),
  backend_key TEXT NOT NULL CHECK (${text("backend_key")}),
  replay_key TEXT NOT NULL CHECK (${text("replay_key")}),
  fingerprint TEXT NOT NULL CHECK (${text("fingerprint")}),
  accepted_spec_json TEXT NOT NULL CHECK (json_valid(accepted_spec_json) AND json_type(accepted_spec_json) = 'object'),
  accepted_output_json TEXT NOT NULL CHECK (json_valid(accepted_output_json) AND json_type(accepted_output_json) = 'object'),
  references_json TEXT CHECK (references_json IS NULL OR (json_valid(references_json) AND json_type(references_json) = 'array')),
  configured_private_inputs_json TEXT CHECK(configured_private_inputs_json IS NULL OR (form_url = ${literal(F2_FORM)} AND json_valid(configured_private_inputs_json) AND json_type(configured_private_inputs_json) = 'object')),
  accepted_at TEXT NOT NULL CHECK (${text("accepted_at")}),
  retain_until TEXT NOT NULL CHECK (${text("retain_until")}),
  revision TEXT NOT NULL CHECK (length(revision) BETWEEN 3 AND 160),
  UNIQUE (resource_uid, generation)
)`,
  ),
  object(
    "table",
    R,
    R,
    `CREATE TABLE ${R} (
  resource_uid TEXT NOT NULL REFERENCES ${I}(resource_uid),
  generation INTEGER NOT NULL CHECK (${integer("generation", 1)}),
  operation_id TEXT NOT NULL UNIQUE REFERENCES ${A}(operation_id),
  revision TEXT NOT NULL CHECK (length(revision) BETWEEN 3 AND 160),
  intent_json TEXT CHECK (intent_json IS NULL OR (json_valid(intent_json) AND json_type(intent_json) = 'object')),
  native_name TEXT CHECK (native_name IS NULL OR length(native_name) BETWEEN 1 AND 255),
  retention TEXT NOT NULL DEFAULT 'accepted' CHECK (retention IN ('accepted', 'serving', 'draining', 'retired')),
  PRIMARY KEY (resource_uid, generation),
  CHECK ((intent_json IS NULL) = (native_name IS NULL))
)`,
  ),
  object(
    "table",
    Q,
    Q,
    `CREATE TABLE ${Q} (
  resource_uid TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (${integer("generation", 1)}),
  installation_id TEXT NOT NULL CHECK (${text("installation_id")}),
  claim_id TEXT NOT NULL UNIQUE CHECK (${hex("claim_id")}),
  state TEXT NOT NULL CHECK (state IN ('pending', 'bound', 'removed')),
  native_id TEXT CHECK (native_id IS NULL OR ${hex("native_id")}),
  claimed_at_ms INTEGER NOT NULL CHECK (${integer("claimed_at_ms", 0)}),
  bound_at_ms INTEGER CHECK (bound_at_ms IS NULL OR ${integer("bound_at_ms", 0)}),
  removed_at_ms INTEGER CHECK (removed_at_ms IS NULL OR ${integer("removed_at_ms", 0)}),
  PRIMARY KEY (resource_uid, generation),
  FOREIGN KEY (resource_uid, generation) REFERENCES ${R}(resource_uid, generation),
  UNIQUE (installation_id, native_id),
  CHECK ((state = 'pending' AND native_id IS NULL AND bound_at_ms IS NULL AND removed_at_ms IS NULL)
    OR (state = 'bound' AND native_id IS NOT NULL AND bound_at_ms IS NOT NULL AND bound_at_ms >= claimed_at_ms AND removed_at_ms IS NULL)
    OR (state = 'removed' AND native_id IS NOT NULL AND bound_at_ms IS NOT NULL AND removed_at_ms IS NOT NULL AND bound_at_ms >= claimed_at_ms AND removed_at_ms >= bound_at_ms))
)`,
  ),
  object(
    "table",
    S,
    S,
    `CREATE TABLE ${S} (
  resource_uid TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (${integer("generation", 1)}),
  attempt INTEGER NOT NULL CHECK (${integer("attempt", 1)}),
  create_claim_id TEXT NOT NULL REFERENCES ${Q}(claim_id),
  native_id TEXT NOT NULL CHECK (${hex("native_id")}),
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'exited')),
  claimed_at_ms INTEGER NOT NULL CHECK (${integer("claimed_at_ms", 0)}),
  confirmed_running_at_ms INTEGER CHECK (confirmed_running_at_ms IS NULL OR ${integer("confirmed_running_at_ms", 0)}),
  confirmed_exited_at_ms INTEGER CHECK (confirmed_exited_at_ms IS NULL OR ${integer("confirmed_exited_at_ms", 0)}),
  PRIMARY KEY (resource_uid, generation, attempt),
  FOREIGN KEY (resource_uid, generation) REFERENCES ${R}(resource_uid, generation),
  CHECK ((state = 'pending' AND confirmed_running_at_ms IS NULL AND confirmed_exited_at_ms IS NULL)
    OR (state = 'running' AND confirmed_running_at_ms IS NOT NULL AND confirmed_running_at_ms >= claimed_at_ms AND confirmed_exited_at_ms IS NULL)
    OR (state = 'exited' AND confirmed_running_at_ms IS NOT NULL AND confirmed_exited_at_ms IS NOT NULL AND confirmed_running_at_ms >= claimed_at_ms AND confirmed_exited_at_ms >= confirmed_running_at_ms))
)`,
  ),
] as const;
const indexes = [
  object(
    "index",
    `${PREFIX}one_serving`,
    R,
    `CREATE UNIQUE INDEX ${PREFIX}one_serving ON ${R}(resource_uid) WHERE retention = 'serving'`,
  ),
  object(
    "index",
    `${PREFIX}one_start`,
    S,
    `CREATE UNIQUE INDEX ${PREFIX}one_start ON ${S}(resource_uid, generation) WHERE state IN ('pending', 'running')`,
  ),
] as const;

function trigger(name: string, table: string, event: string, body: string): OwnerObject {
  return object(
    "trigger",
    `${PREFIX}${name}`,
    table,
    `CREATE TRIGGER ${PREFIX}${name}\n${event} ON ${table}\nBEGIN\n${body}\nEND`,
  );
}
const refuse = (unless: string) =>
  `  SELECT RAISE(ABORT, 'container_owner_invariant') WHERE (${unless}) IS NOT 1;`;
const same = (columns: readonly string[]) =>
  columns.map((c) => `NEW.${c} IS OLD.${c}`).join(" AND ");
const birth = [
  "resource_uid",
  "installation_id",
  "principal",
  "space",
  "name",
  "form_url",
  "backend_id",
  "target_key",
  "incarnation_id",
  "create_operation_id",
  "created_at",
];
const eligible = (alias: string) => `EXISTS (SELECT 1 FROM ${I} i
  JOIN ${R} r ON r.resource_uid = i.resource_uid AND r.generation = ${alias}.generation
  WHERE i.resource_uid = ${alias}.resource_uid AND i.retired_at_ms IS NULL
    AND r.retention IN ('accepted', 'serving')
    AND (i.desired_generation = r.generation OR i.serving_generation = r.generation))`;

const guards: OwnerObject[] = [
  trigger(
    "instance_birth",
    I,
    "BEFORE INSERT",
    refuse(`NEW.desired_generation = 1
    AND NEW.management_epoch = 1 AND NEW.runtime_epoch = 0 AND NEW.serving_generation IS NULL
    AND NEW.retired_at_ms IS NULL AND NEW.retire_operation_id IS NULL
    AND EXISTS (SELECT 1 FROM main.tf_v2_operations op JOIN main.tf_v2_resources resource ON resource.uid = op.resource_uid
      WHERE op.id = NEW.create_operation_id AND op.action = 'create' AND op.generation = 1
        AND op.status = 'queued' AND op.effect = 'none' AND op.dispatch_possible = 0
        AND op.resource_uid = NEW.resource_uid AND op.principal = NEW.principal
        AND op.backend_id = NEW.backend_id AND op.target_key = NEW.target_key
        AND op.created_at = NEW.created_at AND resource.principal = NEW.principal
        AND resource.space = NEW.space AND resource.name = NEW.name AND resource.form_url = NEW.form_url
        AND resource.backend_id = NEW.backend_id AND resource.target_key = NEW.target_key
        AND resource.generation = 1 AND resource.last_operation = op.id AND resource.busy_operation = op.id
        AND resource.phase = 'pending' AND resource.deleted_at IS NULL)`),
  ),
  trigger(
    "acceptance_graph",
    A,
    "BEFORE INSERT",
    `${refuse(`
    (NEW.configured_private_inputs_json IS NULL OR NEW.form_url = ${literal(F2_FORM)})
    AND (json_type(NEW.accepted_spec_json, '$.requiredSensitiveVars') IS NULL
      OR (json_type(NEW.accepted_spec_json, '$.requiredSensitiveVars') = 'array'
        AND (json_array_length(NEW.accepted_spec_json, '$.requiredSensitiveVars') = 0 OR (NEW.form_url=${literal(F2_FORM)} AND json_array_length(NEW.accepted_spec_json, '$.requiredSensitiveVars') <=64))))
    AND json_type(NEW.accepted_spec_json, '$.workloadRevision') = 'text'
    AND NEW.revision = CAST(NEW.generation AS TEXT) || '-' || json_extract(NEW.accepted_spec_json, '$.workloadRevision')
    AND EXISTS (SELECT 1 FROM main.tf_v2_operations op JOIN main.tf_v2_resources resource ON resource.uid = op.resource_uid
      WHERE op.id = NEW.operation_id AND op.resource_uid = NEW.resource_uid
        AND op.principal = NEW.principal AND op.replay_key = NEW.replay_key
        AND op.request_fingerprint = NEW.fingerprint AND op.action = NEW.action AND op.generation = NEW.generation
        AND op.backend_id = NEW.backend_id AND op.target_key = NEW.target_key AND op.backend_key = NEW.backend_key
        AND op.accepted_spec_json = NEW.accepted_spec_json AND op.created_at = NEW.accepted_at
        AND op.retain_until = NEW.retain_until AND op.status = 'queued' AND op.effect = 'none'
        AND op.dispatch_possible = 0 AND (op.private_inputs_present=0 OR NEW.form_url = ${literal(F2_FORM)})
        AND resource.principal = NEW.principal AND resource.space = NEW.space AND resource.name = NEW.name
        AND resource.form_url = NEW.form_url AND resource.backend_id = NEW.backend_id AND resource.target_key = NEW.target_key
        AND resource.generation = NEW.generation AND resource.last_operation = op.id AND resource.busy_operation = op.id
        AND resource.spec_json = NEW.accepted_spec_json AND resource.output_json = NEW.accepted_output_json
        AND resource.phase = CASE WHEN NEW.action = 'delete' THEN 'deleting' ELSE 'pending' END
        AND resource.deleted_at IS NULL)
    AND (NEW.form_url=${literal(F2_FORM)} OR (NOT EXISTS (SELECT 1 FROM main.tf_v2_configured_private_inputs WHERE resource_uid = NEW.resource_uid)))
    AND ((NEW.references_json IS NULL
      AND NOT EXISTS (SELECT 1 FROM main.tf_v2_operation_reference_sets WHERE operation_id = NEW.operation_id)
      AND NOT EXISTS (SELECT 1 FROM main.tf_v2_operation_references WHERE operation_id = NEW.operation_id))
      OR (NEW.references_json IS NOT NULL
        AND EXISTS (SELECT 1 FROM main.tf_v2_operation_reference_sets WHERE operation_id = NEW.operation_id AND sealed = 1)
        AND (SELECT count(*) FROM main.tf_v2_operation_references WHERE operation_id = NEW.operation_id) = json_array_length(NEW.references_json)
        AND NOT EXISTS (SELECT 1 FROM json_each(NEW.references_json) value WHERE NOT EXISTS (
          SELECT 1 FROM main.tf_v2_operation_references edge WHERE edge.operation_id = NEW.operation_id
            AND edge.target_uid IS json_extract(value.value, '$.resourceUid')
            AND edge.form_url IS json_extract(value.value, '$.formUrl')
            AND edge.readiness IS json_extract(value.value, '$.readiness')
            AND edge.target_spec_path IS json_extract(value.value, '$.targetSpecPath')
            AND edge.target_spec_equals IS json_extract(value.value, '$.targetSpecEquals')))
        AND NOT EXISTS (SELECT 1 FROM main.tf_v2_operation_references edge WHERE edge.operation_id = NEW.operation_id
          AND NOT EXISTS (SELECT 1 FROM json_each(NEW.references_json) value
            WHERE edge.target_uid IS json_extract(value.value, '$.resourceUid')
              AND edge.form_url IS json_extract(value.value, '$.formUrl')
              AND edge.readiness IS json_extract(value.value, '$.readiness')
              AND edge.target_spec_path IS json_extract(value.value, '$.targetSpecPath')
              AND edge.target_spec_equals IS json_extract(value.value, '$.targetSpecEquals')))))`)}
  INSERT INTO ${I} (resource_uid, installation_id, principal, space, name, form_url, backend_id, target_key,
    incarnation_id, create_operation_id, desired_generation, management_epoch, runtime_epoch, created_at)
    SELECT NEW.resource_uid, NEW.installation_id, NEW.principal, NEW.space, NEW.name, NEW.form_url, NEW.backend_id, NEW.target_key,
      NEW.incarnation_id, NEW.operation_id, 1, 1, 0, NEW.accepted_at WHERE NEW.action = 'create' AND NEW.generation = 1;
${refuse(`EXISTS (SELECT 1 FROM ${I} i WHERE i.resource_uid = NEW.resource_uid
    AND i.installation_id = NEW.installation_id AND i.incarnation_id = NEW.incarnation_id
    AND i.principal = NEW.principal AND i.space = NEW.space AND i.name = NEW.name AND i.form_url = NEW.form_url
    AND i.backend_id = NEW.backend_id AND i.target_key = NEW.target_key AND i.retired_at_ms IS NULL
    AND ((NEW.action = 'create' AND NEW.generation = 1 AND i.create_operation_id = NEW.operation_id)
      OR (NEW.action IN ('update', 'delete') AND NEW.generation = i.desired_generation + 1)))`)}`,
  ),
  trigger(
    "acceptance_publish",
    A,
    "AFTER INSERT",
    `  INSERT INTO ${R} (resource_uid, generation, operation_id, revision)
    SELECT NEW.resource_uid, NEW.generation, NEW.operation_id, NEW.revision WHERE NEW.action IN ('create', 'update');
  UPDATE ${I} SET desired_generation = NEW.generation, management_epoch = management_epoch + 1,
    retire_operation_id = CASE WHEN NEW.action = 'delete' THEN NEW.operation_id ELSE retire_operation_id END,
    retired_at_ms = CASE WHEN NEW.action = 'delete' THEN CAST(strftime('%s', NEW.accepted_at) AS INTEGER) * 1000 ELSE retired_at_ms END,
    serving_generation = CASE WHEN NEW.action = 'delete' THEN NULL ELSE serving_generation END,
    runtime_epoch = runtime_epoch + CASE WHEN NEW.action = 'delete' THEN 1 ELSE 0 END
    WHERE resource_uid = NEW.resource_uid AND NEW.action <> 'create';`,
  ),
  trigger(
    "instance_transition",
    I,
    "BEFORE UPDATE",
    refuse(`${same(birth)}
    AND (OLD.retired_at_ms IS NULL OR (${same(["desired_generation", "management_epoch", "serving_generation", "runtime_epoch", "retire_operation_id", "retired_at_ms"])}))
    AND ((NEW.desired_generation = OLD.desired_generation AND NEW.management_epoch = OLD.management_epoch)
      OR (NEW.desired_generation = OLD.desired_generation + 1 AND NEW.management_epoch = OLD.management_epoch + 1
        AND EXISTS (SELECT 1 FROM ${A} a WHERE a.resource_uid = OLD.resource_uid AND a.generation = NEW.desired_generation
          AND a.action IN ('update', 'delete'))))
    AND ((NEW.retire_operation_id IS OLD.retire_operation_id AND NEW.retired_at_ms IS OLD.retired_at_ms)
      OR (OLD.retired_at_ms IS NULL AND NEW.retired_at_ms IS NOT NULL AND EXISTS (SELECT 1 FROM ${A} a
        WHERE a.operation_id = NEW.retire_operation_id AND a.resource_uid = OLD.resource_uid
          AND a.action = 'delete' AND a.generation = NEW.desired_generation)))
    AND ((NEW.serving_generation IS OLD.serving_generation AND NEW.retired_at_ms IS OLD.retired_at_ms AND NEW.runtime_epoch = OLD.runtime_epoch)
      OR ((NEW.serving_generation IS NOT OLD.serving_generation OR NEW.retired_at_ms IS NOT OLD.retired_at_ms)
        AND NEW.runtime_epoch = OLD.runtime_epoch + 1))
    AND (NEW.serving_generation IS OLD.serving_generation OR NEW.serving_generation IS NULL OR (NEW.retired_at_ms IS NULL AND EXISTS (SELECT 1 FROM ${R} r
      WHERE r.resource_uid = OLD.resource_uid AND r.generation = NEW.serving_generation AND r.retention IN ('accepted', 'serving')
        AND EXISTS (SELECT 1 FROM ${Q} q JOIN ${S} s ON s.create_claim_id = q.claim_id
          WHERE q.resource_uid = r.resource_uid AND q.generation = r.generation AND q.state = 'bound'
            AND s.resource_uid = q.resource_uid AND s.generation = q.generation AND s.native_id = q.native_id AND s.state = 'running'))))`),
  ),
  trigger(
    "instance_serving",
    I,
    "AFTER UPDATE",
    `  UPDATE ${R} SET retention = CASE WHEN NEW.retired_at_ms IS NOT NULL THEN 'retired' ELSE 'draining' END
    WHERE resource_uid = NEW.resource_uid AND retention = 'serving' AND generation IS NOT NEW.serving_generation;
  UPDATE ${R} SET retention = 'serving'
    WHERE resource_uid = NEW.resource_uid AND generation = NEW.serving_generation AND retention <> 'serving';
  UPDATE ${R} SET retention = 'retired' WHERE resource_uid = NEW.resource_uid AND NEW.retired_at_ms IS NOT NULL AND retention <> 'retired';`,
  ),
  trigger(
    "revision_birth",
    R,
    "BEFORE INSERT",
    refuse(`NEW.intent_json IS NULL AND NEW.native_name IS NULL AND NEW.retention = 'accepted'
    AND EXISTS (SELECT 1 FROM ${A} a WHERE a.operation_id = NEW.operation_id AND a.resource_uid = NEW.resource_uid
      AND a.generation = NEW.generation AND a.action IN ('create', 'update') AND a.revision = NEW.revision)`),
  ),
  trigger(
    "revision_transition",
    R,
    "BEFORE UPDATE",
    refuse(`${same(["resource_uid", "generation", "operation_id", "revision"])}
    AND ((${same(["intent_json", "native_name"])}) OR (OLD.intent_json IS NULL AND NEW.intent_json IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ${Q} q WHERE q.resource_uid = OLD.resource_uid AND q.generation = OLD.generation)
      AND ${eligible("NEW")}
      AND (SELECT count(*) FROM json_each(NEW.intent_json)) = 9
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.intent_json) WHERE key NOT IN
        ('installationId', 'resourceUid', 'incarnationId', 'revision', 'nativeName', 'identityLabel', 'revisionLabel', 'policy', 'requiredSecretNames'))
      AND json_type(NEW.intent_json, '$.identityLabel') = 'text' AND length(json_extract(NEW.intent_json, '$.identityLabel')) BETWEEN 1 AND 255
      AND json_type(NEW.intent_json, '$.revisionLabel') = 'text' AND length(json_extract(NEW.intent_json, '$.revisionLabel')) BETWEEN 1 AND 255
      AND json_type(NEW.intent_json, '$.requiredSecretNames') = 'array' AND (json_array_length(NEW.intent_json,'$.requiredSecretNames')=0 OR (json_array_length(NEW.intent_json,'$.requiredSecretNames')<=64 AND EXISTS(SELECT 1 FROM main.${I} f2_instance WHERE f2_instance.resource_uid=NEW.resource_uid AND f2_instance.form_url=${literal(F2_FORM)})))
      AND json_type(NEW.intent_json, '$.policy') = 'object'
      AND (SELECT count(*) FROM json_each(NEW.intent_json, '$.policy')) = 4
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.intent_json, '$.policy') WHERE key NOT IN ('tenantRef', 'generation', 'policyDigest', 'outboundInternet'))
      AND json_type(NEW.intent_json, '$.policy.tenantRef') = 'text' AND length(json_extract(NEW.intent_json, '$.policy.tenantRef')) BETWEEN 1 AND 2048
      AND json_extract(NEW.intent_json, '$.policy.generation') = NEW.generation
      AND json_type(NEW.intent_json, '$.policy.generation') = 'integer'
      AND json_type(NEW.intent_json, '$.policy.outboundInternet') IN ('true', 'false')
      AND length(json_extract(NEW.intent_json, '$.policy.policyDigest')) = 71
      AND substr(json_extract(NEW.intent_json, '$.policy.policyDigest'), 1, 7) = 'sha256:'
      AND substr(json_extract(NEW.intent_json, '$.policy.policyDigest'), 8) NOT GLOB '*[^0-9a-f]*'
      AND json_extract(NEW.intent_json, '$.resourceUid') = NEW.resource_uid
      AND json_extract(NEW.intent_json, '$.revision') = NEW.revision
      AND json_extract(NEW.intent_json, '$.nativeName') = NEW.native_name
      AND EXISTS (SELECT 1 FROM ${I} i WHERE i.resource_uid = NEW.resource_uid
        AND json_extract(NEW.intent_json, '$.installationId') = i.installation_id
        AND json_extract(NEW.intent_json, '$.incarnationId') = i.incarnation_id
        AND NOT EXISTS (SELECT 1 FROM ${R} other JOIN ${I} owner ON owner.resource_uid = other.resource_uid
          WHERE owner.installation_id = i.installation_id AND other.native_name = NEW.native_name))))
    AND (NEW.retention = OLD.retention
      OR (OLD.retention = 'accepted' AND NEW.retention = 'serving' AND EXISTS (SELECT 1 FROM ${I} i WHERE i.resource_uid = NEW.resource_uid AND i.serving_generation = NEW.generation AND i.retired_at_ms IS NULL))
      OR (OLD.retention = 'serving' AND NEW.retention = 'draining' AND EXISTS (SELECT 1 FROM ${I} i WHERE i.resource_uid = NEW.resource_uid AND i.serving_generation IS NOT NEW.generation))
      OR (OLD.retention IN ('accepted', 'serving', 'draining') AND NEW.retention = 'retired'
        AND EXISTS (SELECT 1 FROM ${I} i WHERE i.resource_uid = NEW.resource_uid AND i.serving_generation IS NOT NEW.generation)))`),
  ),
  trigger(
    "create_claim",
    Q,
    "BEFORE INSERT",
    refuse(`NEW.state = 'pending' AND ${eligible("NEW")}
    AND EXISTS (SELECT 1 FROM ${I} i JOIN ${R} r ON r.resource_uid = i.resource_uid
      WHERE i.resource_uid = NEW.resource_uid AND r.generation = NEW.generation
        AND i.installation_id = NEW.installation_id AND r.intent_json IS NOT NULL AND r.native_name IS NOT NULL)`),
  ),
  trigger(
    "create_transition",
    Q,
    "BEFORE UPDATE",
    refuse(`${same(["resource_uid", "generation", "installation_id", "claim_id", "claimed_at_ms"])}
    AND ((${same(["state", "native_id", "bound_at_ms", "removed_at_ms"])})
      OR (OLD.state = 'pending' AND NEW.state = 'bound' AND NEW.native_id IS NOT NULL AND NEW.bound_at_ms IS NOT NULL AND NEW.removed_at_ms IS NULL)
      OR (OLD.state = 'bound' AND NEW.state = 'removed' AND NEW.native_id IS OLD.native_id AND NEW.bound_at_ms IS OLD.bound_at_ms
        AND NOT EXISTS (SELECT 1 FROM ${S} s WHERE s.resource_uid = OLD.resource_uid AND s.generation = OLD.generation AND s.state IN ('pending', 'running'))))`),
  ),
  trigger(
    "start_claim",
    S,
    "BEFORE INSERT",
    refuse(`NEW.state = 'pending' AND ${eligible("NEW")}
    AND EXISTS (SELECT 1 FROM ${Q} q WHERE q.resource_uid = NEW.resource_uid AND q.generation = NEW.generation
      AND q.claim_id = NEW.create_claim_id AND q.native_id = NEW.native_id AND q.state = 'bound')
    AND NEW.attempt = COALESCE((SELECT max(attempt) + 1 FROM ${S} WHERE resource_uid = NEW.resource_uid AND generation = NEW.generation), 1)
    AND NOT EXISTS (SELECT 1 FROM ${S} s WHERE s.resource_uid = NEW.resource_uid AND s.generation = NEW.generation AND s.state <> 'exited')
    AND NEW.claimed_at_ms >= COALESCE((SELECT max(confirmed_exited_at_ms) FROM ${S} WHERE resource_uid = NEW.resource_uid AND generation = NEW.generation), 0)`),
  ),
  trigger(
    "start_transition",
    S,
    "BEFORE UPDATE",
    refuse(`${same(["resource_uid", "generation", "attempt", "create_claim_id", "native_id", "claimed_at_ms"])}
    AND ((${same(["state", "confirmed_running_at_ms", "confirmed_exited_at_ms"])})
      OR (OLD.state = 'pending' AND NEW.state = 'running' AND NEW.confirmed_running_at_ms IS NOT NULL AND NEW.confirmed_exited_at_ms IS NULL)
      OR (OLD.state = 'running' AND NEW.state = 'exited' AND NEW.confirmed_running_at_ms IS OLD.confirmed_running_at_ms AND NEW.confirmed_exited_at_ms IS NOT NULL))`),
  ),
];
for (const table of [I, A, R, Q, S]) {
  guards.push(
    trigger(
      `${table.slice(PREFIX.length)}_retain`,
      table,
      "BEFORE DELETE",
      "  SELECT RAISE(ABORT, 'container_owner_history_retained');",
    ),
  );
}
guards.push(
  trigger(
    "acceptance_immutable",
    A,
    "BEFORE UPDATE",
    "  SELECT RAISE(ABORT, 'container_owner_acceptance_immutable');",
  ),
);

/** Fixed objects only, no caller DDL and no installation side effects on import. */
export const V2_CONTAINER_OWNER_RECIPE = Object.freeze({
  tables: Object.freeze(tables),
  indexes: Object.freeze(indexes),
  guards: Object.freeze(guards),
  objects: Object.freeze([...tables, ...indexes, ...guards]),
});
const objects = V2_CONTAINER_OWNER_RECIPE.objects;
const names = objects.map((item) => literal(item.name)).join(", ");
const tableNames = tables.map((item) => literal(item.name)).join(", ");

/** Main-pinned complete owning shape; it proves storage only, never current authority. */
const expectedRows = Object.freeze(
  objects.map((item) =>
    Object.freeze<[string, string, string, string]>([item.type, item.name, item.table, item.sql]),
  ),
);
const readyPredicate = (
  encodeValue: (value: string, rowIndex: number, columnIndex: number) => string,
): string => `(
  ${expectedRows.map((row, rowIndex) => `(SELECT count(*) FROM main.sqlite_schema WHERE type = ${encodeValue(row[0], rowIndex, 0)} AND name = ${encodeValue(row[1], rowIndex, 1)} AND tbl_name = ${encodeValue(row[2], rowIndex, 2)} AND sql = ${encodeValue(row[3], rowIndex, 3)}) = 1`).join("\n  AND ")}
  AND NOT EXISTS (SELECT 1 FROM main.sqlite_schema WHERE sql IS NOT NULL
    AND (lower(substr(name, 1, ${PREFIX.length})) = ${literal(PREFIX)} OR tbl_name IN (${tableNames})) AND name NOT IN (${names}))
  AND NOT EXISTS (SELECT 1 FROM  main.sqlite_schema source  WHERE CASE WHEN lower(source.name) IN ('_cf_kv', '_cf_metadata')  AND source.sql IS NOT NULL AND instr(upper(source.sql), 'REFERENCES') = 0 THEN 0 ELSE EXISTS (SELECT 1 FROM  pragma_foreign_key_list(source.name, 'main') fk
     WHERE  source.type = 'table' AND lower(fk."table") IN (${tableNames}) AND source.name NOT IN (${tableNames})) END)
  AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check(NULL, 'main') WHERE "table" IN (${tableNames}))
)`;
export const V2_CONTAINER_OWNER_READY = readyPredicate(literal);
const runtimeReadyParams = Object.freeze([JSON.stringify(expectedRows)]);
const runtimeReady =
  "(WITH container_owner_expected_values(document) AS (VALUES (?)) SELECT " +
  readyPredicate(
    (_value, rowIndex, columnIndex) =>
      `json_extract((SELECT document FROM container_owner_expected_values), '$[${rowIndex}][${columnIndex}]')`,
  ) +
  ")";

export async function inspectV2ContainerOwnerSchema(sql: Sql): Promise<boolean> {
  try {
    const rows = await sql.query(`SELECT ${runtimeReady} AS ready`, runtimeReadyParams);
    if (rows.length !== 1 || Object.keys(rows[0] ?? {}).length !== 1) return false;
    const ready = Object.getOwnPropertyDescriptor(rows[0]!, "ready");
    return !!ready && "value" in ready && ready.value === 1;
  } catch {
    return false;
  }
}

/** Internal construction only. No request DTO, SQL claim or callback mints native authority. */
export function createV2ContainerHostAcceptance(options: {
  readonly sql: Sql;
  readonly installationId: string;
  readonly backendId: string;
  readonly targetKey: string;
}): V2HostAcceptance {
  const { sql, installationId, backendId, targetKey } = options;
  if (
    !sql ||
    typeof sql.query !== "function" ||
    typeof sql.run !== "function" ||
    typeof sql.batch !== "function"
  )
    throw new TypeError("Container Host acceptance requires an atomic Sql");
  for (const value of [installationId, backendId, targetKey]) {
    if (typeof value !== "string" || value.length < 1 || value.length > 2048)
      throw new TypeError("invalid Container Host construction");
  }
  const f2: Pick<V2HostAcceptance, "prepare" | "prepareDelete" | "assertSql"> = Object.freeze({
    prepare(context: V2HostAcceptanceContext) {
      if (context.form !== F2_FORM) return undefined;
      // Copy synchronously before yielding. Redeem still binds the ORIGINAL context
      // identity, while every fixed statement parameter is this captured snapshot.
      if (
        !Object.isFrozen(context) ||
        !Object.keys(context).every((key) =>
          Object.hasOwn(Object.getOwnPropertyDescriptor(context, key) ?? {}, "value"),
        )
      )
        throw new TypeError("invalid original Container F2 context");
      const c = Object.freeze({ ...context });
      for (const field of [
        "principal",
        "key",
        "fingerprint",
        "operationId",
        "resourceUid",
        "at",
        "retainUntil",
        "form",
        "space",
        "name",
        "backendId",
        "targetKey",
      ] as const) {
        const value = c[field];
        if (typeof value !== "string" || value.length < 1 || value.length > 2048)
          throw new TypeError("invalid Container accepted context");
      }
      if (
        c.backendId !== backendId ||
        c.targetKey !== targetKey ||
        (c.action !== "create" && c.action !== "update") ||
        !Number.isSafeInteger(c.generation) ||
        c.generation < 1 ||
        (c.action === "create" && c.generation !== 1)
      )
        throw new TypeError("invalid Container accepted context");
      const spec = parseStrictJson(new TextEncoder().encode(c.specJson), 1_048_576);
      if (!spec || typeof spec !== "object" || Array.isArray(spec))
        throw new TypeError("invalid Container accepted spec");
      const record = spec as Record<string, unknown>;

      const workload = record[C.fields.workloadRevision];
      const names = f2Names(record);
      if (typeof workload !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(workload))
        throw new TypeError("invalid Container F2 workload revision");
      const configuredJson = serializeV2ContainerConfiguredPrivateInputs(c.configuredPrivateInputs);
      if (
        (c.action === "create" &&
          names.length > 0 &&
          (c.privateInputs === undefined || configuredJson === null)) ||
        (c.action === "update" && configuredJson === null)
      )
        throw new TypeError("Container F2 configured private inputs unavailable");
      const incarnation =
        c.action === "create"
          ? Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("")
          : null;
      const guard: SqlStatement = {
        sql: `${V2_CONTAINER_OWNER_READY} AND (${
          c.action === "create"
            ? `NOT EXISTS (SELECT 1 FROM main.${I} WHERE resource_uid = ?)`
            : `EXISTS (SELECT 1 FROM main.${I} WHERE resource_uid = ? AND installation_id = ?
            AND principal = ? AND space = ? AND name = ? AND form_url = ? AND backend_id = ? AND target_key = ?
            AND desired_generation = ? AND retired_at_ms IS NULL)`
        })`,
        params:
          c.action === "create"
            ? [c.resourceUid]
            : [
                c.resourceUid,
                installationId,
                c.principal,
                c.space,
                c.name,
                c.form,
                backendId,
                targetKey,
                c.generation - 1,
              ],
      };
      // If Core accepted op.id, this INSERT MUST run and its guard MUST abort a
      // mismatch. Only a genuine normal refusal (no op.id) produces zero rows.
      // backend_key comes from the actual accepted Core row, never a context field.
      const terminal: SqlStatement = {
        sql: `INSERT INTO main.${A} (operation_id, resource_uid, installation_id, incarnation_id,
          principal, space, name, form_url, backend_id, target_key, action, generation, backend_key,
          replay_key, fingerprint, accepted_spec_json, accepted_output_json, references_json,
          configured_private_inputs_json, accepted_at, retain_until, revision)
          SELECT ?, ?, ?, ${c.action === "create" ? "?" : `(SELECT incarnation_id FROM main.${I} WHERE resource_uid = ?)`},
            ?, ?, ?, ?, ?, ?, ?, ?, op.backend_key, ?, ?, ?, ?, ?, ?, ?, ?, ?
          FROM main.tf_v2_operations op WHERE op.id = ?`,
        params: [
          c.operationId,
          c.resourceUid,
          installationId,
          incarnation ?? c.resourceUid,
          c.principal,
          c.space,
          c.name,
          c.form,
          backendId,
          targetKey,
          c.action,
          c.generation,
          c.key,
          c.fingerprint,
          c.specJson,
          c.outputJson,
          c.referencesJson,
          configuredJson,
          c.at,
          c.retainUntil,
          `${c.generation}-${workload}`,
          c.operationId,
        ],
      };
      return Promise.resolve(prepareV2HostAcceptance(sql, context, guard, terminal));
    },
    prepareDelete(context: V2HostDeleteAcceptanceContext) {
      if (context.form !== F2_FORM) return undefined;
      // Copy synchronously before yielding. Redeem still binds the ORIGINAL context
      // identity, while every fixed statement parameter is this captured snapshot.
      if (
        !Object.isFrozen(context) ||
        !Object.keys(context).every((key) =>
          Object.hasOwn(Object.getOwnPropertyDescriptor(context, key) ?? {}, "value"),
        )
      )
        throw new TypeError("invalid original Container F2 DELETE context");
      const c = Object.freeze({ ...context });
      for (const field of [
        "principal",
        "key",
        "fingerprint",
        "operationId",
        "resourceUid",
        "at",
        "retainUntil",
        "form",
        "space",
        "name",
        "backendId",
        "targetKey",
      ] as const) {
        const value = c[field];
        if (typeof value !== "string" || value.length < 1 || value.length > 2048)
          throw new TypeError("invalid Container accepted context");
      }
      if (
        c.backendId !== backendId ||
        c.targetKey !== targetKey ||
        c.action !== "delete" ||
        !Number.isSafeInteger(c.generation) ||
        c.generation < 2 ||
        c.referencesJson !== null ||
        c.privateInputs !== undefined ||
        c.configuredPrivateInputs !== undefined
      )
        throw new TypeError("invalid Container accepted context");
      const spec = parseStrictJson(new TextEncoder().encode(c.specJson), 1_048_576);
      if (!spec || typeof spec !== "object" || Array.isArray(spec))
        throw new TypeError("invalid Container accepted spec");
      const record = spec as Record<string, unknown>;

      const workload = record[C.fields.workloadRevision];
      f2Names(record);
      if (typeof workload !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(workload))
        throw new TypeError("invalid Container F2 workload revision");
      const guard: SqlStatement = {
        sql: `${V2_CONTAINER_OWNER_READY} AND (${`EXISTS (SELECT 1 FROM main.${I} WHERE resource_uid = ? AND installation_id = ?
            AND principal = ? AND space = ? AND name = ? AND form_url = ? AND backend_id = ? AND target_key = ?
            AND desired_generation = ? AND retired_at_ms IS NULL)`})`,
        params: [
          c.resourceUid,
          installationId,
          c.principal,
          c.space,
          c.name,
          c.form,
          backendId,
          targetKey,
          c.generation - 1,
        ],
      };
      // A selected DELETE terminal always attempts insertion. Missing Core or
      // owner proof must abort the bound batch rather than become zero-row success.
      const terminal: SqlStatement = {
        sql: `INSERT OR ABORT INTO main.${A} (operation_id, resource_uid, installation_id, incarnation_id,
          principal, space, name, form_url, backend_id, target_key, action, generation, backend_key,
          replay_key, fingerprint, accepted_spec_json, accepted_output_json, references_json,
          configured_private_inputs_json, accepted_at, retain_until, revision)
          VALUES ( ?, ?, ?, ${`(SELECT incarnation_id FROM main.${I} WHERE resource_uid = ?)`},
            ?, ?, ?, ?, ?, ?, ?, ?, (SELECT op.backend_key FROM main.tf_v2_operations op WHERE op.id = ?), ?, ?, ?, ?, ?, NULL, ?, ?, ?
          )`,
        params: [
          c.operationId,
          c.resourceUid,
          installationId,
          c.resourceUid,
          c.principal,
          c.space,
          c.name,
          c.form,
          backendId,
          targetKey,
          c.action,
          c.generation,
          c.operationId,
          c.key,
          c.fingerprint,
          c.specJson,
          c.outputJson,
          c.referencesJson,
          c.at,
          c.retainUntil,
          `${c.generation}-${workload}`,
        ],
      };
      return Promise.resolve(prepareV2HostAcceptance(sql, context, guard, terminal));
    },
    assertSql(candidate: Sql) {
      if (candidate !== sql) throw new TypeError("Container F2 Sql identity mismatch");
    },
  });
  const legacy: V2HostAcceptance = Object.freeze({
    assertSql(candidate: Sql) {
      if (candidate !== sql)
        throw new TypeError("Container Host acceptance belongs to another Sql");
    },
    initialOutput() {
      return undefined;
    },
    prepare(context: V2HostAcceptanceContext) {
      if (context.form !== C.formUrl) return undefined;
      // Copy synchronously before yielding. Redeem still binds the ORIGINAL context
      // identity, while every fixed statement parameter is this captured snapshot.
      const c = Object.freeze({ ...context });
      for (const field of [
        "principal",
        "key",
        "fingerprint",
        "operationId",
        "resourceUid",
        "at",
        "retainUntil",
        "form",
        "space",
        "name",
        "backendId",
        "targetKey",
      ] as const) {
        const value = c[field];
        if (typeof value !== "string" || value.length < 1 || value.length > 2048)
          throw new TypeError("invalid Container accepted context");
      }
      if (
        c.backendId !== backendId ||
        c.targetKey !== targetKey ||
        (c.action !== "create" && c.action !== "update") ||
        !Number.isSafeInteger(c.generation) ||
        c.generation < 1 ||
        (c.action === "create" && c.generation !== 1) ||
        c.privateInputs !== undefined ||
        c.configuredPrivateInputs !== undefined
      )
        throw new TypeError("invalid Container accepted context");
      const spec = parseStrictJson(new TextEncoder().encode(c.specJson), 1_048_576);
      if (!spec || typeof spec !== "object" || Array.isArray(spec))
        throw new TypeError("invalid Container accepted spec");
      const record = spec as Record<string, unknown>;
      const sensitive = record[C.fields.requiredSensitiveVars];
      const workload = record[C.fields.workloadRevision];
      if (
        (sensitive !== undefined && (!Array.isArray(sensitive) || sensitive.length !== 0)) ||
        typeof workload !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(workload)
      )
        throw new TypeError("frozen Container Form cannot accept sensitive inputs");
      const incarnation =
        c.action === "create"
          ? Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("")
          : null;
      const guard: SqlStatement = {
        sql: `${runtimeReady} AND (${
          c.action === "create"
            ? `NOT EXISTS (SELECT 1 FROM main.${I} WHERE resource_uid = ?)`
            : `EXISTS (SELECT 1 FROM main.${I} WHERE resource_uid = ? AND installation_id = ?
            AND principal = ? AND space = ? AND name = ? AND form_url = ? AND backend_id = ? AND target_key = ?
            AND desired_generation = ? AND retired_at_ms IS NULL)`
        })`,
        params: [
          ...runtimeReadyParams,
          ...(c.action === "create"
            ? [c.resourceUid]
            : [
                c.resourceUid,
                installationId,
                c.principal,
                c.space,
                c.name,
                c.form,
                backendId,
                targetKey,
                c.generation - 1,
              ]),
        ],
      };
      // If Core accepted op.id, this INSERT MUST run and its guard MUST abort a
      // mismatch. Only a genuine normal refusal (no op.id) produces zero rows.
      // backend_key comes from the actual accepted Core row, never a context field.
      const terminal: SqlStatement = {
        sql: `INSERT INTO main.${A} (operation_id, resource_uid, installation_id, incarnation_id,
          principal, space, name, form_url, backend_id, target_key, action, generation, backend_key,
          replay_key, fingerprint, accepted_spec_json, accepted_output_json, references_json,
          configured_private_inputs_json, accepted_at, retain_until, revision)
          SELECT ?, ?, ?, ${c.action === "create" ? "?" : `(SELECT incarnation_id FROM main.${I} WHERE resource_uid = ?)`},
            ?, ?, ?, ?, ?, ?, ?, ?, op.backend_key, ?, ?, ?, ?, ?, NULL, ?, ?, ?
          FROM main.tf_v2_operations op WHERE op.id = ?`,
        params: [
          c.operationId,
          c.resourceUid,
          installationId,
          incarnation ?? c.resourceUid,
          c.principal,
          c.space,
          c.name,
          c.form,
          backendId,
          targetKey,
          c.action,
          c.generation,
          c.key,
          c.fingerprint,
          c.specJson,
          c.outputJson,
          c.referencesJson,
          c.at,
          c.retainUntil,
          `${c.generation}-${workload}`,
          c.operationId,
        ],
      };
      return Promise.resolve(prepareV2HostAcceptance(sql, context, guard, terminal));
    },
    prepareDelete(context: V2HostDeleteAcceptanceContext) {
      if (context.form !== C.formUrl) return undefined;
      // Copy synchronously before yielding. Redeem still binds the ORIGINAL context
      // identity, while every fixed statement parameter is this captured snapshot.
      const c = Object.freeze({ ...context });
      for (const field of [
        "principal",
        "key",
        "fingerprint",
        "operationId",
        "resourceUid",
        "at",
        "retainUntil",
        "form",
        "space",
        "name",
        "backendId",
        "targetKey",
      ] as const) {
        const value = c[field];
        if (typeof value !== "string" || value.length < 1 || value.length > 2048)
          throw new TypeError("invalid Container accepted context");
      }
      if (
        c.backendId !== backendId ||
        c.targetKey !== targetKey ||
        c.action !== "delete" ||
        !Number.isSafeInteger(c.generation) ||
        c.generation < 2 ||
        c.referencesJson !== null ||
        c.privateInputs !== undefined ||
        c.configuredPrivateInputs !== undefined
      )
        throw new TypeError("invalid Container accepted context");
      const spec = parseStrictJson(new TextEncoder().encode(c.specJson), 1_048_576);
      if (!spec || typeof spec !== "object" || Array.isArray(spec))
        throw new TypeError("invalid Container accepted spec");
      const record = spec as Record<string, unknown>;
      const sensitive = record[C.fields.requiredSensitiveVars];
      const workload = record[C.fields.workloadRevision];
      if (
        (sensitive !== undefined && (!Array.isArray(sensitive) || sensitive.length !== 0)) ||
        typeof workload !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(workload)
      )
        throw new TypeError("frozen Container Form cannot accept sensitive inputs");
      const guard: SqlStatement = {
        sql: `${runtimeReady} AND (${`EXISTS (SELECT 1 FROM main.${I} WHERE resource_uid = ? AND installation_id = ?
            AND principal = ? AND space = ? AND name = ? AND form_url = ? AND backend_id = ? AND target_key = ?
            AND desired_generation = ? AND retired_at_ms IS NULL)`})`,
        params: [
          ...runtimeReadyParams,
          ...[
            c.resourceUid,
            installationId,
            c.principal,
            c.space,
            c.name,
            c.form,
            backendId,
            targetKey,
            c.generation - 1,
          ],
        ],
      };
      // A selected DELETE terminal always attempts insertion. Missing Core or
      // owner proof must abort the bound batch rather than become zero-row success.
      const terminal: SqlStatement = {
        sql: `INSERT OR ABORT INTO main.${A} (operation_id, resource_uid, installation_id, incarnation_id,
          principal, space, name, form_url, backend_id, target_key, action, generation, backend_key,
          replay_key, fingerprint, accepted_spec_json, accepted_output_json, references_json,
          configured_private_inputs_json, accepted_at, retain_until, revision)
          VALUES ( ?, ?, ?, ${`(SELECT incarnation_id FROM main.${I} WHERE resource_uid = ?)`},
            ?, ?, ?, ?, ?, ?, ?, ?, (SELECT op.backend_key FROM main.tf_v2_operations op WHERE op.id = ?), ?, ?, ?, ?, ?, NULL, ?, ?, ?
          )`,
        params: [
          c.operationId,
          c.resourceUid,
          installationId,
          c.resourceUid,
          c.principal,
          c.space,
          c.name,
          c.form,
          backendId,
          targetKey,
          c.action,
          c.generation,
          c.operationId,
          c.key,
          c.fingerprint,
          c.specJson,
          c.outputJson,
          c.referencesJson,
          c.at,
          c.retainUntil,
          `${c.generation}-${workload}`,
        ],
      };
      return Promise.resolve(prepareV2HostAcceptance(sql, context, guard, terminal));
    },
  });
  return Object.freeze({
    assertSql: legacy.assertSql.bind(legacy),
    initialOutput: legacy.initialOutput?.bind(legacy),
    prepare(context: V2HostAcceptanceContext) {
      if (context.form === C.formUrl) return legacy.prepare(context);
      return f2.prepare(context);
    },
    prepareDelete(context: V2HostDeleteAcceptanceContext) {
      if (context.form === C.formUrl) return legacy.prepareDelete!(context);
      return f2.prepareDelete!(context);
    },
  });
}
