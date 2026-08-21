import { describe, expect, test } from "bun:test";
import { landingHtml } from "../src/landing.ts";

describe("Takoserver public site", () => {
  test("is one provider-neutral Japanese and English developer product page", () => {
    const html = landingHtml({
      consoleOrigin: "https://console.takoserver.example",
      apiOrigin: "https://api.takoserver.example",
    });
    expect(html).toContain("Cloud resources, without the cloud maze.");
    expect(html).toContain("クラウドを、迷わず使える形に。");
    expect(html).toContain("コンソールを開く");
    expect(html).toContain("Open the console");
    expect(html).toContain('data-locale="ja"');
    expect(html).toContain('data-locale="en"');
    expect(html).toContain("const localizedPaths=true");
    expect(html).toContain('const pathLocale=location.pathname.split("/")[1]');
    expect(html).toContain('history.replaceState(null,"","/"+lang+"/")');
    expect(html).toContain("https://console.takoserver.example");
    expect(html).toContain("https://api.takoserver.example/openapi.json");
    expect(html).not.toMatch(/Cloudflare|Wasabi|Aiven|UpCloud|Backblaze|OpenSRS/u);
    expect(html).not.toContain("<script src=");
  });

  test("does not invent locale paths on the API-origin landing page", () => {
    const html = landingHtml({ consoleOrigin: null, apiOrigin: null });
    expect(html).toContain("const localizedPaths=false");
  });
});
