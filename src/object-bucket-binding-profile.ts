/** Exact owning Forms; these declarations do not register Host support. */
export const OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL =
  "https://edge.forms.takoform.com/forms/ObjectBucket/0.2.0/" as const;
export const OBJECT_BUCKET_EOF_COUNTED_FORM_URL =
  "https://edge.forms.takoform.com/forms/ObjectBucket/0.3.0/" as const;

export type ObjectBucketBindingFormUrl =
  | typeof OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL
  | typeof OBJECT_BUCKET_EOF_COUNTED_FORM_URL;
export type ObjectBucketBindingProfile = "known-length" | "eof-counted";

/** Value projection only. A valid tuple is not accepted-reference authority. */
export interface ObjectBucketBindingForm {
  readonly publicName: string;
  readonly resourceUid: string;
  readonly formUrl: ObjectBucketBindingFormUrl;
}

/** Select semantics from an exact Form URL, never from kind or a caller flag. */
export function selectObjectBucketBindingProfile(formUrl: unknown): ObjectBucketBindingProfile {
  switch (formUrl) {
    case OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL:
      return "known-length";
    case OBJECT_BUCKET_EOF_COUNTED_FORM_URL:
      return "eof-counted";
    default:
      throw new TypeError("unsupported ObjectBucket Binding Form");
  }
}

/**
 * Snapshot a bounded, dense own-data projection without invoking getters.
 * The trusted caller must separately prove the original accepted SQL graph.
 */
export function snapshotObjectBucketBindingForms(
  input: unknown,
): readonly ObjectBucketBindingForm[] {
  if (!Array.isArray(input)) invalid();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
  const length: unknown = lengthDescriptor?.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 64)
    invalid();
  if (Reflect.ownKeys(input).length !== length + 1) invalid();
  const names = new Set<string>();
  const formsByUid = new Map<string, ObjectBucketBindingFormUrl>();
  const snapshot: ObjectBucketBindingForm[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
    const row = ownDataTuple(descriptor.value);
    const publicName = row.publicName;
    const resourceUid = row.resourceUid;
    const formUrl = row.formUrl;
    if (
      typeof publicName !== "string" ||
      !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u.test(publicName) ||
      typeof resourceUid !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(resourceUid)
    )
      invalid();
    selectObjectBucketBindingProfile(formUrl);
    if (
      formUrl !== OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL &&
      formUrl !== OBJECT_BUCKET_EOF_COUNTED_FORM_URL
    )
      invalid();
    if (names.has(publicName)) invalid();
    const previousForm = formsByUid.get(resourceUid);
    if (previousForm !== undefined && previousForm !== formUrl) invalid();
    names.add(publicName);
    formsByUid.set(resourceUid, formUrl);
    snapshot.push(Object.freeze({ publicName, resourceUid, formUrl }));
  }
  snapshot.sort((left, right) =>
    left.publicName < right.publicName ? -1 : left.publicName > right.publicName ? 1 : 0,
  );
  return Object.freeze(snapshot);
}

function ownDataTuple(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 3) invalid();
  const row: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (key !== "publicName" && key !== "resourceUid" && key !== "formUrl") invalid();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
    row[key] = descriptor.value;
  }
  return row;
}

function invalid(): never {
  throw new TypeError("invalid ObjectBucket Binding Form projection");
}
