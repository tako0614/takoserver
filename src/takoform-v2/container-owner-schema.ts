import {
  CONTAINER_CONTRACT as C,
  isContainerWorkloadRevision,
  V2_CONTAINER_F2_FORM,
} from "../container-contract.ts";
import type { Sql, SqlStatement } from "../ports.ts";
import { parseStrictJson } from "../strict-json.ts";
import {
  prepareV2HostAcceptance,
  type V2HostAcceptance,
  type V2HostAcceptanceContext,
  type V2HostDeleteAcceptanceContext,
} from "./host-acceptance.ts";

export { V2_CONTAINER_F2_FORM };

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
const selectedCatalogReady = (
  expectedObjects: string,
  selectedNames: string,
  selectedTableNames: string,
): string => `(
  ${expectedObjects}
  AND NOT EXISTS (SELECT 1 FROM main.sqlite_schema WHERE sql IS NOT NULL
    AND (lower(substr(name, 1, ${PREFIX.length})) = ${literal(PREFIX)} OR tbl_name IN (${selectedTableNames})) AND name NOT IN (${selectedNames}))
  AND NOT EXISTS (SELECT 1 FROM  main.sqlite_schema source  WHERE CASE WHEN lower(source.name) IN ('_cf_kv', '_cf_metadata')  AND source.sql IS NOT NULL AND instr(upper(source.sql), 'REFERENCES') = 0 THEN 0 ELSE EXISTS (SELECT 1 FROM  pragma_foreign_key_list(source.name, 'main') fk
     WHERE  source.type = 'table' AND lower(fk."table") IN (${selectedTableNames}) AND source.name NOT IN (${selectedTableNames})) END)
  AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check(NULL, 'main') WHERE "table" IN (${selectedTableNames}))
)`;
const readyPredicate = (
  encodeValue: (value: string, rowIndex: number, columnIndex: number) => string,
  selectedRows = expectedRows,
  selectedNames = names,
  selectedTableNames = tableNames,
): string =>
  selectedCatalogReady(
    selectedRows
      .map(
        (row, rowIndex) =>
          `(SELECT count(*) FROM main.sqlite_schema WHERE type = ${encodeValue(row[0], rowIndex, 0)} AND name = ${encodeValue(row[1], rowIndex, 1)} AND tbl_name = ${encodeValue(row[2], rowIndex, 2)} AND sql = ${encodeValue(row[3], rowIndex, 3)}) = 1`,
      )
      .join("\n  AND "),
    selectedNames,
    selectedTableNames,
  );
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

/** Explicit additive expand candidate only. Unregistered: not an applied
 * migration, not part of the immutable legacy recipe, and never auto-applied.
 * Old NULL rows cannot acquire a control binding. Only a fresh selected INSERT
 * reserves this column, and only its one original pending save may seal it. */
export const V2_CONTAINER_CONTROL_RESERVED = '{"kind":"linux-oci-control-reserved@1"}';
const controlColumn =
  "native_control TEXT CHECK (native_control IS NULL OR (typeof(native_control) = 'text' AND length(native_control) BETWEEN 1 AND 65536 AND json_valid(native_control)))";
const controlGuards = Object.freeze([
  trigger(
    "native_control_insert",
    Q,
    "BEFORE INSERT",
    refuse(
      `NEW.native_control IS NULL OR (NEW.native_control = ${literal(V2_CONTAINER_CONTROL_RESERVED)} AND NEW.state = 'pending' AND NEW.native_id IS NULL)`,
    ),
  ),
  trigger(
    "native_control_transition",
    Q,
    "BEFORE UPDATE",
    refuse(`
    (NEW.native_control IS OLD.native_control OR
      (OLD.native_control = ${literal(V2_CONTAINER_CONTROL_RESERVED)} AND OLD.state = 'pending' AND NEW.state = 'pending'
       AND NEW.native_id IS NULL AND NEW.bound_at_ms IS NULL AND NEW.removed_at_ms IS NULL
       AND json_valid(NEW.native_control) AND json_extract(NEW.native_control,'$.kind') = 'linux-oci-sealed-control@1'
       AND json_extract(NEW.native_control,'$.scope.claimId') = OLD.claim_id
       AND json_extract(NEW.native_control,'$.scope.resourceUid') = OLD.resource_uid
       AND json_extract(NEW.native_control,'$.scope.generation') = OLD.generation
       AND json_extract(NEW.native_control,'$.scope.installationId') = OLD.installation_id))
    AND (NEW.state = 'pending' OR NEW.native_control IS NOT ${literal(V2_CONTAINER_CONTROL_RESERVED)})`),
  ),
]);
const controlObjects = Object.freeze([
  ...objects.map((item) =>
    item.name === Q
      ? object(
          item.type,
          item.name,
          item.table,
          item.sql.replace(
            ",\n  PRIMARY KEY (resource_uid, generation),",
            ", " + controlColumn + ",\n  PRIMARY KEY (resource_uid, generation),",
          ),
        )
      : item,
  ),
  ...controlGuards,
]);
export const V2_CONTAINER_OWNER_CONTROL_EXPAND = Object.freeze({
  from: V2_CONTAINER_OWNER_RECIPE,
  statements: Object.freeze([
    `ALTER TABLE ${Q} ADD COLUMN ${controlColumn}`,
    ...controlGuards.map((item) => item.sql),
  ]),
  objects: controlObjects,
});
const controlRows = Object.freeze(
  controlObjects.map((item) =>
    Object.freeze<[string, string, string, string]>([item.type, item.name, item.table, item.sql]),
  ),
);
const controlNames = controlObjects.map((item) => literal(item.name)).join(", ");
const controlReadyParams = Object.freeze([JSON.stringify(controlRows)]);
const controlReady =
  "(WITH container_owner_control_values(document) AS (VALUES (?)) SELECT " +
  readyPredicate(
    (_value, rowIndex, columnIndex) =>
      `json_extract((SELECT document FROM container_owner_control_values), '$[${rowIndex}][${columnIndex}]')`,
    controlRows,
    controlNames,
  ) +
  ")";
/** Optional second additive expand. Existing recipes/statements are immutable.
 * NULL is historical/unknown. Only one fresh reserved->sealed peer save may
 * initialize untouched; consumed is persisted before rm and never rolls back.
 * closed records this allocation's known local cleanup, not Resource removal. */
const allocationColumn =
  "allocation_cleanup TEXT CHECK (allocation_cleanup IS NULL OR allocation_cleanup IN ('untouched','consumed','closed'))";
const allocationGuards = Object.freeze([
  trigger(
    "allocation_cleanup_insert",
    Q,
    "BEFORE INSERT",
    refuse("NEW.allocation_cleanup IS NULL"),
  ),
  trigger(
    "allocation_cleanup_transition",
    Q,
    "BEFORE UPDATE",
    refuse(`
    NEW.allocation_cleanup IS OLD.allocation_cleanup OR
    (OLD.allocation_cleanup IS NULL AND NEW.allocation_cleanup = 'untouched'
      AND OLD.state = 'pending' AND NEW.state = 'pending' AND NEW.native_id IS NULL
      AND OLD.native_control = ${literal(V2_CONTAINER_CONTROL_RESERVED)}
      AND json_extract(NEW.native_control,'$.kind') = 'linux-oci-sealed-control@1'
      AND json_extract(NEW.native_control,'$.scope.purpose') = 'takoserver.linux-oci-parent-peer-control@1') OR
    (OLD.allocation_cleanup = 'untouched' AND NEW.allocation_cleanup = 'consumed'
      AND OLD.state = 'bound' AND NEW.state = 'bound' AND NEW.native_control IS OLD.native_control) OR
    (OLD.allocation_cleanup = 'consumed' AND NEW.allocation_cleanup = 'closed'
      AND OLD.state = 'bound' AND NEW.state = 'bound' AND NEW.native_control IS OLD.native_control)`),
  ),
]);
const allocationObjects = Object.freeze([
  ...controlObjects.map((item) =>
    item.name === Q
      ? object(
          item.type,
          item.name,
          item.table,
          item.sql.replace(
            ",\n  PRIMARY KEY (resource_uid, generation),",
            ", " + allocationColumn + ",\n  PRIMARY KEY (resource_uid, generation),",
          ),
        )
      : item,
  ),
  ...allocationGuards,
]);
export const V2_CONTAINER_OWNER_ALLOCATION_EXPAND = Object.freeze({
  from: V2_CONTAINER_OWNER_CONTROL_EXPAND,
  statements: Object.freeze([
    `ALTER TABLE ${Q} ADD COLUMN ${allocationColumn}`,
    ...allocationGuards.map((item) => item.sql),
  ]),
  objects: allocationObjects,
});
const allocationRows = Object.freeze(
  allocationObjects.map((item) =>
    Object.freeze<[string, string, string, string]>([item.type, item.name, item.table, item.sql]),
  ),
);
const allocationNames = allocationObjects.map((item) => literal(item.name)).join(", ");
const allocationReadyParams = Object.freeze([JSON.stringify(allocationRows)]);
const allocationReady =
  "(WITH container_owner_allocation_values(document) AS (VALUES (?)) SELECT " +
  readyPredicate(
    (_value, rowIndex, columnIndex) =>
      `json_extract((SELECT document FROM container_owner_allocation_values), '$[${rowIndex}][${columnIndex}]')`,
    allocationRows,
    allocationNames,
  ) +
  ")";
/** Third optional additive expand. Historical NULL is never a close fact.
 * Reserve only with the original pending peer-control save; seal only the
 * original bound application's completed close. No runtime is reconstructed. */
export const V2_CONTAINER_APPLICATION_IO_RESERVED =
  '{"kind":"linux-oci-application-io-reserved@1"}';
const applicationIoColumn =
  "application_io_cleanup TEXT CHECK (application_io_cleanup IS NULL OR (typeof(application_io_cleanup) = 'text' AND length(application_io_cleanup) BETWEEN 1 AND 65536 AND json_valid(application_io_cleanup)))";
const applicationIoGuards = Object.freeze([
  trigger(
    "application_io_cleanup_insert",
    Q,
    "BEFORE INSERT",
    refuse("NEW.application_io_cleanup IS NULL"),
  ),
  trigger(
    "application_io_cleanup_transition",
    Q,
    "BEFORE UPDATE",
    refuse(`
    NEW.application_io_cleanup IS OLD.application_io_cleanup OR
    (OLD.application_io_cleanup IS NULL AND NEW.application_io_cleanup = ${literal(V2_CONTAINER_APPLICATION_IO_RESERVED)}
      AND OLD.state = 'pending' AND NEW.state = 'pending' AND NEW.native_id IS NULL
      AND NEW.bound_at_ms IS NULL AND NEW.removed_at_ms IS NULL
      AND OLD.native_control = ${literal(V2_CONTAINER_CONTROL_RESERVED)}
      AND NEW.allocation_cleanup = 'untouched'
      AND json_extract(NEW.native_control,'$.kind') = 'linux-oci-sealed-control@1'
      AND json_extract(NEW.native_control,'$.scope.purpose') = 'takoserver.linux-oci-parent-peer-control@1') OR
    (OLD.application_io_cleanup = ${literal(V2_CONTAINER_APPLICATION_IO_RESERVED)}
      AND OLD.state = 'bound' AND NEW.state = 'bound' AND NEW.native_id IS OLD.native_id
      AND NEW.native_control IS OLD.native_control
      AND json_extract(NEW.application_io_cleanup,'$.kind') = 'linux-oci-sealed-application-io-close@1'
      AND json_extract(NEW.application_io_cleanup,'$.scope.purpose') = 'takoserver.linux-oci-application-io-close@1'
      AND json_extract(NEW.application_io_cleanup,'$.scope.original.claimId') = OLD.claim_id
      AND json_extract(NEW.application_io_cleanup,'$.scope.original.resourceUid') = OLD.resource_uid
      AND json_extract(NEW.application_io_cleanup,'$.scope.original.generation') = OLD.generation
      AND json_extract(NEW.application_io_cleanup,'$.scope.original.installationId') = OLD.installation_id
      AND json_extract(NEW.application_io_cleanup,'$.scope.nativeId') = OLD.native_id)`),
  ),
]);
const applicationIoObjects = Object.freeze([
  ...allocationObjects.map((item) =>
    item.name === Q
      ? object(
          item.type,
          item.name,
          item.table,
          item.sql.replace(
            ",\n  PRIMARY KEY (resource_uid, generation),",
            ", " + applicationIoColumn + ",\n  PRIMARY KEY (resource_uid, generation),",
          ),
        )
      : item,
  ),
  ...applicationIoGuards,
]);
export const V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND = Object.freeze({
  from: V2_CONTAINER_OWNER_ALLOCATION_EXPAND,
  statements: Object.freeze([
    `ALTER TABLE ${Q} ADD COLUMN ${applicationIoColumn}`,
    ...applicationIoGuards.map((item) => item.sql),
  ]),
  objects: applicationIoObjects,
});
const applicationIoRows = Object.freeze(
  applicationIoObjects.map((item) =>
    Object.freeze<[string, string, string, string]>([item.type, item.name, item.table, item.sql]),
  ),
);
const applicationIoNames = applicationIoObjects.map((item) => literal(item.name)).join(", ");
const applicationIoReadyParams = Object.freeze([JSON.stringify(applicationIoRows)]);
const applicationIoReady =
  "(WITH container_owner_application_io_values(document) AS (VALUES (?)) SELECT " +
  readyPredicate(
    (_value, rowIndex, columnIndex) =>
      `json_extract((SELECT document FROM container_owner_application_io_values), '$[${rowIndex}][${columnIndex}]')`,
    applicationIoRows,
    applicationIoNames,
  ) +
  ")";
/** Explicit successor only. Native removal is established by its owning
 * consumer; this guard permits only final DELETE cipherpayload erasure and
 * retains every accepted identity/fingerprint/audit field. No active rewrite. */
const finalDeleteAcceptance = trigger(
  "acceptance_immutable",
  A,
  "BEFORE UPDATE",
  refuse(`OLD.configured_private_inputs_json IS NOT NULL
    AND NEW.configured_private_inputs_json IS NULL
    AND ${same(["operation_id", "resource_uid", "installation_id", "incarnation_id", "principal", "space", "name", "form_url", "backend_id", "target_key", "action", "generation", "backend_key", "replay_key", "fingerprint", "accepted_spec_json", "accepted_output_json", "references_json", "accepted_at", "retain_until", "revision"])}
    AND EXISTS (SELECT 1 FROM tf_v2_resources resource
      JOIN tf_v2_operations op ON op.id=resource.last_operation
      JOIN ${I} instance ON instance.resource_uid=resource.uid
      WHERE resource.uid=OLD.resource_uid AND resource.principal=OLD.principal
        AND resource.space=OLD.space AND resource.name=OLD.name AND resource.form_url=OLD.form_url
        AND resource.backend_id=OLD.backend_id AND resource.target_key=OLD.target_key
        AND resource.phase='deleting' AND resource.deleted_at IS NULL
        AND resource.generation=op.generation AND resource.busy_operation=op.id
        AND resource.spec_json=op.accepted_spec_json AND op.resource_uid=resource.uid
        AND op.principal=resource.principal AND op.backend_id=resource.backend_id AND op.target_key=resource.target_key
        AND op.action='delete' AND op.generation>OLD.generation
        AND op.status='reconciling' AND op.effect='unknown' AND op.dispatch_possible=1
        AND op.lease_token IS NOT NULL AND op.lease_until_ms>(CAST(strftime('%s','now') AS INTEGER)+1)*1000
        AND instance.installation_id=OLD.installation_id AND instance.incarnation_id=OLD.incarnation_id
        AND instance.retire_operation_id=op.id AND instance.desired_generation=op.generation
        AND EXISTS (SELECT 1 FROM ${Q} claim WHERE claim.resource_uid=resource.uid)
        AND NOT EXISTS (SELECT 1 FROM ${Q} claim WHERE claim.resource_uid=resource.uid
          AND (claim.state<>'removed' OR claim.allocation_cleanup IS NOT 'closed'
            OR json_extract(claim.application_io_cleanup,'$.scope.operation.operationId') IS NOT op.id)))
    AND NOT EXISTS (SELECT 1 FROM tf_v2_operation_configured_private_inputs material
      WHERE material.resource_uid=OLD.resource_uid)`),
);
const finalDeleteObjects = Object.freeze(
  applicationIoObjects.map((item) =>
    item.name === finalDeleteAcceptance.name ? finalDeleteAcceptance : item,
  ),
);
const finalDeleteRows = Object.freeze(
  finalDeleteObjects.map((item) =>
    Object.freeze<[string, string, string, string]>([item.type, item.name, item.table, item.sql]),
  ),
);
const finalDeleteNames = finalDeleteObjects.map((item) => literal(item.name)).join(", ");
const finalDeleteReadyParams = Object.freeze([JSON.stringify(finalDeleteRows)]);
const finalDeleteReady =
  "(WITH container_owner_final_delete_values(document) AS (VALUES (?)) SELECT " +
  readyPredicate(
    (_value, row, column) =>
      `json_extract((SELECT document FROM container_owner_final_delete_values), '$[${row}][${column}]')`,
    finalDeleteRows,
    finalDeleteNames,
  ) +
  ")";
export const V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND = Object.freeze({
  from: V2_CONTAINER_OWNER_APPLICATION_IO_EXPAND,
  objects: finalDeleteObjects,
  statements: Object.freeze([
    {
      sql: "CREATE TABLE __tako_container_final_delete_transition (ok INTEGER NOT NULL CHECK(ok=1))",
    },
    {
      sql: `INSERT INTO __tako_container_final_delete_transition VALUES (${applicationIoReady})`,
      params: applicationIoReadyParams,
    },
    { sql: `DROP TRIGGER ${finalDeleteAcceptance.name}` },
    { sql: finalDeleteAcceptance.sql },
    { sql: "DROP TABLE __tako_container_final_delete_transition" },
  ]),
});
export async function inspectV2ContainerOwnerFinalDeleteSchema(sql: Sql): Promise<boolean> {
  try {
    const rows = await sql.query(`SELECT ${finalDeleteReady} AS ready`, finalDeleteReadyParams);
    return rows.length === 1 && Object.keys(rows[0] ?? {}).length === 1 && rows[0]?.ready === 1;
  } catch {
    return false;
  }
}
const selectedApplicationIoReady = "(" + applicationIoReady + " OR " + finalDeleteReady + ")";
const selectedApplicationIoReadyParams = Object.freeze([
  ...applicationIoReadyParams,
  ...finalDeleteReadyParams,
]);
export async function inspectV2ContainerOwnerApplicationIoSchema(sql: Sql): Promise<boolean> {
  try {
    const rows = await sql.query(
      `SELECT ${selectedApplicationIoReady} AS ready`,
      selectedApplicationIoReadyParams,
    );
    return rows.length === 1 && Object.keys(rows[0] ?? {}).length === 1 && rows[0]?.ready === 1;
  } catch {
    return false;
  }
}
const selectedAllocationReady = "(" + allocationReady + " OR " + selectedApplicationIoReady + ")";
const selectedAllocationReadyParams = Object.freeze([
  ...allocationReadyParams,
  ...selectedApplicationIoReadyParams,
]);
const selectedControlReady = "(" + controlReady + " OR " + selectedAllocationReady + ")";
const selectedControlReadyParams = Object.freeze([
  ...controlReadyParams,
  ...selectedAllocationReadyParams,
]);
export async function inspectV2ContainerOwnerAllocationSchema(sql: Sql): Promise<boolean> {
  try {
    const rows = await sql.query(
      `SELECT ${selectedAllocationReady} AS ready`,
      selectedAllocationReadyParams,
    );
    return rows.length === 1 && Object.keys(rows[0] ?? {}).length === 1 && rows[0]?.ready === 1;
  } catch {
    return false;
  }
}
export async function inspectV2ContainerOwnerControlSchema(sql: Sql): Promise<boolean> {
  try {
    const rows = await sql.query(
      `SELECT ${selectedControlReady} AS ready`,
      selectedControlReadyParams,
    );
    return rows.length === 1 && Object.keys(rows[0] ?? {}).length === 1 && rows[0]?.ready === 1;
  } catch {
    return false;
  }
}

// Optional exact successor. Original final-delete DDL/inspectors remain exact:
// only consumers selecting this full shape may recognize a past UPDATE close.
const historicalUpdateClose = `EXISTS (
  SELECT 1 FROM ${A} ha JOIN tf_v2_operations ho ON ho.id=ha.operation_id
  JOIN ${R} hv ON hv.operation_id=ha.operation_id AND hv.resource_uid=ha.resource_uid
    AND hv.generation=ha.generation AND hv.revision=ha.revision
  WHERE ha.operation_id=json_extract(claim.application_io_cleanup,'$.scope.operation.operationId')
    AND ha.resource_uid=resource.uid AND ha.installation_id=instance.installation_id
    AND ha.incarnation_id=instance.incarnation_id AND ha.principal=resource.principal
    AND ha.space=resource.space AND ha.name=resource.name AND ha.form_url=resource.form_url
    AND ha.backend_id=resource.backend_id AND ha.target_key=resource.target_key
    AND ha.action='update' AND ha.generation>claim.generation AND ha.generation<op.generation
    AND ho.status='succeeded' AND ho.effect='complete'
    AND ho.resource_uid=ha.resource_uid AND ho.principal=ha.principal AND ho.action=ha.action
    AND ho.generation=ha.generation AND ho.replay_key=ha.replay_key
    AND ho.request_fingerprint=ha.fingerprint AND ho.created_at=ha.accepted_at
    AND ho.backend_id=ha.backend_id AND ho.target_key=ha.target_key AND ho.backend_key=ha.backend_key
    AND ho.accepted_spec_json=ha.accepted_spec_json AND julianday(ho.retain_until)>=julianday(ha.retain_until)
    AND ha.revision=CAST(ha.generation AS TEXT)||'-'||json_extract(ha.accepted_spec_json,'$.${C.fields.workloadRevision}')
    AND json_extract(claim.application_io_cleanup,'$.scope.original') IS json_extract(claim.native_control,'$.scope')
    AND json_extract(claim.application_io_cleanup,'$.scope.nativeId') IS claim.native_id
    AND json_extract(claim.application_io_cleanup,'$.scope.operation.action') IS ha.action
    AND json_extract(claim.application_io_cleanup,'$.scope.operation.generation') IS ha.generation
    AND json_extract(claim.application_io_cleanup,'$.scope.operation.resourceUid') IS ha.resource_uid
    AND json_extract(claim.application_io_cleanup,'$.scope.operation.principal') IS ha.principal
    AND json_extract(claim.application_io_cleanup,'$.scope.operation.space') IS ha.space
    AND json_extract(claim.application_io_cleanup,'$.scope.operation.name') IS ha.name
    AND json_extract(claim.application_io_cleanup,'$.scope.operation.form') IS ha.form_url
    AND json_extract(claim.application_io_cleanup,'$.scope.operation.backendId') IS ha.backend_id
    AND json_extract(claim.application_io_cleanup,'$.scope.operation.targetKey') IS ha.target_key
    AND json_extract(claim.application_io_cleanup,'$.scope.operation.backendKey') IS ha.backend_key
    AND json_extract(claim.application_io_cleanup,'$.scope.operation.acceptedFingerprint') IS ha.fingerprint
    AND json_extract(claim.application_io_cleanup,'$.scope.operation.revision') IS ha.revision)`;
const historicalDeleteAcceptance = Object.freeze({
  ...finalDeleteAcceptance,
  sql: finalDeleteAcceptance.sql.replace(
    "json_extract(claim.application_io_cleanup,'$.scope.operation.operationId') IS NOT op.id",
    "NOT (json_extract(claim.application_io_cleanup,'$.scope.operation.operationId') IS op.id OR " +
      historicalUpdateClose +
      ")",
  ),
});
const historicalDeleteObjects = Object.freeze(
  finalDeleteObjects.map((item) =>
    item.name === historicalDeleteAcceptance.name ? historicalDeleteAcceptance : item,
  ),
);
const historicalDeleteRows = Object.freeze(
  historicalDeleteObjects.map((item) =>
    Object.freeze<[string, string, string, string]>([item.type, item.name, item.table, item.sql]),
  ),
);
const historicalDeleteNames = historicalDeleteObjects.map((item) => literal(item.name)).join(", ");
const historicalDeleteParams = Object.freeze([JSON.stringify(historicalDeleteRows)]);
const historicalDeleteReady =
  "(WITH container_owner_historical_delete_values(document) AS (VALUES (?)) SELECT " +
  readyPredicate(
    (_value, row, column) =>
      `json_extract((SELECT document FROM container_owner_historical_delete_values), '$[${row}][${column}]')`,
    historicalDeleteRows,
    historicalDeleteNames,
  ) +
  ")";
export const V2_CONTAINER_OWNER_HISTORICAL_DELETE_EXPAND = Object.freeze({
  objects: historicalDeleteObjects,
  statements: Object.freeze([
    {
      sql: "CREATE TABLE __tako_container_historical_delete_transition (ok INTEGER NOT NULL CHECK(ok=1))",
    },
    {
      sql: `INSERT INTO __tako_container_historical_delete_transition VALUES (${finalDeleteReady})`,
      params: finalDeleteReadyParams,
    },
    { sql: `DROP TRIGGER ${historicalDeleteAcceptance.name}` },
    { sql: historicalDeleteAcceptance.sql },
    { sql: "DROP TABLE __tako_container_historical_delete_transition" },
  ]),
});
export async function inspectV2ContainerOwnerHistoricalDeleteSchema(sql: Sql): Promise<boolean> {
  try {
    const rows = await sql.query(
      `SELECT ${historicalDeleteReady} AS ready`,
      historicalDeleteParams,
    );
    return rows.length === 1 && Object.keys(rows[0] ?? {}).length === 1 && rows[0]?.ready === 1;
  } catch {
    return false;
  }
}

/** Optional add-on to the exact final-DELETE shape. This table retains the
 * original creator's shutdown fact before any subsequent DELETE is accepted.
 * The owning runtime still authenticates the envelope and native control digest. */
const shutdownIoTable = `${PREFIX}shutdown_io_closes`;
const shutdownIoObjects = Object.freeze([
  object(
    "table",
    shutdownIoTable,
    shutdownIoTable,
    `CREATE TABLE ${shutdownIoTable} (
  resource_uid TEXT NOT NULL CHECK (${text("resource_uid")}),
  generation INTEGER NOT NULL CHECK (${integer("generation", 1)}),
  claim_id TEXT NOT NULL CHECK (${hex("claim_id")}),
  native_id TEXT NOT NULL CHECK (${hex("native_id")}),
  close_document TEXT NOT NULL CHECK (typeof(close_document) = 'text' AND length(close_document) BETWEEN 1 AND 65536 AND json_valid(close_document)),
  PRIMARY KEY (resource_uid, generation),
  FOREIGN KEY (resource_uid, generation) REFERENCES ${Q}(resource_uid, generation)
)`,
  ),
  trigger(
    "shutdown_io_close_insert",
    shutdownIoTable,
    "BEFORE INSERT",
    refuse(`CASE WHEN json_valid(NEW.close_document) THEN
      json_type(NEW.close_document) = 'object'
      AND (SELECT count(*) FROM json_each(NEW.close_document)) = 5
      AND json_extract(NEW.close_document, '$.kind') = 'linux-oci-sealed-host-shutdown-io-close@1'
      AND ${text("json_extract(NEW.close_document, '$.keyId')")}
      AND ${text("json_extract(NEW.close_document, '$.nonce')")}
      AND json_type(NEW.close_document, '$.ciphertext') = 'text'
      AND length(json_extract(NEW.close_document, '$.ciphertext')) > 0
      AND json_type(NEW.close_document, '$.scope') = 'object'
      AND (SELECT count(*) FROM json_each(NEW.close_document, '$.scope')) = 8
      AND json_extract(NEW.close_document, '$.scope.purpose') = 'takoserver.linux-oci-host-shutdown-io-close@1'
      AND json_type(NEW.close_document, '$.scope.resourceUid') = 'text'
      AND json_extract(NEW.close_document, '$.scope.resourceUid') = NEW.resource_uid
      AND json_type(NEW.close_document, '$.scope.generation') = 'integer'
      AND json_extract(NEW.close_document, '$.scope.generation') = NEW.generation
      AND json_type(NEW.close_document, '$.scope.claimId') = 'text'
      AND json_extract(NEW.close_document, '$.scope.claimId') = NEW.claim_id
      AND json_type(NEW.close_document, '$.scope.nativeId') = 'text'
      AND json_extract(NEW.close_document, '$.scope.nativeId') = NEW.native_id
      AND json_type(NEW.close_document, '$.scope.installationId') = 'text'
      AND json_type(NEW.close_document, '$.scope.incarnationId') = 'text'
      AND substr(json_extract(NEW.close_document, '$.scope.controlDigest'), 1, 7) = 'sha256:'
      AND ${hex("substr(json_extract(NEW.close_document, '$.scope.controlDigest'), 8)")}
      AND EXISTS (SELECT 1 FROM ${Q} claim
        JOIN ${I} instance ON instance.resource_uid = claim.resource_uid AND instance.installation_id = claim.installation_id
        WHERE claim.resource_uid = NEW.resource_uid AND claim.generation = NEW.generation
          AND claim.claim_id = NEW.claim_id AND claim.native_id = NEW.native_id AND claim.state = 'bound'
          AND json_extract(claim.native_control, '$.kind') = 'linux-oci-sealed-control@1'
          AND instance.retire_operation_id IS NULL AND instance.retired_at_ms IS NULL
          AND claim.installation_id = json_extract(NEW.close_document, '$.scope.installationId')
          AND instance.incarnation_id = json_extract(NEW.close_document, '$.scope.incarnationId'))
      AND NOT EXISTS (SELECT 1 FROM ${shutdownIoTable} WHERE resource_uid = NEW.resource_uid AND generation = NEW.generation)
      ELSE 0 END`),
  ),
  trigger("shutdown_io_close_immutable", shutdownIoTable, "BEFORE UPDATE", refuse("0")),
  trigger("shutdown_io_close_retain", shutdownIoTable, "BEFORE DELETE", refuse("0")),
]);
const shutdownIoSelectedObjects = Object.freeze([...finalDeleteObjects, ...shutdownIoObjects]);
const shutdownIoRows = Object.freeze(
  shutdownIoSelectedObjects.map((item) =>
    Object.freeze<[string, string, string, string]>([item.type, item.name, item.table, item.sql]),
  ),
);
const shutdownIoReadyParams = Object.freeze([JSON.stringify(shutdownIoRows)]);
const shutdownIoReady =
  "(WITH container_owner_shutdown_io_values(document) AS (VALUES (?)) SELECT " +
  readyPredicate(
    (_value, row, column) =>
      `json_extract((SELECT document FROM container_owner_shutdown_io_values), '$[${row}][${column}]')`,
    shutdownIoRows,
    shutdownIoSelectedObjects.map((item) => literal(item.name)).join(", "),
    `${tableNames}, ${literal(shutdownIoTable)}`,
  ) +
  ")";
const shutdownIoTransition = "__tako_container_shutdown_io_transition";
const shutdownIoStatements: readonly SqlStatement[] = Object.freeze(
  [
    {
      sql: `CREATE TABLE temp.${shutdownIoTransition} (ok INTEGER NOT NULL)`,
    },
    {
      sql: `INSERT INTO temp.${shutdownIoTransition} VALUES (CASE WHEN ${finalDeleteReady} THEN 1 END)`,
      params: finalDeleteReadyParams,
    },
    ...shutdownIoObjects.map(({ sql }) => ({ sql })),
    {
      sql: `UPDATE temp.${shutdownIoTransition} SET ok = CASE WHEN ${shutdownIoReady} THEN 1 END`,
      params: shutdownIoReadyParams,
    },
    { sql: `DROP TABLE temp.${shutdownIoTransition}` },
  ].map((statement) => Object.freeze(statement)),
);
/** The owning SQLite executor must apply this exact optional transition in one batch. */
export const V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND = Object.freeze({
  from: V2_CONTAINER_OWNER_FINAL_DELETE_EXPAND,
  objects: shutdownIoSelectedObjects,
  statements: shutdownIoStatements,
});
export async function inspectV2ContainerOwnerShutdownIoSchema(sql: Sql): Promise<boolean> {
  try {
    const rows = await sql.query(`SELECT ${shutdownIoReady} AS ready`, shutdownIoReadyParams);
    return rows.length === 1 && Object.keys(rows[0] ?? {}).length === 1 && rows[0]?.ready === 1;
  } catch {
    return false;
  }
}

const applicationSuccessorOwnerToken = "application_successor_owner_token";
const applicationSuccessorTable = "tf_v2_container_application_successors";

function buildApplicationSuccessorSchema() {
  const successorOwnerColumn = `${applicationSuccessorOwnerToken} TEXT CHECK (${applicationSuccessorOwnerToken} IS NULL OR (form_url = ${literal(F2_FORM)} AND action IN ('update', 'delete') AND ${hex(applicationSuccessorOwnerToken)}))`;
  const currentApplicationSuccessorClaim = `EXISTS (
  SELECT 1 FROM ${Q} claim
  JOIN ${I} instance ON instance.resource_uid = claim.resource_uid
  JOIN ${R} revision ON revision.resource_uid = claim.resource_uid AND revision.generation = claim.generation
  JOIN ${S} started ON started.resource_uid = claim.resource_uid AND started.generation = claim.generation
  JOIN main.tf_v2_resources resource ON resource.uid = claim.resource_uid
  JOIN main.tf_v2_operations operation ON operation.id = revision.operation_id
  WHERE claim.resource_uid = NEW.resource_uid AND claim.generation = NEW.generation
    AND claim.claim_id = NEW.claim_id AND claim.native_id = NEW.native_id
    AND claim.installation_id = instance.installation_id AND claim.state = 'bound'
    AND claim.allocation_cleanup = 'untouched'
    AND claim.application_io_cleanup = ${literal(V2_CONTAINER_APPLICATION_IO_RESERVED)}
    AND json_extract(claim.native_control, '$.kind') = 'linux-oci-sealed-control@1'
    AND json_extract(claim.native_control, '$.scope.purpose') = 'takoserver.linux-oci-parent-peer-control@1'
    AND instance.form_url = ${literal(F2_FORM)} AND instance.desired_generation = claim.generation
    AND instance.serving_generation = claim.generation AND instance.retire_operation_id IS NULL
    AND instance.retired_at_ms IS NULL AND revision.retention = 'serving'
    AND started.attempt = 1 AND started.create_claim_id = claim.claim_id AND started.native_id = claim.native_id
    AND started.state = 'running' AND started.confirmed_running_at_ms IS NOT NULL
    AND resource.principal = instance.principal AND resource.space = instance.space AND resource.name = instance.name
    AND resource.form_url = instance.form_url AND resource.backend_id = instance.backend_id
    AND resource.target_key = instance.target_key AND resource.generation = claim.generation
    AND resource.observed_generation = claim.generation AND resource.last_operation = operation.id
    AND resource.phase = 'idle' AND resource.deleted_at IS NULL AND resource.busy_operation IS NULL
    AND json_type(resource.observed_json, '$.ready') = 'true'
    AND json_extract(resource.observed_json, '$.servingGeneration') = claim.generation
    AND operation.resource_uid = resource.uid AND operation.generation = claim.generation
    AND operation.status = 'succeeded' AND operation.effect = 'complete')`;
  const applicationSuccessorClaim = `resource_uid = NEW.resource_uid AND generation = NEW.generation
      AND claim_id = NEW.claim_id AND native_id = NEW.native_id`;
  const acceptedApplicationSuccessorRetirement = `EXISTS (
    SELECT 1 FROM ${Q} claim
    JOIN ${I} instance ON instance.resource_uid = claim.resource_uid
    JOIN ${R} revision ON revision.resource_uid = claim.resource_uid AND revision.generation = claim.generation
    JOIN ${S} started ON started.resource_uid = claim.resource_uid AND started.generation = claim.generation
    JOIN main.tf_v2_resources resource ON resource.uid = instance.resource_uid
    JOIN ${A} management ON management.operation_id = resource.busy_operation
    JOIN main.tf_v2_operations operation ON operation.id = management.operation_id
    WHERE claim.resource_uid = NEW.resource_uid AND claim.generation = NEW.generation
      AND claim.claim_id = NEW.claim_id AND claim.native_id = NEW.native_id
      AND claim.installation_id = instance.installation_id AND claim.state = 'bound'
      AND claim.allocation_cleanup = 'untouched'
      AND claim.application_io_cleanup = ${literal(V2_CONTAINER_APPLICATION_IO_RESERVED)}
      AND json_extract(claim.native_control, '$.kind') = 'linux-oci-sealed-control@1'
      AND json_extract(claim.native_control, '$.scope.purpose') = 'takoserver.linux-oci-parent-peer-control@1'
      AND instance.form_url = ${literal(F2_FORM)}
      AND started.attempt = 1 AND started.create_claim_id = claim.claim_id
      AND started.native_id = claim.native_id AND started.state = 'running'
      AND started.confirmed_running_at_ms IS NOT NULL AND started.confirmed_exited_at_ms IS NULL
      AND management.${applicationSuccessorOwnerToken} = NEW.owner_token
      AND management.resource_uid = instance.resource_uid AND management.installation_id = instance.installation_id
      AND management.incarnation_id = instance.incarnation_id AND management.principal = instance.principal
      AND management.space = instance.space AND management.name = instance.name AND management.form_url = instance.form_url
      AND management.backend_id = instance.backend_id AND management.target_key = instance.target_key
      AND management.generation = instance.desired_generation AND management.generation > claim.generation
      AND resource.principal = instance.principal AND resource.space = instance.space AND resource.name = instance.name
      AND resource.form_url = instance.form_url AND resource.backend_id = instance.backend_id
      AND resource.target_key = instance.target_key AND resource.generation = management.generation
      AND resource.last_operation = operation.id AND resource.busy_operation = operation.id
      AND resource.deleted_at IS NULL AND resource.spec_json = management.accepted_spec_json
      AND operation.resource_uid = management.resource_uid AND operation.principal = management.principal
      AND operation.action = management.action AND operation.generation = management.generation
      AND operation.backend_id = management.backend_id AND operation.target_key = management.target_key
      AND operation.backend_key = management.backend_key AND operation.accepted_spec_json = management.accepted_spec_json
      AND operation.status = 'reconciling' AND operation.effect = 'unknown' AND operation.dispatch_possible = 1
      AND operation.lease_token IS NOT NULL AND operation.lease_until_ms > (CAST(strftime('%s','now') AS INTEGER) + 1) * 1000
      AND ((management.action = 'delete' AND instance.retire_operation_id = management.operation_id
        AND instance.retired_at_ms IS NOT NULL AND instance.serving_generation IS NULL
        AND resource.phase = 'deleting' AND revision.retention = 'retired')
      OR (management.action = 'update' AND instance.retire_operation_id IS NULL
        AND instance.retired_at_ms IS NULL AND instance.serving_generation = management.generation
        AND resource.phase = 'pending' AND revision.retention = 'draining'
        AND EXISTS (
          SELECT 1 FROM ${R} serving
          JOIN ${Q} replacement ON replacement.resource_uid = serving.resource_uid AND replacement.generation = serving.generation
          JOIN ${S} running ON running.resource_uid = replacement.resource_uid AND running.generation = replacement.generation
          WHERE serving.resource_uid = management.resource_uid AND serving.generation = management.generation
            AND serving.operation_id = management.operation_id AND serving.revision = management.revision
            AND serving.retention = 'serving' AND replacement.installation_id = instance.installation_id
            AND replacement.state = 'bound' AND replacement.allocation_cleanup = 'untouched'
            AND replacement.application_io_cleanup = ${literal(V2_CONTAINER_APPLICATION_IO_RESERVED)}
            AND json_extract(replacement.native_control, '$.kind') = 'linux-oci-sealed-control@1'
            AND json_extract(replacement.native_control, '$.scope.purpose') = 'takoserver.linux-oci-parent-peer-control@1'
            AND running.attempt = 1 AND running.create_claim_id = replacement.claim_id
            AND running.native_id = replacement.native_id AND running.state = 'running'
            AND running.confirmed_running_at_ms IS NOT NULL AND running.confirmed_exited_at_ms IS NULL)))
  )`;
  const applicationSuccessorClose = `CASE WHEN json_valid(NEW.close_document) THEN
    json_type(NEW.close_document) = 'object'
    AND (SELECT count(*) FROM json_each(NEW.close_document)) = 5
    AND json_extract(NEW.close_document, '$.kind') = 'linux-oci-sealed-host-application-successor-close@1'
    AND ${text("json_extract(NEW.close_document, '$.keyId')")}
    AND ${text("json_extract(NEW.close_document, '$.nonce')")}
    AND json_type(NEW.close_document, '$.ciphertext') = 'text'
    AND length(json_extract(NEW.close_document, '$.ciphertext')) > 0
    AND json_type(NEW.close_document, '$.scope') = 'object'
    AND (SELECT count(*) FROM json_each(NEW.close_document, '$.scope')) = 10
    AND json_extract(NEW.close_document, '$.scope.purpose') = 'takoserver.linux-oci-host-application-successor-close@1'
    AND json_type(NEW.close_document, '$.scope.resourceUid') = 'text'
    AND json_extract(NEW.close_document, '$.scope.resourceUid') IS NEW.resource_uid
    AND json_type(NEW.close_document, '$.scope.generation') = 'integer'
    AND json_extract(NEW.close_document, '$.scope.generation') IS NEW.generation
    AND json_extract(NEW.close_document, '$.scope.claimId') IS NEW.claim_id
    AND json_extract(NEW.close_document, '$.scope.nativeId') IS NEW.native_id
    AND json_type(NEW.close_document, '$.scope.epoch') = 'integer'
    AND json_extract(NEW.close_document, '$.scope.epoch') IS NEW.epoch
    AND json_extract(NEW.close_document, '$.scope.ownerToken') IS NEW.owner_token
    AND json_extract(NEW.close_document, '$.scope.installationId') IS json_extract(NEW.predecessor_close_document, '$.scope.installationId')
    AND json_extract(NEW.close_document, '$.scope.incarnationId') IS json_extract(NEW.predecessor_close_document, '$.scope.incarnationId')
    AND json_extract(NEW.close_document, '$.scope.controlDigest') IS json_extract(NEW.predecessor_close_document, '$.scope.controlDigest')
  ELSE 0 END`;
  const applicationSuccessorObjects = Object.freeze([
    object(
      "table",
      applicationSuccessorTable,
      applicationSuccessorTable,
      `CREATE TABLE ${applicationSuccessorTable} (
  resource_uid TEXT NOT NULL CHECK (${text("resource_uid")}),
  generation INTEGER NOT NULL CHECK (${integer("generation", 1)}),
  claim_id TEXT NOT NULL CHECK (${hex("claim_id")}),
  native_id TEXT NOT NULL CHECK (${hex("native_id")}),
  epoch INTEGER NOT NULL CHECK (${integer("epoch", 1)}),
  owner_token TEXT NOT NULL UNIQUE CHECK (${hex("owner_token")}),
  predecessor_close_document TEXT NOT NULL CHECK (typeof(predecessor_close_document) = 'text' AND length(predecessor_close_document) BETWEEN 1 AND 65536 AND json_valid(predecessor_close_document)),
  close_document TEXT CHECK (close_document IS NULL OR (typeof(close_document) = 'text' AND length(close_document) BETWEEN 1 AND 65536 AND json_valid(close_document))),
  PRIMARY KEY (resource_uid, generation, epoch),
  FOREIGN KEY (resource_uid, generation) REFERENCES ${Q}(resource_uid, generation)
)`,
    ),
    trigger(
      "application_successor_reserve",
      applicationSuccessorTable,
      "BEFORE INSERT",
      refuse(`NEW.close_document IS NULL AND ${currentApplicationSuccessorClaim}
    AND NOT EXISTS (SELECT 1 FROM ${applicationSuccessorTable}
      WHERE owner_token = NEW.owner_token OR (resource_uid = NEW.resource_uid AND generation = NEW.generation AND epoch >= NEW.epoch))
    AND ((NEW.epoch = 1 AND EXISTS (SELECT 1 FROM ${shutdownIoTable}
        WHERE ${applicationSuccessorClaim} AND close_document = NEW.predecessor_close_document))
      OR (NEW.epoch > 1 AND EXISTS (SELECT 1 FROM ${applicationSuccessorTable}
        WHERE ${applicationSuccessorClaim} AND epoch = NEW.epoch - 1 AND close_document = NEW.predecessor_close_document)))`),
    ),
    trigger(
      "application_successor_record_close",
      applicationSuccessorTable,
      "BEFORE UPDATE",
      refuse(`${same(["resource_uid", "generation", "claim_id", "native_id", "epoch", "owner_token", "predecessor_close_document"])}
    AND OLD.close_document IS NULL AND ${applicationSuccessorClose}
    AND NOT EXISTS (SELECT 1 FROM ${applicationSuccessorTable} later
      WHERE later.resource_uid = NEW.resource_uid AND later.generation = NEW.generation AND later.epoch > NEW.epoch)
    AND (${currentApplicationSuccessorClaim} OR ${acceptedApplicationSuccessorRetirement})`),
    ),
    trigger(
      "application_successor_retain",
      applicationSuccessorTable,
      "BEFORE DELETE",
      refuse("0"),
    ),
    trigger(
      "application_successor_fence_management",
      A,
      "BEFORE INSERT",
      `  SELECT CASE WHEN NEW.action IN ('update', 'delete') AND NOT (
    NOT EXISTS (
      SELECT 1 FROM ${applicationSuccessorTable} historical
      JOIN ${I} instance ON instance.resource_uid = historical.resource_uid
      WHERE historical.resource_uid = NEW.resource_uid
        AND historical.generation IS NOT instance.serving_generation
        AND (historical.close_document IS NULL OR NOT EXISTS (
          SELECT 1 FROM ${Q} claim
          WHERE claim.resource_uid = historical.resource_uid AND claim.generation = historical.generation
            AND claim.claim_id = historical.claim_id AND claim.native_id = historical.native_id
            AND claim.installation_id = instance.installation_id AND claim.state = 'removed'
            AND claim.allocation_cleanup = 'closed' AND historical.generation < NEW.generation)))
    AND ((NEW.${applicationSuccessorOwnerToken} IS NULL AND NOT EXISTS (
      SELECT 1 FROM ${applicationSuccessorTable} successor
      JOIN ${I} instance ON instance.resource_uid = successor.resource_uid
      WHERE successor.resource_uid = NEW.resource_uid AND instance.serving_generation = successor.generation))
    OR EXISTS (
      SELECT 1 FROM ${applicationSuccessorTable} successor
      JOIN ${I} instance ON instance.resource_uid = successor.resource_uid
      JOIN ${Q} claim ON claim.resource_uid = successor.resource_uid AND claim.generation = successor.generation
      WHERE successor.resource_uid = NEW.resource_uid AND successor.owner_token = NEW.${applicationSuccessorOwnerToken}
        AND instance.installation_id = NEW.installation_id AND instance.incarnation_id = NEW.incarnation_id
        AND instance.desired_generation = NEW.generation - 1 AND instance.serving_generation = successor.generation
        AND instance.retire_operation_id IS NULL AND claim.installation_id = instance.installation_id
        AND claim.state = 'bound' AND claim.native_id = successor.native_id AND claim.claim_id = successor.claim_id
        AND claim.allocation_cleanup = 'untouched'
        AND claim.application_io_cleanup = ${literal(V2_CONTAINER_APPLICATION_IO_RESERVED)}
        AND NOT EXISTS (SELECT 1 FROM ${applicationSuccessorTable} later
          WHERE later.resource_uid = successor.resource_uid AND later.generation = successor.generation
            AND later.epoch > successor.epoch)
    ))) THEN CASE WHEN NEW.action = 'delete' THEN RAISE(ABORT, 'container_owner_application_successor_delete')
      ELSE RAISE(ABORT, 'container_owner_application_successor_update') END END;`,
    ),
    trigger(
      "application_successor_acceptance_retain",
      A,
      "BEFORE UPDATE",
      refuse(`NEW.${applicationSuccessorOwnerToken} IS OLD.${applicationSuccessorOwnerToken}`),
    ),
  ]);
  const applicationSuccessorSelectedObjects = Object.freeze([
    ...shutdownIoSelectedObjects.map((item) =>
      item.type === "table" && item.name === A
        ? object(
            item.type,
            item.name,
            item.table,
            item.sql.replace(
              ",\n  UNIQUE (resource_uid, generation)",
              `, ${successorOwnerColumn},\n  UNIQUE (resource_uid, generation)`,
            ),
          )
        : item.name === historicalDeleteAcceptance.name
          ? historicalDeleteAcceptance
          : item,
    ),
    ...applicationSuccessorObjects,
  ]);
  const applicationSuccessorRows = Object.freeze(
    applicationSuccessorSelectedObjects.map((item) =>
      Object.freeze<[string, string, string, string]>([item.type, item.name, item.table, item.sql]),
    ),
  );
  const applicationSuccessorReadyParams = Object.freeze([JSON.stringify(applicationSuccessorRows)]);
  const expectedPositions = applicationSuccessorRows.map((_, index) => `(${index})`).join(", ");
  // Extract each expected object's fields once per SQLite statement, then compare
  // the same exact catalog rows and run the live inventory and foreign-key guards.
  const applicationSuccessorReady =
    `(WITH owner_catalog_document(document) AS (VALUES (?)),
      owner_catalog_positions(position) AS (VALUES ${expectedPositions}),
      owner_catalog_tuples(tuple) AS MATERIALIZED (
        SELECT json_extract(document, '$[' || position || ']')
        FROM owner_catalog_document CROSS JOIN owner_catalog_positions
      ),
      expected_owner_objects(type, name, tbl_name, definition) AS MATERIALIZED (
        SELECT json_extract(tuple, '$[0]'), json_extract(tuple, '$[1]'),
          json_extract(tuple, '$[2]'), json_extract(tuple, '$[3]') FROM owner_catalog_tuples
    ) SELECT ` +
    selectedCatalogReady(
      `NOT EXISTS (SELECT 1 FROM expected_owner_objects e WHERE (SELECT count(*) FROM main.sqlite_schema s
        WHERE s.type = e.type AND s.name = e.name AND s.tbl_name = e.tbl_name
          AND s.sql = e.definition) <> 1)`,
      applicationSuccessorSelectedObjects.map((item) => literal(item.name)).join(", "),
      `${tableNames}, ${literal(shutdownIoTable)}, ${literal(applicationSuccessorTable)}`,
    ) +
    ")";
  const applicationSuccessorTransition = "__tako_container_application_successor_transition";

  return Object.freeze({
    from: V2_CONTAINER_OWNER_SHUTDOWN_IO_EXPAND,
    objects: applicationSuccessorSelectedObjects,
    ready: Object.freeze({
      sql: applicationSuccessorReady,
      params: applicationSuccessorReadyParams,
    }),
    statements: Object.freeze(
      [
        { sql: `CREATE TABLE temp.${applicationSuccessorTransition} (ok INTEGER NOT NULL)` },
        {
          sql: `INSERT INTO temp.${applicationSuccessorTransition} VALUES (CASE WHEN ${shutdownIoReady} THEN 1 END)`,
          params: shutdownIoReadyParams,
        },
        { sql: `ALTER TABLE ${A} ADD COLUMN ${successorOwnerColumn}` },
        { sql: `DROP TRIGGER ${historicalDeleteAcceptance.name}` },
        { sql: historicalDeleteAcceptance.sql },
        ...applicationSuccessorObjects.map(({ sql }) => ({ sql })),
        {
          sql: `UPDATE temp.${applicationSuccessorTransition} SET ok = CASE WHEN ${applicationSuccessorReady} THEN 1 END`,
          params: applicationSuccessorReadyParams,
        },
        { sql: `DROP TABLE temp.${applicationSuccessorTransition}` },
      ].map((statement) => Object.freeze(statement)),
    ) as readonly SqlStatement[],
  });
}

/** Optional SQLite candidate. The row records a one-use reservation before I/O
 * and retains one terminal envelope per epoch. Only the owning runtime can
 * authenticate either close envelope. Selected DELETE and UPDATE atomically
 * bind the serving owner in their existing acceptance transaction. */
export const V2_CONTAINER_OWNER_APPLICATION_SUCCESSOR_EXPAND =
  /* @__PURE__ */ buildApplicationSuccessorSchema();

async function inspectContainerOwnerReadiness(
  sql: Sql,
  { sql: predicate, params }: SqlStatement,
): Promise<boolean> {
  try {
    const rows = await sql.query(`SELECT ${predicate} AS ready`, params);
    return rows.length === 1 && Object.keys(rows[0] ?? {}).length === 1 && rows[0]?.ready === 1;
  } catch {
    return false;
  }
}

export function inspectV2ContainerOwnerApplicationSuccessorSchema(sql: Sql): Promise<boolean> {
  return inspectContainerOwnerReadiness(sql, V2_CONTAINER_OWNER_APPLICATION_SUCCESSOR_EXPAND.ready);
}

/** Existing standalone inspectors retain their exact predecessor shapes. */
export async function inspectV2ContainerOwnerSelectedSchema(
  sql: Sql,
  layer: "control" | "allocation" | "application-io" | "final-delete",
): Promise<boolean> {
  const original =
    layer === "control"
      ? ([selectedControlReady, selectedControlReadyParams] as const)
      : layer === "allocation"
        ? ([selectedAllocationReady, selectedAllocationReadyParams] as const)
        : layer === "application-io"
          ? ([selectedApplicationIoReady, selectedApplicationIoReadyParams] as const)
          : ([finalDeleteReady, finalDeleteReadyParams] as const);
  try {
    const rows = await sql.query(
      `SELECT (${original[0]} OR ${historicalDeleteReady} OR ${shutdownIoReady}) AS ready`,
      [...original[1], ...historicalDeleteParams, ...shutdownIoReadyParams],
    );
    return rows.length === 1 && Object.keys(rows[0] ?? {}).length === 1 && rows[0]?.ready === 1;
  } catch {
    return false;
  }
}
const historicalSelectedControlReady = `(${selectedControlReady} OR ${historicalDeleteReady} OR ${shutdownIoReady})`;
const historicalSelectedControlParams = Object.freeze([
  ...selectedControlReadyParams,
  ...historicalDeleteParams,
  ...shutdownIoReadyParams,
]);

interface ContainerHostAcceptanceOptions {
  readonly sql: Sql;
  readonly installationId: string;
  readonly backendId: string;
  readonly targetKey: string;
}

/** Construct the public Host acceptance compiler for its existing SQL shapes. */
export function createV2ContainerHostAcceptance(
  options: ContainerHostAcceptanceOptions & { readonly ociParentControl?: "sealed-original@1" },
): V2HostAcceptance {
  return createContainerHostAcceptance(options, options.ociParentControl === "sealed-original@1");
}

/** The selected native application owner uses the same acceptance transaction. */
export function createNativeOciContainerHostAcceptance(
  options: ContainerHostAcceptanceOptions,
): V2HostAcceptance {
  return createContainerHostAcceptance(options, true, {
    ready: V2_CONTAINER_OWNER_APPLICATION_SUCCESSOR_EXPAND.ready,
    ownerTokenColumn: applicationSuccessorOwnerToken,
    selectServingOwner: `SELECT successor.owner_token
  FROM main.${applicationSuccessorTable} successor
  JOIN main.${I} instance ON instance.resource_uid = successor.resource_uid
  WHERE successor.resource_uid = ? AND successor.generation = instance.serving_generation
  ORDER BY successor.epoch DESC LIMIT 1`,
  });
}

/** No request DTO, SQL claim or callback mints native authority. */
function createContainerHostAcceptance(
  options: ContainerHostAcceptanceOptions,
  usesOciControl: boolean,
  applicationSuccessor?: {
    readonly ready: Required<SqlStatement>;
    readonly ownerTokenColumn: string;
    readonly selectServingOwner: string;
  },
): V2HostAcceptance {
  const { sql, installationId, backendId, targetKey } = options;
  const selectedReady = usesOciControl ? historicalSelectedControlReady : runtimeReady;
  const selectedReadyParams = usesOciControl ? historicalSelectedControlParams : runtimeReadyParams;
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
    async prepare(context: V2HostAcceptanceContext) {
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
      if (!isContainerWorkloadRevision(workload))
        throw new TypeError("invalid Container F2 workload revision");
      const configuredJson = serializeV2ContainerConfiguredPrivateInputs(c.configuredPrivateInputs);
      // A void UPDATE hook after an empty CREATE has no stable CREATE envelope
      // in the original Core context. Retention must be proved from accepted
      // Core and owner history inside the same atomic admission batch.
      const needsRetainedMaterial =
        c.action === "update" && names.length > 0 && configuredJson === null;
      if (
        (c.action === "create" &&
          names.length > 0 &&
          (c.privateInputs === undefined || configuredJson === null)) ||
        (needsRetainedMaterial && c.privateInputs !== undefined)
      )
        throw new TypeError("Container F2 configured private inputs unavailable");
      const incarnation =
        c.action === "create"
          ? Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("")
          : null;
      const retainedMaterialGuard = needsRetainedMaterial
        ? ` AND EXISTS (SELECT 1 FROM main.${A} prior
          JOIN main.${A} previous ON previous.resource_uid = prior.resource_uid AND previous.generation = ?
          JOIN main.tf_v2_operations accepted ON accepted.id = prior.operation_id
          JOIN main.tf_v2_resources resource ON resource.uid = prior.resource_uid
          WHERE prior.resource_uid = ? AND prior.generation < ?
            AND prior.installation_id = ? AND prior.principal = ? AND prior.space = ?
            AND prior.name = ? AND prior.form_url = ? AND prior.backend_id = ? AND prior.target_key = ?
            AND prior.configured_private_inputs_json IS NOT NULL
            AND prior.action IN ('create', 'update') AND previous.action IN ('create', 'update')
            AND resource.principal = prior.principal AND resource.space = prior.space
            AND resource.name = prior.name AND resource.form_url = prior.form_url
            AND resource.backend_id = prior.backend_id AND resource.target_key = prior.target_key
            AND resource.generation = ? AND resource.deleted_at IS NULL
            AND accepted.resource_uid = prior.resource_uid AND accepted.generation = prior.generation
            AND accepted.action = prior.action AND accepted.principal = prior.principal
            AND accepted.backend_id = prior.backend_id AND accepted.target_key = prior.target_key
            AND accepted.accepted_spec_json = prior.accepted_spec_json
            AND NOT EXISTS (SELECT 1 FROM json_each(?) required
              WHERE NOT EXISTS (SELECT 1 FROM json_each(previous.accepted_spec_json, '$.requiredSensitiveVars') declared
                WHERE declared.value = required.value))
            AND ((prior.action = 'create' AND prior.generation = 1
              AND EXISTS (SELECT 1 FROM main.tf_v2_configured_private_inputs material
                WHERE material.resource_uid = prior.resource_uid
                  AND material.key_id = json_extract(prior.configured_private_inputs_json, '$.keyId')
                  AND material.nonce = json_extract(prior.configured_private_inputs_json, '$.nonce')
                  AND material.ciphertext = json_extract(prior.configured_private_inputs_json, '$.ciphertext')))
              OR (prior.action = 'update'
                AND EXISTS (SELECT 1 FROM main.tf_v2_operation_configured_private_inputs material
                  WHERE material.operation_id = prior.operation_id
                    AND material.resource_uid = prior.resource_uid AND material.generation = prior.generation
                    AND material.key_id = json_extract(prior.configured_private_inputs_json, '$.keyId')
                    AND material.nonce = json_extract(prior.configured_private_inputs_json, '$.nonce')
                    AND material.ciphertext = json_extract(prior.configured_private_inputs_json, '$.ciphertext'))))
            AND NOT EXISTS (SELECT 1 FROM main.tf_v2_operation_configured_private_inputs later
              WHERE later.resource_uid = prior.resource_uid AND later.generation > prior.generation
                AND later.generation < ?))`
        : "";
      const retainedMaterialParams = needsRetainedMaterial
        ? [
            c.generation - 1,
            c.resourceUid,
            c.generation,
            installationId,
            c.principal,
            c.space,
            c.name,
            c.form,
            backendId,
            targetKey,
            c.generation - 1,
            JSON.stringify(names),
            c.generation,
          ]
        : [];
      const selectedSuccessor =
        applicationSuccessor &&
        c.action === "update" &&
        (await inspectContainerOwnerReadiness(sql, applicationSuccessor.ready))
          ? applicationSuccessor
          : undefined;
      const readiness =
        selectedSuccessor?.ready ??
        (applicationSuccessor && c.action === "create"
          ? {
              sql: `(${selectedReady} OR ${applicationSuccessor.ready.sql})`,
              params: [...selectedReadyParams, ...applicationSuccessor.ready.params],
            }
          : { sql: selectedReady, params: selectedReadyParams });
      const guard: SqlStatement = {
        sql: `${readiness.sql} AND (${
          c.action === "create"
            ? `NOT EXISTS (SELECT 1 FROM main.${I} WHERE resource_uid = ?)`
            : `EXISTS (SELECT 1 FROM main.${I} WHERE resource_uid = ? AND installation_id = ?
            AND principal = ? AND space = ? AND name = ? AND form_url = ? AND backend_id = ? AND target_key = ?
            AND desired_generation = ? AND retired_at_ms IS NULL)`
        })${retainedMaterialGuard}`,
        params: [
          ...readiness.params,
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
                ...retainedMaterialParams,
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
          configured_private_inputs_json, accepted_at, retain_until, revision${selectedSuccessor ? `, ${selectedSuccessor.ownerTokenColumn}` : ""})
          SELECT ?, ?, ?, ${c.action === "create" ? "?" : `(SELECT incarnation_id FROM main.${I} WHERE resource_uid = ?)`},
            ?, ?, ?, ?, ?, ?, ?, ?, op.backend_key, ?, ?, ?, ?, ?, ?, ?, ?, ?${selectedSuccessor ? `, (${selectedSuccessor.selectServingOwner})` : ""}
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
          ...(selectedSuccessor ? [c.resourceUid] : []),
          c.operationId,
        ],
      };
      return prepareV2HostAcceptance(sql, context, guard, terminal);
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
      if (!isContainerWorkloadRevision(workload))
        throw new TypeError("invalid Container F2 workload revision");
      return (async () => {
        const successor =
          applicationSuccessor &&
          (await inspectContainerOwnerReadiness(sql, applicationSuccessor.ready))
            ? applicationSuccessor
            : undefined;
        const readiness = successor?.ready ?? { sql: selectedReady, params: selectedReadyParams };
        const guard: SqlStatement = {
          sql: `${readiness.sql} AND (${`EXISTS (SELECT 1 FROM main.${I} WHERE resource_uid = ? AND installation_id = ?
            AND principal = ? AND space = ? AND name = ? AND form_url = ? AND backend_id = ? AND target_key = ?
            AND desired_generation = ? AND retired_at_ms IS NULL)`})`,
          params: [
            ...readiness.params,
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
          configured_private_inputs_json, accepted_at, retain_until, revision${successor ? `, ${successor.ownerTokenColumn}` : ""})
          VALUES ( ?, ?, ?, ${`(SELECT incarnation_id FROM main.${I} WHERE resource_uid = ?)`},
            ?, ?, ?, ?, ?, ?, ?, ?, (SELECT op.backend_key FROM main.tf_v2_operations op WHERE op.id = ?), ?, ?, ?, ?, ?, NULL, ?, ?, ?${
              successor ? `, (${successor.selectServingOwner})` : ""
            }
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
            ...(successor ? [c.resourceUid] : []),
          ],
        };
        return prepareV2HostAcceptance(sql, context, guard, terminal);
      })();
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
        !isContainerWorkloadRevision(workload)
      )
        throw new TypeError("frozen Container Form cannot accept sensitive inputs");
      const incarnation =
        c.action === "create"
          ? Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("")
          : null;
      const guard: SqlStatement = {
        sql: `${selectedReady} AND (${
          c.action === "create"
            ? `NOT EXISTS (SELECT 1 FROM main.${I} WHERE resource_uid = ?)`
            : `EXISTS (SELECT 1 FROM main.${I} WHERE resource_uid = ? AND installation_id = ?
            AND principal = ? AND space = ? AND name = ? AND form_url = ? AND backend_id = ? AND target_key = ?
            AND desired_generation = ? AND retired_at_ms IS NULL)`
        })`,
        params: [
          ...selectedReadyParams,
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
        !isContainerWorkloadRevision(workload)
      )
        throw new TypeError("frozen Container Form cannot accept sensitive inputs");
      const guard: SqlStatement = {
        sql: `${selectedReady} AND (${`EXISTS (SELECT 1 FROM main.${I} WHERE resource_uid = ? AND installation_id = ?
            AND principal = ? AND space = ? AND name = ? AND form_url = ? AND backend_id = ? AND target_key = ?
            AND desired_generation = ? AND retired_at_ms IS NULL)`})`,
        params: [
          ...selectedReadyParams,
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
      if (context.form === F2_FORM) return f2.prepare(context);
      return undefined;
    },
    prepareDelete(context: V2HostDeleteAcceptanceContext) {
      if (context.form === C.formUrl) return legacy.prepareDelete!(context);
      return f2.prepareDelete!(context);
    },
  });
}
