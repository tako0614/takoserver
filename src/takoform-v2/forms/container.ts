import { CONTAINER_CONTRACT as C } from "../../container-contract.ts";
import { parseStrictJson } from "../../strict-json.ts";
import { TakoformV2Error } from "../types.ts";

const F = C.fields;
export type ContainerSpec = {
  readonly [F.image]: string;
  readonly [F.httpPort]: number;
  readonly [F.healthPath]: string;
  readonly [F.workloadRevision]: string;
  readonly [F.environment]: Readonly<Record<string, string>>;
  readonly [F.requiredSensitiveVars]: readonly string[];
  readonly [F.outboundInternet]: false;
};

const required: readonly string[] = [F.image, F.httpPort, F.healthPath, F.workloadRevision];
const optional: readonly string[] = [F.environment, F.requiredSensitiveVars, F.outboundInternet];
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function invalid(): never {
  throw new TakoformV2Error(C.errors.invalidSpec, 422);
}

export function containerRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) invalid();
  }
  return value as Record<string, unknown>;
}

export function scalarStringWithin(value: unknown, maximum: number): value is string {
  if (typeof value !== "string") return false;
  let count = 0;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if ((point >= 0xd800 && point <= 0xdfff) || ++count > maximum) return false;
  }
  return true;
}

export function isContainerImage(value: unknown): value is string {
  if (!scalarStringWithin(value, 512)) return false;
  const match = /^([a-z0-9.-]+(?::[0-9]{1,5})?)\/([^@]+)@sha256:[a-f0-9]{64}$/u.exec(value);
  if (!match) return false;
  const registry = match[1]!;
  const [hostname, port] = registry.split(":");
  if (!hostname || (!hostname.includes(".") && hostname !== "localhost" && !port)) return false;
  if (hostname.split(".").some((part) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(part)))
    return false;
  if (port && (Number(port) < 1 || Number(port) > 65535)) return false;
  const [repository, tag, extra] = match[2]!.split(":");
  if (
    extra !== undefined ||
    (tag !== undefined && (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(tag) || tag === "latest"))
  )
    return false;
  return (
    !!repository &&
    repository.split("/").every((part) => /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/u.test(part))
  );
}

export function isContainerHealthPath(value: unknown): value is string {
  if (!scalarStringWithin(value, 2048) || !value.startsWith("/") || value.startsWith("//"))
    return false;
  if (!/^(?:[A-Za-z0-9/._~!$&'()*+,;=:@-]|%[a-fA-F0-9]{2})+$/u.test(value)) return false;
  let decoded = value;
  // Also reject double-encoded traversal/separators at intermediaries.
  for (let depth = 0; depth <= value.length; depth++) {
    if (
      /[\\?#]/u.test(decoded) ||
      Array.from(decoded).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) ||
      decoded.split("/").includes("..") ||
      /%(?:2f|5c)/iu.test(decoded)
    )
      return false;
    if (!/%[a-fA-F0-9]{2}/u.test(decoded)) return true;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return true;
      decoded = next;
    } catch {
      return false;
    }
  }
  return false;
}

export function parseContainerSpec(input: unknown, privateInputs?: unknown): ContainerSpec {
  const spec = containerRecord(input);
  if (privateInputs !== undefined && Object.keys(containerRecord(privateInputs)).length !== 0)
    invalid();
  if (
    Object.keys(spec).some((key) => ![...required, ...optional].includes(key)) ||
    required.some((key) => !Object.hasOwn(spec, key))
  )
    invalid();
  if (
    !isContainerImage(spec[F.image]) ||
    !Number.isInteger(spec[F.httpPort]) ||
    (spec[F.httpPort] as number) < 1 ||
    (spec[F.httpPort] as number) > 65535 ||
    !isContainerHealthPath(spec[F.healthPath]) ||
    typeof spec[F.workloadRevision] !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(spec[F.workloadRevision] as string)
  )
    invalid();
  const environment = containerRecord(
    Object.hasOwn(spec, F.environment) ? spec[F.environment] : {},
  );
  if (Object.keys(environment).length > 64) invalid();
  const normalized: Record<string, string> = Object.create(null);
  for (const key of Object.keys(environment).sort()) {
    const value = environment[key];
    if (
      !envName.test(key) ||
      key.startsWith("CLOUDFLARE_") ||
      key.startsWith("TAKOFORM_") ||
      !scalarStringWithin(value, 4096) ||
      value.includes("\0")
    )
      invalid();
    normalized[key] = value;
  }
  const sensitive = Object.hasOwn(spec, F.requiredSensitiveVars)
    ? spec[F.requiredSensitiveVars]
    : [];
  if (
    !Array.isArray(sensitive) ||
    Reflect.ownKeys(sensitive).length !== 1 ||
    sensitive.length !== 0
  )
    invalid();
  if (Object.hasOwn(spec, F.outboundInternet) && spec[F.outboundInternet] !== false) invalid();
  return {
    [F.image]: spec[F.image] as string,
    [F.httpPort]: spec[F.httpPort] as number,
    [F.healthPath]: spec[F.healthPath] as string,
    [F.workloadRevision]: spec[F.workloadRevision] as string,
    [F.environment]: normalized,
    [F.requiredSensitiveVars]: [],
    [F.outboundInternet]: false,
  };
}

export function parseContainerSpecJson(bytes: Uint8Array): ContainerSpec {
  try {
    return parseContainerSpec(parseStrictJson(bytes, 1_048_576));
  } catch {
    invalid();
  }
}
