# Self-host V2 SQLite Worker binding (internal implementation note)

This is an internal connection between the published WorkerVersion 0.5.0
`sqliteBindings` reference and SQLiteDatabase 0.2.0. The published Forms remain
the contract; this note does not add a Form, SQL capability, or public API.

The normal composition must create a `createSQLiteWorkerBindingAuthority` from
the V2 Core SQL and exact SQLite target key. It must inject that resolver, the
UID-native store, a private persistent signing key, the native owner's
`observeVersionTarget`, and a complete current-publication graph readback into
`createSelfhostV2SqliteBindingBroker`. The graph readback must prove that the
accepted WorkerVersion Resource UID still maps to the selected native
`versionId` for the same Worker UID, incarnation, and serving source Operation.
Neither an in-memory registration nor a caller-supplied version name is proof.

At publication, the Host may issue one signed per-Version grant with exact
principal, Space, target, Worker UID, WorkerVersion UID, native version ID,
incarnation, serving source Operation, and the accepted SQLite Binding
name-to-Resource-UID map. The grant is stored only on workerd's Host-private
companion service. The tenant service receives only `env[name]` with
`execute`, `query`, and `transaction`; it gets no bearer, address, raw SQLite
handle, `close`, or migration authority. The execution-copy adapter adds V2
argument-shape `TypeError` behavior without changing the retained V1 SQL facade.
Composition must choose two collision-free root-level `.js` module names for
the adapter and its captured-intrinsics helper, then add both returned modules
and their JavaScript media types to the execution copy before graph compilation.
The adapter keeps the original main module's named exports, including any
Actor or Workflow class export used by a separate native bootstrap; its own
default export alone wraps the declared Worker handlers.

Every SQL call rechecks the native selected Version and Core current graph, the
settled Version/Operation and sealed exact reference set, the active edge, and
the current settled SQLiteDatabase/Operation. The grant identifies the DB by
UID, not by generation: a same-spec `{}` PUT is unavailable while pending, then
continues on the same UID without Version republishing. The captured current
vector is rechecked before and after native execution under the store's UID
mutex. The store additionally proves the private sidecar belongs to that UID
and exact accepted create Operation. Only then does the native SQL plane own a
connection with its authorizer and exact `_takoform_sqlite_migrations` ledger
identity. A lost response after a native SQL effect is not proof of non-effect;
callers must not infer that `backend_unavailable` means their SQL did not run.

This packet proves the broker/projection seam with a real pinned workerd child
and a real UID-owned SQLite file. It is not a claim that normal V2 publication
composition has been wired, or that Cloud, all Worker Forms, or every published
SQLiteDatabase 0.2.0 behavior is qualified. The production composition must
provide the persistent signing key and exact graph resolver; test stubs for
those ports are never authority.

The Host-private companion streams SQL requests separately from the retained
40 MiB KV/Queue JSON path. The SQLite broker first stages an input larger than
1 MiB beneath an operator-selected private root, opens a mode-0600 file in a
fresh mode-0700 call directory, then unlinks the file before reading it through
its private descriptor. Normal, malformed, and interrupted calls close that
descriptor and remove their own directory; process death cannot leave named SQL
input bytes, although an empty directory may remain. Each staged statement is
read and executed in order under one UID lock and SQLite transaction, with the
published combined-output limit checked before commit.

The native 42-by-1-MB transaction journey now succeeds. This does not establish
the full maximum legal input size: the Worker adapter still serializes a whole
call to JSON before sending it, and resource exhaustion may return
`backend_unavailable`. Do not advertise full SQLiteDatabase 0.2.0 support from
this bounded evidence alone.
