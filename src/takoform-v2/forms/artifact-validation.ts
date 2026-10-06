import { isV2HttpsUrl } from "../identity.ts";

export const ARTIFACT_PATH_MAX_BYTES = 1_024;
export const ARTIFACT_URL_MAX_ASCII_BYTES = 8_192;

/** Absolute HTTPS artifact URL with no userinfo, query, or fragment. */
export function isArtifactUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= ARTIFACT_URL_MAX_ASCII_BYTES &&
    isV2HttpsUrl(value) &&
    !value.includes("?") &&
    !value.includes("#")
  );
}

/** Relative POSIX path shared by the currently supported artifact manifests. */
export function isValidArtifactPath(value: string): boolean {
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > ARTIFACT_PATH_MAX_BYTES ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    hasPathControl(value)
  ) {
    return false;
  }
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function bareSha256Digest(value: `sha256:${string}`): string {
  return value.slice("sha256:".length);
}

function hasPathControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
