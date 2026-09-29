import { describe, expect, test } from "bun:test";
import { landingHtml } from "../src/landing.ts";

describe("Takoserver public site", () => {
  test("is one provider-neutral Japanese and English developer product page", () => {
    const html = landingHtml({
      consoleOrigin: "https://console.takoserver.example",
      apiOrigin: "https://api.takoserver.example",
    });
    expect(html).toContain("Declare infrastructure. The Host prices, provisions, and meters it.");
    expect(html).toContain("Exact Form identity");
    expect(html).toContain("Prepaid hold / capture");
    expect(html).toContain("edge.objects");
    expect(html).toContain('"service_forms": <b>true</b>');
    expect(html).toContain('"api": "https://api.takoserver.example/apis/forms.takoform.com/v1"');
    expect(html).toContain("bun src/entry-bun.ts");
    expect(html).toContain("https://github.com/tako0614/takoserver");
    expect(html).toContain("インフラを宣言。Hostが価格を決め、プロビジョニングし、計測します。");
    expect(html).toContain("コンソールを開く");
    expect(html).toContain("Open the console");
    expect(html).toContain('data-locale="ja"');
    expect(html).toContain('data-locale="en"');
    expect(html).toContain("const localizedPaths=true");
    expect(html).toContain('const pathLocale=location.pathname.split("/")[1]');
    expect(html).toContain('history.replaceState(null,"","/"+lang+"/")');
    expect(html).toContain("https://console.takoserver.example");
    expect(html).toContain("https://api.takoserver.example/openapi.json");
    expect(html).toContain('<noscript><a href="/ja/">日本語</a>');
    expect(html).not.toMatch(/Cloudflare|Wasabi|Aiven|UpCloud|Backblaze|OpenSRS/u);
    expect(html).not.toContain("<script src=");
  });

  test("renders a Japanese static page for no-JavaScript visitors", () => {
    const html = landingHtml({
      consoleOrigin: "https://console.takoserver.example",
      apiOrigin: "https://api.takoserver.example",
      locale: "ja",
    });
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain("インフラを宣言。Hostが価格を決め、プロビジョニングし、計測します。");
    expect(html).toContain("厳密なForm同一性");
    expect(html).toContain("日本語");
  });

  test("renders complete endpoint URLs in every locale", () => {
    const apiOrigin = "https://api.takoserver.example";
    const endpoints = ["/openapi.json", "/.well-known/takoserver", "/.well-known/takoform/v1"];

    for (const locale of ["en", "ja"] as const) {
      const html = landingHtml({ consoleOrigin: null, apiOrigin, locale });

      for (const endpoint of endpoints) {
        expect(html).toContain(`<code>${apiOrigin}${endpoint}</code>`);
      }
    }
  });

  test("does not invent locale paths on the API-origin landing page", () => {
    const html = landingHtml({ consoleOrigin: null, apiOrigin: null });
    expect(html).toContain("const localizedPaths=false");
  });
});
