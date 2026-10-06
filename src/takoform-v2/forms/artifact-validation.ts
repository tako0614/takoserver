import { isV2HttpsUrl } from "../identity.ts";

export { ARTIFACT_PATH_MAX_BYTES, isValidArtifactPath } from "../../artifact-path.ts";

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

export function bareSha256Digest(value: `sha256:${string}`): string {
  return value.slice("sha256:".length);
}
