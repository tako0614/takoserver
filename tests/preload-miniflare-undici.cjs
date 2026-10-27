// Load the installed package, bypassing Bun's built-in Undici shim. This file
// also runs in Miniflare's synchronous HTTP thread, outside the test registry.
const { Module } = require("node:module");
const { dirname, join } = require("node:path");
const undici = require(join(dirname(require.resolve("undici/package.json")), "index.js"));
const originalFetch = undici.fetch;
const exportsWithClosedConnections = {
  ...undici,
  fetch(input, init) {
    const headers = new undici.Headers(
      init?.headers ?? (input instanceof undici.Request ? input.headers : undefined),
    );
    headers.set("connection", "close");
    return originalFetch(input, { ...init, headers });
  },
};
const cached = new Module("undici");
cached.exports = exportsWithClosedConnections;
cached.loaded = true;
require.cache.undici = cached;
module.exports = exportsWithClosedConnections;
