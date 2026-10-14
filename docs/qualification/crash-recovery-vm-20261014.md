# Bun single-host crash recovery VM qualification — 2026-10-14

Status: **INCOMPLETE / postponed by operator priority switch**. The earlier EXTRA artifact passed two resets and two kills. The final artifact passed two resets and one kill; its second kill hit a QEMU io_uring allocation failure before reboot. The VM recovered, its guest clock was restored and it was shut down normally. Full repository gate ended FAIL (exit 1): the normal-entry regression exceeded its 20-second readiness budget under shared load. Further fix/rerun is postponed; no overall PASS is claimed.

Scope: Bun self-host control/artifact profile with real authenticated AI HTTP
requests to a VM-only TLS upstream. This VM has no native workerd binary;
native Worker, Actor and Workflow execution is not qualified by these VM runs.
Root-scoped previous-boot custody is covered by repository regression tests.

## Provenance and environment

- Repository base: `04a94429`, branch `test/crash-recovery-vm-20261014`.
- Runtime and bundler: pinned Bun **1.4.0**. Source commit is the PR head recorded in the PR validation summary.
- Earlier EXTRA server SHA256: `3074378c913dfb8976cc539df85c0dcef43cdea6a126c74a77cd2891941295b2`.
- Final server SHA256: `a7fd475c5fcb2e473e08d9e7ea1f7c346355d2c545942cd16d993d904e478910` (always fences the canonical default/external DB and validates its parent).
- Ubuntu 24.04, Linux `6.8.0-142-generic`, QEMU TCG, four vCPUs,
  4 GiB RAM, ext4 on qcow2 with `cache=writeback`.
- Guest systemd unit runs as a dedicated `takoserver` user, enabled at boot,
  `Restart=on-failure`, `PrivateTmp=yes`. No manual start after a crash.
- Explicit configuration: `TAKOSERVER_SINGLE_HOST={"hostId":"crash-recovery-vm-20261014"}`.
- No production/staging access, provider credentials, or real payment service.
  Credentials and purchased credits are generated synthetic guest fixtures.
  No credentials are included in this report. `destroy.sh` was never executed.

## Reproduced failures and fixes

1. **Duplicate control writers.** Baseline processes on ports 8787 and 8789
   both returned readiness HTTP 200 over the same control database. Added a
   permanent private lock inode, held by a Linux kernel flock through bun:ffi.
   The descriptor stays held until process exit and is close-on-exec. An
   external control database is additionally locked at its canonical path.
2. **Stranded dispatched holds.** Baseline reset left eight calls dispatched
   with 8,800,000 micros held after their persisted deadlines. Added a bounded
   settlement sweep that atomically terminalizes pending calls and writes their
   exact release using existing ledger allocation guards. Staged billable
   results are excluded from this expiry sweep. No inference resend
   or client retry is used to release abandoned calls.
3. **Lost committed dispatch fence.** A pre-EXTRA reset changed one of two
   committed dispatched records back to ready, while integrity_check stayed
   clean. Observed defaults were synchronous=FULL and journal_mode=DELETE.
   The Bun writer now sets and verifies synchronous=EXTRA before migration.
   [SQLite's documented contract](https://www.sqlite.org/pragma.html#pragma_synchronous)
   explains that EXTRA also syncs the journal unlink directory; FULL with a
   rollback journal can lose the last committed transaction after power loss.
   The observed reversal is consistent with that contract; the exact kernel
   crash window was not traced.

Ownership also records a private epoch through file fsync, atomic rename and
parent-directory fsync, before writable control state opens. hostId and
machine-id are cross-checks. The acquired kernel lock is takeover authority;
machine-id does not authorize takeover. Only state beneath a currently held,
validated root can use previous-boot absence for native process custody.
Same-boot namespace uncertainty and foreign listeners retain their existing
refusals. No SQL schema or migration changes were introduced.

## Procedure and earlier EXTRA trials

Each trial starts two concurrent authenticated Chat Completions against a
local delayed TLS upstream. Read-only SQL snapshots prove both calls have
status 102/dispatched and 2,200,000 micros held before the crash. The operator
then invokes the existing VM `crash.sh reset` or `crash.sh kill` utility.
After SSH and automatic service readiness return, the test checks the changed
boot_id, epoch +1, unchanged lock inode, exactly one Host process, preserved
dispatch records and holds, and authenticated public models HTTP 200.

The guest wall clock is advanced beyond the calls' original **24-hour durable
idempotency deadlines**; the existing 30-second settlement timer performs the
release. This accelerates expiry testing without modifying row deadlines or
manually calling maintenance. The guest clock is restored after each trial.

| Trial | Before boot_id | After boot_id | Epoch | SSH recovery | Result |
| --- | --- | --- | --- | --- | --- |
| reset-extra-1 | `31830c08-d12a-40f6-973d-45536b8c2c07` | `cec4f18b-9e17-4f6e-8e2c-aae6de7096ad` | 4→5 | 131.49s | PASS |
| reset-extra-2 | `cec4f18b-9e17-4f6e-8e2c-aae6de7096ad` | `12225f3b-6aca-4634-afbb-dea2935e8cdd` | 5→6 | 116.62s | PASS |
| kill-extra-1 | `12225f3b-6aca-4634-afbb-dea2935e8cdd` | `f06ae718-762b-4530-8ad8-71dd0aec6f17` | 6→7 | 107.20s | PASS |
| kill-extra-2 | `f06ae718-762b-4530-8ad8-71dd0aec6f17` | `b5589600-3f51-4aea-8ee7-69590df07ff0` | 7→8 | 111.40s | PASS |

All earlier EXTRA trials preserve permanent lock inode `264297`. Each restored
snapshot contains both original dispatched calls, with the same held amount.
Every expiry yields zero held funds and zero hold allocations, exactly one
release per original hold, status 410 terminal records, no duplicate ledger
references, `integrity_check=ok`, no foreign key violations, and an unchanged
schema hash `32c982c103d92cdd62025b13da7200c750e8882d900c6362d3add2f9f8b2c47a`.

The earlier EXTRA dataset contains 34 holds and 34 matching releases, including
baseline and aborted setup attempts. Aggregate held funds are zero. The earlier EXTRA
four trials specifically account for eight abandoned calls and eight releases.

## Refusal tests

- A peer on another port exits 1 with `single-host lease is held or unavailable`.
- A real loopback NFSv4 mount is refused at filesystem type `0x6969` by both
  the lease probe and normal entry. Both exit 1 before creating SQL or epoch.
  The mount is unmounted after the test.
- Changing hostId or temporarily replacing the guest machine-id refuses
  takeover. Final refusals leave epoch **8 unchanged**. Original machine-id is
  restored in a finally block, then the service is started normally.

## Representative log and SQL evidence

```text
single-host lease acquired epoch=8 boot_id=b5589600-3f51-4aea-8ee7-69590df07ff0
self-host control database synchronous=EXTRA (commit directory sync)
takoserver listening on 127.0.0.1:8787 as https://crash-recovery.test:8443 (provisioning: local)
NFS refusal PASS probe_exit=1 entry_exit=1 no_database_or_epoch=true
single-host hostId/machine-id cross-check mismatch; refusing takeover
```

```text
Final qualified kill: dispatched=2; held=2200000; epoch=8; one Host PID=773
After expiry: terminal 410 count=18; prior completed 502 count=16
ledger: holds=34 (+37400000 held); releases=34 (-37400000 held)
allocated_held=0; duplicate_ledger_references=0; foreign_key_violations=0
integrity_check=ok
```

## Validation and boundaries

- Final focused regression run: **21 pass, 0 fail, 173 assertions** across six files (`recovery-tests-final.log`).
  Covers killed lease takeover, peer exclusion, epoch/machine cross-checks,
  aliases, external-DB exclusion, scoped boot proof, normal entry reopen,
  AI expiry races and rollback, and DELETE/WAL durability settings.
- Full `bun run check` with pinned Bun 1.4.0: **FAIL**, exit 1 after 5248 tests across 529 files / 3185.81s. The normal-entry regression timed out at its 20-second startup budget; earlier focused run passed. Remaining test/build stages were not reached.
- Installed host Bun 1.4.2 produced different generated bootstrap bytes;
  using the pinned toolchain resolved that mismatch without regenerating source.
- Baseline main CI is RED due to the existing money rehearsal fixture's missing
  `/dev/shm/t` parent on GitHub CI. [Failed main check](https://github.com/tako0614/takoserver/actions/runs/38543509980/job/115784340569).
  No merge or production/staging deploy is performed.
- A first eight-client fixed trial aborted before crash on observer SQLITE_BUSY.
  The observer now retries complete fresh snapshots for a bounded interval and
  final VM trials use two clients. The pre-EXTRA reset is a recorded FAIL,
  retained alongside the final PASS evidence.
- These repetitions qualify this VM/profile and the exercised boundaries;
  they do not establish exhaustive crash-window coverage or native execution
  qualification. The VM was stopped normally before the Linux Tier 1 install task reused it.

Raw scripts, logs, full JSON snapshots, task ledger and RESULTS.md are retained
in `/root/hdd/takos-dev/operator-runs/crash-recovery-vm-20261014/`.
Reversal for this fixture is stopping the service and restoring the baseline
artifact. No SQL migration is involved; expired release entries remain
append-only evidence and are not undone by restoring old code.

## Priority switch — 2026-10-14

Per BB6A-2230 and the revised 22:40 coverage addendum, preserve this branch and postpone further crash repetitions. Current unfinished work: final kill infrastructure interruption, final-artifact negative probes, full gate completion, and PR review. QEMU disk I/O was changed explicitly to `aio=threads` (cache remains writeback) after `Failed to initialize io_uring: Cannot allocate memory`; the original run-qemu.sh is retained outside the repo. Recovery after this intervention cannot count as an unattended final kill PASS. No production/staging mutation, merge, or destroy.sh.

## Final artifact trials and safe recovery

| Trial | Boot before | Boot after | Epoch | SSH seconds | Outcome |
|---|---|---|---|---:|---|
| reset-final-1 | `b5589600-3f51-4aea-8ee7-69590df07ff0` | `dab9b0bf-d4b5-4d97-8a18-5e5c66016cc4` | 11→12 | 132.19 | PASS |
| reset-final-2 | `dab9b0bf-d4b5-4d97-8a18-5e5c66016cc4` | `cad8fecd-82aa-451e-ae4d-b0ac9fa2512b` | 12→13 | 127.81 | PASS |
| kill-final-1 | `cad8fecd-82aa-451e-ae4d-b0ac9fa2512b` | `0dcd1e61-87b9-4850-bd0c-8114cad1ae8a` | 13→14 | 102.86 | PASS |
| kill-final-2 | `0dcd1e61-87b9-4850-bd0c-8114cad1ae8a` | `588b23f5-6dd7-4b30-8d3d-35f16b5f6dd2` | 14→15 | 770.18 | INTERRUPTED; recovered after operator I/O change; not unattended PASS |

Recovery completed: final two dispatched records survived; epoch 15; fixed lock inode 264297. Automatic deadline expiry released both holds. Final dataset: 42 holds and 42 releases, zero held/allocated funds, 26 expiry terminals (410), 16 earlier completed (502), integrity_check=ok, no FK violations/duplicate ledger references, unchanged schema hash. Guest clock restored. Host and synthetic upstream are being stopped cleanly and VM ACPI shutdown requested. No further crash/negative repetitions under the priority switch.

Saved checkpoint: 0be1f7fd on test/crash-recovery-vm-20261014. Final VM held/allocated balances were zero; private stopped crash disk was retained outside the repository. Final-artifact negative probes and an unattended fourth repetition remain postponed.
