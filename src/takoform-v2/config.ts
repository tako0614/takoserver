import { base64UrlDecode } from "../json.ts";
import { parseStrictJson, StrictJsonError } from "../strict-json.ts";
import { createV2HeldArtifactSource, type V2HeldArtifactEntry } from "./forms/artifact-source.ts";
import { isV2HttpsUrl } from "./identity.ts";

const MAX_CONFIG_BYTES = 8 * 1_024 * 1_024;
const CONFIG_ENV = "TAKOSERVER_TAKOFORM_V2_CONFIG";
const CURSOR_KEY_ENV = "TAKOSERVER_TAKOFORM_V2_CURSOR_KEY";

export interface V2ApplicationConfig {
  readonly cursorSigningKey: Uint8Array;
  readonly documentation: string;
  readonly authenticationDocumentation: string;
  readonly sqliteMigrationSet?: V2HeldArtifactBackendConfig;
  readonly workerBundle?: V2HeldArtifactBackendConfig;
  readonly staticAssetBundle?: V2HeldArtifactBackendConfig;
}

export type V2ApplicationPublicConfig = Omit<V2ApplicationConfig, "cursorSigningKey">;

export interface V2HeldArtifactBackendConfig {
  readonly targetKey: string;
  readonly heldArtifacts: readonly V2HeldArtifactEntry[];
}

export interface V2ApplicationEnvironment {
  readonly TAKOSERVER_TAKOFORM_V2_CONFIG?: string | undefined;
  readonly TAKOSERVER_TAKOFORM_V2_CURSOR_KEY?: string | undefined;
}

export type V2ApplicationConfigErrorCode =
  | "missing_configuration"
  | "missing_cursor_key"
  | "invalid_configuration"
  | "invalid_cursor_key";

/** Payload-free startup configuration failure. */
export class V2ApplicationConfigError extends TypeError {
  constructor(readonly code: V2ApplicationConfigErrorCode) {
    super(code);
    this.name = "V2ApplicationConfigError";
  }
}

/** Parse the explicit non-secret v2 config and its separately managed HMAC key. */
export function parseTakoformV2ApplicationConfig(
  environment: V2ApplicationEnvironment,
): V2ApplicationConfig {
  const json = environment?.[CONFIG_ENV];
  const encodedKey = environment?.[CURSOR_KEY_ENV];
  if (typeof json !== "string" || json.length === 0) {
    throw new V2ApplicationConfigError("missing_configuration");
  }
  if (typeof encodedKey !== "string" || encodedKey.length === 0) {
    throw new V2ApplicationConfigError("missing_cursor_key");
  }
  const cursorKey = base64UrlDecode(encodedKey);
  if (!cursorKey || cursorKey.byteLength < 32) {
    throw new V2ApplicationConfigError("invalid_cursor_key");
  }

  return { cursorSigningKey: new Uint8Array(cursorKey), ...parseTakoformV2PublicConfig(json) };
}

/** Parse only the exact non-secret JSON that deploy may realize as a plain-text binding. */
export function parseTakoformV2PublicConfig(json: string): V2ApplicationPublicConfig {
  if (typeof json !== "string" || json.length === 0) {
    throw new V2ApplicationConfigError("missing_configuration");
  }
  let parsed: unknown;
  try {
    if (json.length > MAX_CONFIG_BYTES) throw new StrictJsonError();
    parsed = parseStrictJson(new TextEncoder().encode(json), MAX_CONFIG_BYTES);
  } catch {
    throw new V2ApplicationConfigError("invalid_configuration");
  }

  const record = asRecord(parsed);
  if (
    !record ||
    !hasExactKeys(
      record,
      ["documentation", "authenticationDocumentation"],
      ["sqliteMigrationSet", "workerBundle", "staticAssetBundle"],
    )
  ) {
    throw new V2ApplicationConfigError("invalid_configuration");
  }
  if (!isV2HttpsUrl(record.documentation) || !isV2HttpsUrl(record.authenticationDocumentation)) {
    throw new V2ApplicationConfigError("invalid_configuration");
  }

  let sqliteMigrationSet: V2ApplicationConfig["sqliteMigrationSet"];
  if (Object.hasOwn(record, "sqliteMigrationSet")) {
    sqliteMigrationSet = parseHeldArtifactBackendConfig(record.sqliteMigrationSet);
  }
  let workerBundle: V2ApplicationConfig["workerBundle"];
  if (Object.hasOwn(record, "workerBundle")) {
    workerBundle = parseHeldArtifactBackendConfig(record.workerBundle);
  }
  let staticAssetBundle: V2ApplicationConfig["staticAssetBundle"];
  if (Object.hasOwn(record, "staticAssetBundle")) {
    staticAssetBundle = parseHeldArtifactBackendConfig(record.staticAssetBundle);
  }
  return {
    documentation: record.documentation,
    authenticationDocumentation: record.authenticationDocumentation,
    ...(sqliteMigrationSet ? { sqliteMigrationSet } : {}),
    ...(workerBundle ? { workerBundle } : {}),
    ...(staticAssetBundle ? { staticAssetBundle } : {}),
  };
}

function parseHeldArtifactBackendConfig(value: unknown): V2HeldArtifactBackendConfig {
  const config = asRecord(value);
  if (!config || !hasExactKeys(config, ["targetKey", "heldArtifacts"])) {
    throw new V2ApplicationConfigError("invalid_configuration");
  }
  if (
    typeof config.targetKey !== "string" ||
    config.targetKey.length === 0 ||
    !Array.isArray(config.heldArtifacts)
  ) {
    throw new V2ApplicationConfigError("invalid_configuration");
  }

  const heldArtifacts = config.heldArtifacts.map(parseHeldArtifactEntry);
  try {
    // Reuse the source's exact URL, digest, duplicate, and grant validation.
    createV2HeldArtifactSource({
      objects: { get: async () => null },
      entries: heldArtifacts,
    });
  } catch {
    throw new V2ApplicationConfigError("invalid_configuration");
  }
  return { targetKey: config.targetKey, heldArtifacts };
}

function parseHeldArtifactEntry(value: unknown): V2HeldArtifactEntry {
  const entry = asRecord(value);
  if (!entry || !hasExactKeys(entry, ["url", "sha256", "objectKey", "grants"])) {
    throw new V2ApplicationConfigError("invalid_configuration");
  }
  if (
    typeof entry.url !== "string" ||
    typeof entry.sha256 !== "string" ||
    typeof entry.objectKey !== "string" ||
    !Array.isArray(entry.grants)
  ) {
    throw new V2ApplicationConfigError("invalid_configuration");
  }
  const grants = entry.grants.map((value) => {
    const grant = asRecord(value);
    if (!grant || !hasExactKeys(grant, ["principal", "space"])) {
      throw new V2ApplicationConfigError("invalid_configuration");
    }
    if (typeof grant.principal !== "string" || typeof grant.space !== "string") {
      throw new V2ApplicationConfigError("invalid_configuration");
    }
    return { principal: grant.principal, space: grant.space };
  });
  return {
    url: entry.url,
    sha256: entry.sha256,
    objectKey: entry.objectKey,
    grants,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}
