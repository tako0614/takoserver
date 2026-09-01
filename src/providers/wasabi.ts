import {
  type ApplyInput,
  failed,
  PROVIDER_READBACK_API_VERSION,
  type Provider,
  type ProviderNativeAbsence,
  type ProviderNativeAbsenceUnknownReason,
  type ProviderNativeReadbackDescriptor,
  type ProviderNativeReadbackInput,
  type ProviderOffering,
  ProviderReadbackDescriptorError,
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
  readonly recoveryOfferings?: readonly ProviderOffering[];
  readonly clock?: () => Date;
  readonly fetch?: (request: Request) => Promise<Response>;
}

/** Wasabi's ordinary S3 bucket lifecycle behind the provider-neutral port. */
export function createWasabiProvider(options: WasabiProviderOptions): Provider {
  const id = options.id ?? "wasabi";
  const region = identifier(options.region, "region", 64);
  const endpoint = wasabiEndpoint(region);
  const offerings = structuredClone(options.offerings) as ProviderOffering[];
  const recoveryOfferings = structuredClone(options.recoveryOfferings ?? []) as ProviderOffering[];
  const acceptedOfferings = [...offerings, ...recoveryOfferings];
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

  const recoveryObserved = async (nativeId: string): Promise<ProviderTicket> => {
    const result = await observed(nativeId);
    // A missing deterministic object cannot prove that an earlier PUT did not
    // commit. Keep recovery retryable and never turn that ambiguity into a
    // fresh mutation.
    return result.phase === "failed" && result.failure.code === "not_found"
      ? failed("unavailable", "the recovery outcome could not be proven", true)
      : result;
  };

  return {
    id,
    offerings,
    ...(recoveryOfferings.length > 0 ? { recoveryOfferings } : {}),

    createNativeReadbackDescriptor(
      input: ProviderNativeReadbackInput,
    ): ProviderNativeReadbackDescriptor {
      if (
        !offering(acceptedOfferings, input.offering) ||
        wasabiKind(input.offering) !== "ObjectBucket"
      ) {
        throw new ProviderReadbackDescriptorError();
      }
      const native = parseNativeId(input.nativeId, region);
      if (!native) throw new ProviderReadbackDescriptorError();
      return {
        apiVersion: PROVIDER_READBACK_API_VERSION,
        provider: id,
        kind: "ObjectBucket",
        nativeId: input.nativeId,
        data: { region, bucket: native.bucket },
      };
    },

    /** HEAD the exact bucket identity; never replay a PUT or issue DELETE. */
    async verifyNativeAbsence(input: {
      offering: ProviderOffering;
      descriptor: ProviderNativeReadbackDescriptor;
    }): Promise<ProviderNativeAbsence> {
      if (
        !offering(acceptedOfferings, input.offering) ||
        wasabiKind(input.offering) !== "ObjectBucket"
      ) {
        return wasabiUnknown("unsupported", false);
      }
      const native = validateWasabiReadbackDescriptor(id, input.offering, region, input.descriptor);
      if (!native) return wasabiUnknown("malformed", false);
      const response = await call("HEAD", native.bucket);
      if (!response) return wasabiUnknown("transport", true);
      if (response.status === 404) {
        return wasabiAbsence("absent", id, input.descriptor, region);
      }
      if (response.ok) {
        return wasabiAbsence("present", id, input.descriptor, region);
      }
      if (response.status === 401 || response.status === 403) {
        return wasabiUnknown("authority_unavailable", false);
      }
      return wasabiUnknown("transport", response.status >= 500 || response.status === 429);
    },

    async apply(input: ApplyInput): Promise<ProviderTicket> {
      const available = input.operationMode === "recovery" ? acceptedOfferings : offerings;
      if (!offering(available, input.offering) || input.offering.kind !== "object_bucket") {
        return failed("invalid_spec", "this offering is not provisionable here");
      }
      if (input.region !== undefined && input.region !== region) {
        return failed("invalid_spec", "this installation does not serve the requested region");
      }
      if (input.previous) return await observed(input.previous.nativeId);

      const bucket = await derivedName(input.identity);
      const nativeId = `wasabi:${region}:${bucket}`;
      if (input.operationMode === "recovery" || input.providerHandle) {
        // Recovery has no safe PUT path: the deterministic bucket identity is
        // read back instead. A provider handle is retained for the Host's
        // saga identity, but Wasabi has no asynchronous poll endpoint.
        return await recoveryObserved(nativeId);
      }
      const body =
        region === "us-east-1"
          ? undefined
          : `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`;
      const response = await call("PUT", bucket, body);
      if (!response) return failed("unavailable", "the backend could not serve the request", true);
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

    async recoverApply(input: ApplyInput): Promise<ProviderTicket> {
      if (!offering(acceptedOfferings, input.offering) || input.offering.kind !== "object_bucket") {
        return failed("invalid_spec", "this offering is not provisionable here");
      }
      if (input.region !== undefined && input.region !== region) {
        return failed("invalid_spec", "this installation does not serve the requested region");
      }
      if (input.previous) return await observed(input.previous.nativeId);
      const bucket = await derivedName(input.identity);
      return await recoveryObserved(`wasabi:${region}:${bucket}`);
    },

    async observe(input): Promise<ProviderTicket> {
      if (!offering(acceptedOfferings, input.offering)) {
        return failed("invalid_spec", "this offering is not provisionable here");
      }
      return await observed(input.nativeId);
    },

    async delete(input): Promise<ProviderTicket> {
      if (input.operationMode === "recovery" && !input.providerHandle) {
        return failed("unavailable", "provider mutation recovery requires an opaque handle", true);
      }
      if (input.providerHandle) {
        return failed("unavailable", "Wasabi delete recovery cannot poll this handle", true);
      }
      if (!offering(acceptedOfferings, input.offering)) {
        return failed("invalid_spec", "this offering is not provisionable here");
      }
      const native = parseNativeId(input.nativeId, region);
      if (!native) return failed("not_found", "the resource does not exist");
      const response = await call("DELETE", native.bucket);
      if (!response) return failed("unavailable", "the backend could not serve the request", true);
      if (!response.ok && response.status !== 404) return classify(response.status);
      return succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} });
    },

    async recoverDelete(input): Promise<ProviderTicket> {
      if (!offering(acceptedOfferings, input.offering)) {
        return failed("invalid_spec", "this offering is not provisionable here");
      }
      if (input.providerHandle) {
        return failed("unavailable", "Wasabi delete recovery cannot poll this handle", true);
      }
      const native = parseNativeId(input.nativeId, region);
      if (!native) return failed("not_found", "the resource does not exist");
      const result = await observed(input.nativeId);
      if (result.phase === "failed" && result.failure.code === "not_found") {
        return succeeded({ nativeId: input.nativeId, observed: { deleted: true }, outputs: {} });
      }
      if (result.phase === "succeeded") {
        return failed(
          "unavailable",
          "the delete outcome is not proven; operator repair is required",
          true,
        );
      }
      return result;
    },

    async adopt(input): Promise<ProviderTicket> {
      if (input.operationMode === "recovery" && !input.providerHandle) {
        return failed("unavailable", "provider mutation recovery requires an opaque handle", true);
      }
      if (input.providerHandle) {
        return failed("unavailable", "Wasabi adopt recovery cannot poll this handle", true);
      }
      if (!offering(acceptedOfferings, input.offering)) {
        return failed("invalid_spec", "this offering is not provisionable here");
      }
      return await observed(input.nativeId);
    },

    /** Adoption recovery is read-only: HEAD the deterministic bucket identity. */
    async recoverAdopt(input): Promise<ProviderTicket> {
      if (!offering(acceptedOfferings, input.offering)) {
        return failed("invalid_spec", "this offering is not provisionable here");
      }
      if (input.providerHandle) {
        return failed("unavailable", "Wasabi adopt recovery cannot poll this handle", true);
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

function wasabiKind(offering: ProviderOffering): string {
  return offering.kind === "object_bucket" ? "ObjectBucket" : offering.form.kind;
}

function validateWasabiReadbackDescriptor(
  provider: string,
  offering: ProviderOffering,
  expectedRegion: string,
  descriptor: ProviderNativeReadbackDescriptor,
): { readonly bucket: string } | null {
  if (typeof descriptor !== "object" || descriptor === null || Array.isArray(descriptor)) {
    return null;
  }
  if (
    descriptor.apiVersion !== PROVIDER_READBACK_API_VERSION ||
    descriptor.provider !== provider ||
    descriptor.kind !== wasabiKind(offering) ||
    descriptor.kind !== "ObjectBucket" ||
    typeof descriptor.nativeId !== "string" ||
    descriptor.nativeId.length > 4_096
  ) {
    return null;
  }
  const native = parseNativeId(descriptor.nativeId, expectedRegion);
  if (!native) return null;
  const data = descriptor.data;
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    Object.keys(data).length !== 2 ||
    data.region !== expectedRegion ||
    data.bucket !== native.bucket
  ) {
    return null;
  }
  return native;
}

function wasabiAbsence(
  outcome: "absent" | "present",
  provider: string,
  descriptor: ProviderNativeReadbackDescriptor,
  region: string,
): ProviderNativeAbsence {
  return {
    outcome,
    // Do not expose descriptor.nativeId. Bucket and region are the safe,
    // provider-owned descriptor is retained only by the Host; public evidence
    // carries no native identifier or credential-bearing field.
    evidence: {
      provider,
      kind: descriptor.kind,
      state: outcome,
      region,
      endpoint: wasabiEndpoint(region),
    },
  };
}

function wasabiUnknown(
  reason: ProviderNativeAbsenceUnknownReason,
  retryable: boolean,
): ProviderNativeAbsence {
  return { outcome: "unknown", reason, retryable };
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
