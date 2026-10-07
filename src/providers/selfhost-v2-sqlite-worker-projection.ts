import { selfhostWorkerPreludeSource } from "./selfhost-worker-prelude.ts";

const NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;
const ROOT_MODULE = /^[A-Za-z0-9_$][A-Za-z0-9_$.-]{0,127}\.js$/u;

/**
 * A scoped v2 execution-copy adapter. The existing workerd SQL transport is
 * retained, while the published 0.2.0 JS argument errors become TypeError.
 * Neither generated module receives a database handle, token, or endpoint.
 * The caller must choose two application-module names absent from the bundle.
 */
export function v2SqliteWorkerProjection(input: {
  readonly originalMainModule: string;
  readonly adapterModule: string;
  readonly intrinsicModule: string;
  readonly sqliteBindingNames: readonly string[];
  readonly declaredHandlers: readonly ("fetch" | "scheduled" | "queue")[];
}): ReadonlyMap<string, Uint8Array> {
  if (
    !input.originalMainModule ||
    !ROOT_MODULE.test(input.adapterModule) ||
    !ROOT_MODULE.test(input.intrinsicModule) ||
    new Set([input.originalMainModule, input.adapterModule, input.intrinsicModule]).size !== 3 ||
    !input.sqliteBindingNames.every((name) => NAME.test(name)) ||
    new Set(input.sqliteBindingNames).size !== input.sqliteBindingNames.length ||
    !input.declaredHandlers.every((name) => ["fetch", "scheduled", "queue"].includes(name)) ||
    new Set(input.declaredHandlers).size !== input.declaredHandlers.length
  )
    throw new TypeError("invalid v2 SQLite projection");
  const importSpecifier = (name: string) => `./${name.replace(/^\.\//u, "")}`;
  const handlers = input.declaredHandlers
    .map(
      (name) =>
        `${JSON.stringify(name)}(...args) { return invoke(${JSON.stringify(name)}, args); }`,
    )
    .join(",\n");
  const source = `import {
  SafeApply as apply, SafeArrayIsArray as isArray, SafeAtob as atobSafe,
  SafeBtoa as btoaSafe, SafeMathAbs as abs, SafeNumberIsFinite as finite, SafeNumberMaxSafeInteger as MAX_SAFE,
  SafeObjectCreate as create, SafeObjectGetOwnPropertyDescriptor as descriptor,
  SafeObjectGetPrototypeOf as prototype, SafeObjectHasOwn as hasOwn, SafeObjectKeys as keys,
  SafeObjectPrototype as OBJECT_PROTO, SafeObject as SafeObject, SafeOwnKeys as ownKeys,
  SafeReflectGet as reflectGet, SafeReflect as SafeReflect,
  SafeTypeError as TypeErrorSafe, SafeTextEncoder as Encoder,
  SafeTextDecoder as Decoder, SafeTextEncoderEncode as encode,
  SafeTextDecoderDecode as decode,
} from ${JSON.stringify(importSpecifier(input.intrinsicModule))};
import original from ${JSON.stringify(importSpecifier(input.originalMainModule))};
const sqliteNames = ${JSON.stringify(input.sqliteBindingNames)};
const encoder = new Encoder();
const decoder = new Decoder("utf-8", { fatal: true });
function typeError() { throw new TypeErrorSafe("invalid SQLiteDatabase argument"); }
function own(value, name) {
  const found = apply(descriptor, SafeObject, [value, name]);
  if (!found || !("value" in found)) typeError();
  return found.value;
}
function plain(value) {
  if (!value || typeof value !== "object" || isArray(value)) return false;
  const p = apply(prototype, SafeObject, [value]);
  return p === OBJECT_PROTO || p === null;
}
function fields(value, allowed, required) {
  if (!plain(value)) typeError();
  const names = apply(keys, SafeObject, [value]);
  if (apply(ownKeys, SafeReflect, [value]).length !== names.length) typeError();
  for (const name of names) {
    let found = false;
    for (const allowedName of allowed) if (name === allowedName) found = true;
    if (!found) typeError();
  }
  for (const name of required) if (!apply(hasOwn, SafeObject, [value, name])) typeError();
  for (const name of names) own(value, name);
}
function dense(value, max) {
  if (!isArray(value) || value.length > max) typeError();
  const copied = [];
  for (let i = 0; i < value.length; i++) copied.push(own(value, String(i)));
  if (apply(ownKeys, SafeReflect, [value]).length !== value.length + 1) typeError();
  return copied;
}
function sqlValue(value) {
  if (value === null) return value;
  if (typeof value === "number") {
    if (!finite(value) || abs(value) > MAX_SAFE) typeError();
    return value;
  }
  if (typeof value === "string") {
    const bytes = apply(encode, encoder, [value]);
    if (bytes.length > 1000000 || apply(decode, decoder, [bytes]) !== value) typeError();
    return value;
  }
  fields(value, ["encoding", "data"], ["encoding", "data"]);
  const encoding = own(value, "encoding");
  const data = own(value, "data");
  if (encoding !== "base64" || typeof data !== "string" || data.length > 1333336) typeError();
  let raw;
  try { raw = atobSafe(data); } catch { typeError(); }
  if (raw.length > 1000000 || btoaSafe(raw) !== data) typeError();
  return { encoding, data };
}
function params(value) {
  const values = dense(value, 100);
  const normalized = [];
  for (const item of values) normalized.push(sqlValue(item));
  return normalized;
}
function statement(sql, values) {
  if (typeof sql !== "string") typeError();
  // SQL syntax/byte-limit failures are sql_error, not shape errors.
  return [sql, values === undefined ? undefined : params(values)];
}
function facade(base) {
  const projected = create(null);
  projected.execute = async (...args) => {
    if (args.length > 2) typeError();
    const [s, p] = statement(args[0], args[1]);
    return await apply(base.execute, base, [s, p]);
  };
  projected.query = async (...args) => {
    if (args.length > 2) typeError();
    const [s, p] = statement(args[0], args[1]);
    return await apply(base.query, base, [s, p]);
  };
  projected.transaction = async (...args) => {
    if (args.length > 1) typeError();
    const values = dense(args[0], 100);
    if (values.length === 0) typeError();
    const normalized = [];
    for (const value of values) {
      fields(value, ["sql", "params"], ["sql"]);
      const [sql, p] = statement(own(value, "sql"), apply(hasOwn, SafeObject, [value, "params"]) ? own(value, "params") : undefined);
      normalized.push(p === undefined ? { sql } : { sql, params: p });
    }
    return await apply(base.transaction, base, [normalized]);
  };
  return projected;
}
function projectEnv(env) {
  const projected = create(null);
  for (const name of apply(keys, SafeObject, [env])) projected[name] = env[name];
  for (const name of sqliteNames) {
    if (!apply(hasOwn, SafeObject, [projected, name])) typeError();
    projected[name] = facade(projected[name]);
  }
  return projected;
}
function invoke(handler, args) {
  if (!plain(original)) typeError();
  const method = apply(reflectGet, SafeReflect, [original, handler]);
  if (typeof method !== "function") typeError();
  args[1] = projectEnv(args[1]);
  return apply(method, original, args);
}
export default { ${handlers} };
`;
  const encoder = new TextEncoder();
  return new Map([
    [input.intrinsicModule, encoder.encode(selfhostWorkerPreludeSource())],
    [input.adapterModule, encoder.encode(source)],
  ]);
}
