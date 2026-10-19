import { CONTAINER_CONTRACT } from "../container-contract.ts";
import type { V2PrivateInputKey } from "../takoform-v2/private-inputs.ts";

export class ContainerSpecError extends Error {
  readonly code = CONTAINER_CONTRACT.errors.invalidSpec;
  readonly status = 422;
  constructor() {
    super(CONTAINER_CONTRACT.errors.invalidSpec);
  }
}

export function containerRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== "string" ||
      !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value")
    )
      return invalid();
  }
  return value as Record<string, unknown>;
}

function scalarLength(value: string) {
  let length = 0;
  for (const char of value) {
    const point = char.codePointAt(0) ?? 0;
    if (point >= 0xd800 && point <= 0xdfff) invalid();
    length++;
  }
  return length;
}

export function validateContainerSensitiveNames(
  value: unknown,
  environmentNames: readonly string[] = [],
): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) return invalid();
  const names = new Set<string>();
  for (const name of value) {
    if (
      typeof name !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,63}$/u.test(name) ||
      /^(?:CLOUDFLARE_|TAKOFORM_)/u.test(name) ||
      names.has(name) ||
      environmentNames.includes(name)
    )
      return invalid();
    names.add(name);
  }
  return Object.freeze([...names].sort());
}

export function validateContainerPrivateInputs(
  names: readonly string[],
  value: unknown,
): Readonly<Record<string, string>> {
  const required = validateContainerSensitiveNames(names);
  const supplied = containerRecord(value === undefined && required.length === 0 ? {} : value);
  const actual = Object.keys(supplied).sort();
  if (actual.length !== required.length) return invalid();
  const copied: Record<string, string> = Object.create(null);
  for (let index = 0; index < required.length; index++) {
    const name = required[index];
    if (!name || actual[index] !== name) return invalid();
    const secret = supplied[name];
    if (typeof secret !== "string" || secret.length === 0 || secret.includes("\0"))
      return invalid();
    scalarLength(secret);
    copied[name] = secret;
  }
  return copied;
}

const invalid = (): never => {
  throw new ContainerSpecError();
};

export function isContainerSecretKey(key: CryptoKey | undefined): key is CryptoKey {
  if (!(key instanceof CryptoKey)) return false;
  const algorithm = key.algorithm as { name: string; length?: number };
  return (
    key.type === "secret" &&
    !key.extractable &&
    algorithm.name === "AES-GCM" &&
    algorithm.length === 256 &&
    key.usages.includes("encrypt") &&
    key.usages.includes("decrypt")
  );
}

export function encodeContainerSecretBytes(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function decodeContainerSecretBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return fail("unavailable");
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (encode(bytes) !== value) return fail("unavailable");
  return bytes;
}

const usableKey = isContainerSecretKey;
const encode = encodeContainerSecretBytes;
const decode = decodeContainerSecretBytes;

export function encryptContainerSecretBytes(
  key: CryptoKey,
  nonce: Uint8Array<ArrayBuffer>,
  plaintext: Uint8Array<ArrayBuffer>,
  additionalData: Uint8Array<ArrayBuffer>,
): Promise<ArrayBuffer> {
  return crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData }, key, plaintext);
}

export async function decryptContainerSecretBytes(
  key: CryptoKey,
  nonce: Uint8Array<ArrayBuffer>,
  ciphertext: Uint8Array<ArrayBuffer>,
  additionalData: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData }, key, ciphertext),
  );
}

/** Copied accepted Host identity, never supplied through the application Binding. */
export interface HostedContainerSecretScope {
  readonly targetKey: string;
  readonly providerInstallationId: string;
  readonly principal: string;
  readonly space: string;
  readonly resourceUid: string;
  readonly incarnationId: string;
  readonly generation: number;
}
export interface HostedContainerSecretReference {
  readonly id: string;
}
/** Ciphertext only. The store must durably await writes/deletes and never log raw records. */
export interface HostedContainerSecretRecord {
  readonly scope: HostedContainerSecretScope;
  readonly names: readonly string[];
  readonly keyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
}
export interface HostedContainerSecretStore {
  get(id: string): Promise<HostedContainerSecretRecord | null>;
  putIfAbsent(id: string, record: HostedContainerSecretRecord): Promise<boolean>;
  delete(id: string): Promise<void>;
}
export interface HostedContainerSecretKeyring {
  readonly current: V2PrivateInputKey;
  keyForDecryption(id: string): CryptoKey | undefined;
}
export interface HostedContainerSecretsPort {
  prepare(input: {
    readonly scope: HostedContainerSecretScope;
    readonly requiredSensitiveVars: readonly string[];
    readonly privateInputs?: unknown;
    readonly environmentNames?: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<HostedContainerSecretReference | null>;
  /** Use only at native startup. Never merge these values into a durable revision configuration. */
  withEnvironment<T>(
    input: {
      readonly scope: HostedContainerSecretScope;
      readonly reference: HostedContainerSecretReference;
      readonly requiredSensitiveVars: readonly string[];
      readonly environment?: Readonly<Record<string, string>>;
      /** Must recheck the owning current native-send/grant fence synchronously. */
      readonly isCurrent: () => boolean;
      readonly signal?: AbortSignal;
    },
    work: (environment: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  revoke(reference: HostedContainerSecretReference): Promise<void>;
  /** Cancels this process's leases; retained ciphertext survives ordinary Host restarts. */
  dispose(): void;
}
export class HostedContainerSecretsError extends Error {
  constructor(readonly code: "invalid_inputs" | "unavailable" | "cancelled") {
    super(`Container secret ${code}`);
    this.name = "HostedContainerSecretsError";
  }
}
const DOMAIN = "takoserver.container-runtime-secrets@v1";
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REFERENCE = /^[a-f0-9]{64}$/u;
const SCOPE_STRINGS = [
  "targetKey",
  "providerInstallationId",
  "principal",
  "space",
  "resourceUid",
  "incarnationId",
] as const;
const fail = (code: HostedContainerSecretsError["code"]): never => {
  throw new HostedContainerSecretsError(code);
};
function sanitized(error: unknown): HostedContainerSecretsError {
  const code = error instanceof HostedContainerSecretsError ? error.code : "unavailable";
  return new HostedContainerSecretsError(
    code === "invalid_inputs" || code === "cancelled" ? code : "unavailable",
  );
}
function copyScope(value: HostedContainerSecretScope): HostedContainerSecretScope {
  const raw = containerRecord(value);
  if (
    Object.keys(raw).sort().join() !== [...SCOPE_STRINGS, "generation"].sort().join() ||
    SCOPE_STRINGS.some(
      (name) => typeof raw[name] !== "string" || !raw[name] || (raw[name] as string).includes("\0"),
    ) ||
    typeof raw.generation !== "number" ||
    !Number.isSafeInteger(raw.generation) ||
    raw.generation < 1
  )
    return fail("unavailable");
  return Object.freeze({
    targetKey: value.targetKey,
    providerInstallationId: value.providerInstallationId,
    principal: value.principal,
    space: value.space,
    resourceUid: value.resourceUid,
    incarnationId: value.incarnationId,
    generation: value.generation,
  });
}
function scopeText(scope: HostedContainerSecretScope): string {
  return JSON.stringify([DOMAIN, ...SCOPE_STRINGS.map((name) => scope[name]), scope.generation]);
}

function referenceId(value: HostedContainerSecretReference): string {
  const raw = containerRecord(value);
  if (Object.keys(raw).join() !== "id" || typeof raw.id !== "string" || !REFERENCE.test(raw.id))
    return fail("unavailable");
  return raw.id;
}
function clearEnvironment(value: Record<string, string>): void {
  for (const name of Object.keys(value)) delete value[name];
}
function cancelRead<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new HostedContainerSecretsError("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => undefined);
    if (signal.aborted) abort();
  });
}

/** Host-owned encrypted storage adapter; no default key, environment lookup, or native side effect. */
export function createHostedContainerSecrets(options: {
  readonly keyring: HostedContainerSecretKeyring;
  readonly store: HostedContainerSecretStore;
  /** Exact UTF-8 encoded secret-map budget, selected by the Host's capacity profile. */
  readonly maxSecretBytes: number;
}): HostedContainerSecretsPort {
  const current = options.keyring?.current;
  if (
    !current ||
    !KEY_ID.test(current.id) ||
    !usableKey(current.key) ||
    options.keyring.keyForDecryption(current.id) !== current.key ||
    !Number.isSafeInteger(options.maxSecretBytes) ||
    options.maxSecretBytes < 2 ||
    options.maxSecretBytes > 1_048_576 ||
    !options.store
  )
    return fail("unavailable");
  const key = current.key;
  const keyId = current.id;
  const keyForDecryption = options.keyring.keyForDecryption.bind(options.keyring);
  const store = options.store;
  const maxBytes = options.maxSecretBytes;
  const active = new Map<string, Set<AbortController>>();
  const revoked = new Set<string>();
  let closed = false;
  const assertAvailable = (signal?: AbortSignal, id?: string) => {
    if (signal?.aborted) return fail("cancelled");
    if (closed || (id !== undefined && revoked.has(id))) return fail("unavailable");
  };
  const port: HostedContainerSecretsPort = {
    async prepare(input) {
      let plaintext: ReturnType<TextEncoder["encode"]> | undefined;
      let values: Record<string, string> | undefined;
      let stored = false;
      let id: string | undefined;
      const signal = input.signal;
      try {
        assertAvailable(signal);
        const scope = copyScope(input.scope);
        const names = validateContainerSensitiveNames(
          input.requiredSensitiveVars,
          input.environmentNames,
        );
        const supplied = containerRecord(
          input.privateInputs === undefined && names.length === 0 ? {} : input.privateInputs,
        );
        let minimumBytes = 2;
        for (const [name, value] of Object.entries(supplied)) {
          if (typeof value !== "string") return fail("invalid_inputs");
          minimumBytes += name.length + value.length + 5;
          if (minimumBytes > maxBytes) return fail("invalid_inputs");
        }
        values = validateContainerPrivateInputs(names, input.privateInputs) as Record<
          string,
          string
        >;
        if (names.length === 0) return null;
        plaintext = new TextEncoder().encode(JSON.stringify(values));
        if (plaintext.byteLength > maxBytes) return fail("invalid_inputs");
        const nonce = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await encryptContainerSecretBytes(
          key,
          nonce,
          plaintext,
          new TextEncoder().encode(scopeText(scope)),
        );
        assertAvailable(signal);
        id = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        const record = Object.freeze({
          scope,
          names,
          keyId,
          nonce: encode(nonce),
          ciphertext: encode(new Uint8Array(ciphertext)),
        });
        // An unknown write is never retried against another reference here.
        stored = true;
        if (!(await store.putIfAbsent(id, record))) {
          stored = false;
          return fail("unavailable");
        }
        assertAvailable(signal);
        return Object.freeze({ id });
      } catch (error) {
        if (stored && id) {
          revoked.add(id);
          try {
            await store.delete(id);
          } catch {
            return fail("unavailable");
          }
        }
        if (error instanceof HostedContainerSecretsError) throw sanitized(error);
        return fail(error instanceof ContainerSpecError ? "invalid_inputs" : "unavailable");
      } finally {
        plaintext?.fill(0);
        if (values) clearEnvironment(values);
      }
    },
    async withEnvironment(input, work) {
      let plaintext: Uint8Array | undefined;
      const environment: Record<string, string> = Object.create(null);
      const controller = new AbortController();
      let id: string | undefined;
      const signal = input.signal;
      const isCurrent = input.isCurrent;
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        assertAvailable(signal);
        id = referenceId(input.reference);
        assertAvailable(controller.signal, id);
        const scope = copyScope(input.scope);
        const names = validateContainerSensitiveNames(input.requiredSensitiveVars);
        const publicEnvironment = containerRecord(input.environment ?? {});
        for (const [name, value] of Object.entries(publicEnvironment)) {
          if (
            !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(name) ||
            /^(?:CLOUDFLARE_|TAKOFORM_)/u.test(name) ||
            names.includes(name) ||
            typeof value !== "string" ||
            value.includes("\0")
          )
            return fail("unavailable");
          environment[name] = value;
        }
        const leases = active.get(id) ?? new Set<AbortController>();
        leases.add(controller);
        active.set(id, leases);
        if (!isCurrent()) return fail("unavailable");
        const retained = await cancelRead(store.get(id), controller.signal);
        assertAvailable(controller.signal, id);
        if (!retained || scopeText(copyScope(retained.scope)) !== scopeText(scope))
          return fail("unavailable");
        if (
          validateContainerSensitiveNames(retained.names).join() !== names.join() ||
          !KEY_ID.test(retained.keyId) ||
          typeof retained.nonce !== "string" ||
          retained.nonce.length !== 16 ||
          typeof retained.ciphertext !== "string" ||
          retained.ciphertext.length > Math.ceil(((maxBytes + 16) * 4) / 3)
        )
          return fail("unavailable");
        const decryptionKey = keyForDecryption(retained.keyId);
        if (!usableKey(decryptionKey)) return fail("unavailable");
        const nonce = decode(retained.nonce);
        const ciphertext = decode(retained.ciphertext);
        if (
          nonce.length !== 12 ||
          ciphertext.byteLength < 17 ||
          ciphertext.byteLength > maxBytes + 16
        )
          return fail("unavailable");
        plaintext = await decryptContainerSecretBytes(
          decryptionKey,
          nonce,
          ciphertext,
          new TextEncoder().encode(scopeText(scope)),
        );
        assertAvailable(controller.signal, id);
        const parsed: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plaintext),
        );
        const values = validateContainerPrivateInputs(names, parsed);
        Object.assign(environment, values);
        clearEnvironment(values as Record<string, string>);
        // Listener and lease are already installed: revocation cannot slip past decryption.
        assertAvailable(controller.signal, id);
        if (!isCurrent()) return fail("unavailable");
        const operation = Promise.resolve(work(environment, controller.signal));
        const cancellation = new Promise<never>((_, reject) => {
          const cancelled = () => reject(new HostedContainerSecretsError("cancelled"));
          controller.signal.addEventListener("abort", cancelled, { once: true });
          operation
            .finally(() => controller.signal.removeEventListener("abort", cancelled))
            .catch(() => undefined);
          if (controller.signal.aborted) cancelled();
        });
        const result = await Promise.race([operation, cancellation]);
        assertAvailable(controller.signal, id);
        return result;
      } catch (error) {
        throw sanitized(error);
      } finally {
        controller.abort();
        signal?.removeEventListener("abort", abort);
        clearEnvironment(environment);
        plaintext?.fill(0);
        if (id) {
          active.get(id)?.delete(controller);
          if (active.get(id)?.size === 0) active.delete(id);
        }
      }
    },
    async revoke(reference) {
      let id: string;
      try {
        id = referenceId(reference);
      } catch {
        return fail("unavailable");
      }
      revoked.add(id);
      for (const controller of active.get(id) ?? []) controller.abort();
      try {
        await store.delete(id);
      } catch {
        return fail("unavailable");
      }
    },
    dispose() {
      closed = true;
      for (const leases of active.values()) for (const controller of leases) controller.abort();
    },
  };
  return Object.freeze(port);
}
