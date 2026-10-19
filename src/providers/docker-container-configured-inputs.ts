import { CONTAINER_CONTRACT } from "../container-contract.ts";
import { canonicalJson } from "../json.ts";
import type { Sql } from "../ports.ts";
import {
  readV2ConfiguredPrivateInputs,
  type V2ConfiguredPrivateInputIdentity,
  type V2ConfiguredPrivateInputs,
} from "../takoform-v2/configured-private-inputs.ts";
import {
  isContainerHealthPath,
  isContainerImage,
  scalarStringWithin,
} from "../takoform-v2/forms/container.ts";
import type { V2PrivateInputMap } from "../takoform-v2/private-inputs.ts";
import type { V2Execution, V2Form } from "../takoform-v2/types.ts";
import {
  type HostedContainerSecretKeyring as ContainerSecretKeyring,
  ContainerSpecError,
  containerRecord,
  decodeContainerSecretBytes,
  decryptContainerSecretBytes,
  encodeContainerSecretBytes as encode,
  encryptContainerSecretBytes,
  isContainerSecretKey as usable,
  validateContainerSensitiveNames as validateLegacySensitiveNames,
  validateContainerPrivateInputs as validateValues,
} from "./container-secret-codec.ts";
import type { createDockerContainerCoreOwner } from "./docker-container-core-owner.ts";
import type { DockerContainerCreateRecord } from "./docker-container-create-custody.ts";

type Hooks = NonNullable<V2Form["privateInputs"]>;
type CreateInput = Parameters<NonNullable<Hooks["prepareCreate"]>>[0];
type Source = V2ConfiguredPrivateInputIdentity & {
  readonly operationId: string;
  readonly generation: number;
  readonly names: readonly string[];
};

const FORM = "https://edge.forms.takoform.com/forms/Container/0.2.0/";

const DOMAIN = "takoserver.container-configured-inputs@v1";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const ENCODER = new TextEncoder();

function unavailable(): never {
  throw new Error("Container configured inputs unavailable");
}

function token(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    ![...value].some((char) => {
      const point = char.codePointAt(0) ?? 0;
      return point < 32 || point === 127 || (point >= 0xd800 && point <= 0xdfff);
    })
  );
}

function identityCopy(value: V2ConfiguredPrivateInputIdentity): V2ConfiguredPrivateInputIdentity {
  const { principal, space, name, form, resourceUid } = value;
  if (![principal, space, name, resourceUid].every(token) || form !== FORM) unavailable();
  return Object.freeze({ principal, space, name, form, resourceUid });
}

function sealedCopy(value: V2ConfiguredPrivateInputs): V2ConfiguredPrivateInputs {
  const raw = containerRecord(value);
  if (
    Object.keys(raw).sort().join() !== "ciphertext,keyId,nonce" ||
    typeof raw.keyId !== "string" ||
    !KEY_ID.test(raw.keyId) ||
    typeof raw.nonce !== "string" ||
    typeof raw.ciphertext !== "string"
  )
    unavailable();
  return Object.freeze({ keyId: raw.keyId, nonce: raw.nonce, ciphertext: raw.ciphertext });
}

export function validateDockerContainerSensitiveNames(
  value: unknown,
  environmentNames: readonly string[] = [],
): readonly string[] {
  return validateLegacySensitiveNames(value, environmentNames);
}

// This consumer is a source candidate for the fixed full-scope Form contract.
// It does not replace the currently adopted zero-only public Form validator.
function parseContainerSpec(value: unknown, privateInputs?: unknown) {
  const raw = containerRecord(value);
  const fields = CONTAINER_CONTRACT.fields;
  const allowed = Object.values(fields);
  if (
    Object.keys(raw).some((key) => !allowed.includes(key as (typeof allowed)[number])) ||
    ![fields.image, fields.httpPort, fields.healthPath, fields.workloadRevision].every((key) =>
      Object.hasOwn(raw, key),
    ) ||
    !isContainerImage(raw.image) ||
    !isContainerHealthPath(raw.healthPath) ||
    typeof raw.httpPort !== "number" ||
    !Number.isInteger(raw.httpPort) ||
    raw.httpPort < 1 ||
    raw.httpPort > 65535 ||
    typeof raw.workloadRevision !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(raw.workloadRevision)
  )
    throw new ContainerSpecError();
  const environment = containerRecord(
    Object.hasOwn(raw, fields.environment) ? raw.environment : {},
  );
  if (Object.keys(environment).length > 64) throw new ContainerSpecError();
  for (const [name, item] of Object.entries(environment)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      /^(CLOUDFLARE_|TAKOFORM_)/.test(name) ||
      !scalarStringWithin(item, 4096) ||
      item.includes("\0")
    )
      throw new ContainerSpecError();
  }
  const requiredSensitiveVars = validateDockerContainerSensitiveNames(
    Object.hasOwn(raw, fields.requiredSensitiveVars) ? raw.requiredSensitiveVars : [],
    Object.keys(environment),
  );
  if (Object.hasOwn(raw, fields.outboundInternet) && typeof raw.outboundInternet !== "boolean")
    throw new ContainerSpecError();
  if (privateInputs !== undefined)
    validateDockerContainerPrivateInputs(requiredSensitiveVars, privateInputs);
  return Object.freeze({ requiredSensitiveVars });
}

export function validateDockerContainerPrivateInputs(
  names: readonly string[],
  value: unknown,
): V2PrivateInputMap {
  const copied = validateValues(validateDockerContainerSensitiveNames(names), value);
  let bytes = 0;
  for (const secret of Object.values(copied)) {
    if (!scalarStringWithin(secret, 16384)) throw new ContainerSpecError();
    bytes += ENCODER.encode(secret).byteLength;
  }
  if (bytes > 65536) throw new ContainerSpecError();
  return copied;
}

function decode(value: string, maxBytes: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length > Math.ceil((maxBytes * 4) / 3)) unavailable();
  const bytes = decodeContainerSecretBytes(value);
  if (bytes.length > maxBytes) unavailable();
  return bytes;
}

function clear(values: V2PrivateInputMap | undefined): void {
  if (values)
    for (const name of Object.keys(values)) delete (values as Record<string, string>)[name];
}

export interface DockerContainerConfiguredInputs {
  readonly prepareCreate: NonNullable<Hooks["prepareCreate"]>;
  readonly prepareUpdate: NonNullable<Hooks["prepareUpdate"]>;
  withAcceptedInputs(
    input: { readonly execution: V2Execution; readonly record: DockerContainerCreateRecord },
    work: (
      values: V2PrivateInputMap,
      signal: AbortSignal,
      assertCurrent: () => Promise<void>,
    ) => Promise<void>,
  ): Promise<void>;
}

export function createDockerContainerConfiguredInputs(options: {
  readonly sql: Sql;
  readonly selection: {
    readonly targetKey: string;
    readonly providerInstallationId: string;
    readonly backendId: string;
  };
  readonly keyring: ContainerSecretKeyring;
  readonly owner: ReturnType<typeof createDockerContainerCoreOwner>;
  readonly maxSecretBytes: number;
}): DockerContainerConfiguredInputs {
  const originalOwner = options.owner;
  originalOwner.acceptance.assertSql(options.sql);
  const withAuthority = originalOwner.owner.withAuthority.bind(originalOwner.owner);
  const selection = Object.freeze({ ...options.selection });
  const currentKey = Object.freeze({ ...options.keyring.current });
  if (
    !options.sql ||
    typeof options.sql.query !== "function" ||
    Object.keys(selection).sort().join() !== "backendId,providerInstallationId,targetKey" ||
    !Object.values(selection).every(token) ||
    !KEY_ID.test(currentKey.id ?? "") ||
    !usable(currentKey.key) ||
    options.keyring.keyForDecryption(currentKey.id) !== currentKey.key ||
    !Number.isSafeInteger(options.maxSecretBytes) ||
    options.maxSecretBytes < 2 ||
    options.maxSecretBytes > 1_048_576
  )
    unavailable();
  const sql: Sql = Object.freeze({
    query: options.sql.query.bind(options.sql),
    run: options.sql.run.bind(options.sql),
    batch: options.sql.batch.bind(options.sql),
  });
  const keyForDecryption = options.keyring.keyForDecryption.bind(options.keyring);
  const maxBytes = options.maxSecretBytes;
  function aad(source: Source): ReturnType<TextEncoder["encode"]> {
    return ENCODER.encode(
      canonicalJson([
        DOMAIN,
        selection.targetKey,
        selection.providerInstallationId,
        selection.backendId,
        source.principal,
        source.space,
        source.name,
        source.form,
        source.resourceUid,
        source.operationId,
        source.generation,
        source.names,
      ]),
    );
  }
  async function readCreate(identity: V2ConfiguredPrivateInputIdentity): Promise<Source> {
    const rows = await sql.query(
      `SELECT source.id AS create_id, source.accepted_spec_json AS create_spec,
      source.private_inputs_present AS create_private
      FROM tf_v2_resources resource JOIN tf_v2_operations source ON source.resource_uid = resource.uid
      WHERE resource.uid = ? AND resource.principal = ? AND resource.space = ? AND resource.name = ?
        AND resource.form_url = ? AND resource.backend_id = ? AND resource.target_key = ?
        AND resource.deleted_at IS NULL AND source.action = 'create' AND source.generation = 1
        AND source.principal = resource.principal AND source.backend_id = resource.backend_id
        AND source.target_key = resource.target_key LIMIT 2`,
      [
        identity.resourceUid,
        identity.principal,
        identity.space,
        identity.name,
        identity.form,
        selection.backendId,
        selection.targetKey,
      ],
    );
    const row = rows[0];
    if (rows.length !== 1 || !row || !token(row.create_id) || typeof row.create_spec !== "string")
      unavailable();
    const parsed = parseContainerSpec(JSON.parse(row.create_spec), undefined);
    if (parsed.requiredSensitiveVars.length > 0 && row.create_private !== 1) unavailable();
    return Object.freeze({
      ...identity,
      operationId: row.create_id,
      generation: 1,
      names: parsed.requiredSensitiveVars,
    });
  }
  async function latestSource(
    identity: V2ConfiguredPrivateInputIdentity,
    upperGeneration: number,
  ): Promise<Source> {
    if (!Number.isSafeInteger(upperGeneration) || upperGeneration < 1) unavailable();
    const created = await readCreate(identity);
    if (upperGeneration === 1) return created;
    const rows = await sql.query(
      `SELECT op.id AS source_id, op.generation AS source_generation,
        op.accepted_spec_json AS source_spec
       FROM tf_v2_resources resource JOIN tf_v2_operations op ON op.resource_uid = resource.uid
       JOIN tf_v2_operation_configured_private_inputs material ON material.operation_id = op.id
       WHERE resource.uid = ? AND resource.principal = ? AND resource.space = ? AND resource.name = ?
         AND resource.form_url = ? AND resource.backend_id = ? AND resource.target_key = ?
         AND resource.deleted_at IS NULL AND op.principal = resource.principal
         AND op.backend_id = resource.backend_id AND op.target_key = resource.target_key
         AND op.action = 'update' AND op.private_inputs_present = 1
         AND op.generation = material.generation AND op.generation <= ?
       ORDER BY op.generation DESC LIMIT 2`,
      [
        identity.resourceUid,
        identity.principal,
        identity.space,
        identity.name,
        identity.form,
        selection.backendId,
        selection.targetKey,
        upperGeneration,
      ],
    );
    if (rows.length === 0) return created;
    const row = rows[0];
    if (
      !row ||
      !token(row.source_id) ||
      !Number.isSafeInteger(row.source_generation) ||
      (row.source_generation as number) < 2 ||
      typeof row.source_spec !== "string"
    )
      unavailable();
    const parsed = parseContainerSpec(JSON.parse(row.source_spec), undefined);
    return Object.freeze({
      ...identity,
      operationId: row.source_id,
      generation: row.source_generation as number,
      names: parsed.requiredSensitiveVars,
    });
  }

  async function readSourceMaterial(source: Source): Promise<V2ConfiguredPrivateInputs | null> {
    return readV2ConfiguredPrivateInputs(
      sql,
      source,
      source.generation === 1
        ? undefined
        : { operationId: source.operationId, generation: source.generation },
    );
  }

  async function seal(
    source: Source,
    values: V2PrivateInputMap,
  ): Promise<V2ConfiguredPrivateInputs> {
    const plaintext = ENCODER.encode(canonicalJson(values));
    if (plaintext.length > maxBytes) {
      plaintext.fill(0);
      throw new ContainerSpecError();
    }
    const nonce = crypto.getRandomValues(new Uint8Array(12)),
      additionalData = aad(source);
    try {
      const ciphertext = await encryptContainerSecretBytes(
        currentKey.key,
        nonce,
        plaintext,
        additionalData,
      );
      return Object.freeze({
        keyId: currentKey.id,
        nonce: encode(nonce),
        ciphertext: encode(new Uint8Array(ciphertext)),
      });
    } catch {
      unavailable();
    } finally {
      plaintext.fill(0);
      additionalData.fill(0);
    }
  }

  async function open(
    source: Source,
    value: V2ConfiguredPrivateInputs,
  ): Promise<V2PrivateInputMap> {
    const sealed = sealedCopy(value);
    const key = keyForDecryption(sealed.keyId);
    if (!usable(key)) unavailable();
    const nonce = decode(sealed.nonce, 12),
      ciphertext = decode(sealed.ciphertext, maxBytes + 16);
    if (nonce.length !== 12 || ciphertext.length < 18) unavailable();
    const additionalData = aad(source);
    let plaintext: Uint8Array | undefined;
    try {
      plaintext = await decryptContainerSecretBytes(key, nonce, ciphertext, additionalData);
      if (plaintext.length > maxBytes) unavailable();
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plaintext),
      );
      return validateDockerContainerPrivateInputs(source.names, value);
    } finally {
      plaintext?.fill(0);
      additionalData.fill(0);
    }
  }
  return Object.freeze({
    async prepareCreate(input: CreateInput): Promise<V2ConfiguredPrivateInputs | null> {
      const identity = identityCopy(input);
      const parsed = parseContainerSpec(input.spec, input.privateInputs);
      const values = validateDockerContainerPrivateInputs(
        parsed.requiredSensitiveVars,
        input.privateInputs,
      );
      if (input.generation !== 1 || !token(input.operationId)) unavailable();
      if (parsed.requiredSensitiveVars.length === 0) return null;
      const source = Object.freeze({
        ...identity,
        operationId: input.operationId,
        generation: 1,
        names: parsed.requiredSensitiveVars,
      });
      const plaintext = ENCODER.encode(canonicalJson(values));
      if (plaintext.length > maxBytes) {
        plaintext.fill(0);
        throw new ContainerSpecError();
      }
      const nonce = crypto.getRandomValues(new Uint8Array(12)),
        additionalData = aad(source);
      try {
        const ciphertext = await encryptContainerSecretBytes(
          currentKey.key,
          nonce,
          plaintext,
          additionalData,
        );
        return Object.freeze({
          keyId: currentKey.id,
          nonce: encode(nonce),
          ciphertext: encode(new Uint8Array(ciphertext)),
        });
      } catch {
        unavailable();
      } finally {
        plaintext.fill(0);
        additionalData.fill(0);
      }
    },
    async prepareUpdate(input: Parameters<NonNullable<Hooks["prepareUpdate"]>>[0]) {
      const identity = identityCopy(input);
      const previous = parseContainerSpec(input.previousSpec, undefined);
      const next = parseContainerSpec(input.spec, input.privateInputs);
      if (
        !token(input.operationId) ||
        !Number.isSafeInteger(input.generation) ||
        input.generation < 2
      )
        unavailable();
      if (input.privateInputs !== undefined) {
        const proposed = Object.freeze(
          validateDockerContainerPrivateInputs(next.requiredSensitiveVars, input.privateInputs),
        );
        if (next.requiredSensitiveVars.length === 0) return;
        return seal(
          Object.freeze({
            ...identity,
            operationId: input.operationId,
            generation: input.generation,
            names: next.requiredSensitiveVars,
          }),
          proposed,
        );
      }
      if (next.requiredSensitiveVars.some((name) => !previous.requiredSensitiveVars.includes(name)))
        throw new ContainerSpecError();
      if (next.requiredSensitiveVars.length === 0) return;
      const candidate = input.configured === null ? null : sealedCopy(input.configured);
      const source = await latestSource(identity, input.generation - 1);
      const retainedCreate = await readV2ConfiguredPrivateInputs(sql, identity);
      if (
        (candidate === null) !== (retainedCreate === null) ||
        (candidate !== null &&
          retainedCreate !== null &&
          canonicalJson(sealedCopy(retainedCreate)) !== canonicalJson(candidate))
      )
        unavailable();
      if (next.requiredSensitiveVars.some((name) => !source.names.includes(name))) unavailable();
      const material = await readSourceMaterial(source);
      if (!material) unavailable();
      await open(source, material);
    },
    async withAcceptedInputs(
      input: Parameters<DockerContainerConfiguredInputs["withAcceptedInputs"]>[0],
      work: Parameters<DockerContainerConfiguredInputs["withAcceptedInputs"]>[1],
    ) {
      try {
        // Only the original Core callback supplies execution. Data cloning grants nothing.
        const publicExecution = { ...input.execution };
        delete publicExecution.privateInputs;
        const execution = Object.freeze(structuredClone(publicExecution));
        const copied = structuredClone(input.record);
        const record: DockerContainerCreateRecord = Object.freeze({
          ...copied,
          intent: Object.freeze({
            ...copied.intent,
            policy: Object.freeze({ ...copied.intent.policy }),
            requiredSecretNames: Object.freeze([...copied.intent.requiredSecretNames]),
          }),
        });
        const identity = identityCopy(execution);
        const parsed = parseContainerSpec(execution.spec);
        if (
          typeof work !== "function" ||
          execution.form !== FORM ||
          execution.targetKey !== selection.targetKey ||
          execution.backendId !== selection.backendId ||
          ![execution.operationId, execution.leaseToken, execution.backendKey].every(token) ||
          !Number.isSafeInteger(execution.generation) ||
          execution.generation < 1 ||
          !["create", "update"].includes(execution.action) ||
          record.intent.installationId !== selection.providerInstallationId ||
          record.intent.resourceUid !== execution.resourceUid ||
          record.intent.policy.generation !== execution.generation ||
          !token(record.intent.incarnationId) ||
          canonicalJson(
            validateDockerContainerSensitiveNames(record.intent.requiredSecretNames),
          ) !== canonicalJson(parsed.requiredSensitiveVars)
        )
          unavailable();
        await withAuthority(record, "reconcile", async (held) => {
          const controller = new AbortController();
          let values: V2PrivateInputMap | undefined;
          const revocation = held.revocation;
          const current = held.stillCurrent.bind(held);
          if (!(revocation instanceof AbortSignal)) unavailable();
          const revoke = () => {
            controller.abort();
            clear(values);
          };
          revocation.addEventListener("abort", revoke, { once: true });
          const local = () => {
            if (controller.signal.aborted || revocation.aborted) unavailable();
          };
          const assertCurrent = async () => {
            local();
            if (!(await current())) unavailable();
            local();
            const rows = await sql.query(
              `SELECT op.accepted_spec_json FROM tf_v2_operations op
            JOIN tf_v2_resources resource ON resource.uid = op.resource_uid
            WHERE op.id = ? AND op.resource_uid = ? AND op.principal = ? AND op.action = ?
              AND op.generation = ? AND op.backend_id = ? AND op.target_key = ? AND op.backend_key = ?
              AND op.lease_token = ? AND op.lease_until_ms > (CAST(strftime('%s','now') AS INTEGER) + 1) * 1000
              AND op.status = 'reconciling' AND op.effect = 'unknown' AND op.dispatch_possible = 1
              AND resource.principal = op.principal AND resource.form_url = ? AND resource.space = ?
              AND resource.name = ? AND resource.backend_id = op.backend_id AND resource.target_key = op.target_key
              AND resource.generation = op.generation AND resource.last_operation = op.id AND resource.busy_operation = op.id
              AND resource.phase = 'pending' AND resource.deleted_at IS NULL AND resource.spec_json = op.accepted_spec_json LIMIT 2`,
              [
                execution.operationId,
                execution.resourceUid,
                execution.principal,
                execution.action,
                execution.generation,
                execution.backendId,
                execution.targetKey,
                execution.backendKey,
                execution.leaseToken,
                execution.form,
                execution.space,
                execution.name,
              ],
            );
            local();
            if (
              rows.length !== 1 ||
              typeof rows[0]?.accepted_spec_json !== "string" ||
              canonicalJson(JSON.parse(rows[0].accepted_spec_json)) !==
                canonicalJson(execution.spec)
            )
              unavailable();
            if (!(await current())) unavailable();
            local();
          };
          try {
            await assertCurrent();
            const created = await readCreate(identity);
            await assertCurrent();
            if (
              execution.action === "create" &&
              (execution.operationId !== created.operationId ||
                execution.generation !== 1 ||
                canonicalJson(created.names) !== canonicalJson(parsed.requiredSensitiveVars))
            )
              unavailable();
            const source = await latestSource(identity, execution.generation);
            if (parsed.requiredSensitiveVars.some((name) => !source.names.includes(name)))
              unavailable();
            const retained = await readSourceMaterial(source);
            await assertCurrent();
            if (parsed.requiredSensitiveVars.length === 0) {
              values = Object.create(null) as Record<string, string>;
            } else {
              if (!retained) unavailable();
              const opened = await open(source, retained);
              try {
                const projected = Object.create(null) as Record<string, string>;
                for (const name of parsed.requiredSensitiveVars) {
                  const value = opened[name];
                  if (typeof value !== "string") unavailable();
                  projected[name] = value;
                }
                values = projected;
              } finally {
                clear(opened);
              }
            }
            await assertCurrent();
            local();
            await work(values, controller.signal, assertCurrent);
            await assertCurrent();
          } finally {
            revoke();
            revocation.removeEventListener("abort", revoke);
          }
        });
      } catch {
        unavailable();
      }
    },
  });
}

export { parseContainerSpec as validateDockerContainerSpec };
