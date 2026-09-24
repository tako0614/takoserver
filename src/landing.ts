/**
 * The page Takoserver shows a person who arrives without an application.
 *
 * One page, rendered in two places: the API answers it at its own root, and the
 * apex serves it as a file. Writing it twice would produce two descriptions of
 * one product, and they would disagree within a month.
 */

export interface LandingOptions {
  /** Where the console is, if this deployment has one. */
  readonly consoleOrigin: string | null;
  /** Prefix for the API links. Empty when the page is served by the API. */
  readonly apiOrigin: string | null;
  /** Static locale for the page body; the API root defaults to English. */
  readonly locale?: "en" | "ja";
}

const landingMessages = {
  en: {
    description: "A Takoform Host that owns accounts, money, and machines.",
    console: "Open the console",
    eyebrow: "Takoform Host",
    headline: "Declare infrastructure. The Host prices, provisions, and meters it.",
    lede: "Takoserver owns the accounts, money, and machines. Declare an exact Form, fund a prepaid wallet, and inspect every usage charge.",
    products: "Host primitives",
    formTitle: "Exact Form identity",
    formBody: "Every declaration pins group, kind, definition version, and schema digest.",
    holdTitle: "Prepaid hold / capture",
    holdBody: "Work holds wallet balance, captures on success, and releases on failure.",
    objectTitle: "edge.objects",
    objectBody: "ObjectBucket binds through bucketBindings to the exact edge.objects interface.",
    meterTitle: "Provision + meter",
    meterBody: "Provision Deployments, record usage, and capture reported AI token use.",
    billingTitle: "Usage-based, prepaid billing",
    billingBody: "Measured usage is accumulated at fine precision and settled to your wallet in clear rollups. You can see what was used and charged.",
    api: "API description",
    product: "Product discovery",
    host: "Takoform Host discovery",
  },
  ja: {
    description: "アカウント、資金、マシンを管理するTakoform Host。",
    console: "コンソールを開く",
    eyebrow: "Takoform Host",
    headline: "インフラを宣言。Hostが価格を決め、プロビジョニングし、計測します。",
    lede: "Takoserverはアカウント、資金、マシンを管理します。正確なFormを宣言し、前払いウォレットから利用量に応じて支払います。",
    products: "Hostのプリミティブ",
    formTitle: "正確なForm identity",
    formBody: "すべての宣言はgroup、kind、definition version、schema digestを固定します。",
    holdTitle: "Prepaid hold / capture",
    holdBody: "処理前にウォレットをholdし、成功時にcapture、失敗時にreleaseします。",
    objectTitle: "edge.objects",
    objectBody: "ObjectBucketはbucketBindingsを通じて正確なedge.objects interfaceに接続します。",
    meterTitle: "Provision + meter",
    meterBody: "Deploymentをプロビジョニングし、利用量を記録して、AIの報告トークン使用量をcaptureします。",
    billingTitle: "前払い・使用量ベースの課金",
    billingBody: "細かな単位で利用量を蓄積し、明確な集計としてウォレットへ精算します。利用量と請求額を確認できます。",
    api: "API仕様",
    product: "製品ディスカバリー",
    host: "Takoform Hostディスカバリー",
  },
} as const;

/**
 * What the API serves at its own root.
 *
 * Not a console — the console is a separate deployment on its own hostname.
 * This is the page a person lands on after typing the API's address, so its
 * whole job is to say what this is and where everything actually lives.
 *
 * Inline and self-contained: an API answering its own root should not need a
 * second request to render one screen.
 */
export function landingHtml(options: LandingOptions): string {
  const locale = options.locale ?? "en";
  const copy = landingMessages[locale];
  const consoleOrigin = options.consoleOrigin;
  const console_ = consoleOrigin
    ? `<a class="cta" href="${consoleOrigin}" data-i18n="console">${copy.console}</a>`
    : "";
  const base = options.apiOrigin ?? "";
  const noScriptLocale_ = options.apiOrigin !== null
    ? `<noscript><a href="/ja/">日本語</a> · <a href="/en/">English</a></noscript>`
    : "";
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Takoserver</title>
<meta name="description" content="${copy.description}">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 34 34'%3E%3Crect width='34' height='34' fill='%23b0301f'/%3E%3C/svg%3E">
<style>
:root {
  color-scheme: light;
  --ink: #0e0e10; --ink-2: #6e7076; --line: #e6e6e8;
  --bg: #ffffff; --bg-2: #f6f6f7; --accent: #b0301f; --face: #17100f;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --ink: #f2f2f3; --ink-2: #8a8c93; --line: #232327;
    --bg: #0b0b0c; --bg-2: #101012; --accent: #e0533c; --face: #0b0b0c;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 400 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Hiragino Sans", sans-serif;
  letter-spacing: -0.006em; -webkit-font-smoothing: antialiased;
}
main { max-width: 46rem; margin: 0 auto; padding: 88px 24px 96px; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.wordmark { font-weight: 650; letter-spacing: -0.025em; }
.locale { display: inline-flex; padding: 3px; border: 1px solid var(--line); border-radius: 7px; }
.locale button {
  appearance: none; border: 0; border-radius: 4px; padding: 5px 9px; cursor: pointer;
  background: transparent; color: var(--ink-2); font: inherit; font-size: 12px;
}
.locale button[aria-pressed="true"], .locale a:hover { background: var(--bg-2); color: var(--ink); }
.locale a { padding: 5px 9px; color: var(--ink-2); font-size: 12px; text-decoration: none; }
.hero { margin-top: 76px; }
.eyebrow { color: var(--accent); font: 600 12px/1.3 ui-monospace, monospace; letter-spacing: .06em; text-transform: uppercase; }
h1 { margin: 22px 0 0; font-size: 34px; font-weight: 600; letter-spacing: -0.035em; }
p.lede { margin: 12px 0 0; color: var(--ink-2); font-size: 16px; max-width: 34rem; }
.cta {
  display: inline-flex; align-items: center; margin-top: 28px; padding: 9px 16px;
  border-radius: 6px; background: var(--accent); color: #fff;
  font-size: 14px; font-weight: 500; text-decoration: none;
}
.cta:hover { filter: brightness(1.08); }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; margin-top: 56px; background: var(--line); border: 1px solid var(--line); }
.grid article { min-height: 132px; padding: 20px; background: var(--bg); }
.grid h2 { margin: 0; font-size: 14px; font-weight: 600; }
.grid p { margin: 8px 0 0; color: var(--ink-2); font-size: 13px; }
.billing { margin-top: 56px; padding: 22px; border-left: 3px solid var(--accent); background: var(--bg-2); }
.billing h2 { margin: 0; font-size: 18px; }
.billing p { margin: 6px 0 0; color: var(--ink-2); }
ul { margin: 44px 0 0; padding: 0; list-style: none; border-top: 1px solid var(--line); }
li { border-bottom: 1px solid var(--line); }
li a {
  display: flex; justify-content: space-between; gap: 16px; align-items: baseline;
  padding: 14px 2px; color: inherit; text-decoration: none;
}
li a:hover { background: var(--bg-2); }
li span { color: var(--ink-2); font-size: 13px; }
code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; }
footer { margin-top: 56px; color: var(--ink-2); font-size: 13px; }
@media (max-width: 520px) {
  main { padding-top: 28px; }
  .hero { margin-top: 54px; }
  .grid { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<main>
<div class="top"><span class="wordmark">takoserver</span><div class="locale" role="group" aria-label="Language"><button type="button" data-locale="ja">日本語</button><button type="button" data-locale="en">English</button>${noScriptLocale_}</div></div>
<section class="hero">
<svg viewBox="0 0 34 34" width="44" height="44" shape-rendering="crispEdges" aria-hidden="true"><rect x="9" y="0" width="17" height="8" fill="var(--accent)"/><rect x="8" y="1" width="1" height="30" fill="var(--accent)"/><rect x="26" y="1" width="1" height="33" fill="var(--accent)"/><rect x="7" y="2" width="1" height="30" fill="var(--accent)"/><rect x="27" y="2" width="1" height="30" fill="var(--accent)"/><rect x="6" y="3" width="1" height="31" fill="var(--accent)"/><rect x="28" y="3" width="1" height="22" fill="var(--accent)"/><rect x="29" y="4" width="1" height="20" fill="var(--accent)"/><rect x="5" y="5" width="1" height="29" fill="var(--accent)"/><rect x="4" y="6" width="1" height="15" fill="var(--accent)"/><rect x="30" y="6" width="1" height="17" fill="var(--accent)"/><rect x="3" y="7" width="1" height="13" fill="var(--accent)"/><rect x="31" y="7" width="1" height="15" fill="var(--accent)"/><rect x="2" y="8" width="1" height="9" fill="var(--accent)"/><rect x="9" y="8" width="4" height="23" fill="var(--accent)"/><rect x="15" y="8" width="5" height="3" fill="var(--accent)"/><rect x="22" y="8" width="4" height="23" fill="var(--accent)"/><rect x="32" y="8" width="1" height="13" fill="var(--accent)"/><rect x="1" y="10" width="1" height="4" fill="var(--accent)"/><rect x="13" y="10" width="2" height="21" fill="var(--accent)"/><rect x="20" y="10" width="2" height="24" fill="var(--accent)"/><rect x="33" y="10" width="1" height="10" fill="var(--accent)"/><rect x="17" y="11" width="3" height="20" fill="var(--accent)"/><rect x="16" y="12" width="1" height="1" fill="var(--accent)"/><rect x="15" y="14" width="1" height="20" fill="var(--accent)"/><rect x="16" y="16" width="1" height="18" fill="var(--accent)"/><rect x="0" y="20" width="3" height="2" fill="var(--accent)"/><rect x="1" y="22" width="2" height="2" fill="var(--accent)"/><rect x="3" y="23" width="2" height="8" fill="var(--accent)"/><rect x="2" y="24" width="1" height="2" fill="var(--accent)"/><rect x="28" y="27" width="1" height="4" fill="var(--accent)"/><rect x="29" y="28" width="1" height="3" fill="var(--accent)"/><rect x="2" y="29" width="1" height="2" fill="var(--accent)"/><rect x="30" y="29" width="1" height="2" fill="var(--accent)"/><rect x="1" y="30" width="1" height="1" fill="var(--accent)"/><rect x="31" y="30" width="1" height="1" fill="var(--accent)"/><rect x="10" y="31" width="3" height="1" fill="var(--accent)"/><rect x="17" y="31" width="1" height="1" fill="var(--accent)"/><rect x="22" y="31" width="1" height="1" fill="var(--accent)"/><rect x="25" y="31" width="1" height="3" fill="var(--accent)"/><rect x="10" y="32" width="2" height="2" fill="var(--accent)"/><rect x="13" y="8" width="2" height="2" fill="var(--face)"/><rect x="20" y="8" width="2" height="2" fill="var(--face)"/><rect x="15" y="11" width="2" height="1" fill="var(--face)"/><rect x="15" y="12" width="1" height="2" fill="var(--face)"/><rect x="16" y="13" width="1" height="3" fill="var(--face)"/></svg>
<p class="eyebrow" data-i18n="eyebrow">${copy.eyebrow}</p>
<h1 data-i18n="headline">${copy.headline}</h1>
<p class="lede" data-i18n="lede">${copy.lede}</p>
${console_}
</section>
<section class="grid" aria-label="${copy.products}">
<article><h2 data-i18n="formTitle">${copy.formTitle}</h2><p data-i18n="formBody">${copy.formBody}</p></article>
<article><h2 data-i18n="holdTitle">${copy.holdTitle}</h2><p data-i18n="holdBody">${copy.holdBody}</p></article>
<article><h2 data-i18n="objectTitle">${copy.objectTitle}</h2><p data-i18n="objectBody">${copy.objectBody}</p></article>
<article><h2 data-i18n="meterTitle">${copy.meterTitle}</h2><p data-i18n="meterBody">${copy.meterBody}</p></article>
</section>
<section class="billing"><h2 data-i18n="billingTitle">${copy.billingTitle}</h2><p data-i18n="billingBody">${copy.billingBody}</p></section>
<ul>
<li><a href="${base}/openapi.json"><code>${base}/openapi.json</code><span data-i18n="api">${copy.api}</span></a></li>
<li><a href="${base}/.well-known/takoserver"><code>${base}/.well-known/takoserver</code><span data-i18n="product">${copy.product}</span></a></li>
<li><a href="${base}/.well-known/takoform/v1"><code>${base}/.well-known/takoform/v1</code><span data-i18n="host">${copy.host}</span></a></li>
</ul>
<footer>takoserver.com</footer>
</main>
<script>
const messages=${JSON.stringify(landingMessages)};
const localizedPaths=${String(options.apiOrigin !== null)};
const pathLocale=location.pathname.split("/")[1];
const setLocale=(locale,updatePath=false)=>{const lang=locale==="ja"?"ja":"en";document.documentElement.lang=lang;document.querySelector('meta[name="description"]').content=messages[lang].description;for(const node of document.querySelectorAll("[data-i18n]")){const value=messages[lang][node.dataset.i18n];if(value)node.textContent=value}for(const button of document.querySelectorAll("[data-locale]"))button.setAttribute("aria-pressed",String(button.dataset.locale===lang));try{localStorage.setItem("takoserver.locale",lang)}catch{}if(updatePath&&localizedPaths)history.replaceState(null,"","/"+lang+"/")};
let stored=null;try{stored=localStorage.getItem("takoserver.locale")}catch{}setLocale(pathLocale==="ja"||pathLocale==="en"?pathLocale:stored??(navigator.language.toLowerCase().startsWith("ja")?"ja":"en"));for(const button of document.querySelectorAll("[data-locale]"))button.addEventListener("click",()=>setLocale(button.dataset.locale,true));
</script>
</body>
</html>
`;
}
