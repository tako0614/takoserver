import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createActorAddressing } from "../src/actor-addressing.ts";

const encoder = new TextEncoder();
const DOMAIN = encoder.encode("takoserver.actor.name.v1\0");

function expectedNamedId(name: string): string {
  const utf16le = Buffer.alloc(name.length * 2);
  for (let i = 0; i < name.length; i += 1) {
    utf16le.writeUInt16LE(name.charCodeAt(i), i * 2);
  }
  return `n1_${createHash("sha256").update(DOMAIN).update(utf16le).digest("hex")}`;
}

const savedIterator = String.prototype[Symbol.iterator];
const savedCharCodeAt = String.prototype.charCodeAt;

afterEach(() => {
  String.prototype[Symbol.iterator] = savedIterator;
  String.prototype.charCodeAt = savedCharCodeAt;
});

describe("Actor opaque addressing", () => {
  test("matches independent SHA-256 vectors over the exact UTF-16LE name", () => {
    const addressing = createActorAddressing({ randomBytes: () => undefined });
    expect(addressing.idFromName("a")).toBe(
      "n1_83ab017f591ba7a23c7b0ecb270d77020b30cd4c9b52e960bf97bd4aa1b66716",
    );
    for (const name of ["a", "room-01", "é", "e\u0301", "😀", "\ud800", "\udc00", "a\ud800b"]) {
      expect(addressing.idFromName(name)).toBe(expectedNamedId(name));
    }
    expect(addressing.idFromName("é")).not.toBe(addressing.idFromName("e\u0301"));
    expect(addressing.idFromName("\ud800")).not.toBe(addressing.idFromName("\udc00"));
  });

  test("is stable across helper instances and uses a namespace disjoint from random IDs", () => {
    const first = createActorAddressing({ randomBytes: (bytes) => bytes.fill(0x11) });
    const second = createActorAddressing({ randomBytes: (bytes) => bytes.fill(0xee) });
    expect(first.idFromName("stable-name")).toBe(second.idFromName("stable-name"));
    expect(first.newUniqueId()).toBe(`u1_${"11".repeat(32)}`);
    expect(second.newUniqueId()).toBe(`u1_${"ee".repeat(32)}`);
    expect(first.newUniqueId()).not.toBe(first.idFromName("stable-name"));
  });

  test("uses captured platform cryptographic randomness by default", () => {
    const addressing = createActorAddressing();
    const first = addressing.newUniqueId();
    const second = addressing.newUniqueId();
    expect(first).toMatch(/^u1_[0-9a-f]{64}$/u);
    expect(second).toMatch(/^u1_[0-9a-f]{64}$/u);
    expect(first).not.toBe(second);
  });

  test("validates names and opaque IDs by code point count, including lone surrogates", () => {
    const addressing = createActorAddressing({ randomBytes: () => undefined });
    expect(() => addressing.idFromName("")).toThrow(
      expect.objectContaining({ code: "invalid_name" }),
    );
    expect(() => addressing.idFromName("😀".repeat(2048))).not.toThrow();
    expect(() => addressing.idFromName("😀".repeat(2049))).toThrow(
      expect.objectContaining({ code: "invalid_name" }),
    );
    expect(() => addressing.idFromName("\ud800".repeat(2049))).toThrow(
      expect.objectContaining({ code: "invalid_name" }),
    );
    expect(addressing.isValidActorId("x".repeat(256))).toBe(true);
    expect(addressing.isValidActorId("x".repeat(257))).toBe(false);
    expect(addressing.isValidActorId("😀".repeat(256))).toBe(true);
    expect(addressing.isValidActorId("😀".repeat(257))).toBe(false);
    expect(addressing.isValidActorId("\ud800".repeat(256))).toBe(true);
    expect(addressing.isValidActorId("")).toBe(false);
    expect(addressing.isValidActorId(17)).toBe(false);
  });

  test("does not depend on the mutable String iterator or charCodeAt after capture", () => {
    const addressing = createActorAddressing({ randomBytes: () => undefined });
    const expected = expectedNamedId("exact\ud800name");
    String.prototype[Symbol.iterator] = () => {
      throw new Error("untrusted iterator invoked");
    };
    String.prototype.charCodeAt = () => {
      throw new Error("untrusted charCodeAt invoked");
    };
    expect(addressing.idFromName("exact\ud800name")).toBe(expected);
    expect(addressing.isValidActorId("valid")).toBe(true);
  });

  test("fails closed when cryptographic randomness is unavailable or fails", () => {
    const missing = createActorAddressing({ randomBytes: null });
    expect(() => missing.newUniqueId()).toThrow(
      expect.objectContaining({ code: "backend_unavailable" }),
    );
    const broken = createActorAddressing({
      randomBytes: () => {
        throw new Error("rng unavailable");
      },
    });
    expect(() => broken.newUniqueId()).toThrow(
      expect.objectContaining({ code: "backend_unavailable" }),
    );
  });
});
