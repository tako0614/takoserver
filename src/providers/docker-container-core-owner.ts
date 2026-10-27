import { CONTAINER_CONTRACT as C } from "../container-contract.ts";
import { canonicalDigest, canonicalJson, isJsonObject, type JsonObject } from "../json.ts";
import type { Row, Sql, SqlParam, SqlStatement } from "../ports.ts";
import { parseStrictJson } from "../strict-json.ts";
import { readV2ConfiguredPrivateInputs } from "../takoform-v2/configured-private-inputs.ts";
import {
  createV2ContainerHostAcceptance,
  serializeV2ContainerConfiguredPrivateInputs,
  V2_CONTAINER_F2_FORM,
  validateV2ContainerF2SensitiveNames,
} from "../takoform-v2/container-owner-schema.ts";
import type {
  V2HostAcceptance,
  V2HostAcceptanceContext,
  V2HostDeleteAcceptanceContext,
} from "../takoform-v2/host-acceptance.ts";
import type { V2Execution } from "../takoform-v2/types.ts";
import type { HostedContainerSecretKeyring } from "./container-secret-codec.ts";
import {
  createDockerContainerConfiguredInputs,
  type DockerContainerConfiguredInputs,
  validateDockerContainerSpec,
} from "./docker-container-configured-inputs.ts";
import {
  createDockerContainerCreateCustody,
  type DockerContainerCreateIntent,
  type DockerContainerCreateOwnerPort,
  type DockerContainerCreatePhase,
  type DockerContainerCreateRecord,
} from "./docker-container-create-custody.ts";
import {
  type DockerContainerNativeIdentity,
  type DockerContainerRuntimePolicy,
  DockerContainerRuntimePreparation,
} from "./docker-container-runtime-preparation.ts";
import { LinuxDockerRuntimePreparation } from "./linux-docker-runtime-preparation.ts";

export interface DockerPhysicalCoreOwnerPort extends DockerContainerCreateOwnerPort {
  publishServing(
    record: DockerContainerCreateRecord,
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
    runtime: DockerContainerRuntimePreparation | LinuxDockerRuntimePreparation,
  ): Promise<void>;
  readStartClaim(
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
  ): Promise<"unclaimed" | "claimed" | "unknown">;
  claimStart(
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
  ): Promise<"claimed" | "already-claimed" | "unknown">;
  assertNetworkAllocation(
    record: DockerContainerCreateRecord,
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
  ): Promise<void>;
  readNetworkMemberRecords(
    record: DockerContainerCreateRecord,
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
    observedIds: readonly string[],
  ): Promise<readonly DockerContainerCreateRecord[]>;
  assertNetworkMembers(
    record: DockerContainerCreateRecord,
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
    observedIds: readonly string[],
  ): Promise<void>;
}
const verifyOriginalRuntime = DockerContainerRuntimePreparation.prototype.verifyExisting;
const verifyLinuxRuntime = LinuxDockerRuntimePreparation.prototype.verifyExisting;
type Context = V2HostAcceptanceContext | V2HostDeleteAcceptanceContext;
type Proof = Record<string, string | number | null>;
type Lease = {
  readonly record: DockerContainerCreateRecord;
  readonly phase: DockerContainerCreatePhase;
  proof: Proof;
  readonly controller: AbortController;
  active: boolean;
};

export interface DockerContainerCoreOwnerOptions {
  readonly sql: Sql;
  readonly clock: () => Date;
  readonly installationId: string;
  readonly backendId: string;
  readonly targetKey: string;
  readonly configuredInputs?: {
    readonly keyring: HostedContainerSecretKeyring;
    readonly maxSecretBytes: number;
  };
}
export interface DockerContainerCoreOwner {
  readonly acceptance: V2HostAcceptance;
  readonly owner: DockerPhysicalCoreOwnerPort;
  createCustody(
    policy: DockerContainerRuntimePolicy,
    requiredSecretNames: readonly string[],
  ): ReturnType<typeof createDockerContainerCreateCustody>;
  readAcceptedExecution(original: V2Execution): Promise<DockerContainerAcceptedExecution>;
  withExecution<T>(execution: V2Execution, work: () => Promise<T>): Promise<T>;
}
export interface DockerContainerAcceptedExecution {
  readonly installationId: string;
  readonly operationId: string;
  readonly resourceUid: string;
  readonly incarnationId: string;
  readonly principal: string;
  readonly space: string;
  readonly name: string;
  readonly form: string;
  readonly backendId: string;
  readonly targetKey: string;
  readonly action: V2Execution["action"];
  readonly generation: number;
  readonly revision: string;
  readonly spec: JsonObject;
  readonly requiredSecretNames: readonly string[];
  readonly outboundInternet: boolean;
  readonly retained: readonly {
    readonly record: DockerContainerCreateRecord;
    readonly spec: JsonObject;
    readonly removedAtMs: number | null;
  }[];
  readonly servingConfirmedAtMs: number | null;
}
type ExecutionScope = {
  readonly execution: V2Execution;
  readonly operationId: string;
  readonly resourceUid: string;
  readonly generation: number;
  readonly leaseToken: string;
  readonly action: V2Execution["action"];
};

const columns = {
  i: [
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
    "desired_generation",
    "management_epoch",
    "serving_generation",
    "runtime_epoch",
    "retire_operation_id",
    "retired_at_ms",
    "created_at",
  ],
  v: [
    "resource_uid",
    "generation",
    "operation_id",
    "revision",
    "intent_json",
    "native_name",
    "retention",
  ],
  a: [
    "operation_id",
    "resource_uid",
    "installation_id",
    "incarnation_id",
    "principal",
    "space",
    "name",
    "form_url",
    "backend_id",
    "target_key",
    "action",
    "generation",
    "backend_key",
    "replay_key",
    "fingerprint",
    "accepted_spec_json",
    "accepted_output_json",
    "references_json",
    "configured_private_inputs_json",
    "accepted_at",
    "retain_until",
    "revision",
  ],
  o: [
    "id",
    "resource_uid",
    "principal",
    "replay_key",
    "request_fingerprint",
    "action",
    "generation",
    "created_at",
    "retain_until",
    "backend_id",
    "target_key",
    "backend_key",
    "accepted_spec_json",
    "private_inputs_present",
    "status",
  ],
  r: [
    "uid",
    "principal",
    "form_url",
    "space",
    "name",
    "backend_id",
    "target_key",
    "active_name",
    "generation",
    "phase",
    "spec_json",
    "last_operation",
    "deleted_at",
  ],
  la: [
    "operation_id",
    "resource_uid",
    "installation_id",
    "incarnation_id",
    "principal",
    "space",
    "name",
    "form_url",
    "backend_id",
    "target_key",
    "action",
    "generation",
    "backend_key",
    "replay_key",
    "fingerprint",
    "accepted_spec_json",
    "accepted_output_json",
    "references_json",
    "configured_private_inputs_json",
    "accepted_at",
    "retain_until",
    "revision",
  ],
  lo: [
    "id",
    "resource_uid",
    "principal",
    "replay_key",
    "request_fingerprint",
    "action",
    "generation",
    "created_at",
    "retain_until",
    "backend_id",
    "target_key",
    "backend_key",
    "accepted_spec_json",
    "private_inputs_present",
    "status",
  ],
  q: [
    "resource_uid",
    "generation",
    "installation_id",
    "claim_id",
    "state",
    "native_id",
    "claimed_at_ms",
    "bound_at_ms",
    "removed_at_ms",
  ],
} as const;
const fields = Object.entries(columns).flatMap(([alias, names]) =>
  names.map((name) => ({ column: alias + "." + name, key: alias + "_" + name })),
);
const from =
  " FROM tf_v2_container_instances i JOIN tf_v2_container_revisions v ON v.resource_uid=i.resource_uid JOIN tf_v2_container_acceptances a ON a.operation_id=v.operation_id JOIN tf_v2_operations o ON o.id=a.operation_id JOIN tf_v2_resources r ON r.uid=i.resource_uid JOIN tf_v2_container_acceptances la ON la.operation_id=r.last_operation JOIN tf_v2_operations lo ON lo.id=la.operation_id LEFT JOIN tf_v2_container_create_claims q ON q.resource_uid=v.resource_uid AND q.generation=v.generation";
const select = "SELECT " + fields.map(({ column, key }) => column + " AS " + key).join(",") + from;
const fail: () => never = (): never => {
  throw new TypeError("Docker Core owner authority refused");
};
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 2048;
const hex = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const own = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return !!d && Object.hasOwn(d, "value");
  });
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const encodedRevision = (value: unknown, generation: unknown): value is string =>
  typeof value === "string" &&
  Number.isSafeInteger(generation) &&
  Number(generation) > 0 &&
  value.startsWith(`${generation}-`) &&
  hex(value.slice(String(generation).length + 1));

const intentKeys = [
  "installationId",
  "resourceUid",
  "incarnationId",
  "revision",
  "nativeName",
  "identityLabel",
  "revisionLabel",
  "policy",
  "requiredSecretNames",
];
const policyKeys = ["tenantRef", "generation", "policyDigest", "outboundInternet"];

function intentSnapshot(value: DockerContainerCreateIntent): DockerContainerCreateIntent {
  if (
    !own(value, intentKeys) ||
    !own(value.policy, policyKeys) ||
    !Array.isArray(value.requiredSecretNames)
  )
    return fail();
  if (
    !intentKeys.slice(0, 7).every((key) => text(value[key])) ||
    !encodedRevision(value.revision, value.policy.generation) ||
    !digest(value.identityLabel) ||
    !digest(value.revisionLabel) ||
    !text(value.policy.tenantRef) ||
    !digest(value.policy.policyDigest) ||
    !Number.isSafeInteger(value.policy.generation) ||
    Number(value.policy.generation) < 1 ||
    typeof value.policy.outboundInternet !== "boolean"
  )
    return fail();
  return Object.freeze({
    installationId: value.installationId as string,
    resourceUid: value.resourceUid as string,
    incarnationId: value.incarnationId as string,
    revision: value.revision as string,
    nativeName: value.nativeName as string,
    identityLabel: value.identityLabel as string,
    revisionLabel: value.revisionLabel as string,
    policy: Object.freeze({
      tenantRef: value.policy.tenantRef,
      generation: value.policy.generation as number,
      policyDigest: value.policy.policyDigest,
      outboundInternet: value.policy.outboundInternet,
    }),
    requiredSecretNames: validateV2ContainerF2SensitiveNames(value.requiredSecretNames),
  });
}
function intentJson(value: DockerContainerCreateIntent): string {
  return JSON.stringify(intentSnapshot(value));
}
function rowProof(row: Row): Proof {
  const proof: Proof = {};
  for (const { key } of fields) {
    const value = row[key];
    if (
      value !== null &&
      typeof value !== "string" &&
      (typeof value !== "number" || !Number.isSafeInteger(value))
    )
      return fail();
    proof[key] = value as string | number | null;
  }
  return Object.freeze(proof);
}
function fence(proof: Proof): { sql: string; params: SqlParam[] } {
  return {
    sql:
      "EXISTS (SELECT 1" +
      from +
      " WHERE " +
      fields.map(({ column }) => column + " IS ?").join(" AND ") +
      ")",
    params: fields.map(({ key }) => proof[key]!),
  };
}

/** Must be installed into actual Core through AppPorts.v2ContainerHostAcceptance. */
export function createDockerContainerCoreOwner(
  options: DockerContainerCoreOwnerOptions,
): DockerContainerCoreOwner {
  const { sql, clock, installationId, backendId, targetKey } = options;
  const original = createV2ContainerHostAcceptance({ sql, installationId, backendId, targetKey });
  if (typeof clock !== "function") return fail();
  const executions = new Set<ExecutionScope>();
  const deleteExecutions = new Set<ExecutionScope>();
  let configuredInputs: DockerContainerConfiguredInputs | undefined;
  const contexts = new Map<string, Context>();
  const leases = new Set<Lease>();
  const now = () => {
    const value = clock();
    if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime()) || value.getTime() < 0)
      return fail();
    return value.getTime();
  };
  const capture = (context: Context) => {
    if (
      !Object.isFrozen(context) ||
      !Object.keys(context).every((key) => {
        const d = Object.getOwnPropertyDescriptor(context, key);
        return !!d && Object.hasOwn(d, "value");
      })
    )
      return fail();
    for (const lease of leases)
      if (
        lease.record.intent.resourceUid === context.resourceUid &&
        !(context.action === "update" && retainedServing(lease, lease.proof))
      )
        lease.controller.abort();
    contexts.set(context.operationId, context);
  };
  const acceptance: V2HostAcceptance = Object.freeze<V2HostAcceptance>({
    assertSql(candidate) {
      original.assertSql(candidate);
    },
    initialOutput(scope) {
      return original.initialOutput(scope);
    },
    prepare(context) {
      const prepared = original.prepare(context);
      if (prepared === undefined) return undefined;
      return prepared.then((value) => {
        capture(context);
        return value;
      });
    },
    prepareDelete(context) {
      const prepared = original.prepareDelete!(context);
      if (prepared === undefined) return undefined;
      return prepared.then((value) => {
        capture(context);
        return value;
      });
    },
  });
  function acceptedLegacy(
    proof: Proof,
    acceptanceAlias: "a" | "la",
    operationAlias: "o" | "lo",
  ): void {
    const a = (key: string) => proof[acceptanceAlias + "_" + key];
    const o = (key: string) => proof[operationAlias + "_" + key];
    const requiredText = [
      "operation_id",
      "resource_uid",
      "installation_id",
      "incarnation_id",
      "principal",
      "space",
      "name",
      "form_url",
      "backend_id",
      "target_key",
      "backend_key",
      "replay_key",
      "fingerprint",
      "accepted_at",
      "retain_until",
    ];
    if (
      !requiredText.every((key) => text(a(key))) ||
      !["create", "update", "delete"].includes(String(a("action"))) ||
      typeof a("generation") !== "number" ||
      Number(a("generation")) < 1 ||
      (a("action") === "create" ? a("generation") !== 1 : Number(a("generation")) < 2)
    )
      fail();
    const scope: readonly [string, unknown][] = [
      ["resource_uid", proof.i_resource_uid],
      ["installation_id", installationId],
      ["incarnation_id", proof.i_incarnation_id],
      ["principal", proof.i_principal],
      ["space", proof.i_space],
      ["name", proof.i_name],
      ["form_url", C.formUrl],
      ["backend_id", backendId],
      ["target_key", targetKey],
      ["configured_private_inputs_json", null],
    ];
    if (
      !scope.every(([key, value]) => a(key) === value) ||
      (a("action") === "delete" && a("references_json") !== null)
    )
      fail();
    const operationPairs: readonly [string, string][] = [
      ["id", "operation_id"],
      ["resource_uid", "resource_uid"],
      ["principal", "principal"],
      ["replay_key", "replay_key"],
      ["request_fingerprint", "fingerprint"],
      ["action", "action"],
      ["generation", "generation"],
      ["created_at", "accepted_at"],
      ["backend_id", "backend_id"],
      ["target_key", "target_key"],
      ["accepted_spec_json", "accepted_spec_json"],
      ["backend_key", "backend_key"],
    ];
    if (
      !operationPairs.every(([key, acceptedKey]) => o(key) === a(acceptedKey)) ||
      o("private_inputs_present") !== 0
    )
      fail();
    const acceptedUntil = Date.parse(String(a("retain_until")));
    const currentUntil = Date.parse(String(o("retain_until")));
    if (
      !Number.isFinite(acceptedUntil) ||
      !Number.isFinite(currentUntil) ||
      currentUntil < acceptedUntil
    )
      fail();
    for (const key of ["accepted_spec_json", "accepted_output_json", "references_json"]) {
      const value = a(key);
      if (value === null && key === "references_json") continue;
      if (typeof value !== "string") fail();
      const parsed = parseStrictJson(new TextEncoder().encode(value), 1048576);
      if (key === "references_json" ? !Array.isArray(parsed) : !isJsonObject(parsed)) fail();
    }
    const spec = parseStrictJson(
      new TextEncoder().encode(String(a("accepted_spec_json"))),
      1048576,
    );
    if (
      !isJsonObject(spec) ||
      !hex(spec[C.fields.workloadRevision]) ||
      (a("action") !== "delete" &&
        `${a("generation")}-${spec[C.fields.workloadRevision]}` !== a("revision")) ||
      (spec[C.fields.requiredSensitiveVars] !== undefined &&
        (!Array.isArray(spec[C.fields.requiredSensitiveVars]) ||
          (spec[C.fields.requiredSensitiveVars] as unknown[]).length !== 0))
    )
      fail();
    // A live preparation keeps its exact original identity; durable recovery
    // verifies existing rows without reconstructing any Core context/prepared.
    const context = contexts.get(String(a("operation_id")));
    if (context) {
      if (!Object.isFrozen(context)) fail();
      const originalPairs: readonly [string, unknown][] = [
        ["operation_id", context.operationId],
        ["resource_uid", context.resourceUid],
        ["principal", context.principal],
        ["space", context.space],
        ["name", context.name],
        ["form_url", context.form],
        ["backend_id", context.backendId],
        ["target_key", context.targetKey],
        ["action", context.action],
        ["generation", context.generation],
        ["replay_key", context.key],
        ["fingerprint", context.fingerprint],
        ["accepted_spec_json", context.specJson],
        ["accepted_output_json", context.outputJson],
        ["references_json", context.referencesJson],
        ["accepted_at", context.at],
        ["retain_until", context.retainUntil],
      ];
      if (
        !originalPairs.every(([key, value]) => a(key) === value) ||
        context.privateInputs !== undefined ||
        context.configuredPrivateInputs !== undefined
      )
        fail();
    }
  }
  function acceptedF2(proof: Proof, acceptanceAlias: "a" | "la", operationAlias: "o" | "lo"): void {
    const a = (key: string) => proof[acceptanceAlias + "_" + key];
    const o = (key: string) => proof[operationAlias + "_" + key];
    const requiredText = [
      "operation_id",
      "resource_uid",
      "installation_id",
      "incarnation_id",
      "principal",
      "space",
      "name",
      "form_url",
      "backend_id",
      "target_key",
      "backend_key",
      "replay_key",
      "fingerprint",
      "accepted_at",
      "retain_until",
    ];
    if (
      !requiredText.every((key) => text(a(key))) ||
      !["create", "update", "delete"].includes(String(a("action"))) ||
      typeof a("generation") !== "number" ||
      Number(a("generation")) < 1 ||
      (a("action") === "create" ? a("generation") !== 1 : Number(a("generation")) < 2)
    )
      fail();
    const scope: readonly [string, unknown][] = [
      ["resource_uid", proof.i_resource_uid],
      ["installation_id", installationId],
      ["incarnation_id", proof.i_incarnation_id],
      ["principal", proof.i_principal],
      ["space", proof.i_space],
      ["name", proof.i_name],
      ["form_url", V2_CONTAINER_F2_FORM],
      ["backend_id", backendId],
      ["target_key", targetKey],
    ];
    if (
      !scope.every(([key, value]) => a(key) === value) ||
      (a("action") === "delete" && a("references_json") !== null)
    )
      fail();
    const operationPairs: readonly [string, string][] = [
      ["id", "operation_id"],
      ["resource_uid", "resource_uid"],
      ["principal", "principal"],
      ["replay_key", "replay_key"],
      ["request_fingerprint", "fingerprint"],
      ["action", "action"],
      ["generation", "generation"],
      ["created_at", "accepted_at"],
      ["backend_id", "backend_id"],
      ["target_key", "target_key"],
      ["accepted_spec_json", "accepted_spec_json"],
      ["backend_key", "backend_key"],
    ];
    if (
      !operationPairs.every(([key, acceptedKey]) => o(key) === a(acceptedKey)) ||
      (o("private_inputs_present") !== 0 && o("private_inputs_present") !== 1)
    )
      fail();
    const acceptedUntil = Date.parse(String(a("retain_until")));
    const currentUntil = Date.parse(String(o("retain_until")));
    if (
      !Number.isFinite(acceptedUntil) ||
      !Number.isFinite(currentUntil) ||
      currentUntil < acceptedUntil
    )
      fail();
    for (const key of ["accepted_spec_json", "accepted_output_json", "references_json"]) {
      const value = a(key);
      if (value === null && key === "references_json") continue;
      if (typeof value !== "string") fail();
      const parsed = parseStrictJson(new TextEncoder().encode(value), 1048576);
      if (key === "references_json" ? !Array.isArray(parsed) : !isJsonObject(parsed)) fail();
    }
    const spec = parseStrictJson(
      new TextEncoder().encode(String(a("accepted_spec_json"))),
      1048576,
    );
    if (
      !isJsonObject(spec) ||
      !hex(spec[C.fields.workloadRevision]) ||
      (a("action") !== "delete" &&
        `${a("generation")}-${spec[C.fields.workloadRevision]}` !== a("revision"))
    )
      fail();
    const environment = spec[C.fields.environment];
    if (environment !== undefined && !isJsonObject(environment)) fail();
    const names = validateV2ContainerF2SensitiveNames(
      spec[C.fields.requiredSensitiveVars] === undefined
        ? []
        : spec[C.fields.requiredSensitiveVars],
      environment === undefined ? [] : Object.keys(environment),
    );
    if (
      spec[C.fields.outboundInternet] !== undefined &&
      typeof spec[C.fields.outboundInternet] !== "boolean"
    )
      fail();
    const rawConfigured = a("configured_private_inputs_json");
    if (rawConfigured !== null && typeof rawConfigured !== "string") fail();
    const configured =
      rawConfigured === null
        ? null
        : serializeV2ContainerConfiguredPrivateInputs(
            parseStrictJson(new TextEncoder().encode(rawConfigured as string), 1048576),
          );
    if (
      (a("action") === "delete" && (configured !== null || o("private_inputs_present") !== 0)) ||
      (a("action") === "create" &&
        names.length > 0 &&
        (configured === null || o("private_inputs_present") !== 1)) ||
      // An explicit map that declares names must carry its own sealed envelope. An UPDATE
      // without a map keeps what Core captured at admission, which is null when the CREATE
      // had no envelope; its retained source is proved separately at admission.
      (a("action") === "update" &&
        configured === null &&
        names.length > 0 &&
        o("private_inputs_present") === 1)
    )
      fail();
    // A live preparation keeps its exact original identity; durable recovery
    // verifies existing rows without reconstructing any Core context/prepared.
    const context = contexts.get(String(a("operation_id")));
    if (context) {
      if (!Object.isFrozen(context)) fail();
      const originalPairs: readonly [string, unknown][] = [
        ["operation_id", context.operationId],
        ["resource_uid", context.resourceUid],
        ["principal", context.principal],
        ["space", context.space],
        ["name", context.name],
        ["form_url", context.form],
        ["backend_id", context.backendId],
        ["target_key", context.targetKey],
        ["action", context.action],
        ["generation", context.generation],
        ["replay_key", context.key],
        ["fingerprint", context.fingerprint],
        ["accepted_spec_json", context.specJson],
        ["accepted_output_json", context.outputJson],
        ["references_json", context.referencesJson],
        ["accepted_at", context.at],
        ["retain_until", context.retainUntil],
      ];
      if (
        !originalPairs.every(([key, value]) => a(key) === value) ||
        (context.privateInputs === undefined ? 0 : 1) !== o("private_inputs_present") ||
        serializeV2ContainerConfiguredPrivateInputs(context.configuredPrivateInputs) !== configured
      )
        fail();
    }
  }
  function accepted(proof: Proof, acceptanceAlias: "a" | "la", operationAlias: "o" | "lo"): void {
    if (proof.i_form_url === C.formUrl) {
      acceptedLegacy(proof, acceptanceAlias, operationAlias);
      return;
    }
    if (proof.i_form_url === V2_CONTAINER_F2_FORM) {
      acceptedF2(proof, acceptanceAlias, operationAlias);
      return;
    }
    fail();
  }
  function ownsAcceptedUpdateMaterial(proof: Proof, alias: "a" | "la"): boolean {
    const a = (key: string) => proof[alias + "_" + key];
    const o = (key: string) => proof[(alias === "a" ? "o" : "lo") + "_" + key];
    if (a("action") !== "update" || o("private_inputs_present") !== 1) return false;
    const spec = parseStrictJson(
      new TextEncoder().encode(String(a("accepted_spec_json"))),
      1048576,
    );
    if (!isJsonObject(spec)) return fail();
    const environment = spec[C.fields.environment];
    if (environment !== undefined && !isJsonObject(environment)) return fail();
    return (
      validateV2ContainerF2SensitiveNames(
        spec[C.fields.requiredSensitiveVars] === undefined
          ? []
          : spec[C.fields.requiredSensitiveVars],
        environment === undefined ? [] : Object.keys(environment),
      ).length > 0
    );
  }
  async function configuredSnapshot(proof: Proof, alias: "a" | "la"): Promise<void> {
    const a = (key: string) => proof[alias + "_" + key];
    if (proof.i_form_url !== V2_CONTAINER_F2_FORM || a("action") === "delete") return;
    const value = await readV2ConfiguredPrivateInputs(
      sql,
      {
        resourceUid: String(a("resource_uid")),
        principal: String(a("principal")),
        space: String(a("space")),
        name: String(a("name")),
        form: String(a("form_url")),
      },
      // Only an UPDATE that carries its own map with declared names owns an accepted-UPDATE
      // row. A CREATE, an omitted PUT, an explicit empty map and a name removal captured the
      // Resource-owned CREATE envelope (or null) at admission. The shape is decided from the
      // accepted evidence, never from whether a row can be read, so a missing own map still
      // fails closed and never falls back to the CREATE anchor.
      ownsAcceptedUpdateMaterial(proof, alias)
        ? { operationId: String(a("operation_id")), generation: Number(a("generation")) }
        : undefined,
    );
    const raw = a("configured_private_inputs_json");
    const captured =
      raw === null
        ? null
        : serializeV2ContainerConfiguredPrivateInputs(
            parseStrictJson(new TextEncoder().encode(String(raw)), 1048576),
          );
    if (serializeV2ContainerConfiguredPrivateInputs(value) !== captured) return fail();
  }

  function validate(proof: Proof, intent: DockerContainerCreateIntent) {
    if (proof.i_form_url !== C.formUrl && proof.i_form_url !== V2_CONTAINER_F2_FORM) return fail();
    accepted(proof, "a", "o");
    accepted(proof, "la", "lo");
    const latest = (key: string) => proof["la_" + key];
    if (
      proof.a_action === "delete" ||
      proof.a_resource_uid !== intent.resourceUid ||
      proof.a_generation !== intent.policy.generation ||
      proof.v_revision !== intent.revision ||
      proof.v_operation_id !== proof.a_operation_id ||
      proof.i_installation_id !== installationId ||
      intent.installationId !== installationId ||
      proof.i_incarnation_id !== intent.incarnationId ||
      proof.i_backend_id !== backendId ||
      proof.i_target_key !== targetKey ||
      proof.i_desired_generation !== latest("generation") ||
      typeof proof.i_management_epoch !== "number" ||
      proof.i_management_epoch < 1 ||
      typeof proof.i_runtime_epoch !== "number" ||
      proof.i_runtime_epoch < 0
    )
      return fail();
    const resourcePairs: readonly [string, unknown][] = [
      ["uid", latest("resource_uid")],
      ["principal", latest("principal")],
      ["space", latest("space")],
      ["name", latest("name")],
      ["form_url", proof.i_form_url],
      ["backend_id", backendId],
      ["target_key", targetKey],
      ["generation", latest("generation")],
      ["last_operation", latest("operation_id")],
      ["spec_json", latest("accepted_spec_json")],
    ];
    if (!resourcePairs.every(([key, value]) => proof["r_" + key] === value)) return fail();
    if (latest("action") === "delete") {
      if (
        proof.i_retire_operation_id !== latest("operation_id") ||
        typeof proof.i_retired_at_ms !== "number"
      )
        return fail();
      if (proof.r_deleted_at === null) {
        if (
          proof.r_active_name !== latest("name") ||
          !(
            proof.r_phase === "deleting" ||
            (proof.r_phase === "error" && proof.lo_status === "failed")
          )
        )
          return fail();
      } else if (
        typeof proof.r_deleted_at !== "string" ||
        proof.r_active_name !== null ||
        proof.r_phase !== "idle" ||
        proof.lo_status !== "succeeded"
      )
        return fail();
    } else if (
      proof.i_retired_at_ms !== null ||
      proof.i_retire_operation_id !== null ||
      proof.r_deleted_at !== null ||
      proof.r_active_name !== latest("name")
    )
      return fail();
    const spec = parseStrictJson(
      new TextEncoder().encode(String(proof.a_accepted_spec_json)),
      1048576,
    );
    if (
      !isJsonObject(spec) ||
      `${intent.policy.generation}-${spec[C.fields.workloadRevision]}` !== intent.revision ||
      (spec[C.fields.outboundInternet] ?? false) !== intent.policy.outboundInternet
    )
      return fail();
    const acceptedEnvironment = spec[C.fields.environment];
    const expectedNames =
      proof.i_form_url === C.formUrl
        ? []
        : validateV2ContainerF2SensitiveNames(
            spec[C.fields.requiredSensitiveVars] === undefined
              ? []
              : spec[C.fields.requiredSensitiveVars],
            isJsonObject(acceptedEnvironment) ? Object.keys(acceptedEnvironment) : [],
          );
    if (JSON.stringify(expectedNames) !== JSON.stringify(intent.requiredSecretNames)) return fail();
    if (
      proof.v_intent_json !== null &&
      (proof.v_intent_json !== intentJson(intent) || proof.v_native_name !== intent.nativeName)
    )
      return fail();
    if (
      proof.q_claim_id !== null &&
      (proof.q_resource_uid !== intent.resourceUid ||
        proof.q_generation !== intent.policy.generation ||
        proof.q_installation_id !== installationId ||
        !hex(proof.q_claim_id))
    )
      return fail();
  }
  function executionScope(execution: V2Execution): ExecutionScope {
    const matching = [...executions, ...deleteExecutions].filter(
      (scope) => scope.execution === execution,
    );
    if (
      matching.length !== 1 ||
      !execution ||
      typeof execution !== "object" ||
      (Object.getPrototypeOf(execution) !== Object.prototype &&
        Object.getPrototypeOf(execution) !== null) ||
      ![
        "form",
        "backendId",
        "targetKey",
        "operationId",
        "resourceUid",
        "generation",
        "leaseToken",
        "action",
      ].every((key) =>
        Object.hasOwn(Object.getOwnPropertyDescriptor(execution, key) ?? {}, "value"),
      ) ||
      !Reflect.ownKeys(execution).every(
        (key) =>
          typeof key === "string" &&
          Object.hasOwn(Object.getOwnPropertyDescriptor(execution, key) ?? {}, "value"),
      )
    )
      return fail();
    const scope = matching[0]!;
    if (
      scope.operationId !== execution.operationId ||
      scope.resourceUid !== execution.resourceUid ||
      scope.generation !== execution.generation ||
      scope.leaseToken !== execution.leaseToken ||
      scope.action !== execution.action ||
      execution.form !== V2_CONTAINER_F2_FORM ||
      execution.backendId !== backendId ||
      execution.targetKey !== targetKey
    )
      return fail();
    return scope;
  }
  async function assertExecution(execution: V2Execution): Promise<void> {
    executionScope(execution);
    const rows = await sql.query(
      execution.action === "delete"
        ? `SELECT op.accepted_spec_json FROM tf_v2_operations op
            JOIN tf_v2_resources resource ON resource.uid = op.resource_uid
            WHERE op.id = ? AND op.resource_uid = ? AND op.principal = ? AND op.action = ?
              AND op.generation = ? AND op.backend_id = ? AND op.target_key = ? AND op.backend_key = ?
              AND op.lease_token = ? AND op.lease_until_ms > (CAST(strftime('%s','now') AS INTEGER) + 1) * 1000
              AND op.status = 'reconciling' AND op.effect = 'unknown' AND op.dispatch_possible = 1
              AND resource.principal = op.principal AND resource.form_url = ? AND resource.space = ?
              AND resource.name = ? AND resource.backend_id = op.backend_id AND resource.target_key = op.target_key
              AND resource.generation = op.generation AND resource.last_operation = op.id AND resource.busy_operation = op.id
              AND resource.phase='deleting' AND resource.deleted_at IS NULL AND resource.spec_json = op.accepted_spec_json LIMIT 2`
        : `SELECT op.accepted_spec_json FROM tf_v2_operations op
            JOIN tf_v2_resources resource ON resource.uid = op.resource_uid
            WHERE op.id = ? AND op.resource_uid = ? AND op.principal = ? AND op.action = ?
              AND op.generation = ? AND op.backend_id = ? AND op.target_key = ? AND op.backend_key = ?
              AND op.lease_token = ? AND op.lease_until_ms > (CAST(strftime('%s','now') AS INTEGER) + 1) * 1000
              AND op.status = 'reconciling' AND op.effect = 'unknown' AND op.dispatch_possible = 1
              AND resource.principal = op.principal AND resource.form_url = ? AND resource.space = ?
              AND resource.name = ? AND resource.backend_id = op.backend_id AND resource.target_key = op.target_key
              AND resource.generation = op.generation AND resource.last_operation = op.id AND resource.busy_operation = op.id
              AND resource.phase = 'pending' AND resource.deleted_at IS NULL AND resource.spec_json = op.accepted_spec_json LIMIT 2`,
      [
        execution.operationId,
        execution.resourceUid,
        execution.principal,
        execution.action,
        execution.generation,
        execution.backendId,
        execution.targetKey,
        execution.backendKey,
        execution.leaseToken,
        execution.form,
        execution.space,
        execution.name,
      ],
    );
    executionScope(execution);
    if (
      rows.length !== 1 ||
      typeof rows[0]?.accepted_spec_json !== "string" ||
      canonicalJson(JSON.parse(rows[0].accepted_spec_json)) !== canonicalJson(execution.spec)
    )
      fail();
  }
  function publicSpec(raw: unknown): JsonObject {
    if (typeof raw !== "string") return fail();
    const parsed = parseStrictJson(new TextEncoder().encode(raw), 1048576);
    if (!isJsonObject(parsed)) return fail();
    validateDockerContainerSpec(parsed);
    const freeze = (value: unknown): void => {
      if (value && typeof value === "object") {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
      }
    };
    freeze(parsed);
    return parsed;
  }
  async function assertSnapshot(proof: Proof): Promise<void> {
    const guard = fence(proof);
    const rows = await sql.query("SELECT 1 AS owner_current WHERE " + guard.sql, guard.params);
    if (rows.length !== 1 || rows[0]?.owner_current !== 1) return fail();
  }
  async function load(input: DockerContainerCreateIntent) {
    const intent = intentSnapshot(input);
    const identity = await canonicalDigest({
      installation: installationId,
      resource: intent.resourceUid,
      incarnation: intent.incarnationId,
      revision: intent.revision,
    });
    const nativeName = `takoserver-${identity.slice(7)}`;
    if (intent.identityLabel !== identity || intent.nativeName !== nativeName) return fail();
    const rows = await sql.query(select + " WHERE i.resource_uid=? AND v.generation=?", [
      intent.resourceUid,
      intent.policy.generation,
    ]);
    if (rows.length !== 1) return fail();
    const proof = rowProof(rows[0]!);
    validate(proof, intent);
    await configuredSnapshot(proof, "a");
    await configuredSnapshot(proof, "la");
    return { intent, proof };
  }
  const usable = (proof: Proof, phase: DockerContainerCreatePhase) =>
    phase === "remove"
      ? proof.i_retired_at_ms !== null ||
        (proof.i_serving_generation !== proof.v_generation &&
          proof.i_desired_generation !== proof.v_generation &&
          (proof.v_retention === "draining" || proof.v_retention === "retired"))
      : proof.i_retired_at_ms === null &&
        (proof.v_retention === "accepted" || proof.v_retention === "serving") &&
        (proof.i_desired_generation === proof.v_generation ||
          proof.i_serving_generation === proof.v_generation);
  function record(
    intent: DockerContainerCreateIntent,
    proof: Proof,
  ): DockerContainerCreateRecord | null {
    if (proof.q_claim_id === null) return null;
    if (
      !(
        (proof.q_state === "pending" && proof.q_native_id === null) ||
        ((proof.q_state === "bound" || proof.q_state === "removed") && hex(proof.q_native_id))
      )
    )
      return fail();
    return Object.freeze({
      claimId: proof.q_claim_id as string,
      intent,
      nativeId: proof.q_native_id as string | null,
      state: proof.q_state as DockerContainerCreateRecord["state"],
    });
  }
  function sameRecord(
    input: DockerContainerCreateRecord,
    saved: DockerContainerCreateRecord | null,
  ) {
    if (
      !saved ||
      input.claimId !== saved.claimId ||
      intentJson(input.intent) !== intentJson(saved.intent) ||
      (input.nativeId !== null && input.nativeId !== saved.nativeId) ||
      (input.state === "removed" && saved.state !== "removed")
    )
      return fail();
    return saved;
  }
  function retainedServing(lease: Lease, proof: Proof): boolean {
    const previous = lease.proof;
    return (
      lease.active &&
      !lease.controller.signal.aborted &&
      lease.phase !== "remove" &&
      lease.record.state === "bound" &&
      lease.record.nativeId !== null &&
      previous.q_state === "bound" &&
      proof.q_state === "bound" &&
      previous.q_claim_id === lease.record.claimId &&
      proof.q_claim_id === lease.record.claimId &&
      previous.q_native_id === lease.record.nativeId &&
      proof.q_native_id === lease.record.nativeId &&
      previous.i_retired_at_ms === null &&
      proof.i_retired_at_ms === null &&
      previous.i_serving_generation === lease.record.intent.policy.generation &&
      proof.i_serving_generation === lease.record.intent.policy.generation &&
      proof.v_retention === previous.v_retention &&
      [
        "i_resource_uid",
        "i_installation_id",
        "i_incarnation_id",
        "i_runtime_epoch",
        "i_retired_at_ms",
        "v_generation",
        "v_operation_id",
        "v_revision",
        "v_intent_json",
        "v_native_name",
      ].every((key) => proof[key] === previous[key]) &&
      Object.keys(previous)
        .filter((key) => key.startsWith("a_"))
        .every((key) => proof[key] === previous[key]) &&
      typeof proof.i_management_epoch === "number" &&
      typeof previous.i_management_epoch === "number" &&
      proof.i_management_epoch >= previous.i_management_epoch
    );
  }
  async function current(lease: Lease): Promise<boolean> {
    if (!lease.active || lease.controller.signal.aborted) return false;
    try {
      const { intent, proof } = await load(lease.record.intent);
      sameRecord(lease.record, record(intent, proof));
      if (
        !usable(proof, lease.phase) ||
        ["i_runtime_epoch", "i_incarnation_id", "i_retired_at_ms"].some(
          (key) => proof[key] !== lease.proof[key],
        )
      )
        throw new Error();
      if (
        ["i_management_epoch", "r_last_operation"].some((key) => proof[key] !== lease.proof[key])
      ) {
        if (!retainedServing(lease, proof)) throw new Error();
        lease.proof = proof;
      }
      return lease.active && !lease.controller.signal.aborted;
    } catch {
      lease.controller.abort();
      return false;
    }
  }
  async function activeRecord(
    input: DockerContainerCreateRecord,
    phase?: DockerContainerCreatePhase,
  ) {
    const lease = [...leases].find(
      (item) =>
        item.active &&
        !item.controller.signal.aborted &&
        item.record.claimId === input.claimId &&
        intentJson(item.record.intent) === intentJson(input.intent) &&
        (phase === undefined || item.phase === phase),
    );
    if (!lease || !(await current(lease))) return fail();
    return lease;
  }

  const nativeKeys = [
    "backend",
    "installationId",
    "resourceUid",
    "incarnationId",
    "revision",
    "nativeId",
    "network",
    "networkId",
    "image",
    "imageId",
    "identityLabel",
    "revisionLabel",
  ] as const;
  const snapshotNative = (value: DockerContainerNativeIdentity) => {
    if (
      !own(value, nativeKeys) ||
      value.backend !== "docker" ||
      value.installationId !== installationId ||
      !nativeKeys.slice(1).every((key) => text(value[key])) ||
      !hex(value.nativeId) ||
      !hex(value.networkId) ||
      !encodedRevision(value.revision, Number(value.revision.split("-")[0])) ||
      !digest(value.imageId) ||
      !digest(value.identityLabel) ||
      !digest(value.revisionLabel)
    )
      return fail();
    return Object.freeze({ ...value });
  };
  async function boundNative(
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
  ) {
    const captured = snapshotNative(native);
    if (!own(policy, policyKeys)) return fail();
    const selectedPolicy = Object.freeze({
      tenantRef: policy.tenantRef,
      generation: policy.generation,
      policyDigest: policy.policyDigest,
      outboundInternet: policy.outboundInternet,
    });
    if (
      !text(selectedPolicy.tenantRef) ||
      !digest(selectedPolicy.policyDigest) ||
      !Number.isSafeInteger(selectedPolicy.generation) ||
      selectedPolicy.generation < 1 ||
      typeof selectedPolicy.outboundInternet !== "boolean"
    )
      return fail();
    const rows = await sql.query(select + " WHERE i.resource_uid=? AND v.generation=?", [
      captured.resourceUid,
      selectedPolicy.generation,
    ]);
    if (rows.length !== 1 || typeof rows[0]?.v_intent_json !== "string") return fail();
    const parsed = parseStrictJson(new TextEncoder().encode(rows[0].v_intent_json), 1048576);
    if (!isJsonObject(parsed)) return fail();
    const loaded = await load(intentSnapshot(parsed as unknown as DockerContainerCreateIntent));
    const saved = record(loaded.intent, loaded.proof);
    if (
      !saved ||
      saved.state !== "bound" ||
      saved.nativeId !== captured.nativeId ||
      !usable(loaded.proof, "observe") ||
      loaded.intent.installationId !== captured.installationId ||
      loaded.intent.resourceUid !== captured.resourceUid ||
      loaded.intent.incarnationId !== captured.incarnationId ||
      loaded.intent.revision !== captured.revision ||
      loaded.intent.identityLabel !== captured.identityLabel ||
      loaded.intent.revisionLabel !== captured.revisionLabel ||
      loaded.intent.policy.tenantRef !== selectedPolicy.tenantRef ||
      loaded.intent.policy.generation !== selectedPolicy.generation ||
      loaded.intent.policy.policyDigest !== selectedPolicy.policyDigest ||
      loaded.intent.policy.outboundInternet !== selectedPolicy.outboundInternet
    )
      return fail();
    return { native: captured, ...loaded, record: saved };
  }
  async function allocation(
    input: DockerContainerCreateRecord,
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
  ) {
    const lease = await activeRecord(input);
    const loaded = await boundNative(native, policy);
    sameRecord(input, loaded.record);
    if (!(await current(lease))) return fail();
    return { ...loaded, lease };
  }
  async function startState(loaded: Awaited<ReturnType<typeof boundNative>>) {
    const rows = await sql.query(
      "SELECT resource_uid,generation,attempt,create_claim_id,native_id,state,claimed_at_ms,confirmed_running_at_ms,confirmed_exited_at_ms FROM tf_v2_container_start_attempts WHERE resource_uid=? AND generation=?",
      [loaded.intent.resourceUid, loaded.intent.policy.generation],
    );
    if (rows.length === 0) return "unclaimed" as const;
    if (rows.length !== 1) return "unknown" as const;
    const row = rows[0]!;
    const claimedAt = row.claimed_at_ms;
    if (
      row.resource_uid !== loaded.intent.resourceUid ||
      row.generation !== loaded.intent.policy.generation ||
      row.attempt !== 1 ||
      row.create_claim_id !== loaded.record.claimId ||
      row.native_id !== loaded.native.nativeId ||
      typeof claimedAt !== "number" ||
      !Number.isSafeInteger(claimedAt) ||
      claimedAt < 0
    )
      return "unknown" as const;
    if (
      row.state === "pending" &&
      row.confirmed_running_at_ms === null &&
      row.confirmed_exited_at_ms === null
    )
      return "unknown" as const;
    const timestamp = (value: unknown): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= claimedAt;
    if (
      row.state === "running" &&
      timestamp(row.confirmed_running_at_ms) &&
      row.confirmed_exited_at_ms === null
    )
      return "claimed" as const;
    if (
      row.state === "exited" &&
      timestamp(row.confirmed_exited_at_ms) &&
      (row.confirmed_running_at_ms === null ||
        (timestamp(row.confirmed_running_at_ms) &&
          row.confirmed_exited_at_ms >= row.confirmed_running_at_ms))
    )
      return "claimed" as const;
    return "unknown" as const;
  }
  async function samePendingAnchor(
    loaded: Awaited<ReturnType<typeof boundNative>>,
    claimedAt: number,
  ) {
    const rows = await sql.query(
      "SELECT attempt FROM tf_v2_container_start_attempts WHERE resource_uid=? AND generation=? AND attempt=1 AND create_claim_id=? AND native_id=? AND state='pending' AND claimed_at_ms=? AND confirmed_running_at_ms IS NULL AND confirmed_exited_at_ms IS NULL",
      [
        loaded.intent.resourceUid,
        loaded.intent.policy.generation,
        loaded.record.claimId,
        loaded.native.nativeId,
        claimedAt,
      ],
    );
    return rows.length === 1 && rows[0]?.attempt === 1;
  }
  async function memberRecords(
    input: DockerContainerCreateRecord,
    native: DockerContainerNativeIdentity,
    policy: DockerContainerRuntimePolicy,
    observedIds: readonly string[],
  ) {
    if (
      !Array.isArray(observedIds) ||
      observedIds.length > 4096 ||
      Object.keys(observedIds).length !== observedIds.length
    )
      return fail();
    const ids: string[] = [];
    for (let index = 0; index < observedIds.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(observedIds, String(index));
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        !hex(descriptor.value) ||
        ids.includes(descriptor.value)
      )
        return fail();
      ids.push(descriptor.value);
    }
    const selected = await allocation(input, native, policy);
    const records: DockerContainerCreateRecord[] = [];
    for (const id of ids) {
      if (!(await current(selected.lease))) return fail();
      const rows = await sql.query(select + " WHERE q.installation_id=? AND q.native_id=?", [
        installationId,
        id,
      ]);
      if (rows.length !== 1 || typeof rows[0]?.v_intent_json !== "string") return fail();
      const parsed = parseStrictJson(new TextEncoder().encode(rows[0].v_intent_json), 1048576);
      if (!isJsonObject(parsed)) return fail();
      const loaded = await load(intentSnapshot(parsed as unknown as DockerContainerCreateIntent));
      const saved = record(loaded.intent, loaded.proof);
      if (
        !saved ||
        saved.state !== "bound" ||
        saved.nativeId !== id ||
        !(usable(loaded.proof, "observe") || usable(loaded.proof, "remove"))
      )
        return fail();
      records.push(saved);
    }
    if (!(await current(selected.lease))) return fail();
    // These are current SQL facts. Callers must enter the original observe authority
    // for each record and verify its actual native/kernel state before attachment.
    return Object.freeze(records);
  }

  const owner: DockerPhysicalCoreOwnerPort = Object.freeze<DockerPhysicalCoreOwnerPort>({
    async publishServing(input, native, policy, runtime) {
      const selected = await allocation(input, native, policy);
      const lease = await activeRecord(input, "reconcile");
      if (
        selected.proof.i_desired_generation !== selected.intent.policy.generation ||
        selected.proof.i_retired_at_ms !== null ||
        (!(runtime instanceof DockerContainerRuntimePreparation) &&
          !(runtime instanceof LinuxDockerRuntimePreparation)) ||
        !Object.isFrozen(runtime)
      )
        return fail();
      const descriptor = Object.getOwnPropertyDescriptor(runtime, "policy");
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        !own(descriptor.value, policyKeys) ||
        !Object.isFrozen(descriptor.value) ||
        descriptor.value.tenantRef !== selected.intent.policy.tenantRef ||
        descriptor.value.generation !== selected.intent.policy.generation ||
        descriptor.value.policyDigest !== selected.intent.policy.policyDigest ||
        descriptor.value.outboundInternet !== selected.intent.policy.outboundInternet
      )
        return fail();
      // The original runtime instance obtains the verification guard itself.
      // No caller-supplied callback, receipt DTO, or readiness flag grants cutover.
      const runtimeGuard =
        runtime instanceof LinuxDockerRuntimePreparation
          ? await verifyLinuxRuntime.call(runtime, selected.native)
          : await verifyOriginalRuntime.call(runtime, selected.native);
      await runtimeGuard();
      if (!(await current(lease))) return fail();
      const before = await boundNative(selected.native, selected.intent.policy);
      const attempts = await sql.query(
        "SELECT attempt,create_claim_id,native_id,state,claimed_at_ms,confirmed_running_at_ms,confirmed_exited_at_ms FROM tf_v2_container_start_attempts WHERE resource_uid=? AND generation=?",
        [before.intent.resourceUid, before.intent.policy.generation],
      );
      if (attempts.length !== 1) return fail();
      const attempt = attempts[0]!;
      const claimedAt = attempt.claimed_at_ms;
      if (
        attempt.attempt !== 1 ||
        attempt.create_claim_id !== before.record.claimId ||
        attempt.native_id !== before.native.nativeId ||
        typeof claimedAt !== "number" ||
        !Number.isSafeInteger(claimedAt) ||
        claimedAt < 0 ||
        attempt.confirmed_exited_at_ms !== null ||
        (attempt.state !== "pending" && attempt.state !== "running")
      )
        return fail();
      const runningAt = attempt.state === "pending" ? now() : attempt.confirmed_running_at_ms;
      if (
        typeof runningAt !== "number" ||
        !Number.isSafeInteger(runningAt) ||
        runningAt < claimedAt ||
        (attempt.state === "pending" && attempt.confirmed_running_at_ms !== null)
      )
        return fail();
      if (before.proof.i_serving_generation === before.intent.policy.generation) {
        if (before.proof.v_retention !== "serving" || attempt.state !== "running") return fail();
        await runtimeGuard();
        if (!(await current(lease))) return fail();
        return;
      }
      const oldEpoch = before.proof.i_runtime_epoch;
      if (typeof oldEpoch !== "number" || !Number.isSafeInteger(oldEpoch + 1)) return fail();
      await runtimeGuard();
      if (!(await current(lease))) return fail();
      const guard = fence(before.proof);
      const statements: SqlStatement[] = [];
      if (attempt.state === "pending")
        statements.push({
          sql:
            "UPDATE tf_v2_container_start_attempts SET state='running',confirmed_running_at_ms=? WHERE resource_uid=? AND generation=? AND attempt=1 AND create_claim_id=? AND native_id=? AND state='pending' AND claimed_at_ms=? AND confirmed_running_at_ms IS NULL AND confirmed_exited_at_ms IS NULL AND " +
            guard.sql,
          params: [
            runningAt,
            before.intent.resourceUid,
            before.intent.policy.generation,
            before.record.claimId,
            before.native.nativeId,
            claimedAt,
            ...guard.params,
          ],
        });
      statements.push({
        sql:
          "UPDATE tf_v2_container_instances SET serving_generation=?,runtime_epoch=runtime_epoch+1 WHERE resource_uid=? AND " +
          guard.sql +
          " AND EXISTS (SELECT 1 FROM tf_v2_container_start_attempts s WHERE s.resource_uid=? AND s.generation=? AND s.attempt=1 AND s.create_claim_id=? AND s.native_id=? AND s.state='running' AND s.claimed_at_ms=? AND s.confirmed_running_at_ms=? AND s.confirmed_exited_at_ms IS NULL)",
        params: [
          before.intent.policy.generation,
          before.intent.resourceUid,
          ...guard.params,
          before.intent.resourceUid,
          before.intent.policy.generation,
          before.record.claimId,
          before.native.nativeId,
          claimedAt,
          runningAt,
        ],
      });
      const writes = await sql.batch(statements);
      if (writes.length !== statements.length || writes.some((write) => write.changes !== 1))
        return fail();
      const after = await boundNative(before.native, before.intent.policy);
      if (
        after.proof.i_serving_generation !== before.intent.policy.generation ||
        after.proof.i_runtime_epoch !== oldEpoch + 1 ||
        after.proof.i_management_epoch !== before.proof.i_management_epoch ||
        after.proof.i_desired_generation !== before.proof.i_desired_generation ||
        after.proof.v_retention !== "serving" ||
        after.record.claimId !== before.record.claimId ||
        after.record.nativeId !== before.record.nativeId
      )
        return fail();
      // Advance only existing live leases for this exact accepted/native binding
      // after reading the successful SQL transition. Other generations still revoke.
      for (const held of leases) {
        if (
          held.active &&
          !held.controller.signal.aborted &&
          held.phase !== "remove" &&
          held.record.claimId === after.record.claimId &&
          held.record.nativeId === after.record.nativeId &&
          held.record.intent.policy.generation === after.intent.policy.generation &&
          intentJson(held.record.intent) === intentJson(after.intent) &&
          held.proof.i_management_epoch === before.proof.i_management_epoch &&
          held.proof.i_runtime_epoch === before.proof.i_runtime_epoch &&
          held.proof.i_desired_generation === before.proof.i_desired_generation &&
          held.proof.q_claim_id === after.record.claimId &&
          held.proof.q_native_id === after.record.nativeId
        )
          held.proof = after.proof;
      }
      await runtimeGuard();
      if (!(await current(lease))) return fail();
    },

    async readStartClaim(native, policy) {
      return startState(await boundNative(native, policy));
    },
    async claimStart(native, policy) {
      const loaded = await boundNative(native, policy);
      const lease = await activeRecord(loaded.record, "reconcile");
      if (
        !usable(loaded.proof, "reconcile") ||
        loaded.proof.i_desired_generation !== loaded.intent.policy.generation
      )
        return fail();
      const previous = await startState(loaded);
      if (previous !== "unclaimed") return previous === "claimed" ? "already-claimed" : "unknown";
      const guard = fence(loaded.proof);
      const claimedAt = now();
      if (!(await current(lease))) return fail();
      const write = await sql.run(
        "INSERT INTO tf_v2_container_start_attempts(resource_uid,generation,attempt,create_claim_id,native_id,state,claimed_at_ms,confirmed_running_at_ms,confirmed_exited_at_ms) SELECT ?,?,1,?,?,'pending',?,NULL,NULL WHERE " +
          guard.sql +
          " AND NOT EXISTS (SELECT 1 FROM tf_v2_container_start_attempts WHERE resource_uid=? AND generation=?)",
        [
          loaded.intent.resourceUid,
          loaded.intent.policy.generation,
          loaded.record.claimId,
          loaded.native.nativeId,
          claimedAt,
          ...guard.params,
          loaded.intent.resourceUid,
          loaded.intent.policy.generation,
        ],
      );
      if (write.changes !== 0 && write.changes !== 1) return fail();
      if (!(await current(lease))) return fail();
      const after = await boundNative(loaded.native, loaded.intent.policy);
      if (
        write.changes !== 1 ||
        !(await samePendingAnchor(after, claimedAt)) ||
        !(await current(lease))
      )
        return "unknown";
      // Pending is the durable, consumed pipeline anchor. This result authorizes
      // only this successful insertion's one pipeline; recovery never repeats it.
      return "claimed";
    },
    async assertNetworkAllocation(input, native, policy) {
      await allocation(input, native, policy);
    },
    async readNetworkMemberRecords(input, native, policy, observedIds) {
      return memberRecords(input, native, policy, observedIds);
    },
    async assertNetworkMembers(input, native, policy, observedIds) {
      await memberRecords(input, native, policy, observedIds);
    },

    async read(input) {
      const { intent, proof } = await load(input);
      return record(intent, proof);
    },
    async claim(input) {
      const { intent, proof } = await load(input);
      if (!usable(proof, "reconcile") || proof.i_desired_generation !== intent.policy.generation)
        return fail();
      const previous = record(intent, proof);
      if (previous)
        return { status: previous.state === "pending" ? "unknown" : "existing", record: previous };
      const serialized = intentJson(intent);
      const expected = { ...proof, v_intent_json: serialized, v_native_name: intent.nativeName };
      const statements: SqlStatement[] = [];
      if (proof.v_intent_json === null) {
        const guard = fence(proof);
        statements.push({
          sql:
            "UPDATE tf_v2_container_revisions SET intent_json=?,native_name=? WHERE resource_uid=? AND generation=? AND intent_json IS NULL AND native_name IS NULL AND " +
            guard.sql,
          params: [
            serialized,
            intent.nativeName,
            intent.resourceUid,
            intent.policy.generation,
            ...guard.params,
          ],
        });
      }
      const claimId = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const guard = fence(expected);
      statements.push({
        sql:
          "INSERT INTO tf_v2_container_create_claims(resource_uid,generation,installation_id,claim_id,state,native_id,claimed_at_ms,bound_at_ms,removed_at_ms) SELECT ?,?,?,?,'pending',NULL,?,NULL,NULL WHERE " +
          guard.sql +
          " ON CONFLICT(resource_uid,generation) DO NOTHING",
        params: [
          intent.resourceUid,
          intent.policy.generation,
          installationId,
          claimId,
          now(),
          ...guard.params,
        ],
      });
      const writes = await sql.batch(statements);
      if (
        writes.length !== statements.length ||
        writes.some((write) => write.changes !== 0 && write.changes !== 1)
      )
        return fail();
      const after = await load(intent);
      const saved = record(after.intent, after.proof);
      if (!saved) return fail();
      return {
        status:
          saved.claimId === claimId && writes.at(-1)!.changes === 1
            ? "won"
            : saved.state === "pending"
              ? "unknown"
              : "existing",
        record: saved,
      };
    },
    async withAuthority(input, phase, use) {
      if (!["reconcile", "observe", "remove"].includes(phase) || typeof use !== "function")
        return fail();
      const { intent, proof } = await load(input.intent);
      const saved = sameRecord(input, record(intent, proof));
      if (!usable(proof, phase) || (saved.state === "removed" && phase !== "remove")) return fail();
      const lease: Lease = {
        record: saved,
        phase,
        proof,
        controller: new AbortController(),
        active: true,
      };
      leases.add(lease);
      const guard = async () => {
        if (!(await current(lease))) return fail();
      };
      try {
        await guard();
        let environmentCurrent: (() => Promise<void>) | undefined;
        const secretCurrent = async () => {
          if (!(await current(lease))) return false;
          try {
            if (environmentCurrent) await environmentCurrent();
            return lease.active && !lease.controller.signal.aborted;
          } catch {
            lease.controller.abort();
            return false;
          }
        };
        const held = Object.freeze({
          revocation: lease.controller.signal,
          stillCurrent: lease.proof.i_form_url === C.formUrl ? () => current(lease) : secretCurrent,
          async withEnvironment<T>(
            useEnvironment: (
              values: Readonly<Record<string, string>>,
              signal: AbortSignal,
            ) => Promise<T>,
          ): Promise<T> {
            await guard();
            if (lease.proof.i_form_url === V2_CONTAINER_F2_FORM) {
              if (
                !configuredInputs ||
                lease.phase !== "reconcile" ||
                typeof useEnvironment !== "function"
              )
                return fail();
              const selected = [...executions].filter(
                (scope) =>
                  scope.operationId === lease.proof.a_operation_id &&
                  scope.resourceUid === saved.intent.resourceUid &&
                  scope.generation === saved.intent.policy.generation &&
                  scope.execution.operationId === scope.operationId &&
                  scope.execution.resourceUid === scope.resourceUid &&
                  scope.execution.generation === scope.generation &&
                  scope.execution.leaseToken === scope.leaseToken,
              );
              if (selected.length !== 1) return fail();
              const scope = selected[0]!;
              let result: T | undefined;
              await configuredInputs.withAcceptedInputs(
                { execution: scope.execution, record: saved },
                async (values, signal, assertCurrent) => {
                  if (environmentCurrent) return fail();
                  environmentCurrent = assertCurrent;
                  const loan = new AbortController();
                  const revoke = () => loan.abort();
                  lease.controller.signal.addEventListener("abort", revoke, { once: true });
                  signal.addEventListener("abort", revoke, { once: true });
                  if (lease.controller.signal.aborted || signal.aborted) loan.abort();
                  const check = async () => {
                    if (!executions.has(scope) || loan.signal.aborted) return fail();
                    await guard();
                    await assertCurrent();
                    if (!executions.has(scope) || loan.signal.aborted) return fail();
                  };
                  try {
                    await check();
                    result = await useEnvironment(values, loan.signal);
                    await check();
                  } finally {
                    environmentCurrent = undefined;
                    loan.abort();
                    signal.removeEventListener("abort", revoke);
                    lease.controller.signal.removeEventListener("abort", revoke);
                  }
                },
              );
              await guard();
              return result as T;
            }

            if (
              saved.intent.requiredSecretNames.length !== 0 ||
              typeof useEnvironment !== "function"
            )
              return fail();
            const loan = new AbortController();
            const revoke = () => loan.abort();
            lease.controller.signal.addEventListener("abort", revoke, { once: true });
            if (lease.controller.signal.aborted) loan.abort();
            try {
              await guard();
              const value = await useEnvironment(
                Object.freeze(Object.create(null) as Record<string, string>),
                loan.signal,
              );
              await guard();
              if (loan.signal.aborted) return fail();
              return value;
            } finally {
              loan.abort();
              lease.controller.signal.removeEventListener("abort", revoke);
            }
          },
        });
        const result = await use(held);
        await guard();
        return result;
      } finally {
        lease.active = false;
        lease.controller.abort();
        leases.delete(lease);
      }
    },
    async bindNative(input, nativeId) {
      if (!hex(nativeId)) return fail();
      const lease = await activeRecord(input);
      const { intent, proof } = await load(input.intent);
      const saved = sameRecord(input, record(intent, proof));
      if (saved.nativeId === nativeId && saved.state === "bound") return;
      if (
        saved.state !== "pending" ||
        saved.nativeId !== null ||
        !(lease.phase === "remove" ? usable(proof, "remove") : usable(proof, "reconcile"))
      )
        return fail();
      const guard = fence(proof);
      if (!lease.active || lease.controller.signal.aborted) return fail();
      const write = await sql.run(
        "UPDATE tf_v2_container_create_claims SET state='bound',native_id=?,bound_at_ms=? WHERE resource_uid=? AND generation=? AND claim_id=? AND state='pending' AND native_id IS NULL AND " +
          guard.sql,
        [
          nativeId,
          now(),
          intent.resourceUid,
          intent.policy.generation,
          saved.claimId,
          ...guard.params,
        ],
      );
      if (write.changes !== 1) return fail();
      const after = await load(intent);
      const bound = sameRecord(input, record(after.intent, after.proof));
      if (bound.nativeId !== nativeId || bound.state !== "bound") return fail();
    },
    async confirmStopped(input, observation) {
      const lease = await activeRecord(input, "remove");
      // The custody names the exact native object it inspected and the positive state it
      // saw. The owner cannot see Docker: like bindNative and confirmRemoved, it trusts the
      // custody that holds a live remove lease for this claim, so that observation is part of
      // the trust boundary. What the owner does check: the identity against the stored intent
      // and the bound native ID, and that the exit is written for the exact running attempt
      // under the same accepted-state fence as every other transition.
      if (!own(observation, ["native", "state"]) || observation.state !== "stopped") return fail();
      const native = snapshotNative(observation.native as DockerContainerNativeIdentity);
      const { intent, proof } = await load(input.intent);
      const saved = sameRecord(input, record(intent, proof));
      if (
        saved.state !== "bound" ||
        saved.nativeId !== native.nativeId ||
        !usable(proof, "remove") ||
        native.installationId !== intent.installationId ||
        native.resourceUid !== intent.resourceUid ||
        native.incarnationId !== intent.incarnationId ||
        native.revision !== intent.revision ||
        native.identityLabel !== intent.identityLabel ||
        native.revisionLabel !== intent.revisionLabel
      )
        return fail();
      const attemptSql =
        "SELECT attempt,create_claim_id,native_id,state,claimed_at_ms,confirmed_running_at_ms,confirmed_exited_at_ms FROM tf_v2_container_start_attempts WHERE resource_uid=? AND generation=?";
      const attemptParams = [intent.resourceUid, intent.policy.generation];
      const attempts = await sql.query(attemptSql, attemptParams);
      // Never started: there is no attempt to end, and confirmRemoved's own fence applies.
      if (attempts.length === 0) return;
      const attempt = attempts[0];
      if (attempts.length !== 1 || !attempt) return fail();
      const claimedAt = attempt.claimed_at_ms;
      const runningAt = attempt.confirmed_running_at_ms;
      if (
        attempt.attempt !== 1 ||
        attempt.create_claim_id !== saved.claimId ||
        attempt.native_id !== native.nativeId ||
        typeof claimedAt !== "number" ||
        !Number.isSafeInteger(claimedAt) ||
        claimedAt < 0
      )
        return fail();
      if (attempt.state === "exited") {
        // A previously recorded exit of this exact attempt: idempotent, no write.
        const exitedAt = attempt.confirmed_exited_at_ms;
        if (
          typeof runningAt !== "number" ||
          typeof exitedAt !== "number" ||
          !Number.isSafeInteger(runningAt) ||
          !Number.isSafeInteger(exitedAt) ||
          runningAt < claimedAt ||
          exitedAt < runningAt
        )
          return fail();
        return;
      }
      // A never-confirmed (pending) attempt has no schema-legal exit: it stays refused.
      if (
        attempt.state !== "running" ||
        typeof runningAt !== "number" ||
        !Number.isSafeInteger(runningAt) ||
        runningAt < claimedAt ||
        attempt.confirmed_exited_at_ms !== null
      )
        return fail();
      const exitedAt = Math.max(runningAt, now());
      const guard = fence(proof);
      if (!lease.active || lease.controller.signal.aborted) return fail();
      const write = await sql.run(
        "UPDATE tf_v2_container_start_attempts SET state='exited',confirmed_exited_at_ms=? WHERE resource_uid=? AND generation=? AND attempt=1 AND create_claim_id=? AND native_id=? AND state='running' AND claimed_at_ms=? AND confirmed_running_at_ms=? AND confirmed_exited_at_ms IS NULL AND " +
          guard.sql,
        [
          exitedAt,
          intent.resourceUid,
          intent.policy.generation,
          saved.claimId,
          native.nativeId,
          claimedAt,
          runningAt,
          ...guard.params,
        ],
      );
      if (write.changes !== 1) return fail();
      const after = await load(intent);
      const still = sameRecord(input, record(after.intent, after.proof));
      const rows = await sql.query(attemptSql, attemptParams);
      const written = rows[0];
      if (
        still.nativeId !== native.nativeId ||
        still.state !== "bound" ||
        rows.length !== 1 ||
        !written ||
        written.state !== "exited" ||
        written.native_id !== native.nativeId ||
        written.confirmed_running_at_ms !== runningAt ||
        written.confirmed_exited_at_ms !== exitedAt ||
        !(await current(lease))
      )
        return fail();
    },
    async confirmRemoved(input, nativeId) {
      if (!hex(nativeId)) return fail();
      const lease = await activeRecord(input, "remove");
      const { intent, proof } = await load(input.intent);
      const saved = sameRecord(input, record(intent, proof));
      if (saved.nativeId !== nativeId || !usable(proof, "remove")) return fail();
      if (saved.state === "removed") return;
      if (saved.state !== "bound") return fail();
      const guard = fence(proof);
      if (!lease.active || lease.controller.signal.aborted) return fail();
      const write = await sql.run(
        "UPDATE tf_v2_container_create_claims SET state='removed',removed_at_ms=? WHERE resource_uid=? AND generation=? AND claim_id=? AND state='bound' AND native_id=? AND " +
          guard.sql,
        [
          now(),
          intent.resourceUid,
          intent.policy.generation,
          saved.claimId,
          nativeId,
          ...guard.params,
        ],
      );
      if (write.changes !== 1) return fail();
      const after = await load(intent);
      const removed = sameRecord(input, record(after.intent, after.proof));
      if (removed.nativeId !== nativeId || removed.state !== "removed") return fail();
    },
  });
  const result: DockerContainerCoreOwner = Object.freeze<DockerContainerCoreOwner>({
    async readAcceptedExecution(execution: V2Execution): Promise<DockerContainerAcceptedExecution> {
      await assertExecution(execution);
      const deleting = execution.action === "delete";
      const rows = await sql.query(
        select +
          (deleting
            ? " WHERE i.resource_uid=? LIMIT 4097"
            : " WHERE i.resource_uid=? AND v.generation <= ? ORDER BY v.generation DESC LIMIT 4097"),
        deleting ? [execution.resourceUid] : [execution.resourceUid, execution.generation],
      );
      if (rows.length < 1 || rows.length > 4096) return fail();
      const proofs = rows.map(rowProof);
      const first = proofs[0]!;
      if (!deleting && first.v_generation !== execution.generation) return fail();
      const alias = "la";
      const current = (proof: Proof, key: string) => proof[alias + "_" + key];
      const retained: {
        readonly record: DockerContainerCreateRecord;
        readonly spec: JsonObject;
        readonly removedAtMs: number | null;
      }[] = [];
      for (const proof of proofs) {
        accepted(proof, "a", "o");
        accepted(proof, "la", "lo");
        const expected: readonly [string, unknown][] = [
          ["operation_id", execution.operationId],
          ["resource_uid", execution.resourceUid],
          ["principal", execution.principal],
          ["space", execution.space],
          ["name", execution.name],
          ["form_url", V2_CONTAINER_F2_FORM],
          ["backend_id", backendId],
          ["target_key", targetKey],
          ["action", execution.action],
          ["generation", execution.generation],
          ["backend_key", execution.backendKey],
        ];
        if (
          !expected.every(([key, value]) => current(proof, key) === value) ||
          proof.i_resource_uid !== execution.resourceUid ||
          proof.i_installation_id !== installationId ||
          proof.i_form_url !== V2_CONTAINER_F2_FORM ||
          proof.i_backend_id !== backendId ||
          proof.i_target_key !== targetKey ||
          !hex(proof.i_incarnation_id) ||
          proof.i_incarnation_id !== first.i_incarnation_id ||
          proof.i_desired_generation !== execution.generation ||
          proof.la_operation_id !== execution.operationId ||
          proof.r_uid !== execution.resourceUid ||
          proof.r_principal !== execution.principal ||
          proof.r_form_url !== V2_CONTAINER_F2_FORM ||
          proof.r_space !== execution.space ||
          proof.r_name !== execution.name ||
          proof.r_backend_id !== backendId ||
          proof.r_target_key !== targetKey ||
          proof.r_generation !== execution.generation ||
          proof.r_active_name !== execution.name ||
          proof.r_deleted_at !== null ||
          proof.r_last_operation !== execution.operationId ||
          proof.v_operation_id !== proof.a_operation_id ||
          proof.v_generation !== proof.a_generation ||
          proof.v_revision !== proof.a_revision
        )
          return fail();
        if (
          deleting
            ? proof.i_retire_operation_id !== execution.operationId ||
              typeof proof.i_retired_at_ms !== "number" ||
              Number(proof.v_generation) >= execution.generation
            : proof.i_retire_operation_id !== null ||
              proof.i_retired_at_ms !== null ||
              !Number.isSafeInteger(proof.v_generation) ||
              Number(proof.v_generation) < 1 ||
              Number(proof.v_generation) > execution.generation
        )
          return fail();
        const selectedSpec = publicSpec(current(proof, "accepted_spec_json"));
        if (
          canonicalJson(selectedSpec) !== canonicalJson(execution.spec) ||
          canonicalJson(publicSpec(proof.r_spec_json)) !== canonicalJson(selectedSpec)
        )
          return fail();
        await configuredSnapshot(proof, "a");
        await configuredSnapshot(proof, "la");
        if (proof.q_claim_id === null) {
          if (proof.v_intent_json !== null) return fail();
        } else {
          if (typeof proof.v_intent_json !== "string") return fail();
          const parsed = parseStrictJson(new TextEncoder().encode(proof.v_intent_json), 1048576);
          if (!isJsonObject(parsed)) return fail();
          const loaded = await load(
            intentSnapshot(parsed as unknown as DockerContainerCreateIntent),
          );
          const saved = record(loaded.intent, loaded.proof);
          if (
            !saved ||
            !(
              usable(loaded.proof, deleting ? "remove" : "observe") ||
              (!deleting && usable(loaded.proof, "remove"))
            )
          )
            return fail();
          const removedAtMs = loaded.proof.q_removed_at_ms;
          if (
            saved.state === "removed"
              ? typeof removedAtMs !== "number" ||
                !Number.isSafeInteger(removedAtMs) ||
                removedAtMs < Number(loaded.proof.q_claimed_at_ms)
              : removedAtMs !== null
          )
            return fail();
          retained.push(
            Object.freeze({
              record: saved,
              spec: publicSpec(proof.a_accepted_spec_json),
              removedAtMs: removedAtMs as number | null,
            }),
          );
        }
        await assertSnapshot(proof);
        await assertExecution(execution);
      }
      {
        const claims = await sql.query(
          "SELECT generation,claim_id FROM main.tf_v2_container_create_claims WHERE resource_uid=? LIMIT 4097",
          [execution.resourceUid],
        );
        if (
          claims.length > 4096 ||
          claims.length !== retained.length ||
          !claims.every((row) =>
            retained.some(
              ({ record }) =>
                record.intent.policy.generation === row.generation &&
                record.claimId === row.claim_id,
            ),
          )
        )
          return fail();
      }
      let servingConfirmedAtMs: number | null = null;
      if (!deleting && first.i_serving_generation === execution.generation) {
        const serving = retained.find(
          ({ record }) => record.intent.policy.generation === execution.generation,
        )?.record;
        if (
          !serving ||
          serving.state !== "bound" ||
          serving.nativeId === null ||
          first.q_claim_id !== serving.claimId ||
          first.q_native_id !== serving.nativeId
        )
          return fail();
        const attempts = await sql.query(
          "SELECT attempt,create_claim_id,native_id,state,claimed_at_ms,confirmed_running_at_ms,confirmed_exited_at_ms FROM tf_v2_container_start_attempts WHERE resource_uid=? AND generation=?",
          [execution.resourceUid, execution.generation],
        );
        if (attempts.length !== 1) return fail();
        const attempt = attempts[0]!;
        const claimedAt = attempt.claimed_at_ms;
        const confirmedAt = attempt.confirmed_running_at_ms;
        if (
          attempt.attempt !== 1 ||
          attempt.state !== "running" ||
          attempt.create_claim_id !== serving.claimId ||
          attempt.native_id !== serving.nativeId ||
          attempt.confirmed_exited_at_ms !== null ||
          typeof claimedAt !== "number" ||
          !Number.isSafeInteger(claimedAt) ||
          claimedAt < 0 ||
          typeof confirmedAt !== "number" ||
          !Number.isSafeInteger(confirmedAt) ||
          confirmedAt < claimedAt
        )
          return fail();
        servingConfirmedAtMs = confirmedAt;
        await assertSnapshot(first);
      }
      const spec = publicSpec(current(first, "accepted_spec_json"));
      const names = validateDockerContainerSpec(spec).requiredSensitiveVars;
      await assertExecution(execution);
      return Object.freeze({
        installationId,
        operationId: execution.operationId,
        resourceUid: execution.resourceUid,
        incarnationId: first.i_incarnation_id as string,
        principal: execution.principal,
        space: execution.space,
        name: execution.name,
        form: execution.form,
        backendId,
        targetKey,
        action: execution.action,
        generation: execution.generation,
        revision: current(first, "revision") as string,
        spec,
        requiredSecretNames: names,
        outboundInternet: (spec[C.fields.outboundInternet] ?? false) as boolean,
        retained: Object.freeze(retained),
        servingConfirmedAtMs,
      });
    },
    async withExecution<T>(execution: V2Execution, work: () => Promise<T>): Promise<T> {
      if (
        !execution ||
        typeof execution !== "object" ||
        typeof work !== "function" ||
        (Object.getPrototypeOf(execution) !== Object.prototype &&
          Object.getPrototypeOf(execution) !== null) ||
        ![
          "form",
          "backendId",
          "targetKey",
          "operationId",
          "resourceUid",
          "generation",
          "leaseToken",
          "action",
        ].every((key) =>
          Object.hasOwn(Object.getOwnPropertyDescriptor(execution, key) ?? {}, "value"),
        ) ||
        !Reflect.ownKeys(execution).every(
          (key) =>
            typeof key === "string" &&
            Object.hasOwn(Object.getOwnPropertyDescriptor(execution, key) ?? {}, "value"),
        )
      )
        return fail();
      if (execution.form === C.formUrl) return work();
      if (
        execution.form !== V2_CONTAINER_F2_FORM ||
        execution.backendId !== backendId ||
        execution.targetKey !== targetKey ||
        !text(execution.operationId) ||
        !text(execution.resourceUid) ||
        !text(execution.leaseToken) ||
        !Number.isSafeInteger(execution.generation) ||
        execution.generation < 1 ||
        (execution.action !== "create" &&
          execution.action !== "update" &&
          execution.action !== "delete")
      )
        return fail();
      const scope = Object.freeze({
        execution,
        operationId: execution.operationId,
        resourceUid: execution.resourceUid,
        generation: execution.generation,
        leaseToken: execution.leaseToken,
        action: execution.action,
      });
      const scopes = execution.action === "delete" ? deleteExecutions : executions;
      scopes.add(scope);
      try {
        return await work();
      } finally {
        scopes.delete(scope);
      }
    },
    acceptance,
    owner,
    createCustody(policy: DockerContainerRuntimePolicy, requiredSecretNames: readonly string[]) {
      const names = validateV2ContainerF2SensitiveNames(requiredSecretNames);
      if (names.length > 0 && !configuredInputs) return fail();
      return createDockerContainerCreateCustody({ policy, requiredSecretNames: names, owner });
    },
  });
  if (options.configuredInputs)
    configuredInputs = createDockerContainerConfiguredInputs({
      sql,
      selection: { targetKey, providerInstallationId: installationId, backendId },
      owner: result,
      keyring: options.configuredInputs.keyring,
      maxSecretBytes: options.configuredInputs.maxSecretBytes,
    });
  return result;
}
