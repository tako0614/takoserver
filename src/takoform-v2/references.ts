import { canonicalJson } from "../json.ts";
import type { JsonObject } from "../ports.ts";
import { isV2FormUrl } from "./identity.ts";
import { TakoformV2Error, type V2Form } from "./types.ts";

const uidPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const pathSegment = /^[A-Za-z][A-Za-z0-9_]*$/u;
const MAX_REFERENCES = 512;

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
  const declared = form.references(spec);
  if (!Array.isArray(declared) || declared.length > MAX_REFERENCES) invalid();
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
