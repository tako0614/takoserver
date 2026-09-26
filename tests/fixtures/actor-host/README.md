# Native Actor class execution slice

This is a local qualification fixture for the unadmitted Takoserver-specific
class execution adapter in `src/actor-native-class-execution.ts`. It does not
publish or amend a Form, extend Host API v1, enable Actor admission, or qualify
production Actor support. The existing child-only class helper owns the
constructor/context/start/fetch seam; the new adapter supplies private SQL.

`counter.mjs` is ordinary application code with a synchronous constructor,
awaited initialization, and fetch. `witness.mjs` adds application-side assertions
without native imports. The host-private native class is constructed separately
in the test, gives it only the selected environment and SQL facade, and runs in
a native facet. Application code cannot import the wrapper or native builtins.

Run from the product root with an explicitly selected local native artifact:

```sh
TAKOSERVER_ACTOR_QUALIFICATION_BINARY=/absolute/path/to/workerd \
TAKOSERVER_ACTOR_QUALIFICATION_SHA256=<exact-sha256> \
  bun test tests/workerd-native-actor-class.test.ts
bun test tests/actor-class-execution.test.ts tests/actor-native-class-execution.test.ts
```

The opt-in test copies the binary to its temporary private root and verifies
those bytes before execution. This arbitrary candidate opt-in is **test-only**:
it never changes or bypasses the production artifact selector. With no candidate
configured, this native test is skipped, not counted as native evidence.

Coverage includes initialization order, private per-ID SQL, committed batches,
atomic failure, unconditional query rollback (including DDL), binary values,
denied explicit SQL transaction control, absence of the supervisor's metadata
table, concurrent increments through a real namespace binding, cross-ID progress,
facet reconstruction, and durable data after a quiescent process kill/restart.
SQL projection follows the released Actor operation error sets and EdgeSqlValue
numeric domain. Statement, parameter, transaction, row, column, UTF-8 value, and
materialized-result limits are checked before commit. The lexical boundary
rejects multiple statements while admitting Actor-owned schema and trigger
bodies; SQLite remains the syntax parser. Native regression covers constraint
errors, numeric/output rollback, and trigger side effects rolled back by query.
The adapter unit test also checks that the original streaming Response passes
through without being consumed or buffered.

The supervisor's `blockConcurrencyWhile` and bounded response consumption are
fixture machinery for this Counter, **not a production scheduler**. This proves
ordered Counter execution in that fixture only. It is not proof of distributed
single-context ownership, in-flight process-death recovery, streaming admission
lifetime, asynchronous constructor confinement, deployment/weighted-Version
selection, or safe production handoff. The adapter itself deliberately owns none
of those mechanisms and must not be admitted before its execution owner supplies
them. This direct fixture does not wire an alarm owner, so it is not
alarm-delivery evidence. The actual self-host owner alarm path is exercised in
`tests/selfhost-actor-execution-host.test.ts`; socket and WfP support remain
unavailable. No tenant source executes in the controller process.

Regression sensitivity was checked by temporarily moving the query rollback
outside the native transaction: the native test exposed the surviving
`query_must_rollback` table and the unit test exposed an extra row. Restoring the
rollback restored both tests. This observation is test evidence, not release
authorization.
