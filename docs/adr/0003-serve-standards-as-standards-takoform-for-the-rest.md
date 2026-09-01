# ADR 0003 — Serve standards as standards, Takoform for the rest

**Status:** superseded by ADR 0005, 2026-09-01
**Companion:** Takoform decision 0043 (`terraform-provider-takoform`,
`spec/decisions/0043-forms-target-popular-vendor-locked-primitives.md`), which
records the survey this rule reads from and binds only Takoform's half.

This record is retained only as the tombstone of a discarded object-storage
retail candidate. Its route, credential issuer, supply composition, types, and
tests were removed. It is not authority for any current Takoserver surface.

ADR 0005 owns the current object-storage boundary: exact ObjectBucket Resource,
`edge.objects` Interface, and `module-worker.object-bucket` Binding. The AI API
decision is independent and remains implemented under its own current contract.
