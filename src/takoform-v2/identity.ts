/** Validate an exact serialized Form URL without replacing it with URL.href. */
export function isV2FormUrl(value: unknown): value is string {
  if (typeof value !== "string" || !/^[\x21-\x7e]+$/u.test(value)) return false;
  if (value.includes("\\")) return false;
  if (!/^https:\/\/[^/?#]+\/[^?#]*$/iu.test(value)) return false;
  if (value.includes("?") || value.includes("#") || /%(?![0-9a-f]{2})/iu.test(value)) return false;
  const authority = value.slice(value.indexOf("//") + 2).split("/", 1)[0] ?? "";
  if (authority.includes("@") || /[\\\s]/u.test(authority)) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" && parsed.hostname !== "" && !parsed.username && !parsed.password
    );
  } catch {
    return false;
  }
}

export interface V2BaseUrl {
  readonly url: URL;
  /** Exact configured path, with the root path represented as an empty string. */
  readonly path: string;
}

/** Validate an exact discovery baseUrl, allowing a bare origin but no trailing slash. */
export function parseV2BaseUrl(value: string): V2BaseUrl {
  if (
    typeof value !== "string" ||
    !/^[\x21-\x7e]+$/u.test(value) ||
    !/^https:\/\/[^/?#]+(?:\/[^?#]*)?$/iu.test(value)
  ) {
    throw new TypeError("baseUrl must be an ASCII serialized absolute HTTPS URL");
  }
  if (value.includes("?") || value.includes("#") || /%(?![0-9a-f]{2})/iu.test(value)) {
    throw new TypeError("baseUrl must not contain a query or fragment");
  }
  if (value.includes("\\")) throw new TypeError("baseUrl must not contain backslashes");
  const authority = value.slice(value.indexOf("//") + 2).split("/", 1)[0] ?? "";
  if (authority.includes("@") || /[\\\s]/u.test(authority))
    throw new TypeError("baseUrl must not contain user information");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("baseUrl must be a valid absolute HTTPS URL");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new TypeError("baseUrl must be a valid absolute HTTPS URL without credentials");
  }
  const exactPath = value.match(/^https:\/\/[^/?#]+(\/[^?#]*)?$/iu)?.[1] ?? "";
  if (exactPath.endsWith("/")) throw new TypeError("baseUrl must not end in a slash");
  return { url, path: exactPath };
}

/** Absolute HTTPS URLs used for documentation fields; identity is not normalized. */
export function isV2HttpsUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^[\x21-\x7e]+$/u.test(value) ||
    !/^https:\/\/[^/?#]+(?:\/[^#]*)?(?:\?[^#]*)?(?:#.*)?$/iu.test(value)
  ) {
    return false;
  }
  if (/%(?![0-9a-f]{2})/iu.test(value)) return false;
  if (value.includes("\\")) return false;
  const authority = value.slice(value.indexOf("//") + 2).split(/[/?#]/u, 1)[0] ?? "";
  if (authority.includes("@") || /[\\\s]/u.test(authority)) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" && parsed.hostname !== "" && !parsed.username && !parsed.password
    );
  } catch {
    return false;
  }
}
