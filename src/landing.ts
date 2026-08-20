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
 * The document is functional without a second request. Web fonts are an
 * optional visual enhancement and have local fallbacks.
 */
export function landingHtml(options: LandingOptions): string {
  const base = options.apiOrigin ?? "";
  const primaryHref = options.consoleOrigin ?? `${base}/openapi.json`;
  const primaryLabel = options.consoleOrigin ? "Open Console" : "Read API";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Takoserver — portable cloud resources</title>
<meta name="description" content="An open-source Takoform Host for placing, connecting, metering, and moving provider-backed cloud resources.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&amp;family=IBM+Plex+Mono:wght@500&amp;display=swap" rel="stylesheet">
<style>
/* Hallmark · genre: modern-minimal · macrostructure: Map / Diagram · theme: Coral · enrichment: Tier-A CSS system map · nav: N9 · footer: Ft5 · audience: developers · use: open Console · tone: technical
 * pre-emit critique: P5 H4 E4 S5 R5 V4
 * audit: contrast: pass (40–41) · slop: pass (42–45) · honest: pass (46) · chrome: pass (47) · tokens: pass (48) · responsive: pass (34, 49–57) · icons: pass (30)
 */
:root {
  color-scheme: light;
  --color-paper: oklch(97% 0.012 68);
  --color-paper-strong: oklch(100% 0 0);
  --color-ink: oklch(22% 0.025 43);
  --color-ink-soft: oklch(44% 0.028 45);
  --color-rule: oklch(86% 0.025 62);
  --color-rule-strong: oklch(72% 0.045 52);
  --color-accent: oklch(68% 0.21 42);
  --color-accent-strong: oklch(45% 0.19 36);
  --color-accent-soft: oklch(92% 0.055 62);
  --color-focus: oklch(45% 0.18 245);
  --color-accent-ink: oklch(99% 0.004 70);
  --color-shadow: oklch(22% 0.025 43 / 0.12);
  --color-transparent: transparent;
  --font-display: "Geist", "Avenir Next", "Helvetica Neue", sans-serif;
  --font-body: "Geist", "Avenir Next", "Helvetica Neue", sans-serif;
  --font-mono: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
  --space-3xs: 0.25rem;
  --space-2xs: 0.5rem;
  --space-xs: 0.75rem;
  --space-sm: 1rem;
  --space-md: 1.5rem;
  --space-lg: 2.5rem;
  --space-xl: 4rem;
  --space-2xl: 6rem;
  --space-3xl: 8rem;
  --text-xs: 0.72rem;
  --text-sm: 0.86rem;
  --text-body: 1rem;
  --text-lede: clamp(1.05rem, 1.5vw, 1.3rem);
  --text-h2: clamp(2rem, 4.5vw, 4.5rem);
  --text-display: clamp(3rem, 5vw, 5.5rem);
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
  --dur-short: 160ms;
  --dur-medium: 240ms;
  --rule-hair: 1px;
  --rule-bold: 2px;
  --radius-sm: 0.45rem;
  --radius-md: 0.8rem;
  --page-gutter: clamp(1rem, 4vw, 4.5rem);
  --page-max: 92rem;
}

* { box-sizing: border-box; }
html, body { overflow-x: clip; }
html { background: var(--color-paper); scroll-behavior: smooth; }
body {
  margin: 0;
  min-width: 20rem;
  background: var(--color-paper);
  color: var(--color-ink);
  font-family: var(--font-body);
  font-size: var(--text-body);
  line-height: 1.55;
  letter-spacing: -0.012em;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; }
a:focus-visible {
  outline: var(--rule-bold) solid var(--color-focus);
  outline-offset: 4px;
}
.shell {
  width: min(100%, var(--page-max));
  margin-inline: auto;
  padding-inline: max(var(--page-gutter), env(safe-area-inset-left));
}
.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  min-height: 5.25rem;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  min-height: 2.75rem;
  color: var(--color-ink);
  font-family: var(--font-display);
  font-weight: 700;
  letter-spacing: -0.035em;
  text-decoration: none;
  white-space: nowrap;
  line-height: 1;
}
.brand-mark { width: 1.65rem; height: 1.65rem; flex: none; }
.brand-mark__head { fill: var(--color-accent); }
.brand-mark__line {
  fill: none;
  stroke: var(--color-accent);
  stroke-width: 2.4;
  stroke-linecap: square;
}
.button {
  display: inline-flex;
  min-height: 2.75rem;
  align-items: center;
  justify-content: center;
  padding-inline: var(--space-md);
  border: var(--rule-hair) solid var(--color-ink);
  border-radius: var(--radius-sm);
  background: var(--color-ink);
  color: var(--color-accent-ink);
  font-size: var(--text-sm);
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
  line-height: 1;
  transition: background-color var(--dur-short) var(--ease-out),
    border-color var(--dur-short) var(--ease-out),
    transform 100ms var(--ease-out);
}
.button:active { transform: translateY(1px); }
.button[aria-disabled="true"] {
  cursor: not-allowed;
  opacity: 0.55;
  pointer-events: none;
}
.button--quiet {
  border-color: var(--color-rule-strong);
  background: var(--color-transparent);
  color: var(--color-ink);
}
.hero {
  display: grid;
  min-height: clamp(36rem, 76dvh, 49rem);
  align-items: center;
  gap: var(--space-xl);
  padding-block: var(--space-xl) var(--space-2xl);
  border-block-start: var(--rule-hair) solid var(--color-rule);
}
.hero-copy { min-width: 0; }
.hero h1 {
  max-width: 11ch;
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-display);
  font-style: normal;
  font-weight: 700;
  line-height: 0.94;
  letter-spacing: -0.065em;
  overflow-wrap: anywhere;
  min-width: 0;
}
.hero-lede {
  max-width: 38rem;
  margin: var(--space-lg) 0 0;
  color: var(--color-ink-soft);
  font-size: var(--text-lede);
  line-height: 1.5;
}
.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  margin-block-start: var(--space-lg);
}
.signals {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2xs);
  margin-block-start: var(--space-xl);
}
.signal {
  padding: var(--space-3xs) var(--space-xs);
  border: var(--rule-hair) solid var(--color-rule-strong);
  border-radius: 999px;
  color: var(--color-ink-soft);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  letter-spacing: 0;
}
.system-map {
  position: relative;
  min-width: 0;
  margin: 0;
  padding: var(--space-sm);
  border: var(--rule-hair) solid var(--color-rule-strong);
  border-radius: var(--radius-md);
  background-color: var(--color-paper-strong);
  background-image: radial-gradient(var(--color-rule) var(--rule-hair), var(--color-transparent) var(--rule-hair));
  background-size: var(--space-md) var(--space-md);
  box-shadow: 0 1.5rem 4rem -3rem var(--color-shadow);
}
.system-map__legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  margin: 0 0 var(--space-sm);
  padding: 0 var(--space-xs);
  color: var(--color-ink-soft);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  letter-spacing: 0.02em;
}
.system-map__status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2xs);
  white-space: nowrap;
}
.system-map__status::before {
  width: 0.48rem;
  height: 0.48rem;
  border-radius: 50%;
  background: var(--color-accent);
  content: "";
}
.map-grid { display: grid; gap: var(--space-xs); }
.map-node {
  min-width: 0;
  padding: var(--space-md);
  border: var(--rule-hair) solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-paper);
}
.map-node--core { border-color: var(--color-accent); }
.map-node__type {
  display: block;
  margin-block-end: var(--space-xs);
  color: var(--color-ink-soft);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.map-node h2 {
  min-width: 0;
  margin: 0;
  font-size: 1.1rem;
  line-height: 1.15;
  letter-spacing: -0.035em;
  overflow-wrap: anywhere;
}
.map-node p {
  margin: var(--space-2xs) 0 0;
  color: var(--color-ink-soft);
  font-size: var(--text-sm);
}
.map-node__list {
  display: grid;
  gap: var(--space-2xs);
  margin: var(--space-sm) 0 0;
  padding: 0;
  list-style: none;
}
.map-node__list li {
  padding-block-start: var(--space-2xs);
  border-block-start: var(--rule-hair) solid var(--color-rule);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.map-flow {
  display: grid;
  min-height: 2rem;
  place-items: center;
  color: var(--color-accent-strong);
  font-family: var(--font-mono);
  font-weight: 600;
}
.map-flow::before { content: "↓"; }
.section {
  padding-block: var(--space-3xl);
  border-block-start: var(--rule-hair) solid var(--color-rule);
}
.section--compact { padding-block-end: var(--space-2xl); }
.section h2 {
  max-width: 14ch;
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-h2);
  font-style: normal;
  font-weight: 650;
  line-height: 0.98;
  letter-spacing: -0.055em;
  overflow-wrap: anywhere;
  min-width: 0;
}
.section-intro {
  max-width: 43rem;
  margin: var(--space-lg) 0 0;
  color: var(--color-ink-soft);
  font-size: var(--text-lede);
}
.lanes { margin-block-start: var(--space-2xl); }
.lane {
  display: grid;
  gap: var(--space-sm);
  padding-block: var(--space-lg);
  border-block-start: var(--rule-hair) solid var(--color-rule-strong);
}
.lane:last-child { border-block-end: var(--rule-hair) solid var(--color-rule-strong); }
.lane h3 {
  min-width: 0;
  margin: 0;
  font-size: clamp(1.25rem, 2.7vw, 2rem);
  line-height: 1.1;
  letter-spacing: -0.04em;
  overflow-wrap: anywhere;
}
.lane p { max-width: 42rem; margin: 0; color: var(--color-ink-soft); }
.lane code {
  align-self: start;
  justify-self: start;
  padding: var(--space-3xs) var(--space-2xs);
  border-radius: var(--radius-sm);
  background: var(--color-accent-soft);
  color: var(--color-accent-strong);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.model {
  display: grid;
  gap: 0;
  margin-block-start: var(--space-2xl);
  border-block-start: var(--rule-bold) solid var(--color-ink);
}
.model-row {
  display: grid;
  gap: var(--space-xs);
  padding-block: var(--space-md);
  border-block-end: var(--rule-hair) solid var(--color-rule);
}
.model-row dt {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: 500;
}
.model-row dd { margin: 0; color: var(--color-ink-soft); }
.migration {
  display: grid;
  gap: var(--space-xs);
  margin-block-start: var(--space-2xl);
}
.migration-step {
  position: relative;
  padding: var(--space-md);
  border: var(--rule-hair) solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-paper-strong);
}
.migration-step strong { display: block; font-size: 1rem; }
.migration-step span {
  display: block;
  margin-block-start: var(--space-2xs);
  color: var(--color-ink-soft);
  font-size: var(--text-sm);
}
.migration-step--active { border-color: var(--color-accent); }
.migration-step--active::after {
  position: absolute;
  inset-block-start: var(--space-sm);
  inset-inline-end: var(--space-sm);
  width: 0.52rem;
  height: 0.52rem;
  border-radius: 50%;
  background: var(--color-accent);
  content: "";
}
.developer-links {
  display: grid;
  margin-block-start: var(--space-2xl);
  border-block-start: var(--rule-bold) solid var(--color-ink);
}
.developer-row {
  display: grid;
  gap: var(--space-2xs);
  padding-block: var(--space-md);
  border-block-end: var(--rule-hair) solid var(--color-rule);
}
.developer-row code {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.developer-row span { color: var(--color-ink-soft); font-size: var(--text-sm); }
.developer-action {
  align-self: center;
  justify-self: start;
  min-height: 2.75rem;
  display: inline-flex;
  align-items: center;
  color: var(--color-accent-strong);
  font-size: var(--text-sm);
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}
.closing {
  padding-block: var(--space-3xl) var(--space-2xl);
  border-block-start: var(--rule-hair) solid var(--color-rule);
}
.closing p {
  max-width: 14ch;
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(2.5rem, 7vw, 6.8rem);
  font-weight: 700;
  line-height: 0.93;
  letter-spacing: -0.06em;
  overflow-wrap: anywhere;
  min-width: 0;
}
.footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  padding-block: var(--space-lg) max(var(--space-lg), env(safe-area-inset-bottom));
  border-block-start: var(--rule-bold) solid var(--color-ink);
  color: var(--color-ink-soft);
  font-size: var(--text-sm);
}
.footer-links { display: flex; flex-wrap: wrap; gap: var(--space-md); }
.footer a { min-height: 2.75rem; display: inline-flex; align-items: center; line-height: 1; white-space: nowrap; }
a:active { color: var(--color-accent-strong); }
@media (hover: hover) and (pointer: fine) {
  .brand:hover, .footer a:hover { color: var(--color-accent-strong); }
  .button:hover { background: var(--color-accent-strong); border-color: var(--color-accent-strong); }
  .button--quiet:hover { background: var(--color-accent-soft); color: var(--color-accent-strong); }
  .developer-action:hover { color: var(--color-ink); }
}
@media (pointer: coarse) {
  .button, .developer-action, .footer a { min-height: 3rem; }
}
@media (min-width: 40rem) {
  .lane { grid-template-columns: minmax(0, 0.75fr) minmax(0, 1.45fr); align-items: start; }
  .lane code { grid-column: 2; }
  .model-row { grid-template-columns: minmax(8rem, 0.6fr) minmax(0, 1.4fr); }
  .migration { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .developer-row { grid-template-columns: minmax(0, 1.25fr) minmax(0, 0.75fr) auto; align-items: center; }
}
@media (min-width: 60rem) {
  .hero { grid-template-columns: minmax(0, 0.9fr) minmax(32rem, 1.1fr); gap: var(--space-xl); }
  .map-grid { grid-template-columns: minmax(0, 1fr) var(--space-lg) minmax(0, 1.14fr) var(--space-lg) minmax(0, 1fr); align-items: stretch; }
  .map-flow::before { content: "→"; }
  .section-intro { margin-inline-start: 34%; }
  .lanes, .model, .migration, .developer-links { margin-inline-start: 17%; }
}
@media (min-width: 90rem) {
  .hero { gap: var(--space-2xl); }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .button { transition: none; }
  .button:active { transform: none; }
}
</style>
</head>
<body>
<div class="shell">
  <nav class="nav" aria-label="Primary navigation">
    <a class="brand" href="/" aria-label="Takoserver home">
      <svg class="brand-mark" viewBox="0 0 28 28" aria-hidden="true">
        <rect class="brand-mark__head" x="7" y="3" width="14" height="10" rx="2"/>
        <path class="brand-mark__line" d="M8 12v8c0 3-4 2-4 5M12 12v10c0 3-2 3-2 3M16 12v10c0 3 2 3 2 3M20 12v8c0 3 4 2 4 5"/>
      </svg>
      <span>Takoserver</span>
    </a>
    <a class="button" href="${primaryHref}">${primaryLabel}</a>
  </nav>

  <main>
    <section class="hero">
      <div class="hero-copy">
        <h1>Declare resources. Choose where they run.</h1>
        <p class="hero-lede">Takoserver is an open-source Takoform Host that places logical resources on provider-backed deployments, resolves scoped attachments, and meters what runs.</p>
        <div class="hero-actions">
          <a class="button" href="${primaryHref}">${primaryLabel}</a>
          <a class="button button--quiet" href="${base}/openapi.json">Read API</a>
        </div>
        <div class="signals" aria-label="Product characteristics">
          <span class="signal">Takoform v1alpha3</span>
          <span class="signal">Open source</span>
          <span class="signal">Self-hostable</span>
        </div>
      </div>

      <figure class="system-map">
        <figcaption class="system-map__legend">
          <span>resource routing</span>
          <span class="system-map__status">explicit placement</span>
        </figcaption>
        <div class="map-grid">
          <article class="map-node">
            <span class="map-node__type">Takoform Form</span>
            <h2>ObjectBucket</h2>
            <p>Portable resource meaning, not a provider SKU.</p>
          </article>
          <div class="map-flow" aria-hidden="true"></div>
          <article class="map-node map-node--core">
            <span class="map-node__type">Takoserver control plane</span>
            <h2>Place · attach · meter</h2>
            <ul class="map-node__list">
              <li>Offering catalog</li>
              <li>Deployment state</li>
              <li>Scoped grants</li>
            </ul>
          </article>
          <div class="map-flow" aria-hidden="true"></div>
          <article class="map-node">
            <span class="map-node__type">Provider execution</span>
            <h2>Provider packs</h2>
            <ul class="map-node__list">
              <li>Cloudflare</li>
              <li>Wasabi</li>
              <li>Self-hosted</li>
            </ul>
          </article>
        </div>
      </figure>
    </section>

    <section class="section" aria-labelledby="lanes-title">
      <h2 id="lanes-title">One control plane. Two clean lanes.</h2>
      <p class="section-intro">Infrastructure meaning belongs in Takoform. Protocols that are already standard stay ordinary data services.</p>
      <div class="lanes">
        <article class="lane">
          <h3>Infrastructure through Takoform</h3>
          <p>Exact Form references describe the resource. Offerings choose supply. Deployments record where it actually runs.</p>
          <code>Form → Offering → Deployment</code>
        </article>
        <article class="lane">
          <h3>Standard APIs stay standard</h3>
          <p>S3-compatible object access and OpenAI-compatible inference remain direct APIs with short-lived, resource-scoped authority.</p>
          <code>S3 · OpenAI</code>
        </article>
      </div>
    </section>

    <section class="section" aria-labelledby="model-title">
      <h2 id="model-title">The resource is not the provider.</h2>
      <p class="section-intro">Takoserver keeps meaning, supply, realization, connection, and movement separate so one concern can change without rewriting the rest.</p>
      <dl class="model">
        <div class="model-row"><dt>Form</dt><dd>What the resource means.</dd></div>
        <div class="model-row"><dt>Offering</dt><dd>Which provider pack, installation, region, and commercial terms can supply it.</dd></div>
        <div class="model-row"><dt>Deployment</dt><dd>One provider-native realization of the logical resource.</dd></div>
        <div class="model-row"><dt>Attachment</dt><dd>A scoped connection between independent resources without embedding credentials in outputs.</dd></div>
        <div class="model-row"><dt>Migration</dt><dd>An explicit cutover between source and candidate Deployments, with a retained rollback window.</dd></div>
      </dl>
    </section>

    <section class="section section--compact" aria-labelledby="migration-title">
      <h2 id="migration-title">Change placement, not identity.</h2>
      <p class="section-intro">A provider move is a lifecycle, not an opaque update. Attachments follow the active Deployment after verification.</p>
      <div class="migration" aria-label="Deployment migration states">
        <div class="migration-step migration-step--active"><strong>Active</strong><span>The current provider realization keeps serving.</span></div>
        <div class="migration-step"><strong>Candidate</strong><span>Provision, transfer, and verify independently.</span></div>
        <div class="migration-step"><strong>Retained</strong><span>Cut over, re-resolve Attachments, preserve rollback.</span></div>
      </div>
    </section>

    <section class="section" aria-labelledby="developer-title">
      <h2 id="developer-title">Start from the contract.</h2>
      <p class="section-intro">The product describes itself over stable discovery and OpenAPI surfaces. No dashboard archaeology required.</p>
      <div class="developer-links">
        <div class="developer-row"><code>${base}/openapi.json</code><span>HTTP API description</span><a class="developer-action" href="${base}/openapi.json">Open schema</a></div>
        <div class="developer-row"><code>${base}/.well-known/takoserver</code><span>Takoserver discovery</span><a class="developer-action" href="${base}/.well-known/takoserver">Read discovery</a></div>
        <div class="developer-row"><code>${base}/.well-known/takoform/v1alpha3</code><span>Takoform Host discovery</span><a class="developer-action" href="${base}/.well-known/takoform/v1alpha3">Read host contract</a></div>
      </div>
    </section>

    <section class="closing" aria-label="Closing statement">
      <p>Keep the resource. Change where it runs.</p>
    </section>
  </main>

  <footer class="footer">
    <span>Takoserver · open-source cloud control plane</span>
    <span class="footer-links">
      <a href="${base}/openapi.json">OpenAPI</a>
      <a href="${base}/.well-known/takoserver">Discovery</a>
    </span>
  </footer>
</div>
</body>
</html>
`;
}
