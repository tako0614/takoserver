const MAX_READBACK_BYTES = 32 * 1024 * 1024;

export type CloudflareWfpClientResult<T> =
  | { readonly ok: true; readonly value: T; readonly status: number }
  | {
      readonly ok: false;
      readonly status: number;
      readonly indeterminate: boolean;
      readonly malformed?: true;
    };

export interface CloudflareWfpScriptReadback {
  readonly scriptName: string;
  readonly etag: string;
  readonly handlers: readonly string[];
  readonly settings: Readonly<Record<string, unknown>>;
  readonly secrets: readonly Readonly<Record<string, unknown>>[];
  readonly contentType: string;
  readonly content: Uint8Array;
}

export interface CloudflareWfpClientOptions {
  readonly accountId: string;
  readonly dispatchNamespace: string;
  readonly apiOrigin: string;
  readonly authorize: () => Promise<string> | string;
  readonly fetch: (request: Request) => Promise<Response>;
}

/** Credential-owning REST client for exact WfP and gateway trigger resources. */
export class CloudflareWfpClient {
  readonly accountId: string;
  readonly dispatchNamespace: string;
  readonly #origin: string;
  readonly #authorize: CloudflareWfpClientOptions["authorize"];
  readonly #fetch: CloudflareWfpClientOptions["fetch"];

  constructor(options: CloudflareWfpClientOptions) {
    this.accountId = nativeName(options.accountId, "account");
    this.dispatchNamespace = nativeName(options.dispatchNamespace, "dispatch namespace");
    this.#origin = options.apiOrigin.replace(/\/$/u, "");
    this.#authorize = options.authorize;
    this.#fetch = options.fetch;
  }

  scriptPath(scriptName: string): string {
    return `/accounts/${encodeURIComponent(this.accountId)}/workers/dispatch/namespaces/${encodeURIComponent(this.dispatchNamespace)}/scripts/${encodeURIComponent(nativeName(scriptName, "script"))}`;
  }

  async uploadScript(
    scriptName: string,
    body: FormData,
  ): Promise<CloudflareWfpClientResult<{ readonly etag?: string }>> {
    const response = await this.json("PUT", this.scriptPath(scriptName), body);
    if (!response.ok) return response;
    const result = object(response.value);
    const script = object(result?.script) ?? result;
    const id = text(script?.id);
    if (id !== undefined && id !== scriptName) return malformed(response.status);
    const etag = text(script?.etag);
    return { ok: true, status: response.status, value: { ...(etag ? { etag } : {}) } };
  }

  async readScript(
    scriptName: string,
  ): Promise<CloudflareWfpClientResult<CloudflareWfpScriptReadback>> {
    const detail = await this.json("GET", this.scriptPath(scriptName));
    if (detail.ok === false) return copyFailure(detail);
    const script = object(object(detail.value)?.script);
    const etag = text(script?.etag);
    if (!script || text(script.id) !== scriptName || !etag) return malformed(detail.status);
    const handlers = Array.isArray(script.handlers)
      ? script.handlers.filter((value): value is string => typeof value === "string")
      : [];
    if (handlers.length !== (Array.isArray(script.handlers) ? script.handlers.length : 0)) {
      return malformed(detail.status);
    }
    const content = await this.raw("GET", `${this.scriptPath(scriptName)}/content`);
    if (content.ok === false) return copyFailure(content);
    let contentBytes: Uint8Array;
    try {
      const bytes = await content.value.arrayBuffer();
      if (bytes.byteLength > MAX_READBACK_BYTES) return malformed(content.status);
      contentBytes = new Uint8Array(bytes);
    } catch {
      return malformed(content.status);
    }
    const settings = await this.json("GET", `${this.scriptPath(scriptName)}/settings`);
    if (settings.ok === false) return copyFailure(settings);
    const settingsValue = object(settings.value);
    if (!settingsValue) return malformed(settings.status);
    const secrets = await this.json("GET", `${this.scriptPath(scriptName)}/secrets`);
    if (secrets.ok === false) return copyFailure(secrets);
    if (!Array.isArray(secrets.value) || secrets.value.some((value) => !object(value))) {
      return malformed(secrets.status);
    }
    return {
      ok: true,
      status: detail.status,
      value: {
        scriptName,
        etag,
        handlers,
        settings: settingsValue,
        secrets: secrets.value as readonly Readonly<Record<string, unknown>>[],
        contentType: content.value.headers.get("content-type") ?? "",
        content: contentBytes,
      },
    };
  }

  async scriptAbsent(scriptName: string): Promise<CloudflareWfpClientResult<boolean>> {
    const read = await this.json("GET", this.scriptPath(scriptName));
    if (read.ok === false) {
      return read.status === 404 ? { ok: true, status: 404, value: true } : copyFailure(read);
    }
    return { ok: true, status: read.status, value: false };
  }

  async deleteScript(scriptName: string): Promise<CloudflareWfpClientResult<undefined>> {
    // The dispatch-script DELETE response is allowed to be an empty 2xx body.
    // Do not feed it through the JSON-envelope decoder. Cloudflare does not
    // document If-Match for this endpoint either: callers fence the mutation
    // with an authoritative GET/ETag comparison, issue DELETE once, and prove
    // an acknowledgement loss only through a later GET 404.
    const removed = await this.raw("DELETE", this.scriptPath(scriptName));
    if (removed.ok === false && removed.status !== 404) return copyFailure(removed);
    return { ok: true, status: removed.status, value: undefined };
  }

  async json(
    method: string,
    path: string,
    body?: BodyInit,
    headers?: Readonly<Record<string, string>>,
  ): Promise<CloudflareWfpClientResult<unknown>> {
    const response = await this.raw(method, path, body, headers);
    if (!response.ok) return response;
    try {
      const envelope = object(await response.value.json());
      if (envelope?.success !== true || !("result" in envelope)) {
        return malformed(response.status);
      }
      return { ok: true, status: response.status, value: envelope.result };
    } catch {
      return malformed(response.status);
    }
  }

  async raw(
    method: string,
    path: string,
    body?: BodyInit,
    headers?: Readonly<Record<string, string>>,
  ): Promise<CloudflareWfpClientResult<Response>> {
    const authorization = await this.#authorize();
    try {
      const response = await this.#fetch(
        new Request(`${this.#origin}${path}`, {
          method,
          headers: { authorization, ...headers },
          ...(body === undefined ? {} : { body }),
        }),
      );
      if (!response.ok) {
        return { ok: false, status: response.status, indeterminate: false };
      }
      return { ok: true, status: response.status, value: response };
    } catch {
      return { ok: false, status: 0, indeterminate: method !== "GET" };
    }
  }
}

function nativeName(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(value)) {
    throw new TypeError(`invalid Cloudflare WfP ${label}`);
  }
  return value;
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 ? value : undefined;
}

function malformed(status: number): CloudflareWfpClientResult<never> {
  return { ok: false, status, indeterminate: false, malformed: true };
}

function copyFailure<T>(
  result: Extract<CloudflareWfpClientResult<unknown>, { readonly ok: false }>,
): CloudflareWfpClientResult<T> {
  return {
    ok: false,
    status: result.status,
    indeterminate: result.indeterminate,
    ...(result.malformed ? { malformed: true as const } : {}),
  };
}
