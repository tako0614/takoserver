/** Maximum UTF-8 length of a relative path in a held artifact manifest. */
export const ARTIFACT_PATH_MAX_BYTES = 1_024;

/** Relative POSIX path; no URL interpretation or filesystem access. */
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

function hasPathControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
