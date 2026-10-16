/**
 * Captures the real Console's Resources page for the public site.
 *
 *   bun scripts/capture-site-console.ts
 *
 * The Console bundle is built from this checkout and served next to a stub
 * Host that answers with fictional, public sample data: one organization and
 * the Resources of the "hello" Worker that the site walks through. No account,
 * credential or real Host is used. Requires /usr/bin/google-chrome.
 *
 * Writes site/screens/console-{desktop,tablet,mobile}-{light,dark}-{en,ja}.webp.
 * Desktop is the whole 1200 x 750 viewport; tablet is 820 x 700, a tablet's
 * portrait width, which the page shows between phone and desktop widths so
 * the Console is not shrunk to two thirds there; mobile is 390 x 780, a
 * phone's width, so its text stays legible in the page. All are captured at
 * device scale 2.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

const outputDir = "site/screens";
const tempDir = mkdtempSync(join(tmpdir(), "takoserver-console-capture-"));
const bundleDir = join(tempDir, "bundle");
const port = 4188;
const debugPort = 9344;
const origin = `http://127.0.0.1:${port}`;
const organizationId = "org_sample";
const now = Date.now();
const forms = "https://edge.forms.takoform.com/forms";

const resources = [
  sample("hello", "ModuleWorker/0.3.0", 9, {}),
  sample("hello-bundle-v1", "WorkerBundle/0.2.0", 9, {
    entrypoint: "worker.js",
    fileCount: 1,
    totalBytes: 80,
  }),
  sample("hello-version-v1", "WorkerVersion/0.5.0", 8, {}),
  sample("hello-deployment", "WorkerDeployment/0.4.0", 8, {}),
  sample(
    "hello-endpoint",
    "WorkerEndpoint/0.3.0",
    7,
    { hostname: "hello.apps.example.com" },
    { hostname: "hello.apps.example.com" },
  ),
  sample("notes", "SQLiteDatabase/0.2.0", 26, { databaseExists: true }),
];

function sample(
  name: string,
  form: string,
  minutesAgo: number,
  observed: Record<string, unknown>,
  output: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    uid: `sample-${name}`,
    form: `${forms}/${form}/`,
    space: organizationId,
    name,
    generation: 1,
    observedGeneration: 1,
    observedAt: new Date(now - minutesAgo * 60_000).toISOString(),
    phase: "idle",
    spec: {},
    observed,
    output,
    lastOperation: `sample-operation-${name}`,
  };
}

const build = spawnSync("bun", ["scripts/build-console.ts", "--out", bundleDir], {
  stdio: "inherit",
});
if (build.status !== 0) throw new Error(`Console build exited with status ${build.status}`);
mkdirSync(outputDir, { recursive: true });

const files: Record<string, string> = {
  "/console.js": "console.js",
  "/app.css": "app.css",
  "/favicon.svg": "favicon.svg",
};
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/me") {
      return Response.json({
        principal: {
          id: "sample-principal",
          provider: "sample",
          email: "operator@example.invalid",
          displayName: "Sample Operator",
        },
        organizations: [
          {
            id: organizationId,
            name: "Sample organization",
            ownerPrincipalId: "sample-principal",
            createdAt: new Date(now - 86_400_000).toISOString(),
          },
        ],
      });
    }
    if (url.pathname === "/apis/forms.takoform.com/v2/resources") {
      return Response.json({ items: resources, nextCursor: null });
    }
    if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/apis/")) {
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    }
    const file = files[url.pathname] ?? "index.html";
    return new Response(Bun.file(join(bundleDir, file)), {
      headers: {
        "content-type": types[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  },
});

const chrome = spawn(
  "/usr/bin/google-chrome",
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${join(tempDir, "profile")}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let socket: WebSocket | undefined;
try {
  const page = await waitForPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  socket = ws;
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (e: Error) => void }
  >();
  const listeners = new Map<string, (params: unknown) => void>();
  const errors: string[] = [];
  let sequence = 0;
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiting?.reject(new Error(JSON.stringify(message.error)));
      else waiting?.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      errors.push(message.params.exceptionDetails.text);
    }
    listeners.get(message.method)?.(message.params);
    listeners.delete(message.method);
  });
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve: (value) => resolve(value as Record<string, unknown>), reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const event = (name: string) => new Promise((resolve) => listeners.set(name, resolve));
  const evaluate = async <Value>(expression: string): Promise<Value> => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return (result.result as { value: Value }).value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  // One warm-up load so the first capture lays out like the rest.
  const warm = event("Page.loadEventFired");
  await send("Page.navigate", { url: `${origin}/resources` });
  await warm;
  for (const locale of ["en", "ja"] as const) {
    for (const [shape, width, height] of [
      ["desktop", 1200, 750],
      ["tablet", 820, 700],
      ["mobile", 390, 780],
    ] as const) {
      for (const theme of ["light", "dark"] as const) {
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 2,
          mobile: false,
        });
        await send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }],
        });
        const setup = await send("Page.addScriptToEvaluateOnNewDocument", {
          source: `localStorage.setItem("takoserver.session","cookie");localStorage.setItem("takoserver.organization","${organizationId}");localStorage.setItem("takoserver.theme","${theme}");localStorage.setItem("takoserver.console.locale","${locale}");`,
        });
        const loaded = event("Page.loadEventFired");
        await send("Page.navigate", { url: `${origin}/resources` });
        await loaded;
        const deadline = Date.now() + 12_000;
        while (
          !(await evaluate<boolean>(
            `document.fonts.ready.then(() => document.querySelectorAll('.table-scroll tbody tr').length === ${resources.length})`,
          ))
        ) {
          if (Date.now() > deadline) throw new Error("Console resource rows did not render");
          await Bun.sleep(100);
        }
        const rendered = await evaluate<{
          rows: number;
          applied: number;
          viewport: [number, number];
          pageWidth: number;
          theme: string;
          lang: string;
        }>(
          `({ rows: document.querySelectorAll('.table-scroll tbody tr').length, applied: [...document.querySelectorAll('.table-scroll tbody tr')].filter(row => /Applied|反映済み/.test(row.innerText)).length, viewport: [innerWidth, innerHeight], pageWidth: document.documentElement.scrollWidth, theme: document.documentElement.dataset.theme, lang: document.documentElement.lang })`,
        );
        if (
          rendered.applied !== resources.length ||
          rendered.viewport[0] !== width ||
          rendered.viewport[1] !== height ||
          rendered.pageWidth > width ||
          rendered.theme !== theme
        ) {
          throw new Error(`Unexpected rendered Console: ${JSON.stringify(rendered)}`);
        }
        const shot = await send("Page.captureScreenshot", {
          format: "webp",
          quality: 90,
          fromSurface: true,
          captureBeyondViewport: false,
        });
        const name = `console-${shape}-${theme}-${locale}.webp`;
        await Bun.write(join(outputDir, name), Buffer.from(String(shot.data), "base64"));
        await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: setup.identifier });
        process.stdout.write(`${name}: ${width}x${height}, ${rendered.rows} sample rows\n`);
      }
    }
  }
  if (errors.length > 0) throw new Error(`Console runtime errors: ${errors.join("\n")}`);
} finally {
  socket?.close();
  chrome.kill("SIGTERM");
  server.stop(true);
  rmSync(tempDir, { recursive: true, force: true });
}

async function waitForPage(): Promise<{ webSocketDebuggerUrl: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      const page = pages.find((entry) => entry.type === "page");
      if (page) return page;
    } catch {
      // Chrome is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error("Chrome DevTools endpoint did not start");
}
