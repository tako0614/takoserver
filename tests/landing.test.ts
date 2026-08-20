import { describe, expect, test } from "bun:test";
import { landingHtml } from "../src/landing.ts";

describe("Takoserver landing page", () => {
  const productOrigins = {
    consoleOrigin: "https://console.takoserver.com",
    apiOrigin: "https://api.takoserver.com",
    siteOrigin: "https://takoserver.com",
  } as const;

  test("presents a customer-facing cloud with usage meters and live product links", () => {
    const html = landingHtml(productOrigins);

    expect(html).toContain("Build on a cloud that stays portable.");
    expect(html).toContain("Pay for what you use.");
    expect(html).toContain("Standard APIs stay standard");
    expect(html).toContain("CPU milliseconds");
    expect(html).toContain("Storage capacity-time");
    expect(html).toContain("Rows read · rows written");
    expect(html).toContain("Input tokens · output tokens");
    expect(html).toContain('href="https://console.takoserver.com">Open Console</a>');
    expect(html).toContain('href="https://api.takoserver.com/openapi.json"');
    expect(html).toContain('href="https://api.takoserver.com/.well-known/takoform/v1alpha3"');
    expect(html).not.toContain("unitPriceMinor");
    expect(html).not.toContain("A prepaid resource platform");
    for (const internalSupplyTerm of [
      "Cloudflare",
      "Wasabi",
      "provider-backed",
      "Provider execution",
      "Provider packs",
      "provider-native",
      "Self-hosted",
    ]) {
      expect(html).not.toContain(internalSupplyTerm);
    }
  });

  test("renders complete English and Japanese documents with canonical locale links", () => {
    const english = landingHtml(productOrigins, "en");
    const japanese = landingHtml(productOrigins, "ja");

    expect(english).toContain('<html lang="en">');
    expect(english).toContain("Build on a cloud that stays portable.");
    expect(english).toContain('rel="canonical" href="https://takoserver.com/en/"');
    expect(english).toContain('href="https://takoserver.com/en/" hreflang="en"');
    expect(english).toContain('href="https://takoserver.com/ja/" hreflang="ja"');
    expect(english).toContain('href="/en/" lang="en" hreflang="en" aria-current="page"');
    expect(english).toContain('href="/ja/" lang="ja" hreflang="ja"');

    expect(japanese).toContain('<html lang="ja">');
    expect(japanese).toContain("移行できるクラウドで、つくろう。");
    expect(japanese).toContain('rel="canonical" href="https://takoserver.com/ja/"');
    expect(japanese).toContain("使った分だけ支払う。");
    expect(japanese).toContain("標準APIは、そのまま標準で。");
    expect(japanese).toContain('href="/en/" lang="en" hreflang="en"');
    expect(japanese).toContain('href="/ja/" lang="ja" hreflang="ja" aria-current="page"');
    expect(japanese).not.toContain("Build on a cloud that stays portable.");
    for (const html of [english, japanese]) {
      for (const internalSupplyTerm of ["Cloudflare", "Wasabi", "Provider packs"]) {
        expect(html).not.toContain(internalSupplyTerm);
      }
    }
  });

  test("remains usable at the API root without a configured Console", () => {
    const html = landingHtml({ consoleOrigin: null, apiOrigin: null });

    expect(html).toContain('href="/openapi.json">Read API</a>');
    expect(html).not.toContain("Open Console");
    expect(html).toContain('href="/.well-known/takoserver"');
  });

  test("carries the selected design system and mobile safety floor", () => {
    const html = landingHtml({ consoleOrigin: null, apiOrigin: null });
    const style = html.slice(html.indexOf("<style>") + "<style>".length, html.indexOf("</style>"));

    expect(style.trimStart().startsWith("/* Hallmark · genre: modern-minimal")).toBe(true);
    expect(style).toContain("--color-accent: oklch(");
    expect(style).toContain("html, body { overflow-x: clip; }");
    expect(style).toContain("grid-template-columns: minmax(0,");
    expect(style).toContain("@media (prefers-reduced-motion: reduce)");
    expect(style).not.toContain("transition: all");
    expect(style).not.toContain("width: 100vw");
  });
});
