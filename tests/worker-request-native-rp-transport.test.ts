import { expect, test } from "bun:test";
import { base64UrlEncode } from "../src/json.ts";
import type { WorkerRequestSql } from "../src/worker-request-composition.ts";
import {
  captureWorkerRequestNativeRpTransport,
  decodeAuth103RpSessionEncryptionKey,
} from "../src/worker-request-native-rp-transport.ts";

test("dedicated RP encryption transport DATA decodes exact canonical 32 bytes without aliasing", () => {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
  const encoded = base64UrlEncode(bytes);
  const a = decodeAuth103RpSessionEncryptionKey(encoded);
  const b = decodeAuth103RpSessionEncryptionKey(encoded);
  expect(a).toEqual(bytes);
  expect(b).toEqual(bytes);
  a.fill(255);
  expect(b).toEqual(bytes);
});

test("RP key DATA refuses padding, alternate spelling, foreign lengths and nonstrings", () => {
  const canonical = base64UrlEncode(new Uint8Array(32));
  for (const value of [
    null,
    undefined,
    {},
    new Uint8Array(32),
    "",
    `${canonical}=`,
    ` ${canonical}`,
    `${canonical}\n`,
    base64UrlEncode(new Uint8Array(31)),
    base64UrlEncode(new Uint8Array(33)),
    `${canonical.slice(0, -1)}B`,
  ]) {
    expect(() => decodeAuth103RpSessionEncryptionKey(value)).toThrow(
      "selected RP transport is unavailable",
    );
  }
});

test("a matching Worker request DTO cannot trigger native transport initialization or invoke getters", async () => {
  let getters = 0;
  const forged = Object.defineProperty({}, "sql", {
    get(): never {
      getters++;
      throw new Error("not original");
    },
  }) as WorkerRequestSql;
  await expect(captureWorkerRequestNativeRpTransport(forged)).rejects.toThrow();
  expect(getters).toBe(0);
});
