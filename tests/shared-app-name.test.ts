import { expect, test } from "bun:test";
import {
  normalizeSharedAppName,
  SHARED_APP_STAGING_SUFFIX,
  sharedAppStagingNameFromHost,
  sharedAppStagingOrigin,
} from "../src/shared-app-name.ts";

const accepted = [
  ["foo", "foo"],
  ["FoO", "foo"],
  ["ｆｏｏ", "foo"],
  ["ＦＯＯ", "foo"],
  ["ﬁx", "fix"],
  ["①23", "123"],
  ["foo-bar", "foo-bar"],
  ["123", "123"],
  ["a".repeat(32), "a".repeat(32)],
] as const;

for (const [input, canonical] of accepted) {
  test(`allocation alias ${input} has one canonical ledger key`, () => {
    expect(normalizeSharedAppName(input)).toBe(canonical);
    expect(sharedAppStagingOrigin(input)).toBe(`https://${canonical}.app-staging.takos.jp`);
    expect(normalizeSharedAppName(canonical)).toBe(canonical);
  });
}

const rejected = [
  "",
  "ab",
  "a".repeat(33),
  "a".repeat(129),
  " foo",
  "foo ",
  "foo.",
  "foo.bar",
  "foo/bar",
  "foo:443",
  "-foo",
  "foo-",
  "foo--bar",
  "xn--foo",
  "foo-staging",
  "FOO-STAGING",
  "Admin",
  "ａｄｍｉｎ",
  "admin.",
  "www",
  "accounts",
  "postmaster",
  "undefined",
  "foо", // The last letter is Cyrillic, not Latin o.
  "föö",
  "foo\u200b",
  "foo\u0000",
  "foo\r\nbar",
] as const;

for (const input of rejected) {
  test(`allocation refuses ${JSON.stringify(input)} before provider selection`, () => {
    expect(() => normalizeSharedAppName(input)).toThrow("shared app name is invalid");
    expect(() => sharedAppStagingOrigin(input)).toThrow("shared app name is invalid");
  });
}

// Golden vectors from APP-SUBDOMAIN, independent of the implementation's Set.
const reservedNames = [
  "www",
  "api",
  "app",
  "apps",
  "admin",
  "root",
  "auth",
  "login",
  "oauth",
  "sso",
  "account",
  "accounts",
  "billing",
  "pay",
  "status",
  "docs",
  "help",
  "support",
  "mail",
  "smtp",
  "imap",
  "mx",
  "ns",
  "ns1",
  "ns2",
  "dns",
  "cdn",
  "static",
  "assets",
  "staging",
  "stage",
  "dev",
  "test",
  "prod",
  "internal",
  "control",
  "dashboard",
  "console",
  "takos",
  "takosumi",
  "takoserver",
  "yurucommu",
  "deckide",
  "security",
  "abuse",
  "postmaster",
  "hostmaster",
  "webmaster",
  "null",
  "undefined",
] as const;

for (const name of reservedNames) {
  test(`reserved name ${name} and its normalized aliases cannot allocate or dispatch`, () => {
    const fullWidth = Array.from(name, (character) =>
      String.fromCharCode(character.charCodeAt(0) + 0xfee0),
    ).join("");
    for (const alias of [name, name.toUpperCase(), fullWidth]) {
      expect(() => normalizeSharedAppName(alias)).toThrow("shared app name is invalid");
      expect(sharedAppStagingNameFromHost(`${alias}.app-staging.takos.jp`)).toBeNull();
    }
  });
}

for (const input of [null, undefined, 123, {}, ["foo"]]) {
  test(`allocation refuses non-string ${JSON.stringify(input)}`, () => {
    expect(() => normalizeSharedAppName(input)).toThrow(TypeError);
    expect(sharedAppStagingNameFromHost(input)).toBeNull();
  });
}

test("ASCII Host case and one root dot preserve the same dispatch name", () => {
  expect(SHARED_APP_STAGING_SUFFIX).toBe("app-staging.takos.jp");
  expect(sharedAppStagingNameFromHost("FoO.APP-STAGING.TAKOS.JP")).toBe("foo");
  expect(sharedAppStagingNameFromHost("foo.app-staging.takos.jp.")).toBe("foo");
});

const rejectedHosts = [
  "app-staging.takos.jp",
  ".app-staging.takos.jp",
  "foo.bar.app-staging.takos.jp",
  "foo.app-staging.takos.jp.evil.com",
  "foo.app-staging.takos.jp..",
  "foo.app-staging.takos.jp:443",
  "foo.app-staging.takos.jp:80",
  "foo.app-staging.takos.jp:",
  "foo.app-staging.takos.jp@evil.com",
  "https://foo.app-staging.takos.jp",
  "foo.app-staging.takos.jp/path",
  "foo.app-staging.takos.jp?query",
  "foo.app-staging.takos.jp#fragment",
  "foo.app.takos.jp",
  "foo.app.staging.takos.jp",
  "foo.app-staging.example.test",
  " foo.app-staging.takos.jp",
  "foo.app-staging.takos.jp ",
  "ｆｏｏ.app-staging.takos.jp",
  "foo。app-staging.takos.jp",
  "xn--foo.app-staging.takos.jp",
  "ADMIN.app-staging.takos.jp",
  "foo-staging.app-staging.takos.jp",
  "foo--bar.app-staging.takos.jp",
  "ab.app-staging.takos.jp",
  `${"a".repeat(33)}.app-staging.takos.jp`,
  "foo.app-staging.takos.jp\r\nHost: evil.com",
  "foo.app-staging.takos.jp,bar.app-staging.takos.jp",
];

for (const host of rejectedHosts) {
  test(`raw Host ${JSON.stringify(host)} cannot select any dispatch script`, () => {
    expect(sharedAppStagingNameFromHost(host)).toBeNull();
  });
}
