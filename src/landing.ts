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
}

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
  const consoleOrigin = options.consoleOrigin;
  const console_ = consoleOrigin
    ? `<a class="cta" href="${consoleOrigin}">Open the console</a>`
    : "";
  const base = options.apiOrigin ?? "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Takoserver</title>
<meta name="description" content="A prepaid resource platform. Declare infrastructure with Takoform.">
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
h1 { margin: 22px 0 0; font-size: 34px; font-weight: 600; letter-spacing: -0.035em; }
p.lede { margin: 12px 0 0; color: var(--ink-2); font-size: 16px; max-width: 34rem; }
.cta {
  display: inline-flex; align-items: center; margin-top: 28px; padding: 9px 16px;
  border-radius: 6px; background: var(--accent); color: #fff;
  font-size: 14px; font-weight: 500; text-decoration: none;
}
.cta:hover { filter: brightness(1.08); }
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
</style>
</head>
<body>
<main>
<svg viewBox="0 0 34 34" width="44" height="44" shape-rendering="crispEdges" aria-hidden="true"><rect x="9" y="0" width="17" height="8" fill="var(--accent)"/><rect x="8" y="1" width="1" height="30" fill="var(--accent)"/><rect x="26" y="1" width="1" height="33" fill="var(--accent)"/><rect x="7" y="2" width="1" height="30" fill="var(--accent)"/><rect x="27" y="2" width="1" height="30" fill="var(--accent)"/><rect x="6" y="3" width="1" height="31" fill="var(--accent)"/><rect x="28" y="3" width="1" height="22" fill="var(--accent)"/><rect x="29" y="4" width="1" height="20" fill="var(--accent)"/><rect x="5" y="5" width="1" height="29" fill="var(--accent)"/><rect x="4" y="6" width="1" height="15" fill="var(--accent)"/><rect x="30" y="6" width="1" height="17" fill="var(--accent)"/><rect x="3" y="7" width="1" height="13" fill="var(--accent)"/><rect x="31" y="7" width="1" height="15" fill="var(--accent)"/><rect x="2" y="8" width="1" height="9" fill="var(--accent)"/><rect x="9" y="8" width="4" height="23" fill="var(--accent)"/><rect x="15" y="8" width="5" height="3" fill="var(--accent)"/><rect x="22" y="8" width="4" height="23" fill="var(--accent)"/><rect x="32" y="8" width="1" height="13" fill="var(--accent)"/><rect x="1" y="10" width="1" height="4" fill="var(--accent)"/><rect x="13" y="10" width="2" height="21" fill="var(--accent)"/><rect x="20" y="10" width="2" height="24" fill="var(--accent)"/><rect x="33" y="10" width="1" height="10" fill="var(--accent)"/><rect x="17" y="11" width="3" height="20" fill="var(--accent)"/><rect x="16" y="12" width="1" height="1" fill="var(--accent)"/><rect x="15" y="14" width="1" height="20" fill="var(--accent)"/><rect x="16" y="16" width="1" height="18" fill="var(--accent)"/><rect x="0" y="20" width="3" height="2" fill="var(--accent)"/><rect x="1" y="22" width="2" height="2" fill="var(--accent)"/><rect x="3" y="23" width="2" height="8" fill="var(--accent)"/><rect x="2" y="24" width="1" height="2" fill="var(--accent)"/><rect x="28" y="27" width="1" height="4" fill="var(--accent)"/><rect x="29" y="28" width="1" height="3" fill="var(--accent)"/><rect x="2" y="29" width="1" height="2" fill="var(--accent)"/><rect x="30" y="29" width="1" height="2" fill="var(--accent)"/><rect x="1" y="30" width="1" height="1" fill="var(--accent)"/><rect x="31" y="30" width="1" height="1" fill="var(--accent)"/><rect x="10" y="31" width="3" height="1" fill="var(--accent)"/><rect x="17" y="31" width="1" height="1" fill="var(--accent)"/><rect x="22" y="31" width="1" height="1" fill="var(--accent)"/><rect x="25" y="31" width="1" height="3" fill="var(--accent)"/><rect x="10" y="32" width="2" height="2" fill="var(--accent)"/><rect x="13" y="8" width="2" height="2" fill="var(--face)"/><rect x="20" y="8" width="2" height="2" fill="var(--face)"/><rect x="15" y="11" width="2" height="1" fill="var(--face)"/><rect x="15" y="12" width="1" height="2" fill="var(--face)"/><rect x="16" y="13" width="1" height="3" fill="var(--face)"/></svg>
<h1>Takoserver</h1>
<p class="lede">A prepaid resource platform. Declare what you need with Takoform,
fund a wallet, and pay only for what is actually provisioned.</p>
${console_}
<ul>
<li><a href="${base}/openapi.json"><code>${base}/openapi.json</code><span>API description</span></a></li>
<li><a href="${base}/.well-known/takoserver"><code>${base}/.well-known/takoserver</code><span>Product discovery</span></a></li>
<li><a href="${base}/.well-known/takoform/v1alpha3"><code>${base}/.well-known/takoform/v1alpha3</code><span>Takoform Host discovery</span></a></li>
</ul>
<footer>takoserver.com</footer>
</main>
</body>
</html>
`;
}
