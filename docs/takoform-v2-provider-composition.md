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
