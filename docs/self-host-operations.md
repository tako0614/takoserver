# Self-host backup and restore preparation

This procedure prepares a cold copy of one Bun self-host installation. It is
not a tested disaster-recovery guarantee: the repository has no operator
snapshot/restore command, no restore mode that suppresses startup work, and no
full live-operator restore drill. The test below proves only that selected
local readers can reopen a copied fixture.

## What belongs to one installation

Back up the complete configured `TAKOSERVER_DATA_ROOT` as one unit (default:
`.takoserver`). Do not assemble a backup from a hand-picked list of files. The
root contains the local control database by default, object bytes and their
metadata, customer SQL databases, published Worker bundles and active
deployment data, self-host resource and event state, runtime probes, and
private signing keys. Paths such as `objects/`, `databases/`, `workers/`,
`selfhost/`, and `runtime-probes/` are implementation details; retaining the
whole root also retains paths added by later versions.

`TAKOSERVER_DB` can put `control.sqlite` outside the data root. If it is set,
that exact database is part of the backup set too. A backup is incomplete if
either the root or that database is missing.

The running configuration may also depend on material outside the root. Record
the exact service configuration and protect any configured external values or
files needed to recover the same identity and capabilities, including TLS
certificate/private-key files, `TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING`,
operator-supplied signing keys, and configured provider, payment, identity, or
AI credentials. Do not put secret values in this repository or in a backup
manifest. `TAKOSERVER_WORKERD_BINARY` must still resolve to the exact accepted
artifact for Worker execution; the selected snapshot is retained under the
data root, but startup validates and selects from the configured input path.
Preserve that artifact and its path/configuration through the operator's
protected mechanism. Keep external configuration and secrets at least as
carefully as the data root; the database and files contain customer and
credential-bearing state.

## Cold snapshot

1. Choose a protected destination with enough free space for the whole root and
   any external `TAKOSERVER_DB`. Use a destination that is not served by the
   source host.
2. Stop the Takoserver service through its actual supervisor and wait until
   `entry-bun.ts`, its child `workerd`, and any other process configured to
   write this data has exited. A graceful stop is not enough until all writers
   are gone. The Bun entry starts queue delivery and cron timers and restores
   published Workers automatically at startup; there is no read-only boot
   switch for a copy.
3. With the installation quiescent, make a filesystem copy of the complete
   data root to the protected destination, preserving file contents,
   directories, and restrictive permissions. If `TAKOSERVER_DB` is outside the
   root, copy its main file and any existing SQLite `-wal`, `-shm`, or rollback
   journal sidecars in the same stopped window. Do not copy a live SQLite file,
   copy only its main file while sidecars may be changing, or guess which
   sidecars can be omitted. This procedure intentionally requires a
   stopped-and-quiescent installation rather than promising a live snapshot.
4. Record outside the secret-bearing files which source instance and time the
   copy represents, the resolved data-root and database paths, the product
   commit, and the configured external dependency references needed to locate
   recovery material. Do not record credentials themselves.
5. Keep the source stopped until the copy has completed. Then restart only the
   original instance if it is still the active installation.

## Restore boundary

Restoring the files is not a safe way to validate a clone. Starting
`bun src/entry-bun.ts` on a restored copy is an active operation: it opens and
may migrate SQLite, restores published Worker routing, starts the public
listener, and starts queue/cron delivery. There is no supported mode that
guarantees an isolated clone cannot accept resource writes or replay pending
work. Do not start a restored copy while the source can still serve or deliver
events, and do not attach both copies to the same public origin, runtime
endpoint, external services, or tenant traffic.

For an actual recovery, first fence the source instance and all its writers and
confirm they cannot return. Restore the complete root and any external database
to the intended replacement, reinstate its protected configuration and
required secrets, and verify that only the replacement owns the installation's
network identity before starting it. Use a product build that understands the
database's recorded migration history: SQLite upgrades are forward-only, and a
build that does not know a recorded migration refuses the database rather than
downgrading it. A restart may deliver queued work; treat that as resuming the
installation, not as a no-write restore check. If source fencing, ownership of
the public identity, or the fate of pending operations is uncertain, leave the
restored copy stopped and resolve that uncertainty before activation.

The automated test `tests/self-host-backup-restore.test.ts` copies a disposable
fixture after closing its SQLite connection, then reopens the copied database,
object store, and published Worker files through their current readers. It does
not boot the entrypoint, prove a complete installation restore, exercise
external credentials or services, test a real filesystem snapshot, or replace
an operator recovery drill.
