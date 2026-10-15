import { expect, test } from "bun:test";
import {
  OBJECT_BUCKET_EOF_COUNTED_FORM_URL,
  OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL,
  selectObjectBucketBindingProfile,
  snapshotObjectBucketBindingForms,
} from "../src/takoform-v2/forms/object-bucket-binding-profile.ts";

const known = {
  publicName: "OLD",
  resourceUid: "bucket-old",
  formUrl: OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL,
};
const unknown = {
  publicName: "NEW",
  resourceUid: "bucket-new",
  formUrl: OBJECT_BUCKET_EOF_COUNTED_FORM_URL,
};

test("ObjectBucket profile selects only the two exact owning Form URLs", () => {
  expect(selectObjectBucketBindingProfile(known.formUrl)).toBe("known-length");
  expect(selectObjectBucketBindingProfile(unknown.formUrl)).toBe("eof-counted");
  for (const value of [
    undefined,
    null,
    {},
    "ObjectBucket",
    "edge.objects@1.0.0",
    known.formUrl.slice(0, -1),
    `${unknown.formUrl}?profile=eof-counted`,
    unknown.formUrl.replace("https:", "http:"),
    unknown.formUrl.replace("0.3.0", "0.4.0"),
  ])
    expect(() => selectObjectBucketBindingProfile(value)).toThrow(TypeError);
});

test("ObjectBucket profile snapshot owns sorted immutable mixed Form tuples", () => {
  const first = { ...known };
  const second = { ...unknown };
  const input = [first, second];
  const snapshot = snapshotObjectBucketBindingForms(input);
  expect(snapshot).toEqual([unknown, known]);
  first.publicName = "CHANGED";
  first.resourceUid = "replacement";
  Object.defineProperty(second, "formUrl", { value: OBJECT_BUCKET_KNOWN_LENGTH_FORM_URL });
  input.reverse();
  expect(snapshot).toEqual([unknown, known]);
  expect(Object.isFrozen(snapshot)).toBe(true);
  for (const row of snapshot) expect(Object.isFrozen(row)).toBe(true);
  expect(snapshotObjectBucketBindingForms([{ ...unknown }, { ...known }])).toEqual(snapshot);
});

test("ObjectBucket profile snapshot permits same-Form aliases but refuses UID Form conflicts", () => {
  expect(snapshotObjectBucketBindingForms([known, { ...known, publicName: "ALIAS" }])).toHaveLength(
    2,
  );
  expect(() =>
    snapshotObjectBucketBindingForms([known, { ...unknown, publicName: "OLD" }]),
  ).toThrow(TypeError);
  expect(() =>
    snapshotObjectBucketBindingForms([known, { ...unknown, resourceUid: known.resourceUid }]),
  ).toThrow(TypeError);
});

test("ObjectBucket profile snapshot rejects sparse and inherited slots without invoking getters", () => {
  const empty = new Array<unknown>(1);
  const partial = [known, ...new Array<unknown>(1)];
  delete partial[1];
  const inherited = new Array<unknown>(1);
  const prototype = Object.create(Array.prototype);
  let reads = 0;
  Object.defineProperty(prototype, "0", {
    get() {
      reads += 1;
      return known;
    },
  });
  Object.setPrototypeOf(inherited, prototype);
  const accessor = new Array<unknown>(1);
  Object.defineProperty(accessor, "0", {
    get() {
      reads += 1;
      return known;
    },
  });
  for (const input of [empty, partial, inherited, accessor])
    expect(() => snapshotObjectBucketBindingForms(input)).toThrow(TypeError);
  expect(reads).toBe(0);
});

test("ObjectBucket profile snapshot rejects accessor tuple fields without evaluating them", () => {
  let reads = 0;
  for (const field of ["publicName", "resourceUid", "formUrl"]) {
    const row = { ...known };
    Object.defineProperty(row, field, {
      get() {
        reads += 1;
        return known.formUrl;
      },
    });
    expect(() => snapshotObjectBucketBindingForms([row])).toThrow(TypeError);
  }
  expect(reads).toBe(0);
});

test("ObjectBucket profile snapshot closes tuple shape, names, UIDs and array inventory", () => {
  const extraArray = [known];
  Object.defineProperty(extraArray, "extra", { value: known });
  const symbolRow = { ...known, [Symbol("extra")]: true };
  const inheritedRow = Object.create(known);
  const nullPrototype = Object.assign(Object.create(null), known);
  expect(snapshotObjectBucketBindingForms([nullPrototype])).toEqual([known]);
  for (const value of [
    undefined,
    {},
    [null],
    [inheritedRow],
    [{ ...known, extra: true }],
    [symbolRow],
    [{ publicName: known.publicName, resourceUid: known.resourceUid }],
    [{ ...known, publicName: "not a name" }],
    [{ ...known, resourceUid: "" }],
    [{ ...known, formUrl: undefined }],
    extraArray,
  ])
    expect(() => snapshotObjectBucketBindingForms(value)).toThrow(TypeError);
});

test("ObjectBucket profile snapshot bounds projection at 64 and retains ordinary special names", () => {
  expect(snapshotObjectBucketBindingForms([])).toEqual([]);
  const rows = Array.from({ length: 64 }, (_, index) => ({
    ...known,
    publicName: `B${index}`,
    resourceUid: `bucket-${index}`,
  }));
  expect(snapshotObjectBucketBindingForms(rows)).toHaveLength(64);
  expect(() =>
    snapshotObjectBucketBindingForms([...rows, { ...known, publicName: "EXTRA" }]),
  ).toThrow(TypeError);
  expect(snapshotObjectBucketBindingForms([{ ...known, publicName: "__proto__" }])).toEqual([
    { ...known, publicName: "__proto__" },
  ]);
});
