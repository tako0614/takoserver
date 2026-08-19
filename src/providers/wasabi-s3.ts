import { canonicalJson } from "../json.ts";
import { S3CredentialError, type S3CredentialIssuer, type S3CredentialSet } from "../s3-port.ts";
import { signAwsV4Request } from "./aws-sigv4.ts";

export interface WasabiS3CredentialOptions {
  readonly providerInstallationRef: string;
  /** Existing Wasabi role whose trust policy admits the configured sub-user. */
  readonly roleArn: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly maximumTtlSeconds?: number;
  readonly clock?: () => Date;
  readonly fetch?: (request: Request) => Promise<Response>;
}

/** Wasabi STS AssumeRole narrowed again to one exact provisioned bucket. */
export function createWasabiS3CredentialIssuer(
  options: WasabiS3CredentialOptions,
): S3CredentialIssuer {
  const providerInstallationRef = identifier(options.providerInstallationRef, 255);
  const roleArn = wasabiRoleArn(options.roleArn);
  const credentials = {
    accessKeyId: secret(options.accessKeyId, 512),
    secretAccessKey: secret(options.secretAccessKey, 4_096),
  };
  const maximumSeconds = options.maximumTtlSeconds ?? 3_600;
  if (!Number.isSafeInteger(maximumSeconds) || maximumSeconds < 900 || maximumSeconds > 43_200) {
    throw new TypeError("invalid Wasabi maximum STS duration");
  }
  const clock = options.clock ?? (() => new Date());
  const send = options.fetch ?? ((request: Request) => fetch(request));

  const owns = (input: Parameters<S3CredentialIssuer["limits"]>[0]) =>
    input.providerPackRef === "wasabi" && input.providerInstallationRef === providerInstallationRef
      ? parseWasabiNativeId(input.nativeId)
      : null;

  return {
    limits(input) {
      return owns(input) ? { minimumSeconds: 900, maximumSeconds, defaultSeconds: 900 } : null;
    },

    async issue(input): Promise<S3CredentialSet> {
      const native = owns(input);
      if (
        !native ||
        !Number.isSafeInteger(input.ttlSeconds) ||
        input.ttlSeconds < 900 ||
        input.ttlSeconds > maximumSeconds
      ) {
        throw new S3CredentialError("upstream_invalid");
      }
      const policy = bucketPolicy(native.bucket, input.access);
      const body = new URLSearchParams({
        Action: "AssumeRole",
        Version: "2011-06-15",
        RoleArn: roleArn,
        RoleSessionName: await sessionName(input.organizationId, input.resourceUid),
        DurationSeconds: String(input.ttlSeconds),
        Policy: canonicalJson(policy),
      }).toString();

      let response: Response;
      try {
        const request = await signAwsV4Request({
          method: "POST",
          url: "https://sts.wasabisys.com/",
          region: "us-east-1",
          service: "sts",
          credentials,
          headers: {
            accept: "application/xml",
            "content-type": "application/x-www-form-urlencoded; charset=utf-8",
          },
          body,
          now: clock(),
        });
        response = await send(request);
      } catch {
        throw new S3CredentialError("backend_unavailable");
      }
      if (!response.ok) throw new S3CredentialError("backend_unavailable");
      const xml = await boundedText(response, 65_536);
      const result = credentialsFromXml(xml);
      return {
        endpoint: wasabiEndpoint(native.region),
        region: native.region,
        bucket: native.bucket,
        ...result,
      };
    },
  };
}

function bucketPolicy(bucket: string, access: "read-only" | "read-write") {
  const bucketActions = ["s3:GetBucketLocation", "s3:ListBucket"];
  const objectActions = ["s3:GetObject", "s3:GetObjectVersion"];
  if (access === "read-write") {
    bucketActions.push("s3:ListBucketMultipartUploads");
    objectActions.push(
      "s3:AbortMultipartUpload",
      "s3:DeleteObject",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
    );
  }
  return {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: bucketActions.sort(), Resource: `arn:aws:s3:::${bucket}` },
      { Effect: "Allow", Action: objectActions.sort(), Resource: `arn:aws:s3:::${bucket}/*` },
    ],
  } as const;
}

function credentialsFromXml(xml: string): Omit<S3CredentialSet, "endpoint" | "region" | "bucket"> {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new S3CredentialError("upstream_invalid");
  return {
    accessKeyId: exactXmlText(xml, "AccessKeyId", 512),
    secretAccessKey: exactXmlText(xml, "SecretAccessKey", 4_096),
    sessionToken: exactXmlText(xml, "SessionToken", 16_384),
    expiresAt: exactXmlText(xml, "Expiration", 64),
  };
}

function exactXmlText(xml: string, tag: string, maximum: number): string {
  const expression = new RegExp(`<${tag}>([^<]+)</${tag}>`, "gu");
  const matches = [...xml.matchAll(expression)];
  const value = matches.length === 1 ? matches[0]?.[1] : undefined;
  if (!value || value.length > maximum || hasControlCharacter(value)) {
    throw new S3CredentialError("upstream_invalid");
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

async function boundedText(response: Response, maximum: number): Promise<string> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/u.test(length) || Number(length) > maximum)) {
    throw new S3CredentialError("upstream_invalid");
  }
  const value = await response.text();
  if (new TextEncoder().encode(value).byteLength > maximum) {
    throw new S3CredentialError("upstream_invalid");
  }
  return value;
}

async function sessionName(organizationId: string, resourceUid: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${organizationId}\0${resourceUid}`),
    ),
  );
  return `takoserver-${[...digest.slice(0, 12)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function parseWasabiNativeId(
  value: string,
): { readonly region: string; readonly bucket: string } | null {
  const match = /^wasabi:([a-z0-9-]{1,64}):(ts-[a-f0-9]{40})$/u.exec(value);
  return match?.[1] && match[2] ? { region: match[1], bucket: match[2] } : null;
}

function wasabiEndpoint(region: string): string {
  return region === "us-east-1" ? "https://s3.wasabisys.com" : `https://s3.${region}.wasabisys.com`;
}

function wasabiRoleArn(value: string): string {
  if (!/^arn:aws:iam::[0-9]{1,32}:role\/[A-Za-z0-9+=,.@_/-]{1,512}$/u.test(value)) {
    throw new TypeError("invalid Wasabi role ARN");
  }
  return value;
}

function identifier(value: string, maximum: number): string {
  if (!/^[a-z0-9][a-z0-9._:-]*$/u.test(value) || value.length > maximum) {
    throw new TypeError("invalid Wasabi identifier");
  }
  return value;
}

function secret(value: string, maximum: number): string {
  if (value.length < 3 || value.length > maximum || /\s/u.test(value)) {
    throw new TypeError("invalid Wasabi credential");
  }
  return value;
}
