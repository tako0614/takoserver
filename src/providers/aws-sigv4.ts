/** A bounded AWS Signature Version 4 signer for control-plane REST requests. */

export interface AwsV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export async function signAwsV4Request(input: {
  readonly method: string;
  readonly url: string;
  readonly region: string;
  readonly service: string;
  readonly credentials: AwsV4Credentials;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  readonly now: Date;
}): Promise<Request> {
  const url = new URL(input.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError("AWS SigV4 requires a bare HTTPS target");
  }
  const accessKeyId = bounded(input.credentials.accessKeyId, 1, 512, "access key id");
  const secretAccessKey = bounded(input.credentials.secretAccessKey, 1, 4_096, "secret access key");
  const region = identifier(input.region, "region");
  const service = identifier(input.service, "service");
  if (!Number.isFinite(input.now.getTime())) throw new TypeError("invalid signing time");

  const body =
    typeof input.body === "string"
      ? new TextEncoder().encode(input.body)
      : (input.body ?? new Uint8Array());
  if (body.byteLength > 1_048_576) throw new TypeError("AWS SigV4 control request is too large");
  const payloadHash = await sha256Hex(body);
  const timestamp = input.now.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  const date = timestamp.slice(0, 8);

  const headers = new Headers(input.headers);
  headers.set("host", url.host);
  headers.set("x-amz-content-sha256", payloadHash);
  headers.set("x-amz-date", timestamp);
  if (input.credentials.sessionToken) {
    headers.set(
      "x-amz-security-token",
      bounded(input.credentials.sessionToken, 1, 16_384, "session token"),
    );
  }
  headers.delete("authorization");

  const canonicalHeaders = [...headers.entries()]
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/gu, " ")] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const signedHeaders = canonicalHeaders.map(([name]) => name).join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    `${canonicalHeaders.map(([name, value]) => `${name}:${value}\n`).join("")}`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    await sha256Hex(new TextEncoder().encode(canonicalRequest)),
  ].join("\n");
  const dateKey = await hmac(new TextEncoder().encode(`AWS4${secretAccessKey}`), date);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, service);
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
  );

  return new Request(url, {
    method: input.method,
    headers,
    ...(body.byteLength > 0 ? { body: body.slice().buffer as ArrayBuffer } : {}),
  });
}

function canonicalPath(pathname: string): string {
  return pathname
    .split("/")
    .map((part) =>
      encodeURIComponent(decodeURIComponent(part)).replace(/%[0-9a-f]{2}/gu, (hex) =>
        hex.toUpperCase(),
      ),
    )
    .join("/");
}

function canonicalQuery(search: URLSearchParams): string {
  return [...search.entries()]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/%[0-9a-f]{2}/gu, (part) => part.toUpperCase());
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", value as BufferSource)));
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value)),
  );
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bounded(value: string, minimum: number, maximum: number, field: string): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new TypeError(`invalid AWS ${field}`);
  }
  return value;
}

function identifier(value: string, field: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)) throw new TypeError(`invalid AWS ${field}`);
  return value;
}
