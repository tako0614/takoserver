import { canonicalJson } from "../json.ts";
import type { JsonObject, Sql } from "../ports.ts";
import { isV2FormUrl } from "./identity.ts";
import {
  TakoformV2Error,
  type V2AdmissionPredicate,
  type V2Form,
  type V2PrepareExactReferences,
  type V2ReferenceRequirement,
} from "./types.ts";

const uidPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const pathSegment = /^[A-Za-z][A-Za-z0-9_]*$/u;
const MAX_REFERENCES = 512;
// Only the additive prepared path has this larger combined declaration budget.
const MAX_COMBINED_REFERENCES = 515;

// The contract captures every returned SQL field, while inspecting only these
// identity keys. It does not depend on the persistence implementation's row type.
type ExactReferenceTargetRow = Readonly<
  Record<string, unknown> & { readonly uid: string; readonly form_url: string }
>;

interface PreparedReference {
  resourceUid: string;
  formUrl: string;
  readiness: "observed" | "ready";
  targetSpecPath: string | null;
  targetSpecEquals: string | null;
}

function invalid(): never {
  throw new TakoformV2Error("invalid_spec", 422);
}

/** Normalize trusted Form declarations into one bounded, immutable SQL input. */
export function prepareV2References(form: V2Form, spec: JsonObject): string | null {
  if (!form.references) return null;
  return normalizeReferences(form.references(spec));
}

function normalizeReferences(
  declared: readonly V2ReferenceRequirement[],
  limit = MAX_REFERENCES,
): string {
  if (!Array.isArray(declared) || declared.length > limit) invalid();
  const byUid = new Map<string, PreparedReference>();
  for (const item of declared) {
    if (
      !item ||
      typeof item.resourceUid !== "string" ||
      !uidPattern.test(item.resourceUid) ||
      !isV2FormUrl(item.formUrl) ||
      (item.readiness !== "observed" && item.readiness !== "ready")
    )
      invalid();
    let targetSpecPath: string | null = null;
    let targetSpecEquals: string | null = null;
    if (item.targetSpecMatch !== undefined) {
      const { path, equals } = item.targetSpecMatch;
      if (
        !Array.isArray(path) ||
        path.length < 1 ||
        path.length > 4 ||
        path.some((segment) => typeof segment !== "string" || !pathSegment.test(segment)) ||
        typeof equals !== "string" ||
        !uidPattern.test(equals)
      )
        invalid();
      targetSpecPath = `$.${path.join(".")}`;
      targetSpecEquals = equals;
    }
    const prior = byUid.get(item.resourceUid);
    if (prior) {
      if (
        prior.formUrl !== item.formUrl ||
        (prior.targetSpecPath !== null &&
          targetSpecPath !== null &&
          (prior.targetSpecPath !== targetSpecPath || prior.targetSpecEquals !== targetSpecEquals))
      )
        invalid();
      prior.readiness =
        prior.readiness === "ready" || item.readiness === "ready" ? "ready" : "observed";
      prior.targetSpecPath ??= targetSpecPath;
      prior.targetSpecEquals ??= targetSpecEquals;
    } else {
      byUid.set(item.resourceUid, {
        resourceUid: item.resourceUid,
        formUrl: item.formUrl,
        readiness: item.readiness,
        targetSpecPath,
        targetSpecEquals,
      });
    }
  }
  return canonicalJson(
    [...byUid.values()].sort((a, b) => a.resourceUid.localeCompare(b.resourceUid)),
  );
}

function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) invalid();
  return descriptor.value;
}

/** New async declarations are data, never deferred getters or inherited policy. */
function snapshotRequirements(value: readonly V2ReferenceRequirement[]) {
  if (!Array.isArray(value) || value.length > MAX_REFERENCES) invalid();
  const result: V2ReferenceRequirement[] = [];
  for (let index = 0; index < value.length; index++) {
    const item = own(value, String(index));
    if (typeof item !== "object" || item === null) invalid();
    const resourceUid = own(item, "resourceUid");
    const formUrl = own(item, "formUrl");
    const readiness = own(item, "readiness");
    const match = Object.getOwnPropertyDescriptor(item, "targetSpecMatch");
    if (!match && "targetSpecMatch" in item) invalid();
    if (match && !("value" in match)) invalid();
    let targetSpecMatch: V2ReferenceRequirement["targetSpecMatch"];
    if (match?.value !== undefined) {
      const source: unknown = match.value;
      if (typeof source !== "object" || source === null) invalid();
      const path = own(source, "path");
      const equals = own(source, "equals");
      if (!Array.isArray(path) || typeof equals !== "string") invalid();
      const segments: string[] = [];
      if (path.length < 1 || path.length > 4) invalid();
      for (let index = 0; index < path.length; index++) {
        const segment = own(path, String(index));
        if (typeof segment !== "string") invalid();
        segments.push(segment);
      }
      targetSpecMatch = Object.freeze({ path: Object.freeze(segments), equals });
    }
    if (
      typeof resourceUid !== "string" ||
      typeof formUrl !== "string" ||
      (readiness !== "ready" && readiness !== "observed")
    )
      invalid();
    result.push(
      Object.freeze({
        resourceUid,
        formUrl,
        readiness,
        ...(targetSpecMatch === undefined ? {} : { targetSpecMatch }),
      }),
    );
  }
  normalizeReferences(result);
  return Object.freeze(result);
}

function mergeReferences(pure: string | null, prepared: readonly V2ReferenceRequirement[]) {
  const original = pure === null ? [] : (JSON.parse(pure) as PreparedReference[]);
  return normalizeReferences(
    [
      ...original.map((item) => ({
        resourceUid: item.resourceUid,
        formUrl: item.formUrl,
        readiness: item.readiness,
        ...(item.targetSpecPath === null
          ? {}
          : {
              targetSpecMatch: {
                path: item.targetSpecPath.slice(2).split("."),
                equals: item.targetSpecEquals as string,
              },
            }),
      })),
      ...prepared,
    ],
    MAX_COMBINED_REFERENCES,
  );
}

// Compare the captured target preimage, not merely its readiness at acceptance.
// 0073 still owns exact Form/readiness/spec checks and the sealed dependency set.
const exactPreimageSql = `NOT EXISTS (
  SELECT 1 FROM json_each(?) prepared WHERE NOT EXISTS (
    SELECT 1 FROM tf_v2_resources target
    WHERE target.uid = json_extract(prepared.value, '$.uid')
      AND target.principal = ? AND target.space = ?
      AND target.form_url = json_extract(prepared.value, '$.form_url')
      AND target.backend_id = json_extract(prepared.value, '$.backend_id')
      AND target.target_key = json_extract(prepared.value, '$.target_key')
      AND target.generation = json_extract(prepared.value, '$.generation')
      AND target.observed_generation = json_extract(prepared.value, '$.observed_generation')
      AND target.observed_at IS json_extract(prepared.value, '$.observed_at')
      AND target.phase = json_extract(prepared.value, '$.phase')
      AND target.last_operation = json_extract(prepared.value, '$.last_operation')
      AND target.busy_operation IS json_extract(prepared.value, '$.busy_operation')
      AND target.deleted_at IS json_extract(prepared.value, '$.deleted_at')
      AND target.spec_json = json_extract(prepared.value, '$.spec_json')
      AND target.observed_json = json_extract(prepared.value, '$.observed_json')
      AND target.output_json = json_extract(prepared.value, '$.output_json')))`;

/** One request's lexical issuer; no reusable witness or persisted candidate list. */
export function createV2ExactReferencePreparation(input: {
  readonly sql: Sql;
  readonly principal: string;
  readonly space: string;
  readonly referencesJson: string | null;
  readonly authorizeRead: () => Promise<void>;
  readonly snapshotAdmission: (value: V2AdmissionPredicate) => V2AdmissionPredicate;
}) {
  const { principal, space, referencesJson, authorizeRead, snapshotAdmission } = input;
  const query = input.sql.query.bind(input.sql);
  const targets = new Map<string, Promise<ExactReferenceTargetRow | null>>();
  let open = true;
  let used = false;
  let issued: V2AdmissionPredicate | undefined;
  let domain: V2AdmissionPredicate | undefined;
  let referenceGuard: V2AdmissionPredicate | undefined;
  let merged = referencesJson;
  function current() {
    if (!open) throw new TypeError("exact reference preparation is closed");
  }
  const prepareExactReferences: V2PrepareExactReferences = async (choose, admission) => {
    current();
    if (used || typeof choose !== "function")
      throw new TypeError("exact references must be prepared once per admission");
    used = true;
    if (admission && "preparedExactReferences" in admission)
      throw new TypeError("prepared reference result cannot be reused");
    // Capture domain SQL and binary parameters before authorization or chooser awaits.
    domain = admission === undefined ? undefined : snapshotAdmission(admission);
    await authorizeRead();
    current();
    const declared = await choose(async (resourceUid) => {
      current();
      if (typeof resourceUid !== "string" || !uidPattern.test(resourceUid)) invalid();
      let pending = targets.get(resourceUid);
      if (!pending) {
        if (targets.size >= MAX_REFERENCES) invalid();
        pending = query(
          "SELECT * FROM tf_v2_resources WHERE uid = ? AND principal = ? AND space = ?",
          [resourceUid, principal, space],
        ).then((rows) => {
          const row = rows[0] as unknown as ExactReferenceTargetRow | undefined;
          return row ? Object.freeze({ ...row }) : null;
        });
        targets.set(resourceUid, pending);
      }
      const row = await pending;
      current();
      return row ? Object.freeze({ resourceUid: row.uid, formUrl: row.form_url }) : null;
    });
    current();
    if (declared === null) return null;
    const requirements = snapshotRequirements(declared);
    const selected: ExactReferenceTargetRow[] = [];
    const included = new Set<string>();
    for (const requirement of requirements) {
      const pending = targets.get(requirement.resourceUid);
      if (!pending) throw new TypeError("exact reference was not looked up by this request");
      const row = await pending;
      current();
      if (!row || row.form_url !== requirement.formUrl) return null;
      if (!included.has(row.uid)) selected.push(row);
      included.add(row.uid);
    }
    merged = mergeReferences(referencesJson, requirements);
    referenceGuard = Object.freeze({
      sql: exactPreimageSql,
      params: Object.freeze([canonicalJson(selected), principal, space]),
    });
    issued = Object.freeze({
      ...(domain ?? referenceGuard),
      preparedExactReferences: requirements,
    });
    return issued;
  };
  return Object.freeze({
    prepareExactReferences,
    finish(value: V2AdmissionPredicate | null) {
      current();
      open = false;
      targets.clear();
      if (value === null) return null;
      if (used) {
        if (!issued || value !== issued)
          throw new TypeError("prepared references belong to another admission result");
        return { admission: domain, referencesJson: merged, referenceGuard };
      }
      if ("preparedExactReferences" in value)
        throw new TypeError("prepared references were not issued by this request");
      return { admission: snapshotAdmission(value), referencesJson, referenceGuard: undefined };
    },
    close() {
      open = false;
      targets.clear();
    },
  });
}
