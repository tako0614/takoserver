import { describe, expect, test } from "bun:test";
import { consoleNavigation, resolveConsoleLocale } from "../console/src/i18n.ts";

describe("Takoserver Console locale and navigation", () => {
  test("uses the browser language unless the user saved an explicit choice", () => {
    expect(resolveConsoleLocale(null, ["ja-JP", "en-US"])).toBe("ja");
    expect(resolveConsoleLocale(null, ["en-US"])).toBe("en");
    expect(resolveConsoleLocale("en", ["ja-JP"])).toBe("en");
    expect(resolveConsoleLocale("ja", ["en-US"])).toBe("ja");
  });

  test("keeps the Console operational and leaves Forms and Catalog on the public site", () => {
    expect(consoleNavigation("ja")).toEqual([
      { group: "概要", items: [{ href: "/", label: "ホーム", glyph: "home" }] },
      {
        group: "クラウド",
        items: [{ href: "/resources", label: "リソース", glyph: "layers" }],
      },
      {
        group: "アカウント",
        items: [
          { href: "/billing", label: "使用量と請求", glyph: "wallet" },
          { href: "/keys", label: "APIキー", glyph: "key" },
          { href: "/settings", label: "設定", glyph: "gear" },
        ],
      },
    ]);

    const english = consoleNavigation("en");
    expect(english.flatMap((section) => section.items).map((item) => item.href)).toEqual([
      "/",
      "/resources",
      "/billing",
      "/keys",
      "/settings",
    ]);
    expect(JSON.stringify(english)).not.toContain("Forms");
    expect(JSON.stringify(english)).not.toContain("Catalog");
  });
});
