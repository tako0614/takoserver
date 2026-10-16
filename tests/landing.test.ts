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
    const primary = html.indexOf('class="pill primary external"');
    expect(html.slice(primary, primary + 200)).toContain(
      "docs/self-host-operations.md#first-install-and-first-use",
    );
    // The hero offers the install guide and the source, never a hosted console.
    const hero = html.slice(html.indexOf('<section class="hero"'), html.indexOf('id="forms"'));
    expect(hero).toContain('data-i18n="source"');
    expect(hero).not.toContain("console.takoserver.example");
    // Install, then deploy, then manage.
    const sections = ["forms", "start", "deploy", "after"].map((id) => html.indexOf(`id="${id}"`));
    expect(sections.every((index) => index > 0)).toBe(true);
    expect([...sections].sort((a, b) => a - b)).toEqual(sections);
    expect(html).not.toMatch(/wallet|prepaid|Usage-based/u);
    expect(html).not.toMatch(/Cloudflare|Wasabi|Aiven|UpCloud|Backblaze|OpenSRS/u);
    expect(html).not.toContain("<script src=");
  });

  test("explains Takoform and lists the Forms a self-host can compose, with versions", () => {
    const html = landingHtml(site);
    for (const form of [
      "WorkerBundle 0.2.0",
      "StaticAssetBundle 0.2.0",
      "SQLiteMigrationSet 0.2.0",
      "ModuleWorker 0.3.0",
      "WorkerVersion 0.5.0",
      "WorkerDeployment 0.4.0",
      "WorkerCronTrigger 0.3.0",
      "WorkerEndpoint 0.3.0",
      "SQLiteDatabase 0.2.0",
      "SQLiteMigrationApplication 0.2.0",
      "EdgeKVNamespace 0.2.0",
      "ObjectBucket 0.2.0",
      "AtLeastOnceQueue 0.2.0",
      "QueueConsumer 0.3.0",
      "ActorNamespace 0.3.0",
      "DurableWorkflow 0.3.0",
    ]) {
      expect(html).toContain(`<code>${form}</code>`);
    }
    expect(html).toContain("Takoform describes each kind of resource");
    expect(html).toContain(
      '<a href="https://takoform.com" data-i18n="takoform">About Takoform</a>',
    );
    expect(html).toContain(
      "Artifacts need only Bun and a short block in the Host's settings. Everything else needs the Worker runtime of step 2 below, and publishing at a hostname also needs step 3.",
    );
    // The marketing page names what an operator does, not the Host's internal profile.
    expect(html).not.toMatch(
      /local Worker profile|data plane|bundle block|selfhost-v2-worker-primary/u,
    );
  });

  test("walks one Worker through the guide's create chain to its response", () => {
    const html = landingHtml(site);
    const order = [
      "ModuleWorker 0.3.0",
      "WorkerBundle 0.2.0",
      "WorkerVersion 0.5.0",
      "WorkerDeployment 0.4.0",
      "WorkerEndpoint 0.3.0",
    ].map((kind) => html.indexOf(`<strong>${kind} <span>`));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // One create, as the guide's create function sends it.
    expect(html).toContain(
      'jq -n --arg form "$F/ModuleWorker/0.3.0/" --arg space "$ORG" \\\n' +
        "  '{$form, $space, name: \"hello\", spec: {}}' |\n" +
        'curl -sS "$V2/resources" --data @- \\\n',
    );
    expect(html).toContain('-H "idempotency-key: takoserver-first-use-hello"');
    expect(html).toContain('return new Response("hello from takoserver\\n");');
    expect(html).toContain('curl -sS "https://$NAME/"');
    expect(html).toContain('<span class="out">hello from takoserver</span>');
    expect(html).toContain("docs/self-host-operations.md#6-seed-held-artifacts");
  });

  test("keeps the guide's self-host steps", () => {
    const html = landingHtml(site);
    expect(html).toContain(
      "git checkout --detach &lt;reviewed-commit&gt;\nbun install --frozen-lockfile",
    );
    expect(html).toContain("<code>TAKOSERVER_TAKOFORM_V2_CURSOR_KEY</code>");
    expect(html).toContain("bun --no-env-file src/entry-bun.ts");
    // What a Worker Host needs, in plain terms: workerd, the guard, HTTPS and a wildcard name.
    expect(html).toContain(
      "the pinned workerd from a GitHub Release, checked against its SHA256SUMS",
    );
    expect(html).toContain("the Workflow execution guard, a small Go program");
    expect(html).toContain("a wildcard DNS name and certificate, such as *.apps.example.com");
    expect(html).toContain('href="https://github.com/tako0614/takoserver/releases"');
    expect(html).toContain("docs/self-host-operations.md#1-prerequisites");
    expect(html).toContain("docs/self-host-docker.md");
  });

  test("manages what you deployed on your own Host, not on takoserver.com's", () => {
    const html = landingHtml(site);
    expect(html).not.toContain("curl -sG https://api.takoserver.example");
    expect(html).toContain(
      'curl -sG "$HOST/apis/forms.takoform.com/v2/support" \\\n' +
        '  --data-urlencode "form=&lt;Form URL&gt;" \\\n' +
        '  -H "authorization: Bearer $KEY"',
    );
    expect(html).toContain(
      "<code>bun scripts/build-console.ts --api-origin &lt;API origin&gt;</code>",
    );
    expect(html).toContain("<code>TAKOSERVER_CONSOLE_ORIGIN</code>");
    expect(html).toContain(
      '<a href="https://console.takoserver.example" data-i18n="consoleSite">takoserver.com\'s own console</a>',
    );
    for (const path of ["/openapi.json", "/.well-known/takoform/v2", "/.well-known/takoserver"]) {
      expect(html).toContain(`href="https://api.takoserver.example${path}"`);
    }
  });

  test("shows the real Console in the visitor's language, light or dark, on the public site only", () => {
    const english = landingHtml(site);
    expect(english).toContain(
      'srcset="/screens/console-desktop-dark-en.webp" data-locale-srcset="/screens/console-desktop-dark-{lang}.webp" width="2400" height="1500"',
    );
    expect(english).toContain('src="/screens/console-desktop-light-en.webp"');
    expect(english).toContain('width="780" height="1560"');
    // Between phone and desktop widths the page shows the Console at a tablet's
    // width rather than shrinking the desktop capture.
    expect(english).toContain(
      '<source media="(max-width: 1100px) and (prefers-color-scheme: dark)" srcset="/screens/console-tablet-dark-en.webp" data-locale-srcset="/screens/console-tablet-dark-{lang}.webp" width="1640" height="1480">',
    );
    expect(english.indexOf("console-mobile-light")).toBeLessThan(
      english.indexOf("console-tablet-dark"),
    );
    // Neither capture is shown larger than it was taken.
    expect(english).toContain(".preview .frame { max-width: 848px; margin-inline: auto; }");
    expect(english).toContain(".preview .frame { max-width: 406px; margin-inline: auto; }");
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
    // A Japanese browser at the public root goes to /ja/ before the body loads.
    expect(html.indexOf('location.replace("/ja/")')).toBeGreaterThan(0);
    expect(html.indexOf('location.replace("/ja/")')).toBeLessThan(html.indexOf("<body>"));
    expect(html).toContain(
      '<link rel="alternate" hreflang="ja" href="https://takoserver.com/ja/">',
    );
    expect(html).toContain(
      '<link rel="alternate" hreflang="x-default" href="https://takoserver.com/">',
    );
  });

  test("answers on the API's own root with its own origin and console", () => {
    const html = landingHtml({ consoleOrigin: null, apiOrigin: null });
    expect(html).toContain(
      'curl -sG "<span data-origin>$HOST</span>/apis/forms.takoform.com/v2/support"',
    );
    expect(html).toContain(
      'for(const node of document.querySelectorAll("[data-origin]"))node.textContent=location.origin;',
    );
    expect(html).not.toContain('data-i18n="consoleHost"');
    expect(html).not.toContain("hreflang");
    expect(html).not.toContain('location.replace("/ja/")');
    const withConsole = landingHtml({
      consoleOrigin: "https://console.host.example",
      apiOrigin: null,
    });
    expect(withConsole).toContain(
      'href="https://console.host.example" data-i18n="consoleHost">Open this Host\'s console</a>',
    );
    expect(landingHtml(site)).not.toContain("data-origin>");
  });

  test("answers unknown paths in the same visual system", () => {
    const html = notFoundHtml();
    expect(html).toContain("<title>404 | Takoserver</title>");
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('href="/"');
  });
});
