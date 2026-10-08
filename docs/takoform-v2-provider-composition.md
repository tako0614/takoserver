# Programmatic Takoform v2 Form composition

Takoserver's normal `buildApp` can compose operator-selected, fully implemented
Takoform v2 Forms through `AppPorts.v2FormFactory`. This is a source-level
composition seam for a self-host or closed provider entry, not a public Form
installation endpoint or an environment variable that loads arbitrary code.

```ts
buildApp({
  // Existing SQL, object store, accounts, v2 config, and other AppPorts remain.
  v2FormFactory: ({ sql, objects, clock }) => ({
    [exactFormUrl]: createCompleteForm({ sql, objects, clock, provider }),
  }),
});
```

The synchronous factory only assembles adapters; it must not perform an
external resource mutation at startup. It runs once during application
construction with the same `Sql`, object store, and clock used by the public
Host and its background executor. Its exact-URL Form map is copied into one
immutable map alongside the configured built-in artifact Forms. Discovery,
support checks, HTTP acceptance,
and `tickTakoformV2()` all use that map; mutating the factory's returned map
later does not change the running application. Construction refuses a duplicate
built-in URL, an incomplete backend, or a malformed map. The existing Host
validates every exact Form URL and other HTTP configuration before serving.

The normal v2 HTTP path retains existing organization authentication, live
credential scope checks, SQL Resource/Operation acceptance, replay, and
reconciliation. It does not create another account system, cursor key, Host,
executor, or v1 translation lane. A provider Form must keep its backend ID and
target key stable across restarts so accepted Operations can be reconstructed
against the same authority. Removing a Form while its Resources or Operations
remain is not a cleanup operation: those records become temporarily
unmanageable until the exact backend is restored.

Only register a Form after its complete published create/read/update/delete and
dependency contract is implemented and qualified for the selected provider.
This seam alone does not mount a Worker Form, fetch code from a Form site,
install packages, verify signatures, authorize resale, or qualify a native
workerd implementation. Existing `v2` configuration still selects only its
three artifact-custody Forms unless an operator programmatically composes
additional complete backends.

## Normal Cloudflare Worker entry

The public Cloudflare Worker entry keeps one normal Takoform Host API v2, account
authority, SQL ledger, and scheduled executor. Operator code may select additional
complete Forms with `createWorkerEntry` from `@takoserver/core/worker-entry`:

```ts
import { createWorkerEntry } from "@takoserver/core/worker-entry";

export default createWorkerEntry({
  async composeV2Forms({ env, sql, objects, clock }) {
    // Inspect required schema and compose a complete private backend here.
    // Return only additional exact Form URL entries.
    return privateFormsFor(env, sql, objects, clock);
  },
});
```

This is an in-process, code-selected hook, not a request field, environment
selector, uploaded plug-in, or new public Form. The callback receives the exact
`env`, `Sql`, object store, and clock used by `buildApp`. It may await bounded,
read-only startup qualification; it must not mutate provider state during
composition. A concrete backend still owns its Form-specific admission,
execution, reconciliation, and native authority.

The callback returns a plain map keyed by exact HTTPS Form URL. The canonical
v2 application validates and snapshots it, rejects incomplete entries and
collisions with the configured built-in artifact Forms, then uses that same
snapshot for support and Operation execution. A missing callback retains the
existing three-artifact-form behavior. Each `createWorkerEntry` instance has its
own per-Env startup cache; simultaneous fetch and scheduled calls share one
composition. Failed composition is not cached, so a repaired environment may
retry; the ordinary Worker startup 503 envelope applies. A selected composer's
callback, Form-map validation, or backend-constructor exception text is not
returned to the caller. Existing no-composer configuration diagnostics remain
unchanged.

The hook creates no additional credential, private-input channel, or registry;
`env` remains the existing operator-owned Worker binding object and must not be
logged or returned to tenants. Composing a Form here does not itself qualify a
managed Worker runtime, offer supply, or authorize deployment.
