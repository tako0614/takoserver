import { describe, expect, test } from "bun:test";
import { landingHtml, notFoundHtml } from "../src/landing.ts";

const site = {
  consoleOrigin: "https://console.takoserver.example",
  apiOrigin: "https://api.takoserver.example",
};

describe("Takoserver public site", () => {
  test("presents a self-hostable cloud you deploy Takoform to, installing first", () => {
    const html = landingHtml(site);
    expect(html).toContain("<title>Takoserver</title>");
    expect(html).toContain("Deploy Takoform.\nRun your own cloud.");
    expect(html).toContain(
      "Takoserver is an open-source cloud that runs on your own Linux machine.",
    );
    // The install guide is the primary action; the console comes second.
    const primary = html.indexOf('class="pill primary"');
    expect(html.slice(primary, primary + 200)).toContain(
      "docs/self-host-operations.md#first-install-and-first-use",
    );
    expect(html.indexOf('data-i18n="install"')).toBeLessThan(html.indexOf('data-i18n="console"'));
    expect(html).toContain('href="https://console.takoserver.example" data-i18n="console"');
    expect(html).not.toMatch(/wallet|prepaid|Usage-based/u);
    expect(html).not.toMatch(/Cloudflare|Wasabi|Aiven|UpCloud|Backblaze|OpenSRS/u);
    expect(html).not.toContain("<script src=");
  });

  test("lists the Forms a complete self-host composition accepts, with their versions", () => {
    const html = landingHtml(site);
    for (const form of [
      "ModuleWorker 0.3.0",
      "WorkerVersion 0.5.0",
      "WorkerDeployment 0.4.0",
      "WorkerEndpoint 0.3.0",
      "WorkerCronTrigger 0.3.0",
      "SQLiteDatabase 0.2.0",
      "EdgeKVNamespace 0.2.0",
      "ObjectBucket 0.2.0",
      "AtLeastOnceQueue 0.2.0",
      "QueueConsumer 0.3.0",
      "ActorNamespace 0.3.0",
      "DurableWorkflow 0.3.0",
      "WorkerBundle 0.2.0",
      "StaticAssetBundle 0.2.0",
      "SQLiteMigrationSet 0.2.0",
      "SQLiteMigrationApplication 0.2.0",
    ]) {
      expect(html).toContain(`<code>${form}</code>`);
    }
  });

  test("walks one Worker through the guide's create chain to its response", () => {
    const html = landingHtml(site);
    const order = [
      "ModuleWorker",
      "WorkerBundle",
      "WorkerVersion",
      "WorkerDeployment",
      "WorkerEndpoint",
    ].map((kind) => html.indexOf(`<strong>${kind} <span>`));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('return new Response("hello from takoserver\\n");');
    expect(html).toContain('curl -sS "https://$NAME/"');
    expect(html).toContain('<span class="out">hello from takoserver</span>');
    expect(html).toContain("docs/self-host-operations.md#6-seed-held-artifacts");
  });

  test("keeps the self-host steps and the support check", () => {
    const html = landingHtml(site);
    expect(html).toContain("bun install --frozen-lockfile");
    expect(html).toContain("<code>TAKOSERVER_TAKOFORM_V2_CURSOR_KEY</code>");
    expect(html).toContain("bun src/entry-bun.ts");
    expect(html).toContain("docs/self-host-docker.md");
    expect(html).toContain(
      "curl -sG https://api.takoserver.example/apis/forms.takoform.com/v2/support \\\n" +
        '  --data-urlencode "form=&lt;Form URL&gt;" \\\n' +
        '  -H "authorization: Bearer $KEY"',
    );
    for (const path of ["/openapi.json", "/.well-known/takoform/v2", "/.well-known/takoserver"]) {
      expect(html).toContain(`href="https://api.takoserver.example${path}"`);
    }
  });

  test("shows the real Console in the visitor's language, light or dark, on the public site only", () => {
    const english = landingHtml(site);
    expect(english).toContain('srcset="/screens/console-desktop-dark-en.webp"');
    expect(english).toContain('src="/screens/console-desktop-light-en.webp"');
    expect(english).toContain('data-locale-src="/screens/console-desktop-light-{lang}.webp"');
    expect(english).toContain("public sample data");
    const japanese = landingHtml({ ...site, locale: "ja" });
    expect(japanese).toContain('<html lang="ja">');
    expect(japanese).toContain("Takoformを、\n自分のクラウドへ。");
    expect(japanese).toContain('srcset="/screens/console-mobile-light-ja.webp"');
    expect(japanese).toContain("公開用サンプルデータ");
    const apiRoot = landingHtml({ consoleOrigin: null, apiOrigin: null });
    expect(apiRoot).not.toContain("/screens/");
    expect(apiRoot).not.toContain("/fonts/");
  });

  test("chooses the language without visible controls or a stored choice", () => {
    const html = landingHtml(site);
    expect(html).not.toContain("data-locale=");
    expect(html).not.toContain("localStorage");
    expect(html).not.toContain("history.replaceState");
    expect(html).toContain('const pathLocale=location.pathname.split("/")[1]');
    expect(html).toContain("navigator.languages");
    expect(html).toContain(
      'setLocale(pathLocale==="ja"||pathLocale==="en"?pathLocale:browserLocale)',
    );
  });

  test("names a pasteable origin in commands on the API's own root", () => {
    const html = landingHtml({ consoleOrigin: null, apiOrigin: null });
    expect(html).toContain(
      "curl -sG <span data-origin>$HOST</span>/apis/forms.takoform.com/v2/support",
    );
    expect(html).toContain(
      'for(const node of document.querySelectorAll("[data-origin]"))node.textContent=location.origin;',
    );
    expect(html).toContain('data-i18n="source"');
    expect(html).not.toContain('data-i18n="console"');
    expect(landingHtml(site)).not.toContain("data-origin>");
  });

  test("answers unknown paths in the same visual system", () => {
    const html = notFoundHtml();
    expect(html).toContain("<title>404 | Takoserver</title>");
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('href="/"');
  });
});
