import {
  type ApplyInput,
  failed,
  type Provider,
  type ProviderOffering,
  type ProviderTicket,
  succeeded,
} from "../provider-port.ts";
import { signAwsV4Request } from "./aws-sigv4.ts";

export interface WasabiProviderOptions {
  readonly id?: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly offerings: readonly ProviderOffering[];
  readonly clock?: () => Date;
  readonly fetch?: (request: Request) => Promise<Response>;
}

/** Wasabi's ordinary S3 bucket lifecycle behind the provider-neutral port. */
export function createWasabiProvider(options: WasabiProviderOptions): Provider {
  const id = options.id ?? "wasabi";
  const region = identifier(options.region, "region", 64);
  const endpoint = wasabiEndpoint(region);
  const offerings = structuredClone(options.offerings) as ProviderOffering[];
  const clock = options.clock ?? (() => new Date());
  const send = options.fetch ?? ((request: Request) => fetch(request));
  const credentials = {
    accessKeyId: secret(options.accessKeyId, "access key id", 512),
    secretAccessKey: secret(options.secretAccessKey, "secret access key", 4_096),
  };

  const call = async (
    method: "PUT" | "HEAD" | "DELETE",
    bucket: string,
    body?: string,
  ): Promise<Response | null> => {
    try {
      const request = await signAwsV4Request({
        method,
        url: `${endpoint}/${bucket}`,
        region,
        service: "s3",
        credentials,
        ...(body === undefined ? {} : { headers: { "content-type": "application/xml" }, body }),
        now: clock(),
      });
      return await send(request);
    } catch {
      return null;
    }
  };

  const observed = async (nativeId: string): Promise<ProviderTicket> => {
    const native = parseNativeId(nativeId, region);
    if (!native) return failed("not_found", "the resource does not exist");
    const response = await call("HEAD", native.bucket);
    if (!response) return failed("unavailable", "the backend could not serve the request", true);
    if (!response.ok) return classify(response.status);
    return succeeded({
      nativeId,
      observed: { name: native.bucket, region },
      outputs: {
        protocol: "s3",
        endpoint,
        region,
        bucketName: native.bucket,
      },
    });
  };

  return {
    id,
    offerings,

    async apply(input: ApplyInput): Promise<ProviderTicket> {
      if (!offering(offerings, input.offering) || input.offering.kind !== "object_bucket") {
        return failed("invalid_spec", "this offering is not provisionable here");
      }
      if (input.region !== undefined && input.region !== region) {
        return failed("invalid_spec", "this installation does not serve the requested region");
      }
      if (input.previous) return await observed(input.previous.nativeId);

      const bucket = await derivedName(input.identity);
      const body =
        region === "us-east-1"
          ? undefined
          : `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`;
      const response = await call("PUT", bucket, body);
      if (!response) return failed("unavailable", "the backend could not serve the request", true);
      const nativeId = `wasabi:${region}:${bucket}`;
      if (response.status === 409) {
        // A retry after the create committed but its response was lost sees the
        // deterministic name already present. Re-read rather than making a
        // second bucket or falsely reporting the operation as failed.
        return await observed(nativeId);
      }
      if (!response.ok) return classify(response.status);
      return succeeded({
        nativeId,
        observed: { name: bucket, region },
        outputs: { protocol: "s3", endpoint, region, bucketName: bucket },
      });
    },

    async observe(input): Promise<ProviderTicket> {
      if (!offering(offerings, input.offering)) {
        return failed("invalid_spec", "this offering is not provisionable here");
      }
      return await observed(input.nativeId);
    },

    async delete(input): Promise<ProviderTicket> {
      if (!offering(offerings, input.offering)) {
        return failed("invalid_spec", "this offering is not provisionable here");
      }
      const native = parseNativeId(input.nativeId, region);
      if (!native) return failed("not_found", "the resource does not exist");
      const response = await call("DELETE", native.bucket);
      if (!response) return failed("unavailable", "the backend could not serve the request", true);
      if (!response.ok && response.status !== 404) return classify(response.status);
      return succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} });
    },

    async adopt(input): Promise<ProviderTicket> {
      if (!offering(offerings, input.offering)) {
        return failed("invalid_spec", "this offering is not provisionable here");
      }
      return await observed(input.nativeId);
    },
  };
}

function offering(all: readonly ProviderOffering[], candidate: ProviderOffering): boolean {
  return all.some(
    (item) =>
      item.id === candidate.id &&
      item.form.apiVersion === candidate.form.apiVersion &&
      item.form.kind === candidate.form.kind &&
      item.form.definitionVersion === candidate.form.definitionVersion &&
      item.form.schemaDigest === candidate.form.schemaDigest,
  );
}

function wasabiEndpoint(region: string): string {
  return region === "us-east-1" ? "https://s3.wasabisys.com" : `https://s3.${region}.wasabisys.com`;
}

async function derivedName(identity: {
  readonly tenantRef: string;
  readonly space: string;
  readonly name: string;
}): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${identity.tenantRef}\0${identity.space}\0${identity.name}`),
    ),
  );
  return `ts-${[...digest.slice(0, 20)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function parseNativeId(value: string, expectedRegion: string): { readonly bucket: string } | null {
  const match = /^wasabi:([a-z0-9-]+):(ts-[a-f0-9]{40})$/u.exec(value);
  return match?.[1] === expectedRegion && match[2] ? { bucket: match[2] } : null;
}

function classify(status: number): ProviderTicket {
  if (status === 400 || status === 422) {
    return failed("invalid_spec", "the backend rejected the request");
  }
  if (status === 401 || status === 403) return failed("denied", "the credential was refused");
  if (status === 404) return failed("not_found", "the resource does not exist");
  if (status === 409) return failed("conflict", "the resource already exists");
  if (status === 429) return failed("quota", "the backend is rate limiting", true);
  return failed("unavailable", "the backend could not serve the request", status >= 500);
}

function identifier(value: string, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || !/^[a-z0-9][a-z0-9-]*$/u.test(value)) {
    throw new TypeError(`invalid Wasabi ${field}`);
  }
  return value;
}

function secret(value: string, field: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > maximum ||
    /\s/u.test(value)
  ) {
    throw new TypeError(`invalid Wasabi ${field}`);
  }
  return value;
}
