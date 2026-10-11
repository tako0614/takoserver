import { describe, expect, test } from "bun:test";
import {
  formatSelfhostListenAddress,
  parseSelfhostListenHost,
  SELFHOST_DEFAULT_LISTEN_HOST,
  SELFHOST_LISTEN_HOST_VARIABLE,
} from "../src/selfhost-listen-address.ts";

describe("self-host API listen address", () => {
  test("defaults to IPv4 loopback, never every interface", () => {
    expect(SELFHOST_LISTEN_HOST_VARIABLE).toBe("TAKOSERVER_LISTEN_HOST");
    expect(SELFHOST_DEFAULT_LISTEN_HOST).toBe("127.0.0.1");
    expect(parseSelfhostListenHost(undefined)).toBe("127.0.0.1");
  });

  test("accepts canonical IPv4 and IPv6 interface literals, including the wildcards", () => {
    for (const value of ["127.0.0.1", "0.0.0.0", "10.0.0.7", "192.168.1.20"]) {
      expect(parseSelfhostListenHost(value)).toBe(value);
    }
    for (const value of ["::", "::1", "fd00::7"]) {
      expect(parseSelfhostListenHost(value)).toBe(value);
    }
  });

  test("refuses names, ports, brackets, blanks and non-canonical literals by naming the variable", () => {
    for (const value of [
      "",
      " ",
      "localhost",
      "example.test",
      "127.0.0.1:8787",
      "[::1]",
      "::1 ",
      " 127.0.0.1",
      "127.000.000.001",
      "127.0.0.256",
      "127.0.0",
      "0:0:0:0:0:0:0:1",
      "FD00::7",
      "http://127.0.0.1",
      "127.0.0.1\u0000",
    ]) {
      expect(() => parseSelfhostListenHost(value)).toThrow(
        /TAKOSERVER_LISTEN_HOST must be one canonical IPv4 or IPv6 interface address/u,
      );
    }
  });

  test("formats the bound address the way a client would dial it", () => {
    expect(formatSelfhostListenAddress("127.0.0.1", 8787)).toBe("127.0.0.1:8787");
    expect(formatSelfhostListenAddress("0.0.0.0", 8787)).toBe("0.0.0.0:8787");
    expect(formatSelfhostListenAddress("::", 8787)).toBe("[::]:8787");
    expect(formatSelfhostListenAddress("::1", 9000)).toBe("[::1]:9000");
  });
});
